import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { findDuplicatePeople, completenessGaps, COMPLETENESS_FIELDS, PRIVACY_REQUEST_KINDS } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { peopleQualityFacts, withEmployeeNames } from "@/lib/core2";
import { PageHead, Card, Badge, Empty, Stat, AccessDenied } from "@/components/ui";
import { SpecForm, ActionButton } from "@/components/spec-form";
import { drawQcSampleAction, reviewQcSampleAction, completePrivacyRequestAction } from "@/app/actions/core2-people";
import { saveCompletenessRuleAction, deleteCompletenessRuleAction } from "@/app/actions/core2-setup";

export const metadata = { title: "HR data quality — BooS-HR" };

const P = PERMISSIONS;
const TABS = { duplicates: "Duplicates", completeness: "Completeness", compare: "Compare profiles", reconcile: "Reconciliation", qc: "QC sampling", privacy: "Privacy requests" } as const;
type Tab = keyof typeof TABS;
type SP = { tab?: string; a?: string; b?: string };

/**
 * HR data quality: people who are probably entered twice, records missing
 * what the completeness rules require, two profiles side by side, job
 * history that disagrees with the employee record, a random sample of
 * changes for a second pair of eyes, and the privacy request queue.
 */
export default async function QualityPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const hr = can(viewer, P.EMPLOYEE_UPDATE);
  const allowed: Record<Tab, boolean> = { duplicates: hr, completeness: hr, compare: hr, reconcile: hr, qc: hr, privacy: can(viewer, P.COMPLIANCE_MANAGE) };
  const tabs = (Object.keys(TABS) as Tab[]).filter((k) => allowed[k]);
  if (!tabs.length) return <AccessDenied permission={P.EMPLOYEE_UPDATE} what="people data quality" />;
  const tab: Tab = tabs.includes(sp.tab as Tab) ? (sp.tab as Tab) : tabs[0]!;
  const where = { AND: [{ tenantId: viewer.tenantId }, scopedEmployeeWhere(viewer, P.EMPLOYEE_UPDATE)] };
  return (
    <>
      <PageHead title="HR data quality" subtitle="Duplicates, completeness, reconciliation and second-person checks" actions={<><Link className="btn" href="/hr-ops/desk">HR desk</Link><Link className="btn" href="/hr-ops">HR operations</Link></>} />
      <div className="tabs">
        {tabs.map((k) => <Link key={k} href={`/hr-ops/quality?tab=${k}`} className={`tab${tab === k ? " active" : ""}`}>{TABS[k]}</Link>)}
      </div>
      {tab === "duplicates" ? <Duplicates where={where} /> : null}
      {tab === "completeness" ? <Completeness where={where} tenantId={viewer.tenantId} /> : null}
      {tab === "compare" ? <Compare where={where} sp={sp} /> : null}
      {tab === "reconcile" ? <Reconcile tenantId={viewer.tenantId} /> : null}
      {tab === "qc" ? <Qc tenantId={viewer.tenantId} userId={viewer.user.id} /> : null}
      {tab === "privacy" ? <Privacy tenantId={viewer.tenantId} /> : null}
    </>
  );
}

type Where = Parameters<typeof peopleQualityFacts>[0];

async function Duplicates({ where }: { where: Where }) {
  const people = await peopleQualityFacts(where);
  const pairs = findDuplicatePeople(people);
  const by = new Map(people.map((p) => [p.id, p]));
  return (
    <Card title="Probable duplicates" description="Pairs matching on PAN, personal email, mobile, or name with date of birth." action={<a className="btn sm" href="/exports/core2/duplicates">Export</a>}>
      {pairs.length ? (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Record</th><th>Record</th><th>Why</th><th>Likelihood</th><th /></tr></thead>
          <tbody>{pairs.map((d) => { const a = by.get(d.a)!, b = by.get(d.b)!; return <tr key={`${d.a}${d.b}`}><td><Link href={`/employees/${a.id}`}>{a.displayName}</Link> <span className="muted text-xs">{a.employeeNumber}</span></td><td><Link href={`/employees/${b.id}`}>{b.displayName}</Link> <span className="muted text-xs">{b.employeeNumber}</span></td><td className="text-sm">{d.reasons.join(", ")}</td><td><Badge tone={d.score >= 60 ? "danger" : "warning"}>{d.score}%</Badge></td><td><Link className="btn sm" href={`/hr-ops/quality?tab=compare&a=${a.id}&b=${b.id}`}>Compare</Link></td></tr>; })}</tbody>
        </table></div>
      ) : <Empty title="No likely duplicates" />}
    </Card>
  );
}

async function Completeness({ where, tenantId }: { where: Where; tenantId: string }) {
  const [rules, types, people] = await Promise.all([
    prisma.fieldCompletenessRule.findMany({ where: { tenantId }, orderBy: { field: "asc" } }),
    prisma.workerType.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    peopleQualityFacts(where),
  ]);
  const gaps = people.map((p) => ({ p, gaps: completenessGaps(p, rules) })).filter((x) => x.gaps.length);
  const typeName = new Map(types.map((w) => [w.id, w.name]));
  const fieldOpts = Object.entries(COMPLETENESS_FIELDS).map(([value, label]) => ({ value, label }));
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Rules" value={rules.filter((r) => r.isActive).length} />
        <Stat label="People checked" value={people.length} />
        <Stat label="With missing data" value={gaps.length} tone={gaps.length ? "neg" : undefined} />
        <Stat label="Complete" value={`${people.length ? Math.round(((people.length - gaps.length) / people.length) * 100) : 100}%`} />
      </div>
      <Card title="Completeness rules" description="What every record (or every record of one employment type) must hold.">
        <SpecForm compact action={saveCompletenessRuleAction} submitLabel="Add rule" fields={[
          { name: "field", label: "Field", kind: "select", required: true, options: fieldOpts },
          { name: "workerTypeId", label: "Only for", kind: "select", options: types.map((w) => ({ value: w.id, label: w.name })) },
          { name: "severity", label: "If missing", kind: "select", defaultValue: "ERROR", options: [{ value: "ERROR", label: "Required" }, { value: "WARNING", label: "Recommended" }] },
        ]} />
        {rules.length ? <div className="row gap-2 wrap" style={{ marginTop: 10 }}>{rules.map((r) => <span key={r.id} className="row gap-1"><Badge tone={r.severity === "ERROR" ? "danger" : "warning"}>{COMPLETENESS_FIELDS[r.field as keyof typeof COMPLETENESS_FIELDS] ?? r.field}{r.workerTypeId ? ` · ${typeName.get(r.workerTypeId)}` : ""}</Badge><ActionButton action={deleteCompletenessRuleAction} hidden={{ id: r.id }} label="×" /></span>)}</div> : null}
      </Card>
      <Card title="Records with gaps" action={<a className="btn sm" href="/exports/core2/completeness">Export</a>}>
        {gaps.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Person</th><th>Missing</th></tr></thead>
            <tbody>{gaps.slice(0, 300).map(({ p, gaps: g }) => <tr key={p.id}><td><Link href={`/employees/${p.id}/master`}>{p.displayName}</Link> <span className="muted text-xs">{p.employeeNumber}</span></td><td>{g.map((x) => <Badge key={x.field} tone={x.severity === "ERROR" ? "danger" : "warning"}>{x.label}</Badge>)}</td></tr>)}</tbody>
          </table></div>
        ) : <Empty title={rules.length ? "Every record meets the rules" : "Add a rule to start checking"} />}
      </Card>
    </>
  );
}

async function Compare({ where, sp }: { where: Where; sp: SP }) {
  const people = await peopleQualityFacts(where);
  const a = people.find((p) => p.id === sp.a), b = people.find((p) => p.id === sp.b);
  const [units, extras] = await Promise.all([
    Promise.all([prisma.department.findMany({ select: { id: true, name: true }, where: { id: { in: [a?.departmentId, b?.departmentId].filter((x): x is string => !!x) } } }), prisma.location.findMany({ select: { id: true, name: true }, where: { id: { in: [a?.locationId, b?.locationId].filter((x): x is string => !!x) } } })]),
    prisma.employeeProfileExtra.findMany({ where: { employeeId: { in: [a?.id, b?.id].filter((x): x is string => !!x) } } }),
  ]);
  const name = new Map([...units[0], ...units[1]].map((u) => [u.id, u.name]));
  const mgr = new Map(people.map((p) => [p.id, p.displayName]));
  const rows: Array<[string, (p: (typeof people)[number]) => string]> = [
    ["Employee number", (p) => p.employeeNumber], ["Name", (p) => `${p.firstName} ${p.lastName}`], ["Work email", (p) => p.workEmail ?? "—"], ["Personal email", (p) => p.personalEmail ?? "—"],
    ["Mobile", (p) => p.mobile ?? "—"], ["Date of birth", (p) => (p.dateOfBirth ? formatDate(p.dateOfBirth) : "—")], ["PAN", (p) => p.pan ?? "—"], ["Nationality", (p) => p.nationality ?? "—"],
    ["Job title", (p) => p.jobTitleName ?? "—"], ["Department", (p) => (p.departmentId ? name.get(p.departmentId) ?? "—" : "—")], ["Location", (p) => (p.locationId ? name.get(p.locationId) ?? "—" : "—")],
    ["Manager", (p) => (p.reportingManagerId ? mgr.get(p.reportingManagerId) ?? "—" : "—")], ["Languages", (p) => extras.find((e) => e.employeeId === p.id)?.languages.join(", ") || "—"],
    ["Bank account", (p) => (p.bankAccount ? "Yes" : "No")], ["Emergency contact", (p) => (p.emergencyContact ? "Yes" : "No")], ["Last updated", (p) => formatDate(p.updatedAt)],
  ];
  const opts = people.map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.employeeNumber})</option>);
  return (
    <Card title="Compare two profiles" description="Side by side, with differences highlighted.">
      <form method="get" className="row gap-2 wrap">
        <input type="hidden" name="tab" value="compare" />
        <select className="select" name="a" defaultValue={sp.a ?? ""}><option value="">First person…</option>{opts}</select>
        <select className="select" name="b" defaultValue={sp.b ?? ""}><option value="">Second person…</option>{opts}</select>
        <button className="btn" type="submit">Compare</button>
      </form>
      {a && b ? (
        <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
          <thead><tr><th>Field</th><th>{a.displayName}</th><th>{b.displayName}</th></tr></thead>
          <tbody>{rows.map(([label, f]) => { const x = f(a), y = f(b); return <tr key={label}><td>{label}</td><td style={x !== y ? { background: "var(--warning-bg, #fff7e6)" } : undefined}>{x}</td><td style={x !== y ? { background: "var(--warning-bg, #fff7e6)" } : undefined}>{y}</td></tr>; })}</tbody>
        </table></div>
      ) : null}
    </Card>
  );
}

async function Reconcile({ tenantId }: { tenantId: string }) {
  const [emps, failed, stuck] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId, status: { not: "EXITED" } }, select: { id: true, displayName: true, employeeNumber: true, departmentId: true, locationId: true, reportingManagerId: true, legalEntityId: true, jobHistory: { where: { effectiveTo: null }, orderBy: { effectiveFrom: "desc" }, take: 1, select: { departmentId: true, locationId: true, reportingManagerId: true, legalEntityId: true, effectiveFrom: true } } } }),
    prisma.recordChangeRequest.findMany({ where: { tenantId, error: { not: null } }, select: { id: true, title: true, error: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.jobChange.findMany({ where: { tenantId, status: "SCHEDULED", effectiveFrom: { lt: new Date(Date.now() - 86_400_000) } }, select: { id: true, reason: true, effectiveFrom: true, employeeId: true } }).then((rows) => withEmployeeNames(rows)),
  ]);
  const fields = ["departmentId", "locationId", "reportingManagerId", "legalEntityId"] as const;
  const mismatch = emps.flatMap((e) => {
    const r = e.jobHistory[0];
    if (!r) return [{ e, fields: ["no job record"] }];
    const f = fields.filter((k) => (r[k] ?? null) !== (e[k] ?? null)).map((k) => k.replace("Id", ""));
    return f.length ? [{ e, fields: f }] : [];
  });
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Records checked" value={emps.length} />
        <Stat label="Record ≠ job history" value={mismatch.length} tone={mismatch.length ? "neg" : undefined} />
        <Stat label="Changes that failed to apply" value={failed.length} />
        <Stat label="Moves overdue to apply" value={stuck.length} />
      </div>
      <Card title="Employee record against current job history" description="Where the record and the job record in force disagree, one of them was changed outside a job change." action={<a className="btn sm" href="/exports/core2/reconciliation">Export</a>}>
        {mismatch.length ? <div className="table-wrap"><table className="data"><thead><tr><th>Person</th><th>Differs in</th></tr></thead><tbody>{mismatch.slice(0, 300).map(({ e, fields: f }) => <tr key={e.id}><td><Link href={`/employees/${e.id}?tab=job`}>{e.displayName}</Link> <span className="muted text-xs">{e.employeeNumber}</span></td><td>{f.map((x) => <Badge key={x} tone="warning">{x}</Badge>)}</td></tr>)}</tbody></table></div> : <Empty title="Everything reconciles" />}
      </Card>
      <div className="grid grid-2">
        <Card title="Change requests that failed to apply">{failed.length ? <ul>{failed.map((f) => <li key={f.id}>{f.title}: <span className="text-sm muted">{f.error}</span></li>)}</ul> : <Empty title="None" />}</Card>
        <Card title="Scheduled moves past their date">{stuck.length ? <ul>{stuck.map((s) => <li key={s.id}>{s.employee.displayName} · {s.reason.toLowerCase().replace(/_/g, " ")} · {formatDate(s.effectiveFrom)}</li>)}</ul> : <Empty title="None" />}</Card>
      </div>
    </>
  );
}

async function Qc({ tenantId, userId }: { tenantId: string; userId: string }) {
  const samples = await prisma.hrQcSample.findMany({ where: { tenantId }, orderBy: [{ result: "asc" }, { createdAt: "desc" }], take: 100 });
  const done = samples.filter((s) => s.result !== "PENDING");
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Waiting for a check" value={samples.length - done.length} />
        <Stat label="Passed" value={done.filter((s) => s.result === "PASS").length} />
        <Stat label="Failed" value={done.filter((s) => s.result === "FAIL").length} tone={done.some((s) => s.result === "FAIL") ? "neg" : undefined} />
        <Stat label="Error rate" value={done.length ? `${Math.round((done.filter((s) => s.result === "FAIL").length / done.length) * 100)}%` : "—"} />
      </div>
      <Card title="Draw a sample" description="A random share of recent employee-record changes, for someone other than the person who made them to check.">
        <SpecForm compact action={drawQcSampleAction} submitLabel="Draw sample" fields={[{ name: "days", label: "From the last (days)", kind: "number", defaultValue: 7 }, { name: "pct", label: "Sample size (%)", kind: "number", defaultValue: 10 }]} />
      </Card>
      <Card title="Samples" action={<a className="btn sm" href="/exports/core2/qc">Export</a>}>
        {samples.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Change</th><th>Sampled</th><th>Result</th><th /></tr></thead>
            <tbody>{samples.map((s) => <tr key={s.id}><td>{s.summary}</td><td className="text-sm">{formatDate(s.createdAt)}</td><td>{s.result === "PENDING" ? <Badge>to check</Badge> : <Badge tone={s.result === "PASS" ? "success" : "danger"}>{s.result.toLowerCase()}</Badge>}{s.note ? <div className="text-xs muted">{s.note}</div> : null}</td><td>{s.result === "PENDING" && s.actorId !== userId ? <QcDecide id={s.id} /> : s.result === "PENDING" ? <span className="text-xs muted">your change</span> : null}</td></tr>)}</tbody>
          </table></div>
        ) : <Empty title="No samples yet" />}
      </Card>
    </>
  );
}

function QcDecide({ id }: { id: string }) {
  return (
    <div className="row gap-1">
      <ActionButton action={reviewQcSampleAction} hidden={{ id, result: "PASS" }} label="Pass" variant="primary" />
      <SpecForm compact action={reviewQcSampleAction} hidden={{ id, result: "FAIL" }} submitLabel="Fail" fields={[{ name: "note", label: "What is wrong", required: true }]} />
    </div>
  );
}

async function Privacy({ tenantId }: { tenantId: string }) {
  const rows = await prisma.privacyRequest.findMany({ where: { tenantId }, orderBy: [{ status: "asc" }, { dueDate: "asc" }], take: 200 });
  const people = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, displayName: true } });
  const name = new Map(people.map((p) => [p.id, p.displayName]));
  const now = new Date();
  return (
    <Card title="Privacy requests" description="Raised by employees; approved in the inbox; closed here with what was done." action={<a className="btn sm" href="/exports/core2/privacy">Export</a>}>
      {rows.length ? (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Who</th><th>Asks for</th><th>Due</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{name.get(r.employeeId)}</td><td>{PRIVACY_REQUEST_KINDS[r.kind as keyof typeof PRIVACY_REQUEST_KINDS] ?? r.kind}<div className="text-xs muted">{r.details}</div></td><td>{r.closedAt ? "—" : <Badge tone={r.dueDate < now ? "danger" : "neutral"}>{formatDate(r.dueDate)}</Badge>}</td><td><Badge tone={r.status === "COMPLETED" ? "success" : r.status === "REJECTED" ? "danger" : "neutral"}>{r.status.toLowerCase()}</Badge>{r.response ? <div className="text-xs muted">{r.response}</div> : null}</td><td>{r.status === "APPROVED" ? <SpecForm compact action={completePrivacyRequestAction} hidden={{ id: r.id }} submitLabel="Complete" fields={[{ name: "response", label: "What was done", required: true }]} /> : r.status === "PENDING" ? <Link href="/inbox">Decide in inbox</Link> : null}</td></tr>)}</tbody>
        </table></div>
      ) : <Empty title="No privacy requests" />}
    </Card>
  );
}

