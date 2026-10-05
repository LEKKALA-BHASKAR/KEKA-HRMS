import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import {
  budgetVsActual, clientAllocation, utilisationBySkill, utilisationTargets, profitabilityFeed, approvalDecisionsReport, taskReport, timesheetAuditTrail,
  OPS_EXPORT_COLUMNS, timeTemplatesFor,
} from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Callout } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { OpsRequests, monthOptions, ymdOf } from "@/components/ops-ui";
import {
  saveTimeCodeAction, saveWorkPackageAction, saveTimeTemplateAction, deleteTimeTemplateAction, lockTimesheetsAction, reopenTimesheetAction,
  requestTimeCorrectionAction, certifyProjectTimeAction, requestTaskSignoffAction, allocateOvertimeAction, saveExportProfileAction,
} from "@/app/actions/ops-projects";
import { reopenPeriodAction } from "@/app/actions/ops-time-attend";

export const metadata = { title: "Project time controls" };
const ADMIN_TABS = { codes: "Activity codes", packages: "Work packages", templates: "Templates", locks: "Locks & reopen", corrections: "Corrections", certification: "Certification", signoff: "Task sign-off", reports: "Reports", overtime: "Overtime", exports: "Export profiles", audit: "Audit trail" };
const SELF_TABS = { templates: "Templates", corrections: "Corrections", signoff: "Task sign-off" };
type Tab = keyof typeof ADMIN_TABS;
const REPORTS = { budget: "Budget vs actual", clients: "Client allocation", skills: "Utilisation by skill", targets: "Utilisation targets", profit: "Profitability feed", decisions: "Approval decisions", tasks: "Tasks" };
type Rep = keyof typeof REPORTS;
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Projects › Time controls: activity codes, work packages, entry templates,
 * period locks and reopen, correction requests, project time certification,
 * task sign-off, the time reports, overtime allocation, export profiles and
 * the timesheet audit trail.
 */
export default async function ProjectTimeControlsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireViewer();
  const admin = canAny(v, [P.PROJECT_MANAGE, P.TIMESHEET_APPROVE]);
  if (!admin && !v.employee) forbidden();
  const tabs = admin ? ADMIN_TABS : SELF_TABS;
  const sp = await searchParams;
  const tab: Tab = (sp.tab ?? "") in tabs ? (sp.tab as Tab) : admin ? "codes" : "templates";
  const now = new Date();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? new Date(`${sp.from}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? new Date(`${sp.to}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rep: Rep = (sp.r ?? "") in REPORTS ? (sp.r as Rep) : "budget";
  const t = v.tenantId;
  const manage = can(v, P.PROJECT_MANAGE);
  const exportHref = tab === "reports" ? `/projects/time-controls/export?tab=reports&r=${rep}&from=${ymdOf(from)}&to=${ymdOf(to)}` : tab === "audit" ? `/projects/time-controls/export?tab=audit&from=${ymdOf(from)}&to=${ymdOf(to)}` : null;
  return (
    <>
      <PageHead title="Project time controls" subtitle="Codes, templates, locks, corrections, certification and reports" actions={exportHref && admin ? <a className="btn" href={exportHref}>Download CSV</a> : null} />
      <Tabs base="/projects/time-controls" tabs={tabs} active={tab} />
      {tab === "codes" ? <Codes tenantId={t} manage={manage} /> : null}
      {tab === "packages" ? <Packages tenantId={t} manage={manage} /> : null}
      {tab === "templates" ? <Templates tenantId={t} employeeId={v.employee?.id ?? null} manage={manage} /> : null}
      {tab === "locks" ? <Locks tenantId={t} manage={manage} /> : null}
      {tab === "corrections" ? <Corrections tenantId={t} employeeId={v.employee?.id ?? null} admin={admin} /> : null}
      {tab === "certification" ? <Certification tenantId={t} employeeId={v.employee?.id ?? null} manage={manage} /> : null}
      {tab === "signoff" ? <Signoff tenantId={t} employeeId={v.employee?.id ?? null} admin={admin} /> : null}
      {tab === "reports" ? <Reports tenantId={t} rep={rep} from={from} to={to} /> : null}
      {tab === "overtime" ? <Overtime tenantId={t} manage={manage} /> : null}
      {tab === "exports" ? <Exports tenantId={t} manage={manage} from={from} to={to} /> : null}
      {tab === "audit" ? <Audit tenantId={t} from={from} to={to} /> : null}
    </>
  );
}

const projectOptions = async (tenantId: string) => (await prisma.project.findMany({ where: { tenantId, archivedAt: null }, select: { id: true, name: true, code: true }, orderBy: { name: "asc" } })).map((p) => ({ value: p.id, label: p.code ? `${p.code} · ${p.name}` : p.name }));

async function Codes({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const codes = await prisma.opsTimeCode.findMany({ where: { tenantId }, orderBy: { code: "asc" } });
  return (
    <div className="stack gap-4">
      {manage ? <Card title="Add an activity code" description="Codes classify time (development, meetings, support…). A code can force billable or non-billable, and require a task or a comment.">
        <SpecForm action={saveTimeCodeAction} columns={3} fields={[
          { name: "code", label: "Code", required: true }, { name: "label", label: "Label", required: true },
          { name: "billable", label: "Billing", type: "select", options: [{ value: "", label: "As the project" }, { value: "yes", label: "Always billable" }, { value: "no", label: "Never billable" }] },
          { name: "requiresTask", label: "Task", type: "checkbox", placeholder: "Needs a task" }, { name: "requiresComment", label: "Comment", type: "checkbox", placeholder: "Needs a comment" },
        ]} />
      </Card> : null}
      <Card title="Activity codes" tight>
        <Table head={["Code", "Label", "Billing", "Needs task", "Needs comment", "Active", ""]} empty={codes.length === 0}>
          {codes.map((c) => <tr key={c.id}><td className="strong text-sm">{c.code}</td><td className="text-sm">{c.label}</td><td className="text-sm">{c.billable === null ? "As project" : c.billable ? "Billable" : "Non-billable"}</td><td>{c.requiresTask ? "Yes" : ""}</td><td>{c.requiresComment ? "Yes" : ""}</td><td><Pill s={c.isActive ? "ACTIVE" : "INACTIVE"} /></td>
            <td>{manage ? <ActButton action={saveTimeCodeAction} hidden={{ id: c.id, code: c.code, label: c.label, billable: c.billable === null ? "" : c.billable ? "yes" : "no", requiresTask: c.requiresTask ? "on" : "", requiresComment: c.requiresComment ? "on" : "", isActive: c.isActive ? "" : "on" }} label={c.isActive ? "Retire" : "Restore"} variant="ghost" /> : null}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Packages({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const [pkgs, projects] = await Promise.all([prisma.opsWorkPackage.findMany({ where: { tenantId }, orderBy: [{ projectId: "asc" }, { code: "asc" }] }), projectOptions(tenantId)]);
  const logged = new Map((await prisma.timeEntry.groupBy({ by: ["workPackageId"], where: { tenantId, workPackageId: { in: pkgs.map((p) => p.id) } }, _sum: { hours: true } })).map((g) => [g.workPackageId, Number(g._sum.hours ?? 0)]));
  const pn = new Map(projects.map((p) => [p.value, p.label]));
  return (
    <div className="stack gap-4">
      {manage ? <Card title="Add a work package">
        <SpecForm action={saveWorkPackageAction} columns={3} fields={[
          { name: "projectId", label: "Project", type: "select", required: true, options: projects }, { name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true },
          { name: "budgetHours", label: "Budget hours", type: "number" }, { name: "status", label: "Status", type: "select", required: true, defaultValue: "OPEN", options: [{ value: "OPEN", label: "Open" }, { value: "CLOSED", label: "Closed" }] },
        ]} />
      </Card> : null}
      <Card title="Work packages" tight>
        <Table head={["Project", "Code", "Name", "Budget (h)", "Logged (h)", "Status", ""]} empty={pkgs.length === 0}>
          {pkgs.map((w) => { const l = logged.get(w.id) ?? 0; const b = w.budgetHours === null ? null : Number(w.budgetHours); return (
            <tr key={w.id}><td className="text-sm">{pn.get(w.projectId) ?? ""}</td><td className="strong text-sm">{w.code}</td><td className="text-sm">{w.name}</td><td className="num">{b ?? "—"}</td><td className={`num${b !== null && l > b ? " neg" : ""}`}>{l}</td><td><Pill s={w.status} /></td>
              <td>{manage ? <ActButton action={saveWorkPackageAction} hidden={{ id: w.id, projectId: w.projectId, code: w.code, name: w.name, budgetHours: b === null ? "" : String(b), status: w.status === "OPEN" ? "CLOSED" : "OPEN" }} label={w.status === "OPEN" ? "Close" : "Reopen"} variant="ghost" /> : null}</td></tr>); })}
        </Table>
      </Card>
    </div>
  );
}

async function Templates({ tenantId, employeeId, manage }: { tenantId: string; employeeId: string | null; manage: boolean }) {
  const [tpls, projects] = await Promise.all([timeTemplatesFor(tenantId, employeeId), projectOptions(tenantId)]);
  const pn = new Map(projects.map((p) => [p.value, p.label]));
  const monday = (() => { const d = new Date(); const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); u.setUTCDate(u.getUTCDate() - ((u.getUTCDay() + 6) % 7)); return u; })();
  return (
    <div className="stack gap-4">
      <Callout title="Using templates">Pick a template on the weekly timesheet (Projects › My time) to fill the week in one go. Save your current week as a template here, or build one row by hand.</Callout>
      <div className="grid grid-2">
        {employeeId ? <Card title="Save a week as a template">
          <SpecForm action={saveTimeTemplateAction} columns={1} fields={[{ name: "name", label: "Template name", required: true }, { name: "week", label: "Week starting (Monday)", type: "date", required: true, defaultValue: ymdOf(monday) }, ...(manage ? [{ name: "shared", label: "Sharing", type: "checkbox" as const, placeholder: "Share with everyone" }] : [])]} />
        </Card> : null}
        {employeeId ? <Card title="Build a one-row template">
          <SpecForm action={saveTimeTemplateAction} columns={3} fields={[
            { name: "name", label: "Template name", required: true, wide: true }, { name: "projectId", label: "Project", type: "select", required: true, options: projects, wide: true },
            ...["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => ({ name: `h${i}`, label: d, type: "number" as const, defaultValue: i < 5 ? 8 : 0 })),
            { name: "note", label: "Note", wide: true },
          ]} />
        </Card> : null}
      </div>
      <Card title="Templates" tight>
        <Table head={["Name", "Shared", "Rows", "Hours", ""]} empty={tpls.length === 0}>
          {tpls.map((x) => { const rows = (Array.isArray(x.rows) ? x.rows : []) as Array<{ projectId: string; hours: number[] }>; return (
            <tr key={x.id}><td className="strong text-sm">{x.name}</td><td>{x.employeeId ? "Mine" : "Shared"}</td><td className="text-xs">{rows.map((r) => pn.get(r.projectId) ?? "").join(", ")}</td><td className="num">{rows.reduce((s, r) => s + (r.hours ?? []).reduce((a, b) => a + Number(b || 0), 0), 0)}</td>
              <td>{x.employeeId || manage ? <ActButton action={deleteTimeTemplateAction} hidden={{ id: x.id }} label="Delete" variant="ghost" confirmText="Delete this template?" /> : null}</td></tr>); })}
        </Table>
      </Card>
    </div>
  );
}

async function Locks({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const [locks, sheets] = await Promise.all([
    prisma.opsPeriodLock.findMany({ where: { tenantId, domain: "TIMESHEET" }, orderBy: { periodStart: "desc" }, take: 40 }),
    prisma.timesheet.findMany({ where: { tenantId, status: { in: ["APPROVED", "LOCKED", "SUBMITTED"] } }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { periodStart: "desc" }, take: 100 }),
  ]);
  const names = await userNames(tenantId, locks.map((l) => l.lockedBy));
  return (
    <div className="stack gap-4">
      {manage ? <Card title="Lock timesheets" description="Locks approved weeks in the period; nobody can log or change time there until it is reopened.">
        <SpecForm action={lockTimesheetsAction} columns={3} fields={[{ name: "from", label: "From", type: "date", required: true }, { name: "to", label: "To", type: "date", required: true }, { name: "reason", label: "Reason" }]} />
      </Card> : null}
      <Card title="Locked periods" tight>
        <Table head={["Period", "Status", "Locked by", "Reason", ""]} empty={locks.length === 0}>
          {locks.map((l) => <tr key={l.id}><td className="text-sm">{fmtDate(l.periodStart)} – {fmtDate(l.periodEnd)}</td><td><Pill s={l.status} /></td><td className="text-sm">{names.get(l.lockedBy) ?? ""} · {fmtDate(l.lockedAt)}</td><td className="text-xs">{l.reason ?? ""}{l.reopenReason ? ` / reopened: ${l.reopenReason}` : ""}</td>
            <td>{manage && l.status === "LOCKED" ? <ActButton action={reopenPeriodAction} hidden={{ id: l.id }} label="Unlock" input={{ name: "reason", placeholder: "Why", required: true }} /> : null}</td></tr>)}
        </Table>
      </Card>
      <Card title="Reopen a week" description="Sends an approved, locked or submitted week back to draft so the employee can change it. Invoiced time cannot be reopened." tight>
        <Table head={["Week", "Employee", "Hours", "Status", ""]} empty={sheets.length === 0}>
          {sheets.map((s) => <tr key={s.id}><td className="text-sm">{fmtDate(s.periodStart)}</td><td className="text-sm">{s.employee.displayName} ({s.employee.employeeNumber})</td><td className="num">{Number(s.totalHours)}</td><td><Pill s={s.status} /></td>
            <td><ActButton action={reopenTimesheetAction} hidden={{ timesheetId: s.id }} label="Reopen" input={{ name: "reason", placeholder: "Why reopen", required: true }} /></td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Corrections({ tenantId, employeeId, admin }: { tenantId: string; employeeId: string | null; admin: boolean }) {
  const [mine, rows] = await Promise.all([
    employeeId ? prisma.timesheet.findMany({ where: { tenantId, employeeId, status: { in: ["APPROVED", "LOCKED"] } }, orderBy: { periodStart: "desc" }, take: 20 }) : Promise.resolve([]),
    prisma.opsApprovalRequest.findMany({ where: { tenantId, kind: "OPS_TIME_CORRECTION", ...(admin ? {} : { employeeId: employeeId ?? "-" }) }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const names = await userNames(tenantId, rows.map((r) => r.requestedBy));
  return (
    <div className="stack gap-4">
      {employeeId ? <Card title="Ask to correct an approved week" description="Your manager approves; the week then reopens for you to edit and resubmit.">
        <SpecForm action={requestTimeCorrectionAction} columns={2} fields={[{ name: "timesheetId", label: "Week", type: "select", required: true, options: mine.map((s) => ({ value: s.id, label: `${fmtDate(s.periodStart)} (${Number(s.totalHours)} h, ${s.status.toLowerCase()})` })) }, { name: "reason", label: "What needs correcting", required: true }]} />
      </Card> : null}
      <Card title="Correction requests" tight><OpsRequests rows={rows} names={names} /></Card>
    </div>
  );
}

async function Certification({ tenantId, employeeId, manage }: { tenantId: string; employeeId: string | null; manage: boolean }) {
  const [projects, certs] = await Promise.all([
    prisma.project.findMany({ where: { tenantId, archivedAt: null, ...(manage ? {} : { projectManagerId: employeeId ?? "-" }) }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.opsTimeCertification.findMany({ where: { tenantId }, orderBy: { certifiedAt: "desc" }, take: 100 }),
  ]);
  const pn = new Map((await prisma.project.findMany({ where: { tenantId, id: { in: certs.map((c) => c.projectId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const names = await userNames(tenantId, certs.map((c) => c.certifiedBy));
  return (
    <div className="stack gap-4">
      <Card title="Certify a project's time" description="The project manager confirms the approved hours for a period are complete and correct; the PMO approves.">
        <SpecForm action={certifyProjectTimeAction} columns={3} fields={[
          { name: "projectId", label: "Project", type: "select", required: true, options: projects.map((p) => ({ value: p.id, label: p.name })) },
          { name: "from", label: "From", type: "date", required: true }, { name: "to", label: "To", type: "date", required: true },
          { name: "statement", label: "Statement", required: true, wide: true, defaultValue: "I certify the hours recorded on this project for the period are complete and accurate." },
        ]} />
      </Card>
      <Card title="Certifications" tight>
        <Table head={["Project", "Period", "Hours", "Statement", "Status", "By"]} empty={certs.length === 0}>
          {certs.map((c) => <tr key={c.id}><td className="text-sm">{c.projectId ? pn.get(c.projectId) ?? "" : c.scope}</td><td className="text-sm nowrap">{fmtDate(c.periodStart)} – {fmtDate(c.periodEnd)}</td><td className="num">{Number(c.hours)}</td><td className="text-xs">{c.statement}</td><td><Pill s={c.status} /></td><td className="text-sm">{names.get(c.certifiedBy) ?? ""} · {fmtDate(c.certifiedAt)}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Signoff({ tenantId, employeeId, admin }: { tenantId: string; employeeId: string | null; admin: boolean }) {
  const [tasks, rows] = await Promise.all([
    prisma.task.findMany({ where: { tenantId, status: { not: "DONE" }, ...(admin ? {} : { assigneeId: employeeId ?? "-" }) }, include: { project: { select: { name: true } } }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.opsApprovalRequest.findMany({ where: { tenantId, kind: "OPS_TASK_SIGNOFF" }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const names = await userNames(tenantId, rows.map((r) => r.requestedBy));
  return (
    <div className="stack gap-4">
      <Card title="Ask for sign-off" description="The project manager signs the task off; approval marks it done.">
        <SpecForm action={requestTaskSignoffAction} columns={2} fields={[{ name: "taskId", label: "Task", type: "select", required: true, options: tasks.map((x) => ({ value: x.id, label: `${x.project.name}: ${x.title}` })) }, { name: "note", label: "Note" }]} />
      </Card>
      <Card title="Sign-off requests" tight><OpsRequests rows={rows} names={names} /></Card>
    </div>
  );
}

async function Reports({ tenantId, rep, from, to }: { tenantId: string; rep: Rep; from: Date; to: Date }) {
  const range = (
    <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
      <input type="hidden" name="tab" value="reports" /><input type="hidden" name="r" value={rep} />
      <input className="input" type="date" name="from" defaultValue={ymdOf(from)} style={{ width: 160 }} /><input className="input" type="date" name="to" defaultValue={ymdOf(to)} style={{ width: 160 }} />
      <button className="btn sm" type="submit">Show</button>
    </form>
  );
  const nav = <div className="tabs">{Object.entries(REPORTS).map(([k, l]) => <a key={k} className={`tab${k === rep ? " active" : ""}`} href={`/projects/time-controls?tab=reports&r=${k}&from=${ymdOf(from)}&to=${ymdOf(to)}`}>{l}</a>)}</div>;
  let body: React.ReactNode = null;
  if (rep === "budget") {
    const rows = await budgetVsActual(tenantId);
    body = <Table head={["Project", "Client", "Budget (h)", "Actual (h)", "Burn %", "Elapsed %", "Variance %", "Over-run tasks", "Alert"]} empty={rows.length === 0}>
      {rows.map((r) => <tr key={r.id}><td className="text-sm">{r.name}</td><td className="text-sm">{r.client}</td><td className="num">{r.budget ?? "—"}</td><td className="num">{r.actual}</td><td className="num">{r.burnPct ?? "—"}</td><td className="num">{r.elapsedPct ?? "—"}</td><td className="num">{r.variancePct ?? "—"}</td><td className="num">{r.tasks.filter((x) => x.over).length}</td><td>{r.alert ? <Pill s="OVER" /> : null}</td></tr>)}
    </Table>;
  } else if (rep === "clients") {
    const rows = await clientAllocation(tenantId, from, to);
    body = <Table head={["Client", "Hours", "Billable", "Share %", "Top people"]} empty={rows.length === 0}>
      {rows.map((r) => <tr key={r.clientId}><td className="text-sm">{r.client}</td><td className="num">{r.total}</td><td className="num">{r.billable}</td><td className="num">{r.share}</td><td className="text-xs">{r.people.slice(0, 4).map((p) => `${p.employee} ${p.hours}h`).join(", ")}</td></tr>)}
    </Table>;
  } else if (rep === "skills") {
    const rows = await utilisationBySkill(tenantId, from, to);
    body = <Table head={["Skill", "People", "Logged", "Billable", "Capacity", "Billable %", "Logged %"]} empty={rows.length === 0}>
      {rows.map((r) => <tr key={r.skill}><td className="text-sm">{r.skill}</td><td className="num">{r.people}</td><td className="num">{r.logged}</td><td className="num">{r.billable}</td><td className="num">{r.capacity}</td><td className="num">{r.billablePct}</td><td className="num">{r.loggedPct}</td></tr>)}
    </Table>;
  } else if (rep === "targets") {
    const rows = await utilisationTargets(tenantId, from, to);
    body = <Table head={["Employee", "Target %", "Capacity", "Logged", "Billable", "Billable %", "Gap", "On target"]} empty={rows.length === 0}>
      {rows.map((r) => <tr key={r.employeeId}><td className="text-sm">{r.employee} ({r.employeeNumber})</td><td className="num">{r.target ?? "—"}</td><td className="num">{r.capacity}</td><td className="num">{r.logged}</td><td className="num">{r.billable}</td><td className="num">{r.billablePct}</td><td className={`num${(r.gap ?? 0) < 0 ? " neg" : ""}`}>{r.gap ?? "—"}</td><td>{r.onTarget === null ? "" : <Pill s={r.onTarget ? "YES" : "NO"} />}</td></tr>)}
    </Table>;
  } else if (rep === "profit") {
    const rows = await profitabilityFeed(tenantId, from, to);
    body = <Table head={["Project", "Client", "Hours", "Billable h", "Revenue", "Labour", "Overtime", "Margin", "Margin %"]} empty={rows.length === 0}>
      {rows.map((r) => <tr key={r.projectId}><td className="text-sm">{r.project}</td><td className="text-sm">{r.client}</td><td className="num">{r.hours}</td><td className="num">{r.billableHours}</td><td className="num">{inr(r.revenue)}</td><td className="num">{inr(r.labourCost)}</td><td className="num">{inr(r.overtimeCost)}</td><td className={`num${r.margin < 0 ? " neg" : ""}`}>{inr(r.margin)}</td><td className="num">{r.marginPct ?? "—"}</td></tr>)}
    </Table>;
  } else if (rep === "decisions") {
    const d = await approvalDecisionsReport(tenantId, from, to);
    body = <div className="stack gap-4">
      <Table head={["Approver", "Approved", "Rejected", "Avg turnaround (h)"]} empty={d.approvers.length === 0}>{d.approvers.map((a) => <tr key={a.by}><td className="text-sm">{a.by}</td><td className="num">{a.approved}</td><td className="num">{a.rejected}</td><td className="num">{a.avgTurnaroundHours ?? "—"}</td></tr>)}</Table>
      <Table head={["Week", "Employee", "Hours", "Decision", "By", "When", "Turnaround (h)", "Reason"]} empty={d.rows.length === 0}>{d.rows.map((r) => <tr key={r.id}><td className="text-sm">{fmtDate(r.week)}</td><td className="text-sm">{r.employee}</td><td className="num">{r.hours}</td><td><Pill s={r.decision} /></td><td className="text-sm">{r.by}</td><td className="text-sm">{fmtWhen(r.decidedAt)}</td><td className="num">{r.turnaroundHours ?? "—"}</td><td className="text-xs">{r.reason ?? ""}</td></tr>)}</Table>
    </div>;
  } else {
    const rows = await taskReport(tenantId);
    body = <Table head={["Project", "Task", "Assignee", "Status", "Estimate", "Logged", "Variance", "Sign-off", "Due"]} empty={rows.length === 0}>
      {rows.map((r) => <tr key={r.id}><td className="text-sm">{r.project}</td><td className="text-sm">{r.title}</td><td className="text-sm">{r.assignee}</td><td><Pill s={r.status} /></td><td className="num">{r.estimated ?? "—"}</td><td className="num">{r.logged}</td><td className={`num${(r.variance ?? 0) > 0 ? " neg" : ""}`}>{r.variance ?? "—"}</td><td>{r.signoff ? <Pill s={r.signoff} /> : null}</td><td className="text-sm">{fmtDate(r.dueDate)}</td></tr>)}
    </Table>;
  }
  return <div className="stack gap-4">{nav}{["budget", "tasks"].includes(rep) ? null : range}<Card title={REPORTS[rep]} tight>{body}</Card></div>;
}

async function Overtime({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const rows = await prisma.opsProjectOvertimeAllocation.findMany({ where: { tenantId }, orderBy: [{ date: "desc" }], take: 300 });
  const pn = new Map((await prisma.project.findMany({ where: { tenantId, id: { in: [...new Set(rows.map((r) => r.projectId))] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const en = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  const now = new Date();
  return (
    <div className="stack gap-4">
      {manage ? <Card title="Allocate overtime to projects" description="Shares each person's approved overtime for the month among the projects they logged time to, in proportion to the hours. Feeds project cost and profitability.">
        <SpecForm action={allocateOvertimeAction} columns={2} submitLabel="Allocate" fields={[{ name: "year", label: "Year", type: "number", required: true, defaultValue: now.getUTCFullYear() }, { name: "month", label: "Month", type: "select", required: true, options: monthOptions(), defaultValue: String(now.getUTCMonth() + 1) }]} />
      </Card> : null}
      <Card title="Allocations" tight>
        <Table head={["Month", "Employee", "Project", "Hours", "Cost"]} empty={rows.length === 0}>
          {rows.map((r) => <tr key={r.id}><td className="text-sm">{ymdOf(r.date).slice(0, 7)}</td><td className="text-sm">{en.get(r.employeeId) ?? ""}</td><td className="text-sm">{pn.get(r.projectId) ?? ""}</td><td className="num">{Number(r.hours)}</td><td className="num">{inr(Number(r.amount))}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Exports({ tenantId, manage, from, to }: { tenantId: string; manage: boolean; from: Date; to: Date }) {
  const [profiles, clients, projects] = await Promise.all([
    prisma.opsExportProfile.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.client.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    projectOptions(tenantId),
  ]);
  return (
    <div className="stack gap-4">
      {manage ? <Card title="Save an export profile" description="Choose columns and filters once; download the time for any period in that layout.">
        <SpecForm action={saveExportProfileAction} columns={3} fields={[
          { name: "name", label: "Name", required: true }, { name: "clientId", label: "Client", type: "select", options: clients.map((c) => ({ value: c.id, label: c.name })), placeholder: "All clients" },
          { name: "projectId", label: "Project", type: "select", options: projects, placeholder: "All projects" },
          { name: "billableOnly", label: "Billable", type: "checkbox", placeholder: "Billable time only" }, { name: "approvedOnly", label: "Approved", type: "checkbox", defaultValue: true, placeholder: "Approved weeks only" },
          { name: "columns", label: "Columns", type: "multiselect", wide: true, options: Object.entries(OPS_EXPORT_COLUMNS).map(([value, label]) => ({ value, label })), defaultValue: ["date", "employee", "project", "hours", "billable"] },
        ]} />
      </Card> : null}
      <Card title="Profiles" tight>
        <Table head={["Name", "Columns", "Filters", ""]} empty={profiles.length === 0}>
          {profiles.map((p) => <tr key={p.id}><td className="strong text-sm">{p.name}</td><td className="text-xs">{p.columns.map((c) => OPS_EXPORT_COLUMNS[c] ?? c).join(", ")}</td><td className="text-xs">{[p.billableOnly ? "billable" : null, p.approvedOnly ? "approved" : null, p.clientId ? "one client" : null, p.projectId ? "one project" : null].filter(Boolean).join(", ")}</td>
            <td><a className="btn sm" href={`/projects/time-controls/export?tab=profile&id=${p.id}&from=${ymdOf(from)}&to=${ymdOf(to)}`}>Download {ymdOf(from)} – {ymdOf(to)}</a></td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Audit({ tenantId, from, to }: { tenantId: string; from: Date; to: Date }) {
  const rows = await timesheetAuditTrail(tenantId, from, to);
  return (
    <div className="stack gap-4">
      <form method="get" className="row gap-2 wrap"><input type="hidden" name="tab" value="audit" /><input className="input" type="date" name="from" defaultValue={ymdOf(from)} style={{ width: 160 }} /><input className="input" type="date" name="to" defaultValue={ymdOf(to)} style={{ width: 160 }} /><button className="btn sm" type="submit">Show</button></form>
      <Card title="Timesheet audit trail" tight>
        <Table head={["When", "Who", "Action", "Record", "Summary"]} empty={rows.length === 0}>
          {rows.map((r) => <tr key={r.id}><td className="text-sm nowrap">{fmtWhen(r.createdAt)}</td><td className="text-sm">{r.actorLabel ?? ""}</td><td><Pill s={r.action} /></td><td className="text-xs">{r.entityType}</td><td className="text-xs">{r.summary}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}
