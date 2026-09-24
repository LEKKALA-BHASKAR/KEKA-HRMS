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
