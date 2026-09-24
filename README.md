# Keka — HR & Payroll Platform

A multi-tenant HRMS with a complete Indian statutory payroll engine, built from the
research in `02-corehr-payroll.md` and `Keka-Platform-Teardown.pdf`.

## Running it

```bash
createdb keka_dev          # Postgres 14+ on localhost:5432
npm install
npm run db:migrate         # creates 97 tables
npm run db:seed            # one tenant, 30 employees, full payroll config
npm run dev                # http://localhost:3100
```

Sign in at `/signin`. Every seeded account uses the password `Keka@2026`, and the
sign-in screen lists them as one-click buttons.

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
packages/db          Prisma multi-file schema (97 tables) + seed
packages/rbac        91 permissions, 11 built-in roles, 3 implicit roles, scope resolution
packages/payroll     Pure engine: formulas, structures, PF/ESI/PT/LWF/TDS/gratuity
packages/services    DB-aware orchestration — the payroll run
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
- **102 unit tests**, all passing — `npm test`
- **Production build passes** with full TypeScript checking, no `ignoreBuildErrors`
- **168 route/persona combinations** return only 200 or 403, never a 500
- **A real 28-employee payroll run** reconciles: gross − deductions = net, exactly

## Two bugs worth recording

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

## Scheduled next

Schema and navigation are in place; screens come next, in this order:

1. **Leave & attendance operations** — application and approval flows, the accrual job, biometric ingestion, penalisation policy
2. **Lifecycle** — onboarding task templates with the Applies-To engine, probation evaluation, exit initiation and clearance
3. **Documents & assets** — letter templates with placeholders, document workflows, asset assignment and damage recovery
4. **Statutory filing** — PF and ESI ECR generation, Form 16, Form 24Q/26Q with challan mapping
5. **Helpdesk** — categories with SLA per priority and two-trigger escalation
6. **Talent** — performance reviews with calibration (bell curve, 9-box), OKRs, Keka Hire ATS
7. **PSA** — projects, timesheets, rate cards and margin

## Known limitations

- **Statutory reference tables need verification before go-live.** PT slabs, LWF rules and
  tax slabs are seeded from published schedules and marked as such in the source. They are
  effective-dated and read from the database, so correcting one is a data change, not a code
  change — but they are not a legal authority.
- **Visibility is a directory control, not a data partition.** This mirrors the source
  product exactly: an unscoped role reaches every legal entity regardless of the restriction.
  Businesses that genuinely must not see each other need separate tenants.
- **India only.** The statutory engine is structured so US and GCC packs could be added, but
  nothing outside India is implemented.
# KEKA-HRMS
