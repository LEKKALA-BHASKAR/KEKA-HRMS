# Operations runbook

## Requirements
- Node 20+, PostgreSQL 14+, `pg_dump`/`pg_restore` on the host that runs backups.
- One writable directory for stored files (`STORAGE_DIR`, default `.storage/`). With more
  than one app instance, point every instance at the same shared volume.

## Configuration
| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL URL. Prisma's `?schema=` suffix is fine; the backup scripts strip it. |
| `AUTH_SECRET` | yes | ≥ 32 random characters: `openssl rand -base64 48`. Changing it signs everyone out. |
| `APP_URL` (or `AUTH_URL`) | for email links | Public base URL used in password-reset links. |
| `STORAGE_DIR`, `MAIL_DIR` | no | Defaults `.storage/` and `.mail/` at the repository root. |

The server validates these at start-up (`src/instrumentation.ts`) and refuses to start in
production if any is missing or `AUTH_SECRET` looks like a placeholder.

## Deploying
```bash
npm ci
npx prisma migrate deploy --schema packages/db/prisma/schema   # before the new code starts
npm run build --workspace apps/web
npm run start --workspace apps/web                             # behind TLS
```
Migrations are forward-only and must run before the new build serves traffic. **Restart
every instance after a migration** — the generated database client is loaded once per
process.

`Dockerfile` and `docker-compose.yml` describe the same steps in containers. They were
written alongside this runbook but **have not been built in this environment** (no Docker
available); treat them as a starting point and build them in CI first.

## Scheduled jobs
All jobs are idempotent; a missed or repeated run is safe.
```cron
*/5 * * * *  cd /srv/keka && npm run jobs -- deliver-mail
30 1 * * *   cd /srv/keka && npm run jobs -- nightly        # attendance, journeys, overdue invoices, ledger check, mail; leave accrual on the 1st
```
Each run is recorded in `job_runs`. **Settings → Scheduled jobs** flags any job that has
failed or not run on time.

## Backups
```bash
npm run backup -- /var/backups/keka        # db.dump + storage.tgz + SHA256SUMS
npm run restore -- /var/backups/keka/keka-<timestamp>
```
- Run the backup daily; keep 30 daily and 12 monthly copies off the host.
- **Drill a restore monthly** into a scratch database without touching production:
  `RESTORE_DATABASE_URL=postgresql://…/keka_drill npm run restore -- <dir> --yes`
  then compare row counts. (This drill was run during development: every table matched.)

## Monitoring
- `GET /api/health` → `200 {"status":"ok"}` when the database answers; `503` otherwise.
  It is unauthenticated and reveals nothing else.
- Logs from jobs and start-up checks are single-line JSON.
- **Settings → Sign-in log** shows failed sign-ins and the noisiest addresses.

## Security operations
| Situation | Action |
|---|---|
| Someone is locked out | Settings → Security → *Unlock*. Locks also clear by themselves after the lockout window. |
| A laptop is lost | Settings → Security → *Sign out everywhere* for that user. Their sessions die on the next request. |
| Suspected credential leak | Settings → Security → *Reset everyone*: signs out all users and requires a new password. |
| `AUTH_SECRET` exposed | Replace it and restart. Every session becomes invalid immediately. |
| An employee leaves | Finalising their settlement disables their login automatically. |

## Known gaps before a public launch
- Email is written to `.eml` files; plug a provider into `apps/web/src/lib/mail.ts`.
- The Content-Security-Policy allows inline scripts because Next inlines its bootstrap;
  moving to per-request nonces would tighten it.
- Form 24Q is produced as the deductee CSV; the FVU file is still made with the RPU utility.

## The books
- Payroll months, salary payments, settlements, loans, advances, invoices and receipts post
  to the ledger on their own. **Accounting → Overview** lists any finalised month whose
  accrual or salary payment is missing, with a button to post it.
- Close a month under **Accounting → Periods** once its figures are agreed with the auditor.
  Nothing dated inside a closed month can post; a payroll rollback afterwards reverses its
  entries in the current month instead.
- The nightly `ledger-check` job fails, and Settings → Scheduled jobs shows it, if debits
  stop equalling credits or a stored balance drifts from its lines. Investigate before
  repairing: `rebuildAccountBalances(tenantId)` in `@keka/services` recomputes the stored
  balances from the lines, which are the record.
