/**
 * Scheduled jobs. Run from cron or a scheduler; every job is idempotent, so
 * running one twice — or late — never double-counts anything.
 *
 *   tsx scripts/jobs.ts deliver-mail          every few minutes
 *   tsx scripts/jobs.ts deliver-webhooks      every minute or two; retries back off on their own
 *   tsx scripts/jobs.ts auto-clock-out        nightly (before process-attendance); closes punches left open past the shift's auto clock-out
 *   tsx scripts/jobs.ts process-attendance    nightly; re-evaluates the last 3 days
 *   tsx scripts/jobs.ts journeys              nightly; closes tasks the system can verify
 *   tsx scripts/jobs.ts probation             nightly; opens probation reviews, auto-confirms ended probations
 *   tsx scripts/jobs.ts accrue [YYYY-MM]      monthly; credits leave for the month
 *   tsx scripts/jobs.ts leave-year-end        nightly; closes ended leave years (carry forward, pay out, lapse)
 *   tsx scripts/jobs.ts leave-auto-approve    nightly; approves chained leave left past its auto-approve window
 *   tsx scripts/jobs.ts shift-allowance [YYYY-MM]  nightly; rebuilds the month's unpaid shift allowance from attendance
 *   tsx scripts/jobs.ts invoices              nightly; marks unpaid invoices past due as overdue
 *   tsx scripts/jobs.ts timesheet-reminders   nightly; reminds and escalates unsubmitted timesheets (per the timesheet policy)
 *   tsx scripts/jobs.ts ledger-check          nightly; fails if any tenant's books do not balance
 *   tsx scripts/jobs.ts job-changes           nightly; applies approved promotions/transfers whose effective date has come
 *   tsx scripts/jobs.ts change-requests       nightly; applies approved org, config and profile changes whose effective date has come
 *   tsx scripts/jobs.ts scheduled-reports     hourly (or nightly); emails the CSV of every scheduled report that is due
 *   tsx scripts/jobs.ts workforce             nightly; contract expiry alerts, ends expired contracts, vacates seats of leavers
 *   tsx scripts/jobs.ts governance            nightly; expires time-bound access, escalates workflows, runs automations, retention, audit sealing, security scan
 *   tsx scripts/jobs.ts join-daily            nightly; pre-joining messages, preboarding reminders, onboarding escalation, verification SLA, calendar checks, overtime alerts, comp-off expiry reminders
 *   tsx scripts/jobs.ts engage                nightly (or hourly); recurring pulses, survey reminders/auto-close/retention, scheduled announcements, expiry, anniversary points, overdue action plans, ended programmes
 *   tsx scripts/jobs.ts hire-alerts           nightly; hiring SLA alerts (stage time, screening, feedback, offers, requisitions), pool and consent expiry
 *   tsx scripts/jobs.ts automations           hourly; workflow SLA escalation/reminders and event-triggered automation rules
 *   tsx scripts/jobs.ts cases-docs            nightly; helpdesk escalations, document expiry, e-sign reminders, template reviews, maintenance due, low stock
 *   tsx scripts/jobs.ts nightly               all of the nightly jobs (+ accrual on the 1st)
 *
 * Each run is recorded in job_runs and logged as one JSON line.
 */
import "./_runtime";
import { prisma } from "@keka/db";

type Job = () => Promise<Record<string, unknown>>;

async function record(name: string, job: Job): Promise<boolean> {
  const run = await prisma.jobRun.create({ data: { job: name } });
  const t0 = Date.now();
  try {
    const summary = await job();
    await prisma.jobRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: true, summary: summary as never } });
    console.log(JSON.stringify({ level: "info", job: name, ok: true, ms: Date.now() - t0, ...summary }));
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.jobRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: false, error: msg.slice(0, 2000) } });
    console.error(JSON.stringify({ level: "error", job: name, ok: false, ms: Date.now() - t0, error: msg }));
    return false;
  }
}

async function main() {
  const svc = await import("@keka/services");
  const { fileTransport } = await import("../apps/web/src/lib/mail");
  const [cmd, arg] = process.argv.slice(2);
  const tenants = await prisma.tenant.findMany({ where: { isActive: true }, select: { id: true, subdomain: true } });

  const jobs: Record<string, Job> = {
    "deliver-mail": async () => svc.deliverOutbox(fileTransport, { limit: 500 }),
    "deliver-webhooks": async () => svc.deliverWebhooks({ limit: 500 }),
    "auto-clock-out": async () => {
      let checked = 0, closed = 0;
      for (const t of tenants) { const s = await svc.runAutoClockOut(t.id); checked += s.checked; closed += s.closed; }
      return { tenants: tenants.length, openPunches: checked, closed };
    },
    "process-attendance": async () => {
      const to = new Date(), from = new Date(to.getTime() - 3 * 86_400_000);
      let days = 0, lop = 0;
      for (const t of tenants) { const s = await svc.processAttendance({ tenantId: t.id, from, to }); days += s.days; lop += s.lopDays; }
      return { tenants: tenants.length, days, lopDays: lop };
    },
    journeys: async () => {
      const active = await prisma.journey.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
      let closed = 0;
      for (const j of active) closed += await svc.runAutoChecks(j.id);
      return { journeys: active.length, tasksClosed: closed };
    },
    probation: async () => {
      let started = 0, reviewsOpened = 0, autoConfirmed = 0;
      for (const t of tenants) { const s = await svc.runProbationJob(t.id); started += s.started; reviewsOpened += s.reviewsOpened; autoConfirmed += s.autoConfirmed; }
      return { tenants: tenants.length, started, reviewsOpened, autoConfirmed };
    },
    "leave-year-end": async () => {
      let closed = 0, paid = 0, expired = 0;
      for (const t of tenants) { const s = await svc.runLeaveYearEnd({ tenantId: t.id, apply: true }); closed += s.closed; paid += s.paid; expired += s.expired; }
      return { tenants: tenants.length, closed, payments: paid, expiredCarryForwards: expired };
    },
    "leave-auto-approve": async () => {
      let checked = 0, approved = 0;
      for (const t of tenants) { const s = await svc.autoApproveStaleLeave(t.id); checked += s.checked; approved += s.approved; }
      return { tenants: tenants.length, checked, approved };
    },
    "shift-allowance": async () => {
      const m = /^(\d{4})-(\d{2})$/.exec(arg ?? "");
      const now = new Date();
      const year = m ? Number(m[1]) : now.getUTCFullYear(), month = m ? Number(m[2]) : now.getUTCMonth() + 1;
      let entries = 0, amount = 0;
      for (const t of tenants) { const s = await svc.generateShiftAllowances({ tenantId: t.id, year, month }); entries += s.entries; amount += s.amount; }
      return { period: `${year}-${String(month).padStart(2, "0")}`, entries, amount };
    },
    invoices: async () => ({ markedOverdue: await svc.markOverdueInvoices() }),
    "job-changes": async () => svc.applyDueJobChanges(),
    workforce: async () => {
      let alerted = 0, ended = 0, vacated = 0;
      for (const t of tenants) { const s = await svc.runWorkforceJob(t.id); alerted += s.alerted; ended += s.ended; vacated += s.vacated; }
      return { tenants: tenants.length, contractAlerts: alerted, contractsEnded: ended, positionsVacated: vacated };
    },
    "change-requests": async () => svc.applyDueChangeRequests(),
    "scheduled-reports": async () => {
      const { runScheduledReports } = await import("../apps/web/src/lib/scheduled-reports");
      return runScheduledReports();
    },
    // Off unless a tenant's timesheet policy turns reminders or escalation on;
    // each person and week is chased once, so reruns send nothing new.
    "timesheet-reminders": async () => {
      let reminded = 0, escalated = 0;
      for (const t of tenants) { const s = await svc.runTimesheetReminders(t.id); reminded += s.reminded; escalated += s.escalated; }
      return { tenants: tenants.length, reminded, escalated };
    },
    // Debits must equal credits, and every cached balance must equal its
    // lines. A failure here is a bug to investigate, so it fails the job
    // rather than quietly repairing the numbers.
    "ledger-check": async () => {
      const bad: string[] = [];
      for (const t of tenants) {
        if ((await prisma.ledgerEntry.count({ where: { tenantId: t.id } })) === 0) continue;
        const tb = await svc.trialBalance(t.id);
        if (tb.debit !== tb.credit) bad.push(`${t.subdomain}: debits ${tb.debit} vs credits ${tb.credit}`);
        const accounts = await prisma.account.findMany({ where: { tenantId: t.id, isGroup: false } });
        for (const a of accounts) {
          const row = tb.rows.find((r) => r.id === a.id);
          const expected = (a.normalSide === "DEBIT" ? 1 : -1) * (row?.balance ?? 0);
          if (Math.abs(expected - Number(a.currentBalance)) > 0.005) bad.push(`${t.subdomain}: ${a.code} stored ${a.currentBalance}, lines ${expected}`);
        }
      }
      if (bad.length) throw new Error(bad.join("; "));
      return { tenants: tenants.length, balanced: true };
    },
    governance: async () => {
      const totals: Record<string, number> = {};
      for (const t of tenants) for (const [k, v] of Object.entries(await svc.runGovernanceJob(t.id))) totals[k] = (totals[k] ?? 0) + v;
      return { tenants: tenants.length, ...totals };
    },
    engage: async () => {
      const totals: Record<string, number> = {};
      for (const t of tenants) for (const [k, v] of Object.entries(await svc.runEngageJob(t.id))) totals[k] = (totals[k] ?? 0) + v;
      return { tenants: tenants.length, ...totals };
    },
    "cases-docs": async () => {
      const totals: Record<string, number> = {};
      for (const t of tenants) for (const [k, v] of Object.entries(await svc.runCasesDocsJob(t.id))) totals[k] = (totals[k] ?? 0) + v;
      return { tenants: tenants.length, ...totals };
    },
    "hire-alerts": async () => {
      const totals: Record<string, number> = {};
      for (const t of tenants) for (const [k, v] of Object.entries(await svc.runHireAlerts(t.id))) totals[k] = (totals[k] ?? 0) + v;
      return { tenants: tenants.length, ...totals };
    },
    "join-daily": async () => {
      const totals: Record<string, number> = {};
      for (const t of tenants) for (const [k, v] of Object.entries(await svc.runJoinDaily(t.id))) totals[k] = (totals[k] ?? 0) + v;
      return { tenants: tenants.length, ...totals };
    },
    automations: async () => {
      let escalated = 0, reminded = 0, fired = 0, failed = 0;
      for (const t of tenants) {
        const w = await svc.runWorkflowTimers(t.id); escalated += w.escalated; reminded += w.reminded;
        const e = await svc.runEventAutomations(t.id); fired += e.fired; failed += e.failed;
      }
      return { tenants: tenants.length, escalated, reminded, fired, failed };
    },
    accrue: async () => {
      const m = /^(\d{4})-(\d{2})$/.exec(arg ?? "");
      const now = new Date();
      const year = m ? Number(m[1]) : now.getUTCFullYear(), month = m ? Number(m[2]) : now.getUTCMonth() + 1;
      let credits = 0, already = 0;
      for (const t of tenants) { const s = await svc.runAccrual({ tenantId: t.id, year, month }); credits += s.credits; already += s.skippedAlreadyCredited; }
      return { period: `${year}-${String(month).padStart(2, "0")}`, credits, alreadyCredited: already };
    },
  };

  let ok = true;
  if (cmd === "nightly") {
    for (const name of ["auto-clock-out", "process-attendance", "leave-auto-approve", "shift-allowance", "job-changes", "change-requests", "workforce", "journeys", "probation", "leave-year-end", "invoices", "timesheet-reminders", "ledger-check", "scheduled-reports", "governance", "engage", "cases-docs", "hire-alerts", "join-daily", "deliver-mail"]) ok = (await record(name, jobs[name])) && ok;
    if (new Date().getUTCDate() === 1) ok = (await record("accrue", jobs.accrue)) && ok;
  } else if (cmd && jobs[cmd]) {
    ok = await record(cmd, jobs[cmd]);
  } else {
    console.error(`Usage: tsx scripts/jobs.ts <${[...Object.keys(jobs), "nightly"].join("|")}> [YYYY-MM]`);
    process.exitCode = 2;
    return;
  }
  if (!ok) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
