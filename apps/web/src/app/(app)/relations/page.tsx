import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { erVisibleWhere, erDashboard, activeSuspensions, getErSettings, erRef, ER_KINDS, ER_CATEGORIES, ER_SEVERITIES, ER_STATUSES, ER_OUTCOMES, ER_ACTION_TYPES } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { userOptions, employeeOptions, fmtDate } from "@/lib/governance";
import { PageHead, Card, Stat, Callout } from "@/components/ui";
import { Pill, Tabs, SearchBar, Table } from "@/components/gov-ui";
import { SpecForm } from "@/components/gov-forms";
import { createErCaseAction, saveErSettingsAction, saveErTemplateAction } from "@/app/actions/relations";

export const metadata = { title: "Employee Relations" };

const TABS = { cases: "Cases", new: "Log a case", actions: "Actions & appeals", reports: "Reports", settings: "Settings" };
type Tab = keyof typeof TABS;
const opts = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({ value, label }));

/**
 * Org › Employee Relations: grievances, complaints and disciplinary cases.
 * Lists only the cases the viewer may see (confidential cases need the
 * approve right or a place on the case's access list; the subject of a case
 * never sees it).
 */
export default async function RelationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [PERMISSIONS.ER_CASE_MANAGE, PERMISSIONS.ER_CASE_APPROVE])) forbidden();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "cases";
  const v = { tenantId: viewer.tenantId, userId: viewer.user.id, employeeId: viewer.employee?.id ?? null, canManage: can(viewer, PERMISSIONS.ER_CASE_MANAGE), canApprove: can(viewer, PERMISSIONS.ER_CASE_APPROVE) };
  const visible = await erVisibleWhere(v);
  return (
    <>
      <PageHead title="Employee Relations" subtitle="Grievances, complaints and disciplinary cases — confidential by default"
        actions={<><Link className="btn" href={`/relations/export?${new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => !!e[1])).toString()}`}>Export CSV</Link>{v.canManage ? <Link className="btn primary" href="/relations?tab=new">Log a case</Link> : null}</>} />
      <Tabs base="/relations" tabs={TABS} active={tab} />
      {tab === "cases" ? <Cases where={visible} sp={sp} /> : null}
      {tab === "new" ? (v.canManage ? <NewCase tenantId={viewer.tenantId} /> : <Callout tone="warning">Logging cases needs the employee relations manage right.</Callout>) : null}
      {tab === "actions" ? <Actions where={visible} /> : null}
      {tab === "reports" ? <Reports where={visible} tenantId={viewer.tenantId} /> : null}
      {tab === "settings" ? <Settings tenantId={viewer.tenantId} canApprove={v.canApprove} canManage={v.canManage} /> : null}
    </>
  );
}

async function Cases({ where, sp }: { where: Prisma.ErCaseWhereInput; sp: Record<string, string | undefined> }) {
  const q = sp.q?.trim();
  const num = q ? Number(q.replace(/^ER-/i, "")) : NaN;
  const filter: Prisma.ErCaseWhereInput = {
    AND: [
      where,
      sp.kind ? { kind: sp.kind } : {},
      sp.status ? { status: sp.status } : { status: { not: "CLOSED" } },
      sp.severity ? { severity: sp.severity } : {},
      q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }, ...(Number.isInteger(num) ? [{ number: num }] : [])] } : {},
    ],
  };
  const rows = await prisma.erCase.findMany({ where: filter, orderBy: { createdAt: "desc" }, take: 200 });
  const people = new Map((await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.subjectEmployeeId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  return (
    <Card title={`Cases (${rows.length})`} description="Closed cases are hidden unless you filter by status.">
      <SearchBar action="/relations" tab="cases" q={q}>
        <select className="select" name="kind" defaultValue={sp.kind ?? ""}><option value="">Any kind</option>{opts(ER_KINDS).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        <select className="select" name="status" defaultValue={sp.status ?? ""}><option value="">Open</option>{opts(ER_STATUSES).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        <select className="select" name="severity" defaultValue={sp.severity ?? ""}><option value="">Any severity</option>{opts(ER_SEVERITIES).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      </SearchBar>
      <Table head={["Case", "Kind", "Category", "About", "Severity", "Status", "Opened"]} empty={!rows.length}>
        {rows.map((r) => (
          <tr key={r.id}>
            <td><Link href={`/relations/${r.id}`}><strong>{erRef(r.number)}</strong> {r.title}</Link>{r.isAnonymous ? <span className="badge neutral" style={{ marginLeft: 6 }}>anonymous</span> : null}{r.isConfidential ? <span className="badge danger" style={{ marginLeft: 6 }}>confidential</span> : null}</td>
            <td>{ER_KINDS[r.kind as keyof typeof ER_KINDS] ?? r.kind}</td>
            <td className="text-sm">{ER_CATEGORIES[r.category as keyof typeof ER_CATEGORIES] ?? r.category}</td>
            <td className="text-sm">{r.subjectEmployeeId ? people.get(r.subjectEmployeeId) ?? "—" : "—"}</td>
            <td><Pill s={r.severity} /></td>
            <td><Pill s={r.status} /></td>
            <td className="text-sm">{fmtDate(r.createdAt)}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function NewCase({ tenantId }: { tenantId: string }) {
  const [emps, users, templates, policies] = await Promise.all([
    employeeOptions(tenantId), userOptions(tenantId),
    prisma.erCaseTemplate.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.orgDocument.findMany({ where: { tenantId }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: 200 }),
  ]);
  return (
    <Card title="Log a case" description="For a grievance received in person or by email, a complaint, or a disciplinary matter. The case is confidential unless you untick it.">
      <SpecForm action={createErCaseAction} submitLabel="Create case" fields={[
        { name: "templateId", label: "Start from a template", type: "select", options: templates.map((t) => ({ value: t.id, label: `${t.name} (${ER_KINDS[t.kind as keyof typeof ER_KINDS]})` })), hint: "Fills the kind, category, severity and investigation checklist." },
        { name: "kind", label: "Kind", type: "select", options: opts(ER_KINDS) },
        { name: "category", label: "Category", type: "select", options: opts(ER_CATEGORIES) },
        { name: "severity", label: "Severity", type: "select", options: opts(ER_SEVERITIES), defaultValue: "MEDIUM" },
        { name: "title", label: "Title", required: true, wide: true },
        { name: "description", label: "What happened", type: "textarea", wide: true },
        { name: "subjectEmployeeId", label: "Employee the case is about", type: "select", options: emps, hint: "Required for disciplinary cases. They never see the case." },
        { name: "reporterEmployeeId", label: "Raised by", type: "select", options: emps },
        { name: "incidentDate", label: "Incident date", type: "date" },
        { name: "incidentLocation", label: "Where" },
        { name: "ownerUserId", label: "Case owner", type: "select", options: users, hint: "Defaults to you." },
        { name: "policyDocumentId", label: "Policy it falls under", type: "select", options: policies.map((p) => ({ value: p.id, label: p.title })) },
        { name: "confidential", label: "Confidential", type: "checkbox", defaultValue: true, placeholder: "Only the access list and ER approvers can open it" },
      ]} />
    </Card>
  );
}

async function Actions({ where }: { where: Prisma.ErCaseWhereInput }) {
  const [actions, appeals] = await Promise.all([
    prisma.erAction.findMany({ where: { case: where }, include: { case: { select: { id: true, number: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.erAppeal.findMany({ where: { case: where, status: { in: ["FILED", "UNDER_REVIEW"] } }, include: { case: { select: { id: true, number: true } }, action: true }, orderBy: { filedAt: "asc" } }),
  ]);
  const people = new Map((await prisma.employee.findMany({ where: { id: { in: [...actions.map((a) => a.employeeId), ...appeals.map((a) => a.filedByEmployeeId)] } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  return (
    <div className="stack gap-4">
      <Card title={`Open appeals (${appeals.length})`}>
        <Table head={["Case", "Employee", "Against", "Filed", "Status"]} empty={!appeals.length}>
          {appeals.map((a) => <tr key={a.id}><td><Link href={`/relations/${a.case.id}`}>{erRef(a.case.number)}</Link></td><td>{people.get(a.filedByEmployeeId)}</td><td>{a.action ? ER_ACTION_TYPES[a.action.actionType as keyof typeof ER_ACTION_TYPES] : "—"}</td><td>{fmtDate(a.filedAt)}</td><td><Pill s={a.status} /></td></tr>)}
        </Table>
      </Card>
      <Card title="Disciplinary actions">
        <Table head={["Case", "Employee", "Action", "Effective", "Valid until", "Status", "Acknowledged"]} empty={!actions.length}>
          {actions.map((a) => <tr key={a.id}><td><Link href={`/relations/${a.case.id}`}>{erRef(a.case.number)}</Link></td><td>{people.get(a.employeeId)}</td><td>{ER_ACTION_TYPES[a.actionType as keyof typeof ER_ACTION_TYPES]}</td><td>{fmtDate(a.effectiveOn)}</td><td>{fmtDate(a.expiresOn)}</td><td><Pill s={a.status} /></td><td>{fmtDate(a.acknowledgedAt)}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Reports({ where, tenantId }: { where: Prisma.ErCaseWhereInput; tenantId: string }) {
  const [d, susp] = await Promise.all([erDashboard(where), activeSuspensions(tenantId)]);
  const people = new Map((await prisma.employee.findMany({ where: { id: { in: susp.map((s) => s.employeeId) } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  const list = (m: Map<string, number>, labels: Record<string, string>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => <tr key={k}><td>{labels[k] ?? k}</td><td className="num">{n}</td></tr>);
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Cases you can see" value={d.total} />
        <Stat label="Open" value={d.open} />
        <Stat label="High / critical open" value={d.critical} tone={d.critical ? "neg" : undefined} />
        <Stat label="Average days to resolve" value={d.avgDaysToResolve ?? "—"} />
      </div>
      <div className="grid grid-3">
        <Card title="By kind"><Table head={["Kind", "Cases"]} empty={!d.byKind.size}>{list(d.byKind, ER_KINDS)}</Table></Card>
        <Card title="By category"><Table head={["Category", "Cases"]} empty={!d.byCategory.size}>{list(d.byCategory, ER_CATEGORIES)}</Table></Card>
        <Card title="Outcomes"><Table head={["Outcome", "Cases"]} empty={!d.byOutcome.size}>{list(d.byOutcome, ER_OUTCOMES)}</Table></Card>
      </div>
      <Card title="New cases, last six months">
        <Table head={["Month", "Grievances", "Complaints", "Disciplinary"]}>
          {d.trend.map((t) => <tr key={t.month}><td>{t.month}</td><td className="num">{t.GRIEVANCE}</td><td className="num">{t.COMPLAINT}</td><td className="num">{t.DISCIPLINARY}</td></tr>)}
        </Table>
      </Card>
      <Card title={`Suspended today (${susp.length})`}>
        <Table head={["Employee", "Case", "From", "To", "Paid"]} empty={!susp.length}>
          {susp.map((s) => <tr key={s.id}><td>{people.get(s.employeeId)}</td><td><Link href={`/relations/${s.case.id}`}>{erRef(s.case.number)}</Link></td><td>{fmtDate(s.suspensionFrom)}</td><td>{fmtDate(s.suspensionTo)}</td><td>{s.suspensionPaid ? "Yes" : "No"}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Settings({ tenantId, canApprove, canManage }: { tenantId: string; canApprove: boolean; canManage: boolean }) {
  const [s, templates, letters] = await Promise.all([
    getErSettings(tenantId),
    prisma.erCaseTemplate.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.documentTemplate.findMany({ where: { tenantId, isArchived: false }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <div className="stack gap-4">
      <Card title="Policy settings" description="Approvals for findings, actions and resolutions run through Org › Workflows (built-in: holders of the employee relations approve right).">
        {canApprove ? (
          <SpecForm action={saveErSettingsAction} columns={3} fields={[
            { name: "allowAnonymous", label: "Anonymous reporting", type: "checkbox", defaultValue: s.allowAnonymous, placeholder: "Employees may report without their name" },
            { name: "appealWindowDays", label: "Appeal window (days)", type: "number", defaultValue: s.appealWindowDays },
            { name: "showCauseDays", label: "Show-cause response time (days)", type: "number", defaultValue: s.showCauseDays },
            { name: "warningValidityMonths", label: "Warnings stay active (months)", type: "number", defaultValue: s.warningValidityMonths },
            { name: "retentionMonths", label: "Keep closed cases for (months)", type: "number", defaultValue: s.retentionMonths, hint: "Purged after this by the ER cases retention rule (Org › Compliance › Retention), unless on legal hold." },
          ]} />
        ) : <Callout>Only employee relations approvers change these settings.</Callout>}
      </Card>
      <Card title="Case templates" description="Starting points for common cases: kind, category, severity, an investigation checklist and the notice letter to issue.">
        <Table head={["Name", "Kind", "Category", "Checklist", "Active"]} empty={!templates.length}>
          {templates.map((t) => <tr key={t.id}><td>{t.name}</td><td>{ER_KINDS[t.kind as keyof typeof ER_KINDS]}</td><td>{ER_CATEGORIES[t.category as keyof typeof ER_CATEGORIES]}</td><td className="num">{Array.isArray(t.checklist) ? t.checklist.length : 0}</td><td>{t.isActive ? "Yes" : "No"}</td></tr>)}
        </Table>
        {canManage ? (
          <div style={{ marginTop: 12 }}>
            <SpecForm action={saveErTemplateAction} submitLabel="Add template" fields={[
              { name: "name", label: "Name", required: true },
              { name: "kind", label: "Kind", type: "select", options: opts(ER_KINDS), required: true },
              { name: "category", label: "Category", type: "select", options: opts(ER_CATEGORIES), required: true },
              { name: "severity", label: "Severity", type: "select", options: opts(ER_SEVERITIES), defaultValue: "MEDIUM" },
              { name: "letterTemplateId", label: "Notice letter", type: "select", options: letters.map((l) => ({ value: l.id, label: l.name })) },
              { name: "description", label: "Description", type: "textarea" },
              { name: "checklist", label: "Investigation checklist (one step per line)", type: "textarea", wide: true },
            ]} />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
