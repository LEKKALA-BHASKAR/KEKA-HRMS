# Keka — HR & Payroll Platform

A multi-tenant HRMS with a complete Indian statutory payroll engine, built from the
research in `02-corehr-payroll.md` and `Keka-Platform-Teardown.pdf`.

## Running it

```bash
createdb keka_dev          # Postgres 14+ on localhost:5432
npm install
npm run db:migrate         # creates 191 tables
npm run db:seed            # one tenant, 30 employees, Apr–Aug payroll finalised, Sep open
npm run dev                # http://localhost:3100
npm run test:all           # 275 unit tests + 17 integration suites (558 checks) against the seeded DB
```

After any migration, restart `npm run dev`: the generated Prisma client is a cached
module for the life of the process, so new tables are invisible until it restarts.

Sign in at `/signin` (email first, then password). Every seeded account uses the password
`Keka@2026`; the sign-in screen lists them under "Demo accounts".

| Account | Role | What it demonstrates |
|---|---|---|
| `vikram.menon@acme.test` | Global Admin | Everything — 23 nav items |
| `ramesh.iyer@acme.test` | Payroll Admin | Runs payroll; no roles or settings access |
| `priya.sharma@acme.test` | HR Manager | People and payroll *visibility*, no payroll config |
| `deepak.chauhan@acme.test` | HR Executive, **scoped** | Sees 14 of 30 employees — role scoped to 2 departments |
| `manish.tiwari@acme.test` | Finance Controller (**custom role**) | Read-only payroll, built by ticking permissions |
| `sneha.reddy@acme.test` | *No explicit role* | Access entirely from implicit Reporting Manager + Department Head |
| `meera.krishnan@acme.test` | *No role* | Self-service only — sees exactly 1 employee: herself |

## Layout

```
packages/shared      Decimal money, Indian FY dates — no float arithmetic anywhere
packages/db          Prisma multi-file schema (191 tables, every tenant table cascades) + seed
packages/rbac        124 permissions, 11 built-in roles, 3 implicit roles, scope resolution
packages/payroll     Pure engine: formulas, structures, PF/ESI/PT/LWF/TDS/gratuity, loan schedules
packages/time        Pure engine: calendars, leave counting and sandwich rule, accrual, attendance
packages/documents   Pure: dependency-free PDF writer (with encryption), payslips, Form 16, letters, statutory files
packages/services    DB-aware orchestration — payroll, time, lifecycle, loans, talent, expenses, projects, ledger
apps/web             Next.js 15 App Router, server components, server actions
```

The dependency direction is strict: `payroll` never imports `db`. That is what makes
the engine a pure function and lets 102 tests run in 200ms with no database.

## What is built and verified

### The spine
- **Multi-tenancy** — every row carries `tenantId`; tenant reached by subdomain
- **Auth** — signed httpOnly JWT sessions, 8-hour expiry, bcrypt, generic failure
  messages to prevent account enumeration, constant-time-ish compare against a dummy hash
- **RBAC** — the documented `scope of privilege UNION scope of visibility` rule, implemented
  as both a per-record check and a Prisma `where` filter. Verified: the same list shows
  30 / 14 / 14 / 1 employees depending on who is looking.
- **Audit log** — who, when, what, old and new values, across payroll, employee and auth

### Payroll — the six-step run
1. **Leave, Attendance & Daily Wages** — pending leave, no-attendance days, system LOP with manual adjustment
2. **New Joinees & Exits** — six pay actions per employee, pending settlements block the step
3. **Bonus, Salary Revisions & Overtime** — old/new CTC with % change, back-dated revisions routed to arrears
4. **Reimbursements, Ad-hoc Payments, Deductions** — add and remove inline, taxable/exempt
5. **Salary on Hold & Arrears** — processing hold vs payout hold as distinct behaviours, four arrear sources
6. **Overrides & Finalizing** — per-employee PT/ESI/LWF/TDS override, statutory summary, pre-finalise checks

Then: maker-checker approval (lock becomes *Lock & Send for Approval*), finalise,
payslip release, and rollback that un-consumes every input and archives journal vouchers.

### The statutory engine
| Head | What is implemented |
|---|---|
| **PF** | 12% with the ₹15,000 ceiling prorating alongside payable days, EPS 8.33% on its own ceiling, VPF by amount or percentage, EPS opt-out, EDLI and admin charges as employer cost |
| **ESI** | ₹21,000 limit tested against *full* monthly wage (so unpaid leave cannot pull someone in), contributions rounded **up** per ESIC rule, Apr–Sep / Oct–Mar cycle continuation, arrears in the wage base |
| **PT** | 88 slab rows across 22 states, driven by the employee's office location; monthly, half-yearly and annual states; Tamil Nadu corporation vs panchayat; Maharashtra's gendered thresholds and February rate; Article 276 ₹2,500 annual cap enforced |
| **LWF** | 16 states with their real collection months — Karnataka annually in December, Maharashtra in June and December, Haryana monthly |
| **Income tax** | Both regimes, **three separate old-regime age bands**, 87A rebate with marginal relief, surcharge with marginal relief, 4% cess, s.288A rounding, HRA exemption as least-of-three, Chapter VI-A ceilings |
| **TDS** | Annual liability projected across the full year, less tax already deducted, divided by remaining periods — so it stays level month to month. Flat TDS for contractors, admin override. |
| **Gratuity** | 5-year eligibility, Act-covered (15 days ÷ 26) vs not-covered (÷ 30), part-year over six months rounds up, ₹20L exemption ceiling |

### Verification
- **275 unit tests**, all passing — `npm test` (payroll, time, RBAC, documents and the pure
  parts of services, no database)
- **17 integration suites, 558 checks** — `npm run test:smoke` — drive the real server actions
  through the genuine session → viewer → permission chain, clean up after themselves, and pass
  when run twice in a row: seams, master data, employee lifecycle, payroll config, leave &
  attendance (engine and actions), exits/journeys/helpdesk, loans, authentication, statutory
  filings, performance, hiring, expenses, projects, accounting, self-service, and tenant isolation
- **Production build passes** with full TypeScript checking, no `ignoreBuildErrors`
- **479 page/persona combinations** (every page, and every detail page with a real record, for
  up to seven personas) return only 200, 403, 404 or a deliberate redirect — never a 500
- **A real 28-employee payroll run** reconciles: gross − deductions = net, exactly

## Three bugs worth recording

**Old-regime tax slabs merged across age bands.** The old regime publishes three
complete tables (under-60, 60–79, 80+). Loading them into one list made the 20% and 30%
slabs repeat, over-deducting TDS by roughly 3×. On the seeded data that was **₹7.9 lakh
per month** across 28 employees. Fixed by selecting one band from the employee's age at
31 March; locked in by four regression tests, one of which asserts that merging the bands
*does* inflate the result.

**Nullable columns inside unique constraints.** Postgres treats `NULL`s as distinct in a
unique index, so `@@unique([payGroupId, year, month, type, baseRunId])` would have allowed
duplicate regular payroll runs for the same month. Replaced with an explicit `sequence`
column. The same fix applied to Tamil Nadu's `localBodyType`.

**Conditional Prisma `include` silently drops the relation.** Writing
`enrolments: canEnrol ? { include: { employee: true } } : false` widens the row into a union
in which `employee` does not exist, so the field is unreachable on the half of the union the
compiler picks. Caught by the production typecheck, not at runtime — which is the argument
for keeping `ignoreBuildErrors` off. The includes are now unconditional and gated at render.

## Phase 2 — modules from the CodeCanyon reference products

Feature sets consolidated from three reference HRM products (HRM - HR and Payroll Tool,
HRM OS, PeoplePro HRM). The schema now covers all of it — 174 tables, up from 97 — and
these modules have working screens:

| Module | What works |
|---|---|
| **Announcements** | Publish, pin, schedule, expire; per-employee read and acknowledgement tracking with a completion bar against headcount |
| **Awards & praise** | Award types with cadence and cash value, grants with citations, peer praise wall with badges, quarterly leaderboard |
| **Assets** | 4 categories, 82 seeded items, straight-line depreciation and book value, assignment with employee acknowledgement, returns with condition, damage charges, employee-raised requests |
| **Documents** | Folders with confidential flags and role permissions, per-type mandatory/verification/expiry rules, verify-or-reject queue, 90-day expiry tracker, org policies with acknowledgement, letter templates with placeholder substitution |
| **Contracts** | Permanent and fixed-term, renewal chain, expiry status |
| **HR activities** | Promotion, transfer, warning, complaint, work trip, termination, resignation, appreciation — as a timeline distinct from the effective-dated job record |
| **Training** | Types by mode, programmes with seats/cost/trainer, bulk enrolment with seat-limit enforcement, self-service progress, mandatory-compliance completion tracking with an outstanding list |
| **Meetings** | Rooms with facilities and capacity, invitations with accept/decline/tentative, minutes, action items with owners and overdue flagging |

Recruitment, performance, projects and accounting, which the schema covered from the start,
now have working screens too — see Phase 4.

### The seams that matter

Modules that cannot reach payroll are decorative. Two are wired and tested end to end:

- **A cash award becomes an ad-hoc payment.** Granting an award with a cash value pushes it
  into the open payroll run, raises gross, appears as a named payslip line, and increases TDS
  because it is taxable.
- **An asset damage charge becomes an ad-hoc deduction.** Recording a damaged return and
  recovering it raises deductions, lowers net pay by the same amount, and leaves gross
  untouched because the recovery is not taxable. For a leaver the charge routes to the
  full-and-final settlement instead, and the UI says so, so it cannot be recovered twice.

`scripts/smoke-seams.ts` verifies both, plus whole-run reconciliation afterwards and that
a rollback releases everything the modules injected. **15 checks, all passing.**

## Phase 3 — operations, lifecycle, security

| Area | What works end to end |
|---|---|
| Leave | Apply with a live count (weekends, holidays, sandwich rule), approve/reject in scope, cancel with ledger reversal, accrual job (idempotent, slices sum exactly to the quota), year-end, plans, holiday calendars, team calendar |
| Attendance | Web clock-in with IP allow-list, processing against shifts and policies, late/missing-punch penalties, regularisation/adjustment/WFH requests, monthly register; unpaid leave is charged once, through leave |
| Journeys | Templates per trigger (joining, confirmation, promotion, transfer, exit) started automatically by the event; tasks owned by HR, manager, employee, IT or finance; system-verified tasks close themselves |
| Exits | Resignation and HR-recorded exits, approval, notice shortfall, exit checklist, accrual true-up to the last day, full and final (encashment, gratuity, notice, loans, assets, marginal TDS), finalisation revokes access |
| Helpdesk | Categories with SLA targets, per-tenant ticket numbers, internal notes, status flow, satisfaction |
| Loans | Eligibility against policy, schedules (flat, reducing, interest-free) that repay exactly, skip, foreclose, balances kept in step with payroll |
| Reports | Eleven reports, each scoped by its own permission, with CSV export (formula-injection safe, audited) |
| "Why?" | Pay and payroll changes attributed to revision, LOP, one-offs, joiners/leavers and each deduction — the causes add up exactly |
| Home | Today strip for everyone; ranked attention lists for managers and HR |
| Security | Password policy and history, lockout counted per address (no account enumeration), per-IP rate limiting, email two-factor, sign out everywhere, forced and emailed resets, sign-in log |

| Documents & filings | Payslips and Form 16 as PDFs (encrypted with the PAN, verified against pypdf), letters, uploads checked by content not name; PF ECR, ESI, bank advice and the 24Q annexure generated from the run and reconciled to it |

## Phase 4 — talent, money and the books

| Module | What works end to end |
|---|---|
| Performance | Goals cascading company → department → person with roll-up, weighted check-ins, review cycles (self, manager, peers), calibration against a target distribution, PIPs |
| Hiring | Requisition approval → job → pipeline stages → interviews and scorecards → offer with approval → hire, which creates the employee and starts the department's onboarding journey |
| Expenses & travel | Claims checked against policy as they are typed (caps, receipts, 60-day rule), manager then finance approval above a limit, paid with the next salary; cash advances settled by claims or recovered through payroll; travel desk |
| Projects & time | Clients with GST place of supply; time-and-material, milestone, retainer and internal projects; allocations capped at 100% across projects; weekly timesheets against allocations only, approved by the line or the project manager; health from burn versus calendar |
| Billing | Approved billable hours (or completed milestones, or the retainer) become an invoice at each person's rate, CGST+SGST, IGST or zero-rated by place of supply, sent as a PDF, part-paid, overdue |
| Accounting | Chart of accounts, sequential journal, account ledgers, trial balance, P&L and balance sheet; payroll months, salary payments, F&F settlements, staff loans, advances, invoices and receipts **post themselves**, exactly once; mistakes are reversed, never deleted; months close |
| Tenant isolation | A Global Admin attempts 46 writes and 3 reads against a rival tenant's records — every one refused and the rival untouched — then the rival is deleted, leaving nothing in any of 95 tenant tables |

The ledger is checked against the modules it summarises: staff loans in the books equal the
loans module, receivables equal open invoices, employee advances equal open advances, and
every stored balance equals the sum of its lines. Building it is also how a seed bug surfaced:
three loan instalments were marked deducted that no payslip had ever deducted.

## Phase 5 — the Keka interface

The app now looks and is organised like Keka's own employee experience, rebuilt from
screenshots of a live Keka tenant on our light palette.

**The shell.** A blue top bar (company name, search with ⌘K, notifications, account menu)
and a dark icon rail: **Home, Me, Inbox, My Team, My Finances, Org, Engage**, then — below a
divider, only for roles that need them — **People, Hire, Performance, Projects, Payroll,
Finance, Admin**. Each section has a tab bar, and pages add a second row of sub-tabs. The
whole navigation is one permission-driven model (`lib/nav.ts`); every route belongs to exactly
one section for a given person, so the right rail item and tab light up for any URL.

| Section | Screens |
|---|---|
| Home | Dashboard (time today with web clock-in, on leave today, leave balance rings, holidays, inbox, praise, announcements, birthdays · anniversaries · new joinees) and Welcome (profile completeness, "Introduce yourself", onboarding tasks, Explore cards, HR contact, my team) |
| Me | Attendance (stats vs team, today's shift, live clock, 30-day log with timeline bars, calendar, requests), Leave (balances as rings, weekly/monthly patterns, history), Performance (praise and feedback received and given, internal notes, goals, reviews), Expenses & Travel (drafts, claims in process, past claims, advances, travel), Apps |
| Inbox | Take Action, Notifications and Archive in a three-pane layout, with approve/reject in place |
| My Team | Who is on leave, not in yet, on time, late, remote; a month team calendar; peer and report cards with today's status |
| My Finances | Summary (payroll, bank, PF/ESI/PT, PAN and Aadhaar masked), My Pay (salary timeline, payslips rendered in place, income-tax computation), Manage Tax (declarations with windows and ceilings, proofs, previous income, Form 16) |
| Org | Employee directory with filters, an interactive organisation tree, colleague profiles |

**What changed underneath.**
- Investment declarations now reach payroll: the month's TDS uses each declaration after
  every section ceiling (declared amounts until proofs are ruled on). A test adds an NPS
  declaration, sees TDS fall by exactly the tax it saves, removes it and sees TDS restored.
- Continuous feedback (`Feedback`: feedback and managers' internal notes, which the subject
  never sees), "about me", and who rejected, cancelled or requested on behalf — recorded on
  leave, expense claims and timesheets instead of pieced together from the audit log.
- The directory is a deliberate policy: every colleague sees work details (name, title,
  department, location, work email, manager) and nothing personal or financial.
- Sign-in returns you to the page you were trying to open; only same-site paths are accepted.
- Demo data reaches the day you seed: attendance through yesterday, this morning's
  clock-ins, someone on leave, working from home and on duty today, and a birthday.

## Known limitations

- **Statutory reference tables need verification before go-live.** PT slabs, LWF rules and
  tax slabs are seeded from published schedules and marked as such in the source. They are
  effective-dated and read from the database, so correcting one is a data change, not a code
  change — but they are not a legal authority.
- **Visibility is a directory control, not a data partition.** This mirrors the source
  product exactly: an unscoped role reaches every legal entity regardless of the restriction.
  Businesses that genuinely must not see each other need separate tenants.
- **Email is delivered to files in development.** The outbox, retries and failure tracking
  are real; the transport writes `.eml` files to `.mail/`. A provider transport is a
  single-function swap in `apps/web/src/lib/mail.ts`.
- **Seeded "today" data only inside the demo year.** Seeding between 27 Sep 2026 and 31 Mar
  2027 brings attendance up to the day; outside that window the data ends on 25 Sep 2026.
- **Not built from the Keka screens:** single sign-on (Google, Microsoft, mobile OTP), leave
  encashment and comp-off requests as their own flows, and real photos (avatars are initials).
- **India only.** The statutory engine is structured so US and GCC packs could be added, but
  nothing outside India is implemented.
- **One set of books per tenant.** Ledger entries carry a legal entity column, but the screens
  report the tenant as a whole. GST input credit, bank reconciliation and fixed-asset
  depreciation postings are not built; vendor bills are out of scope.
# KEKA-HRMS
