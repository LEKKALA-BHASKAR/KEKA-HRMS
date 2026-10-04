import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { planMassUpdate, checklistProgress, CORRECTABLE_FIELDS, MASS_UPDATE_KINDS, MASS_STATUSES, CHECKLIST_OWNERS, type MassUpdateKind } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere, scopedEmployeeIds } from "@/lib/scope";
import { massUpdateCandidates, massCurrentOf, massValueLabel } from "@/lib/core-hr";
import { PageHead, Card, Badge, Empty, Callout, Progress } from "@/components/ui";
import { SpecForm, SpecDisclosure, ActionButton, DecideForm, type FieldSpec } from "@/components/spec-form";
import {
  applyMassUpdateAction, rollbackMassUpdateAction, saveChecklistTemplateAction, assignChecklistAction, toggleChecklistItemAction, signOffChecklistAction,
} from "@/app/actions/hr-ops";
import { saveDocumentRequestTypeAction, decideDocumentRequestAction, requestDataCorrectionAction } from "@/app/actions/self-service-depth";

export const metadata = { title: "HR operations — BooS-HR" };

const P = PERMISSIONS;
const TABS = { mass: "Mass update", checklists: "HR checklists", documents: "Letter requests", corrections: "Data corrections", searches: "People searches" } as const;
type Tab = keyof typeof TABS;
type SP = { tab?: string; kind?: string; value?: string; departmentId?: string; locationId?: string; status?: string; numbers?: string; employeeId?: string | string[] };

/**
 * HR operations: change many records at once (with a preview first, a
 * per-person trail and rollback), run HR checklists that a second person
 * signs off, issue letters employees asked for, fix wrong data, and see what
 * people search the directory for.
 */
export default async function HrOpsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const allowed: Record<Tab, boolean> = {
    mass: can(viewer, P.EMPLOYEE_UPDATE), checklists: can(viewer, P.EMPLOYEE_UPDATE), documents: can(viewer, P.LETTER_GENERATE),
    corrections: can(viewer, P.EMPLOYEE_UPDATE), searches: can(viewer, P.ORG_SETTINGS_MANAGE),
  };
  const tabs = (Object.keys(TABS) as Tab[]).filter((k) => allowed[k]);
  if (!tabs.length) forbidden();
  const tab: Tab = tabs.includes(sp.tab as Tab) ? (sp.tab as Tab) : tabs[0]!;
  return (
    <>
      <PageHead title="HR operations" subtitle="Bulk changes, checklists, letters on request and data fixes" />
      <div className="tabs">
        {tabs.map((k) => <Link key={k} href={`/hr-ops?tab=${k}`} className={`tab${tab === k ? " active" : ""}`}>{TABS[k]}</Link>)}
      </div>
      {tab === "mass" ? <Mass sp={sp} /> : null}
      {tab === "checklists" ? <Checklists /> : null}
      {tab === "documents" ? <Documents /> : null}
      {tab === "corrections" ? <Corrections /> : null}
      {tab === "searches" ? <Searches /> : null}
    </>
  );
}

async function Mass({ sp }: { sp: SP }) {
  const viewer = await requireViewer();
  const t = viewer.tenantId;
  const kind = (sp.kind && sp.kind in MASS_UPDATE_KINDS ? sp.kind : "STATUS") as MassUpdateKind;
  const [depts, locs, types, people, batches] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.workerType.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, P.EMPLOYEE_UPDATE), { status: { notIn: ["EXITED"] } }] }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" } }),
    prisma.massUpdateBatch.findMany({ where: { tenantId: t }, orderBy: { createdAt: "desc" }, take: 20, include: { items: { select: { status: true } } } }),
  ]);
  const valueOptions = kind === "STATUS" ? MASS_STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))
    : kind === "MANAGER" ? people.map((p) => ({ value: p.id, label: `${p.displayName} (${p.employeeNumber})` }))
    : kind === "LOCATION" ? locs.map((l) => ({ value: l.id, label: l.name }))
    : kind === "DEPARTMENT" ? depts.map((d) => ({ value: d.id, label: d.name }))
    : types.map((w) => ({ value: w.id, label: w.name }));
  const picked = Array.isArray(sp.employeeId) ? sp.employeeId : sp.employeeId ? [sp.employeeId] : [];
  const hasSelection = !!(picked.length || sp.departmentId || sp.locationId || (sp.numbers ?? "").trim());
  const label = sp.value ? await massValueLabel(t, kind, sp.value) : null;
  const candidates = hasSelection && label ? await massUpdateCandidates(viewer, { employeeIds: picked, departmentId: sp.departmentId, locationId: sp.locationId, status: sp.status, numbers: sp.numbers }) : [];
  const plan = candidates.length ? planMassUpdate(kind, sp.value!, candidates.map((p) => ({ id: p.id, label: `${p.displayName ?? p.firstName} (${p.employeeNumber})`, status: p.status, current: massCurrentOf(kind, p) }))) : [];
  const nameOf = new Map<string, string>([...people.map((p) => [p.id, p.displayName ?? ""] as [string, string]), ...depts.map((d) => [d.id, d.name] as [string, string]), ...locs.map((l) => [l.id, l.name] as [string, string]), ...types.map((w) => [w.id, w.name] as [string, string])]);
  const show = (v: string | null) => (v ? nameOf.get(v) ?? v : "—");
  const numbers = [...new Set([...(sp.numbers ?? "").split(/[\s,;]+/).filter(Boolean), ...candidates.filter((c) => picked.includes(c.id)).map((c) => c.employeeNumber)])].join(", ");
  const toApply = plan.filter((p) => p.action === "APPLY").length;

  return (
    <div className="stack gap-4">
      <Card title="1. Choose the change and who it reaches" description="Pick people, paste employee numbers, or take a whole department or location. Only people you look after are included.">
        <form method="get" className="stack gap-3">
          <input type="hidden" name="tab" value="mass" />
          <div className="grid grid-3">
            <label className="field"><span className="label">Change</span>
              <select className="select" name="kind" defaultValue={kind}>{(Object.keys(MASS_UPDATE_KINDS) as MassUpdateKind[]).map((k) => <option key={k} value={k}>{MASS_UPDATE_KINDS[k]}</option>)}</select></label>
            <label className="field"><span className="label">New value</span>
              <select className="select" name="value" defaultValue={sp.value ?? ""}><option value="">Choose…</option>{valueOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
            <label className="field"><span className="label">Only people now</span>
              <select className="select" name="status" defaultValue={sp.status ?? ""}><option value="">In any status</option>{["PROBATION", "CONFIRMED", "NOTICE_PERIOD", "INACTIVE"].map((s) => <option key={s} value={s}>{s.toLowerCase().replace("_", " ")}</option>)}</select></label>
            <label className="field"><span className="label">Everyone in department</span>
              <select className="select" name="departmentId" defaultValue={sp.departmentId ?? ""}><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            <label className="field"><span className="label">Everyone at location</span>
              <select className="select" name="locationId" defaultValue={sp.locationId ?? ""}><option value="">—</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
            <label className="field"><span className="label">Employee numbers</span>
              <input className="input" name="numbers" defaultValue={sp.numbers ?? ""} placeholder="E001, E002" /></label>
          </div>
          <label className="field"><span className="label">…or pick people</span>
            <select className="select" name="employeeId" multiple defaultValue={picked} style={{ minHeight: 110 }}>{people.map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.employeeNumber})</option>)}</select></label>
          <div><button className="btn primary" type="submit">Preview</button> <span className="text-xs muted">Change the &ldquo;Change&rdquo; and press Preview to see its values.</span></div>
        </form>
      </Card>

      {hasSelection && sp.value ? (
        <Card title={`2. Preview — ${MASS_UPDATE_KINDS[kind]} → ${label ?? "?"}`} description={`${toApply} will change, ${plan.length - toApply} skipped. Nothing has changed yet.`} tight>
          {!label ? <Empty title="That value is not in this company" /> : plan.length === 0 ? <Empty title="No one in your scope matches" /> : (
            <>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Employee</th><th>Now</th><th>Becomes</th><th /></tr></thead>
                <tbody>{plan.map((r) => <tr key={r.employeeId}><td>{r.label}</td><td>{show(r.current)}</td><td>{r.action === "APPLY" ? <strong>{label}</strong> : "—"}</td><td>{r.action === "SKIP" ? <Badge>{r.reason ?? "Skipped"}</Badge> : <Badge tone="brand">Will change</Badge>}</td></tr>)}</tbody>
              </table></div>
              {toApply ? (
                <div style={{ padding: 14 }}>
                  <SpecForm action={applyMassUpdateAction} submitLabel={`Apply to ${toApply}`}
                    hidden={{ kind, value: sp.value, departmentId: sp.departmentId ?? "", locationId: sp.locationId ?? "", status: sp.status ?? "", numbers }}
                    fields={[
                      { name: "effectiveFrom", label: "Effective from", kind: "date", hint: kind === "STATUS" ? "Used as the confirmation date when confirming." : "A future date schedules it; job changes keep their approval chain." },
                      { name: "note", label: "Note (kept on each record's history)" },
                      { name: "confirm", label: `Yes, change ${toApply} record(s)`, kind: "checkbox", wide: true },
                    ]} />
                </div>
              ) : null}
            </>
          )}
        </Card>
      ) : null}

      <Card title="Past mass updates" tight action={<Link className="btn sm" href="/exports/core-hr/mass-updates">Export CSV</Link>}>
        {batches.length === 0 ? <Empty title="None yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>When</th><th>Change</th><th className="num">Applied</th><th className="num">Awaiting approval</th><th className="num">Skipped</th><th>Status</th><th /></tr></thead>
            <tbody>{batches.map((b) => (
              <tr key={b.id}><td>{formatDate(b.createdAt)}</td><td>{MASS_UPDATE_KINDS[b.kind as MassUpdateKind] ?? b.kind} → {b.valueLabel ?? b.value}{b.note ? <div className="text-xs muted">{b.note}</div> : null}</td>
                <td className="num">{b.applied}</td><td className="num">{b.pending}</td><td className="num">{b.skipped}</td>
                <td>{b.status === "ROLLED_BACK" ? <Badge>Rolled back {formatDate(b.rolledBackAt)}</Badge> : <Badge tone="success">Applied</Badge>}</td>
                <td className="right">{b.status !== "ROLLED_BACK" && b.items.some((i) => i.status === "APPLIED") ? <ActionButton action={rollbackMassUpdateAction} hidden={{ id: b.id }} label="Roll back" confirm="Put everyone this changed back as they were?" /> : null}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

async function Checklists() {
  const viewer = await requireViewer();
  const t = viewer.tenantId;
  const ids = await scopedEmployeeIds(viewer, P.EMPLOYEE_UPDATE);
  const [templates, lists, people] = await Promise.all([
    prisma.hrChecklistTemplate.findMany({ where: { tenantId: t }, orderBy: { name: "asc" }, include: { _count: { select: { checklists: true } } } }),
    prisma.hrChecklist.findMany({ where: { tenantId: t, ...(ids === null ? {} : { employeeId: { in: ids } }) }, include: { items: { orderBy: { position: "asc" } } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 60 }),
    prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, P.EMPLOYEE_UPDATE), { status: { notIn: ["EXITED"] } }] }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" } }),
  ]);
  const empOpts = people.map((p) => ({ value: p.id, label: `${p.displayName} (${p.employeeNumber})` }));
  const tone = (s: string) => (s === "SIGNED_OFF" ? "success" : s === "AWAITING_SIGN_OFF" ? "warning" : s === "REOPENED" ? "danger" : "brand") as "success";
  return (
    <div className="stack gap-4">
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Checklist templates" description="One item per line; add “| MANAGER” or “| EMPLOYEE” to give it to someone other than HR.">
          <SpecDisclosure label="+ New checklist">
            <SpecForm action={saveChecklistTemplateAction} submitLabel="Create" fields={[
              { name: "name", label: "Name", required: true },
              { name: "category", label: "Kind", kind: "select", required: true, defaultValue: "GENERAL", options: ["GENERAL", "JOINING", "COMPLIANCE", "TRANSFER", "RETURN_FROM_LEAVE", "EXIT"].map((c) => ({ value: c, label: c.charAt(0) + c.slice(1).toLowerCase().replace(/_/g, " ") })) },
              { name: "items", label: "Items", kind: "textarea", required: true, placeholder: `Collect signed policy | EMPLOYEE\nVerify documents\nIntroduce the team | MANAGER` },
              { name: "requiresSignOff", label: "A second HR person signs it off when complete", kind: "checkbox", defaultChecked: true },
              { name: "description", label: "Description", wide: true },
            ]} />
          </SpecDisclosure>
          {templates.length === 0 ? <Empty title="No checklists yet" /> : (
            <ul className="stack gap-2" style={{ marginTop: 12 }}>{templates.map((tp) => (
              <li key={tp.id}><strong>{tp.name}</strong> <span className="text-xs muted">· {(tp.items as unknown[]).length} items · used {tp._count.checklists}×{tp.requiresSignOff ? " · sign-off" : ""}</span></li>
            ))}</ul>
          )}
        </Card>
        <Card title="Assign a checklist">
          {templates.length === 0 ? <Empty title="Create a checklist first" /> : (
            <SpecForm action={assignChecklistAction} submitLabel="Assign" fields={[
              { name: "templateId", label: "Checklist", kind: "select", required: true, options: templates.filter((x) => x.isActive).map((x) => ({ value: x.id, label: x.name })) },
              { name: "dueDate", label: "Due", kind: "date" },
              { name: "employeeId", label: "For", kind: "multi", options: empOpts, wide: true },
            ]} />
          )}
        </Card>
      </div>
      <Card title="Running checklists" tight action={<Link className="btn sm" href="/exports/core-hr/checklists">Export CSV</Link>}>
        {lists.length === 0 ? <Empty title="None assigned yet" /> : lists.map((c) => {
          const pr = checklistProgress(c.items);
          return (
            <div key={c.id} style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
              <div className="row gap-2 wrap" style={{ justifyContent: "space-between" }}>
                <div><Link className="strong" href={`/employees/${c.employeeId}`}>{c.title}</Link> <Badge tone={tone(c.status)}>{c.status.toLowerCase().replace(/_/g, " ")}</Badge>
                  <div className="text-xs muted">{pr.done}/{pr.total} done{c.dueDate ? ` · due ${formatDate(c.dueDate)}` : ""}{c.signOffNote ? ` · ${c.signOffNote}` : ""}</div></div>
                <div style={{ minWidth: 160 }}><Progress value={pr.percent} tone={pr.complete ? "success" : undefined} /></div>
              </div>
              <ul className="stack gap-1" style={{ margin: "8px 0" }}>{c.items.map((it) => (
                <li key={it.id} className="row gap-2" style={{ alignItems: "center" }}>
                  {c.status !== "SIGNED_OFF" ? <ActionButton action={toggleChecklistItemAction} hidden={{ id: it.id }} label={it.done ? "✓" : "○"} /> : <span>{it.done ? "✓" : "○"}</span>}
                  <span style={{ textDecoration: it.done ? "line-through" : undefined }}>{it.title}</span>
                  <Badge>{(CHECKLIST_OWNERS as readonly string[]).includes(it.owner) ? it.owner.toLowerCase() : it.owner}</Badge>
                  {it.doneAt ? <span className="text-xs muted">{formatDate(it.doneAt)}</span> : null}
                </li>
              ))}</ul>
              {c.status === "AWAITING_SIGN_OFF" && c.assignedBy !== viewer.user.id ? <DecideForm action={signOffChecklistAction} hidden={{ id: c.id }} approveLabel="Sign off" rejectLabel="Send back" /> : null}
              {c.status === "AWAITING_SIGN_OFF" && c.assignedBy === viewer.user.id ? <div className="text-xs muted">Waiting for another HR person to sign off.</div> : null}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

async function Documents() {
  const viewer = await requireViewer();
  const t = viewer.tenantId;
  const ids = await scopedEmployeeIds(viewer, P.LETTER_GENERATE);
  const [types, templates, requests] = await Promise.all([
    prisma.documentRequestType.findMany({ where: { tenantId: t }, orderBy: { name: "asc" }, include: { _count: { select: { requests: true } } } }),
    prisma.documentTemplate.findMany({ where: { tenantId: t, isArchived: false }, select: { id: true, name: true, category: true }, orderBy: { name: "asc" } }),
    prisma.selfServiceDocumentRequest.findMany({ where: { tenantId: t, ...(ids === null ? {} : { employeeId: { in: ids } }) }, include: { type: { select: { name: true } } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 100 }),
  ]);
  const people = await prisma.employee.findMany({ where: { tenantId: t, id: { in: requests.map((r) => r.employeeId) } }, select: { id: true, displayName: true, employeeNumber: true } });
  const who = new Map(people.map((p) => [p.id, `${p.displayName} (${p.employeeNumber})`]));
  const tplName = new Map(templates.map((x) => [x.id, x.name]));
  const pending = requests.filter((r) => r.status === "PENDING");
  const manage = can(viewer, P.DOCUMENT_TEMPLATE_MANAGE);
  return (
    <div className="stack gap-4">
      <Card title={`Waiting to be issued (${pending.length})`} description="Approving generates the letter from its template and files it in the employee's documents." tight>
        {pending.length === 0 ? <Empty title="Nothing waiting" /> : pending.map((r) => (
          <div key={r.id} style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
            <div className="strong">{r.type.name} for <Link href={`/employees/${r.employeeId}`}>{who.get(r.employeeId)}</Link></div>
            <div className="text-sm muted">For: {r.purpose}{r.addressedTo ? ` · To: ${r.addressedTo}` : ""} · asked {formatDate(r.createdAt)}</div>
            <DecideForm action={decideDocumentRequestAction} hidden={{ id: r.id }} approveLabel="Issue letter" rejectLabel="Decline" />
          </div>
        ))}
      </Card>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Letters employees can ask for" tight>
          {types.length === 0 ? <Empty title="None offered yet">Offer a salary certificate, NOC or address proof from one of your letter templates.</Empty> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Letter</th><th>Template</th><th>Approval</th><th className="num">Requests</th></tr></thead>
              <tbody>{types.map((x) => <tr key={x.id}><td className="strong">{x.name}{!x.isActive ? <Badge>Off</Badge> : null}</td><td>{tplName.get(x.templateId) ?? "—"}</td><td>{x.requiresApproval ? "HR issues" : "Instant"}</td><td className="num">{x._count.requests}</td></tr>)}</tbody>
            </table></div>
          )}
          {manage ? <div style={{ padding: 14 }}><SpecDisclosure label="+ Offer a letter"><SpecForm action={saveDocumentRequestTypeAction} submitLabel="Offer" fields={[
            { name: "name", label: "Name employees see", required: true, placeholder: "Salary certificate" },
            { name: "templateId", label: "Letter template", kind: "select", required: true, options: templates.map((x) => ({ value: x.id, label: `${x.name} (${x.category.toLowerCase()})` })) },
            { name: "requiresApproval", label: "HR checks each request before it is issued", kind: "checkbox", defaultChecked: true },
            { name: "description", label: "Description", wide: true },
          ]} /></SpecDisclosure></div> : null}
        </Card>
        <Card title="Recent requests" tight action={<Link className="btn sm" href="/exports/core-hr/document-requests">Export CSV</Link>}>
          {requests.length === 0 ? <Empty title="No requests yet" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Employee</th><th>Letter</th><th>Status</th><th>When</th></tr></thead>
              <tbody>{requests.slice(0, 30).map((r) => <tr key={r.id}><td>{who.get(r.employeeId)}</td><td>{r.type.name}</td><td><Badge tone={r.status === "ISSUED" ? "success" : r.status === "PENDING" ? "warning" : r.status === "REJECTED" ? "danger" : "neutral"}>{r.status.toLowerCase()}</Badge></td><td>{formatDate(r.decidedAt ?? r.createdAt)}</td></tr>)}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </div>
  );
}

async function Corrections() {
  const viewer = await requireViewer();
  const people = await prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, P.EMPLOYEE_UPDATE), { status: { notIn: ["EXITED"] } }] }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" } });
  const open = await prisma.changeRequest.count({ where: { tenantId: viewer.tenantId, category: "CORRECTION", status: "PENDING" } });
  const fields: FieldSpec[] = [
    { name: "employeeId", label: "Employee", kind: "select", required: true, options: people.map((p) => ({ value: p.id, label: `${p.displayName} (${p.employeeNumber})` })) },
    { name: "field", label: "Field", kind: "select", required: true, options: Object.entries(CORRECTABLE_FIELDS).map(([k, f]) => ({ value: k, label: f.label })) },
    { name: "correctValue", label: "Correct value", required: true, hint: "Dates as 2026-04-01; choices in capitals (e.g. MARRIED)." },
    { name: "reason", label: "Why it is wrong / evidence", kind: "textarea", required: true },
  ];
  return (
    <div className="stack gap-4">
      <Callout title="Four eyes on corrections">A correction is raised by one person and approved by another HR person in Change requests; the record is then corrected and both values are kept in the audit log. Employees raise their own from Me › Requests.</Callout>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Raise a correction"><SpecForm action={requestDataCorrectionAction} fields={fields} submitLabel="Raise correction" /></Card>
        <Card title="Waiting for approval"><p className="text-sm">{open} correction(s) open.</p><Link className="btn" href="/admin/change-requests?category=CORRECTION">Open the queue</Link></Card>
      </div>
    </div>
  );
}

async function Searches() {
  const viewer = await requireViewer();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const logs = await prisma.directorySearchLog.findMany({ where: { tenantId: viewer.tenantId, createdAt: { gte: since } }, select: { query: true, resultCount: true } });
  const by = new Map<string, { n: number; zero: number }>();
  for (const l of logs) { const k = l.query; const v = by.get(k) ?? { n: 0, zero: 0 }; v.n++; if (l.resultCount === 0) v.zero++; by.set(k, v); }
  const top = [...by.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 30);
  return (
    <Card title="What people search the directory for (30 days)" description={`${logs.length} searches. Searches that find no one point to missing skills or names on profiles.`} tight action={<Link className="btn sm" href="/exports/core-hr/search-log">Export CSV</Link>}>
      {top.length === 0 ? <Empty title="No searches yet" /> : (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Search</th><th className="num">Times</th><th className="num">Found no one</th></tr></thead>
          <tbody>{top.map(([q, v]) => <tr key={q}><td><Link href={`/directory?${q}`}>{decodeURIComponent(q.replace(/\+/g, " "))}</Link></td><td className="num">{v.n}</td><td className="num">{v.zero ? <Badge tone="warning">{v.zero}</Badge> : 0}</td></tr>)}</tbody>
        </table></div>
      )}
    </Card>
  );
}
