# Architecture

## Dependency direction

```
        apps/web  (Next.js — server components, server actions)
            |
            v
     packages/services   (orchestration: loads inputs, persists results)
        |        |
        v        v
  packages/db   packages/payroll   (pure engine — no I/O, no clock, no DB)
        |        |
        +---> packages/shared  (Decimal money, Indian FY dates)
             packages/rbac     (permissions, roles, scope resolution)
```

`packages/payroll` importing `packages/db` would be the single most damaging change
anyone could make to this codebase. The engine is a pure function of its inputs, which is
why a payroll run is reproducible, auditable, and testable without a database.

## Money

Every rupee figure is a `Decimal` (decimal.js, 28 significant digits, half-up) until it is
rendered or written. Binary floating point is never used for money. `0.1 + 0.2` is asserted
to equal exactly `0.3` in the test suite, because at payroll scale that drift becomes a
reconciliation failure someone has to explain.

Rounding is not uniform, because statute is not uniform:

| Function | Rule | Used for |
|---|---|---|
| `roundRupees` | half-up to 0 dp | salary components, PF |
| `roundPaise` | half-up to 2 dp | statutory figures carrying decimals |
| `roundTax` | **ceiling** to 0 dp | TDS, per Income Tax convention |
| (in `esi.ts`) | **ceiling** to 0 dp | ESI, per ESIC rule |

## Authorisation

Two layers, combined by union — the rule stated verbatim in the source product's docs:

```
effective access = scope of privilege  UNION  scope of visibility
```

**Layer 1, privilege.** A grant is `(user × role × scope)`. Scope filters are department and
location. Legal entity is deliberately *not* a scope filter, matching the source product.
An unscoped grant reaches everyone.

**Layer 2, visibility.** Tenant-wide restriction by legal entity or business unit, with a
manager/reportee override.

Because the layers union rather than intersect, **an unscoped role sees across every legal
entity regardless of the visibility restriction.** This is a directory-visibility control,
not an information barrier. `packages/rbac/src/access.ts` implements it exactly this way
rather than pretending otherwise — the comment there says so, so nobody "fixes" it into
something the product does not do.

Three entry points:

- `hasPermission(ctx, perm)` — does the viewer hold it *anywhere*? **Menu rendering only.**
  A scoped grant appears here without covering the record in question.
- `canAccessEmployee(ctx, target, perm)` — the real check, for any record decision.
- `employeeScopeFilter(ctx, perm)` — a Prisma `where` fragment for lists. Returns `null`
  when unscoped, and a never-match clause when there is no route to the permission at all.

Permissions are re-read from the database on every request and never cached in the session
token. A role revoked at 10:00 must not still work at 10:05.

## The payroll run

`calculatePayroll` in `packages/payroll/src/engine.ts` is one pure function. Its order of
operations follows Indian payroll convention and matters:

1. Resolve the structure into full monthly entitlements
2. Prorate earnings for LOP **and** for mid-period joining or leaving
3. Add variable pay — arrears, bonus, overtime, ad-hoc, claims
4. PF and ESI on the **prorated** wage bases (the PF ceiling prorates too, so a half-month
   joiner is not credited a full month of PF)
5. PT and LWF from the employee's work state
6. Project annual income, back out this month's TDS
7. Subtract deductions and recoveries to reach net pay

### The unit rule

**Every salary formula produces a monthly amount.** The evaluation context exposes both
bases so intent is never ambiguous:

| Reference | Meaning |
|---|---|
| `[CTC]`, `[CTC_ANNUAL]` | annual cost to company |
| `[CTC_MONTHLY]` | CTC ÷ 12 |
| `[BASIC]` | Basic, **monthly** |
| `[BASIC_ANNUAL]` | Basic × 12 |
| `[GROSS]` | running total of earnings resolved so far, monthly |

One component per structure may be `BALANCE`; it absorbs whatever is left of the monthly
CTC after everything else. Components are evaluated in topological order of their formula
dependencies, and a dependency cycle is **reported as a warning**, not silently dropped —
a cycle in a salary structure is a configuration bug an admin needs to see.

### Why TDS moves

The monthly TDS figure is not a monthly calculation. It is the annual liability, projected
from what the employee will earn across the whole financial year, less tax already
deducted, divided by the periods still to run. That is why it changes when a declaration
is approved, a bonus lands, or someone joins mid-year — and why, with year-to-date figures
tracked correctly, it stays level for an employee on a flat salary. There is a test for
exactly that property.

## Recalculation

Every server action that changes a payroll input calls `calculateRun` afterwards. A change
at step 1 is reflected in the step 6 totals immediately. This is affordable precisely
because the engine is pure: recalculating 28 employees is arithmetic, not I/O.

`calculateRun` is idempotent. Existing per-employee rows are read first so the pay actions
and overrides set in steps 2–6 survive, then payslip lines are deleted and rewritten.

## Reversibility

Finalising consumes inputs — arrears, ad-hoc transactions, loan instalments and claims are
all marked processed. Rollback reverses every one of those, deletes the payslips, and
**archives** journal vouchers rather than deleting them, because an exported voucher must
remain auditable.


## Module layering (Phase 2)

The schema is split by domain, with a strict rule: a module may reference the employee
record, but modules do not reference each other's internals. Cross-module effects go
through payroll's existing transaction tables rather than through direct coupling.

```
00-base          tenancy, identity, RBAC, audit
01-org           legal entity -> business unit -> department; location
02-employee      the employee record and its back-relations
03-payroll       pay groups, components, structures, runs, payslips
04-statutory     PF/ESI/PT/LWF/income tax reference tables
05-transactions  arrears, ad-hoc, bonus, claims, loans, F&F, journal vouchers
06-time          leave and attendance
07-workplace     announcements, awards, assets, documents, contracts,
                 HR activities, training, meetings
08-recruitment   requisitions, jobs, candidates, applications, interviews, offers
09-performance   indicators, goals, review cycles, calibration, skills, PIP
10-projects      clients, projects, tasks, milestones, timesheets, invoices
11-accounting    chart of accounts, double-entry ledger, expenses, travel
12-time-ops      attendance policies and requests, the leave ledger
13-lifecycle     journeys, exits, helpdesk, notifications, outbox
14-engage-learn  surveys, courses, career paths, comp-off and encashment requests
15-probation     probation policies, employee probations, review rounds
```

### Why cross-module effects route through payroll transactions

An award with a cash value does not get a foreign key into the payslip. It creates an
`AdhocTransaction` and stores the run id it was pushed into. The same is true of an asset
damage charge. This matters for three reasons:

1. **The payroll engine stays pure.** It consumes ad-hoc transactions and knows nothing
   about awards or assets. Adding a tenth module that needs to pay or recover money requires
   no engine change.
2. **Rollback works uniformly.** Rolling a run back releases every ad-hoc transaction
   regardless of which module created it, because there is one mechanism, not ten.
3. **Double recovery is visible.** An asset charge carries `chargeRecovered`, and a leaver's
   charge is read directly by the full-and-final settlement. The UI states which route
   applies, because the alternative is recovering the same money twice.

### The accounting ledger is double-entry, deliberately

HRM OS describes "account creation and transaction management with account-wise balance
view". A flat transaction list cannot produce a balance anyone should trust. `LedgerEntry`
holds a header with `isBalanced`, and `LedgerLine` holds legs where exactly one of debit or
credit is non-zero. An entry cannot post until debits equal credits, periods can be closed
to block back-dated postings, and an entry is reversed by a contra entry rather than
deleted. The payroll journal-voucher export posts into this ledger rather than existing
beside it.

## Phase 3 decisions

### One definition of "finalised"
Finalising, releasing and rolling back a payroll month live in `services/payroll-close.ts`,
used by the UI, the seed and the tests alike. Every input the month consumes — arrears,
ad-hoc items, bonuses, loan instalments, claims — is marked against exactly the employees
processed in that run, mirroring what `calculateRun` selected. (The earlier inline version
marked a month's claims paid across every tenant.) Rolling back a month under a later
finalised month is refused, because the later month's year-to-date figures depend on it.

### Ledgers, not counters
Leave balances are a cache of `leave_ledger_entries`; loan balances are recomputed from their
schedule after every movement. Anything that changes a balance writes a row that explains
it, with an idempotency key where a job might run twice.

### Events start journeys
Hiring, job changes and exit approval call `startJourney`, which picks the most specific
active template and is idempotent per employee, trigger and date. Tasks with an `autoCheck`
can only be closed by the system verifying the fact, never by ticking a box.

### Explanations add up
`services/explain.ts` compares two months line by line. Every rupee of the change is
attributed to a cause; anything unattributed is shown as "rounding and other", so an
explanation can never silently omit part of a change.

### Tenancy is enforced by the database
Every table with a `tenantId` has a cascading foreign key to `tenants` (74 were added when an
audit found rows left behind by deleted tenants). Deleting a tenant removes all of its data.

### Authentication never answers "does this account exist?"
Wrong password, unknown user, lockout and reset requests produce identical responses for
real and imaginary addresses. Lockout is counted from sign-in events per email, not from the
user row, precisely so a non-existent address locks the same way. Sessions carry a version;
password changes and "sign out everywhere" bump it, killing old sessions on their next request.

## Phase 4 decisions

### Every id from a form is an attack surface
A server action that stores a reference — a department's head, a task's assignee, a salary
structure, a ledger account — must confirm the referenced record is the viewer's tenant's
before writing it. `lib/ownership.ts` (`foreignReference`) does this for twenty kinds of
record in one call; child tables without a `tenantId` are checked through their parent
(a holiday through its calendar, a milestone through its project). Updates and deletes are
written as `updateMany`/`deleteMany` with `tenantId` in the `where`, so a foreign id changes
nothing. `scripts/smoke-isolation.ts` keeps this honest: it builds a rival tenant and has a
Global Admin attack it through 46 actions (and 3 reads). An independent audit of every action found 18
gaps (including ad-hoc payments and loss-of-pay days injectable into another tenant's
payroll); the proof now covers each, and was shown to fail when a fix is removed.

### Tenant deletion and `RESTRICT`
Three foreign keys guard against deleting something in use — an expense category, a helpdesk
category, a ledger account. As `RESTRICT` they also blocked deleting a whole tenant, because
Postgres cascades the tenant's categories one level down before it reaches the lines two
levels down. They are now `NO ACTION DEFERRABLE INITIALLY DEFERRED`: still refused for a
category in use, but checked at commit, when the tenant's lines are already gone.

### The ledger posts itself, once
Payroll finalisation, salary payments, F&F settlements, loan disbursements and foreclosures,
cash advances, claims settled or paid outside payroll, invoices and receipts each post a
balanced entry keyed by the record that produced it (`sourceRefType`, `sourceRefId`). A
second post of the same record returns the existing entry instead of doubling it. Rolling
back payroll reverses its entries with contras dated today, so a closed month is never
touched. The mapping from payslip lines to accounts is a pure function
(`accounting-math.ts: payrollJournal`) tested against the seeded August run to the rupee:
gross and employer contributions are cost; each deduction is owed to whoever collects it;
a loan EMI splits into principal (reducing the asset) and interest (income); a reimbursement
is not salary; a perquisite is not cash and never reaches the ledger.

### Stored balances are a cache
`Account.currentBalance` is maintained on every posting so the chart can show balances
without aggregating the ledger, but the lines are the truth. The overview compares the two
and says so if they ever disagree, and `rebuildAccountBalances` recomputes the cache.

### Projects bill what was approved, at the rate in force
A time entry copies the bill and cost rate from the allocation that covered its date, so a
later rate change never reprices history. Only allocated people can log time; allocations
are capped at 100% across projects; tasks must belong to the project they are logged
against. An invoice takes approved, billable, uninvoiced entries and marks them invoiced in
the same transaction. GST follows place of supply: same state is CGST + SGST, another state
is IGST, abroad is zero-rated.

### Line managers manage people, not projects
`TASK_MANAGE` and `TIMESHEET_APPROVE` are implicit for every reporting manager. On their own
they open the manager's team, never a project: adding tasks needs the project (its manager
or `PROJECT_MANAGE`), and moving a task needs it to be yours, your report's, or your project's.

## Phase 5 decisions

### One navigation model, derived from permissions
`lib/nav.ts` builds the rail and every section's tabs from the viewer's permissions on each
request. Every route belongs to exactly one section per viewer — the longest matching path
prefix wins — so the active rail item and tab follow from the URL alone. A route that is an
admin workspace for one person (say `/helpdesk` for an HR agent) is one of "my apps" for
everyone else; the builder assigns it accordingly. Line managers' implicit rights do not open
workspaces: approving a timesheet or giving interview feedback happens in the inbox and apps,
not in the Projects or Hire workspaces.

### No streaming shell for authorised pages
A segment `loading.tsx` streams the layout before the page runs, after which `forbidden()` and
`notFound()` can no longer set the status — every 403 and 404 would answer 200. Navigation
feedback is a progress bar in the shell instead, which leaves status codes intact.

### The directory is a policy, not a leak
`lib/directory.ts` defines the only employee fields one colleague sees of another: name, title,
department, business unit, location, work email, manager, joining date and "about me". The
search API, directory, organisation tree, team cards and profiles all select through it.
Everything personal or financial stays behind the employee permissions and their scopes.

### Declarations count once, everywhere
The section rules (which sections each regime allows, each ceiling, the shared 80C limit, the
₹2 lakh house-property loss) live in `services/declarations.ts`. The tax pages use them to
accept or refuse a line, and payroll uses them to compute TDS — so what an employee sees as
their projected tax is what the run deducts.

### Who decided is a column
Leave requests record who raised them on someone's behalf and who cancelled them; expense
claims and timesheets record who rejected them. Screens read the columns and fall back to the
audit trail only for rows older than the columns.
