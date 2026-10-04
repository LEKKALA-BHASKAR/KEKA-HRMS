import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { RETENTION_DATA_TYPES, complianceStatus, complianceScore, verifyAuditLog, policyCampaignStatus, seededSample } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { userOptions, userNames, departmentOptions, employeeOptions, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Stat, Callout, Progress } from "@/components/ui";
import { Pill, Tabs, SearchBar, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import {
  saveRetentionRuleAction, retentionOpAction, createLegalHoldAction, releaseLegalHoldAction, saveConsentPurposeAction, submitConsentPurposeAction,
  saveComplianceItemAction, uploadEvidenceAction, complianceItemOpAction, createPolicyDocumentAction, launchPolicyCampaignAction, closePolicyCampaignAction,
  saveFindingAction, findingOpAction, sealAuditLogAction,
} from "@/app/actions/compliance";

const TABS = { dashboard: "Dashboard", checklist: "Checklist & calendar", policies: "Policy acknowledgement", consent: "Consent", retention: "Retention", holds: "Legal holds", findings: "Findings", integrity: "Audit integrity" };
type Tab = keyof typeof TABS;
const CATEGORY = [["STATUTORY", "Statutory filing"], ["LABOUR", "Labour law"], ["TAX", "Tax"], ["DATA_PROTECTION", "Data protection"], ["INTERNAL", "Internal control"]].map(([value, label]) => ({ value: value!, label: label! }));
const FREQ = [["ONE_TIME", "One time"], ["MONTHLY", "Monthly"], ["QUARTERLY", "Quarterly"], ["ANNUAL", "Annual"]].map(([value, label]) => ({ value: value!, label: label! }));
const DATA_TYPES = Object.entries(RETENTION_DATA_TYPES).map(([value, s]) => ({ value, label: s.label }));

export default async function CompliancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireAuth(PERMISSIONS.COMPLIANCE_VIEW);
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "dashboard";
  const t = viewer.tenantId;
  const manage = can(viewer, PERMISSIONS.COMPLIANCE_MANAGE);
  return (
    <>
      <PageHead title="Compliance" subtitle="Obligations, evidence, policies, consent, retention and audit integrity" actions={<Link className="btn" href="/admin/audit">Audit log</Link>} />
      <Tabs base="/admin/compliance" tabs={TABS} active={tab} />
      {tab === "dashboard" ? <Dashboard tenantId={t} /> : null}
      {tab === "checklist" ? <Checklist tenantId={t} manage={manage} q={sp.q} status={sp.status} /> : null}
      {tab === "policies" ? <Policies tenantId={t} manage={manage} id={sp.id} /> : null}
      {tab === "consent" ? <Consent tenantId={t} manage={manage} /> : null}
      {tab === "retention" ? <Retention tenantId={t} manage={manage} /> : null}
      {tab === "holds" ? <Holds tenantId={t} manage={manage} /> : null}
      {tab === "findings" ? <Findings tenantId={t} manage={manage} /> : null}
      {tab === "integrity" ? <Integrity tenantId={t} manage={manage} seed={sp.seed} /> : null}
    </>
  );
}

async function Dashboard({ tenantId }: { tenantId: string }) {
  const now = new Date();
  const [items, holds, campaigns, purposes, findings, verify, employees] = await Promise.all([
    prisma.complianceItem.findMany({ where: { tenantId }, select: { id: true, title: true, status: true, dueOn: true, completedAt: true, category: true } }),
    prisma.legalHold.count({ where: { tenantId, releasedAt: null } }),
    prisma.policyCampaign.findMany({ where: { tenantId, status: "ACTIVE" }, select: { id: true, name: true } }),
    prisma.consentPurpose.findMany({ where: { tenantId, status: "PUBLISHED" }, select: { id: true, title: true, _count: { select: { records: { where: { decision: "GRANTED" } } } } } }),
    prisma.auditFinding.groupBy({ by: ["severity"], where: { tenantId, status: { not: "CLOSED" } }, _count: true }),
    verifyAuditLog(tenantId),
    prisma.employee.count({ where: { tenantId, status: { not: "EXITED" } } }),
  ]);
  const score = complianceScore(items, now);
  const shown = items.map((i) => ({ ...i, s: complianceStatus(i.status, i.dueOn, now) }));
  const overdue = shown.filter((i) => i.s === "OVERDUE"), soon = shown.filter((i) => i.s === "DUE_SOON");
  const camp = await Promise.all(campaigns.map((c) => policyCampaignStatus(tenantId, c.id)));
  const openFindings = findings.reduce((a, f) => a + f._count, 0);
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Compliance score" value={score === null ? "—" : `${score}%`} meta="Done or excepted, of everything due" tone={score !== null && score < 80 ? "neg" : "pos"} />
        <Stat label="Overdue obligations" value={overdue.length} tone={overdue.length ? "neg" : undefined} meta={`${soon.length} due within 7 days`} />
        <Stat label="Open findings" value={openFindings} meta={findings.map((f) => `${f._count} ${f.severity.toLowerCase()}`).join(" · ") || "None"} tone={openFindings ? "neg" : undefined} />
        <Stat label="Audit chain" value={verify.problems.length ? `${verify.problems.length} problem(s)` : "Intact"} meta={`${verify.checked} sealed · ${verify.unsealed} waiting`} tone={verify.problems.length ? "neg" : "pos"} />
      </div>
      {overdue.length ? <Callout tone="danger" title={`${overdue.length} obligation(s) overdue`}>{overdue.slice(0, 5).map((i) => i.title).join(", ")}{overdue.length > 5 ? "…" : ""}. <Link href="/admin/compliance?tab=checklist&status=OVERDUE">Open the checklist</Link>.</Callout> : null}
      <div className="grid grid-2">
        <Card title="Policy acknowledgement" description="Active campaigns">
          {camp.length === 0 ? <div className="muted text-sm">No campaign running.</div> : camp.filter(Boolean).map((c) => (
            <div key={c!.campaign.id} style={{ marginBottom: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}><Link href={`/admin/compliance?tab=policies&id=${c!.campaign.id}`}>{c!.campaign.name}</Link><span className="text-xs">{c!.acknowledged} / {c!.total}</span></div>
              <Progress value={c!.acknowledged} max={Math.max(1, c!.total)} tone={c!.acknowledged === c!.total ? "success" : "warning"} />
            </div>
          ))}
        </Card>
        <Card title="Consent and holds">
          <div className="stack gap-2 text-sm">
            {purposes.map((p) => <div key={p.id} className="row" style={{ justifyContent: "space-between" }}><span>{p.title}</span><span>{p._count.records} / {employees} consented</span></div>)}
            {purposes.length === 0 ? <div className="muted">No consent purposes published.</div> : null}
            <div className="row" style={{ justifyContent: "space-between" }}><span>Active legal holds</span><Link href="/admin/compliance?tab=holds">{holds}</Link></div>
          </div>
        </Card>
      </div>
      <Card tight title="By category">
        <Table head={["Category", "Items", "Completed", "Overdue", "Due soon"]}>
          {CATEGORY.map((c) => { const xs = shown.filter((i) => i.category === c.value); return <tr key={c.value}><td>{c.label}</td><td className="num">{xs.length}</td><td className="num">{xs.filter((i) => i.s === "COMPLETED").length}</td><td className="num">{xs.filter((i) => i.s === "OVERDUE").length}</td><td className="num">{xs.filter((i) => i.s === "DUE_SOON").length}</td></tr>; })}
        </Table>
      </Card>
    </div>
  );
}

async function Checklist({ tenantId, manage, q, status }: { tenantId: string; manage: boolean; q?: string; status?: string }) {
  const now = new Date();
  const [all, users] = await Promise.all([
    prisma.complianceItem.findMany({ where: { tenantId, ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { regulation: { contains: q, mode: "insensitive" } }] } : {}) }, orderBy: { dueOn: "asc" }, take: 300 }),
    userOptions(tenantId),
  ]);
  const shown = all.map((i) => ({ ...i, s: complianceStatus(i.status, i.dueOn, now) })).filter((i) => !status || i.s === status);
  const names = await userNames(tenantId, shown.flatMap((i) => [i.ownerUserId, i.reviewerUserId]));
  // Calendar: the next six months, grouped by month.
  const months = new Map<string, typeof shown>();
  for (const i of shown) if (i.s !== "COMPLETED" && i.s !== "EXCEPTION") { const k = i.dueOn.toISOString().slice(0, 7); months.set(k, [...(months.get(k) ?? []), i]); }
  return (
    <div className="stack gap-4">
      <Card tight title="Obligations" action={<a className="btn sm" href={`/admin/governance/export?report=compliance-items${status ? `&status=${status}` : ""}`}>Export CSV</a>}>
        <SearchBar action="/admin/compliance" tab="checklist" q={q}><select className="select" name="status" defaultValue={status ?? ""}><option value="">Any status</option>{["OPEN", "IN_PROGRESS", "DUE_SOON", "OVERDUE", "SUBMITTED", "COMPLETED", "EXCEPTION"].map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}</select></SearchBar>
        <Table head={["Obligation", "Due", "Owner / reviewer", "Evidence", "Status", ""]} empty={shown.length === 0}>
          {shown.map((i) => (
            <tr key={i.id}>
              <td><strong>{i.title}</strong><div className="text-xs muted">{CATEGORY.find((c) => c.value === i.category)?.label}{i.regulation ? ` · ${i.regulation}` : ""}{i.frequency !== "ONE_TIME" ? ` · ${i.frequency.toLowerCase()}` : ""}</div>{i.exceptionReason ? <div className="text-xs">Exception: {i.exceptionReason}</div> : null}</td>
              <td>{fmtDate(i.dueOn)}</td>
              <td className="text-xs">{names.get(i.ownerUserId)}{i.reviewerUserId ? <div className="muted">reviewed by {names.get(i.reviewerUserId)}</div> : null}</td>
              <td className="text-xs">{i.evidenceFileIds.map((f, n) => <div key={f}><a href={`/files/${f}`}>Evidence {n + 1}</a></div>)}
                {i.status === "OPEN" || i.status === "IN_PROGRESS" ? <SpecForm action={uploadEvidenceAction} hidden={{ id: i.id }} submitLabel="Attach" columns={1} fields={[{ name: "file", label: "", type: "file" }]} /> : null}</td>
              <td><Pill s={i.s} />{i.workflowRequestId ? <div><Link className="text-xs" href={`/me/requests/${i.workflowRequestId}`}>Approval</Link></div> : null}</td>
              <td className="stack gap-2">
                {(i.status === "OPEN" || i.status === "IN_PROGRESS") && i.evidenceFileIds.length ? <ActButton action={complianceItemOpAction} hidden={{ id: i.id, op: "submit" }} label="Submit for sign-off" variant="primary" input={{ name: "notes", placeholder: "Notes (optional)" }} /> : null}
                {manage && i.status !== "COMPLETED" && i.status !== "EXCEPTION" ? <ActButton action={complianceItemOpAction} hidden={{ id: i.id, op: "exception" }} label="Exception" variant="ghost" input={{ name: "reason", placeholder: "Why it does not apply", required: true }} /> : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Compliance calendar">
        {months.size === 0 ? <div className="muted text-sm">Nothing open.</div> : (
          <div className="grid grid-3">
            {[...months.entries()].sort().slice(0, 9).map(([m, xs]) => (
              <div key={m} className="card" style={{ padding: 12 }}>
                <div className="card-title">{new Date(`${m}-01T00:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}</div>
                {xs.map((i) => <div key={i.id} className="row gap-2 text-sm" style={{ justifyContent: "space-between", marginTop: 6 }}><span>{i.dueOn.toISOString().slice(8, 10)} · {i.title}</span><Pill s={i.s} /></div>)}
              </div>
            ))}
          </div>
        )}
      </Card>
      {manage ? (
        <Card title="Add an obligation" description="Recurring items roll forward to the next due date when signed off. Evidence is required before submission; the reviewer approves.">
          <SpecForm action={saveComplianceItemAction} submitLabel="Add" fields={[
            { name: "title", label: "Obligation", required: true, placeholder: "PF ECR filing" }, { name: "dueOn", label: "Due", type: "date", required: true },
            { name: "category", label: "Category", type: "select", options: CATEGORY, required: true }, { name: "frequency", label: "Repeats", type: "select", options: FREQ, required: true },
            { name: "ownerUserId", label: "Owner", type: "select", options: users, required: true }, { name: "reviewerUserId", label: "Reviewer", type: "select", options: users },
            { name: "regulation", label: "Regulation / control", placeholder: "EPF Act 1952, para 38" }, { name: "authority", label: "Authority", placeholder: "EPFO" },
            { name: "description", label: "Notes", type: "textarea", wide: true },
          ]} />
        </Card>
      ) : null}
    </div>
  );
}

async function Policies({ tenantId, manage, id }: { tenantId: string; manage: boolean; id?: string }) {
  const [docs, campaigns, departments] = await Promise.all([
    prisma.orgDocument.findMany({ where: { tenantId, requireAck: true }, orderBy: [{ title: "asc" }, { createdAt: "desc" }], include: { _count: { select: { acknowledgements: true } } } }),
    prisma.policyCampaign.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }),
    departmentOptions(tenantId),
  ]);
  const docTitle = new Map(docs.map((d) => [d.id, `${d.title} ${d.version ?? ""}`.trim()]));
  const detail = id ? await policyCampaignStatus(tenantId, id) : null;
  return (
    <div className="stack gap-4">
      <Card tight title="Policies needing acknowledgement">
        <Table head={["Policy", "Version", "Effective", "Published", "Acknowledged", ""]} empty={docs.length === 0}>
          {docs.map((d) => <tr key={d.id}><td>{d.title}{d.fileUrl ? <div><a className="text-xs" href={d.fileUrl}>Document</a></div> : null}</td><td>{d.version}</td><td>{fmtDate(d.effectiveFrom)}</td><td>{d.isPublished ? <Pill s="PUBLISHED" /> : <Pill s="DRAFT" />}</td><td className="num">{d._count.acknowledgements}</td>
            <td>{manage ? <details><summary className="btn sm ghost">New version</summary><div style={{ marginTop: 8, minWidth: 320 }}><SpecForm action={createPolicyDocumentAction} hidden={{ fromId: d.id }} submitLabel="Save version" columns={1} fields={[{ name: "title", label: "Title", required: true, defaultValue: d.title }, { name: "file", label: "Document", type: "file" }, { name: "effectiveFrom", label: "Effective from", type: "date" }]} /></div></details> : null}</td></tr>)}
        </Table>
      </Card>
      <Card tight title="Acknowledgement campaigns">
        <Table head={["Campaign", "Policy", "Due", "Status", ""]} empty={campaigns.length === 0}>
          {campaigns.map((c) => <tr key={c.id}><td><Link href={`/admin/compliance?tab=policies&id=${c.id}`}>{c.name}</Link></td><td>{docTitle.get(c.documentId)}</td><td>{fmtDate(c.dueOn)}</td><td><Pill s={c.status} /></td>
            <td className="row gap-2"><a className="btn sm ghost" href={`/admin/governance/export?report=policy-acks&id=${c.id}`}>CSV</a>{manage && c.status === "ACTIVE" ? <ActButton action={closePolicyCampaignAction} hidden={{ id: c.id }} label="Close" variant="ghost" /> : null}</td></tr>)}
        </Table>
      </Card>
      {detail ? (
        <Card tight title={`${detail.campaign.name}: ${detail.acknowledged} of ${detail.total} acknowledged`}>
          <Table head={["Employee", "Department", "Acknowledged"]}>
            {detail.rows.map((r) => <tr key={r.employeeId}><td>{r.name} <span className="text-xs muted">{r.employeeNumber}</span></td><td>{r.department}</td><td>{r.acknowledgedAt ? fmtWhen(r.acknowledgedAt) : <Pill s="PENDING" />}</td></tr>)}
          </Table>
        </Card>
      ) : null}
      {manage ? (
        <div className="grid grid-2">
          <Card title="New policy" description="Saved as a draft; launching a campaign publishes it.">
            <SpecForm action={createPolicyDocumentAction} submitLabel="Save policy" columns={1} fields={[{ name: "title", label: "Title", required: true, placeholder: "Code of conduct" }, { name: "version", label: "Version", placeholder: "v1" }, { name: "description", label: "Summary", type: "textarea" }, { name: "file", label: "Document", type: "file" }, { name: "effectiveFrom", label: "Effective from", type: "date" }]} />
          </Card>
          <Card title="Launch a campaign" description="Publishes the policy, asks the audience to acknowledge it and reminds them until the due date.">
            <SpecForm action={launchPolicyCampaignAction} submitLabel="Launch" columns={1} fields={[
              { name: "documentId", label: "Policy", type: "select", required: true, options: docs.map((d) => ({ value: d.id, label: docTitle.get(d.id)! })) },
              { name: "name", label: "Campaign name", required: true, placeholder: "FY27 code of conduct" }, { name: "dueOn", label: "Due", type: "date", required: true },
              { name: "departmentIds", label: "Departments (none: everyone)", type: "multiselect", options: departments },
            ]} />
          </Card>
        </div>
      ) : null}
    </div>
  );
}

async function Consent({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const [purposes, employees] = await Promise.all([
    prisma.consentPurpose.findMany({ where: { tenantId }, orderBy: [{ key: "asc" }, { version: "desc" }], include: { records: { select: { decision: true, version: true } } } }),
    prisma.employee.count({ where: { tenantId, status: { not: "EXITED" } } }),
  ]);
  return (
    <div className="stack gap-4">
      <Card tight title="Consent purposes" description="Each change is a new version; publishing a version asks everyone again." action={<a className="btn sm" href="/admin/governance/export?report=consents">Export records</a>}>
        <Table head={["Purpose", "Version", "Required", "Status", "Granted", "Declined / withdrawn", ""]} empty={purposes.length === 0}>
          {purposes.map((p) => {
            const cur = p.records.filter((r) => r.version === p.version);
            return <tr key={p.id}><td><strong>{p.title}</strong><div className="text-xs muted">{p.description}</div></td><td>v{p.version}</td><td>{p.mandatory ? "Yes" : "No"}</td><td><Pill s={p.status} /></td>
              <td className="num">{cur.filter((r) => r.decision === "GRANTED").length} / {employees}</td><td className="num">{cur.filter((r) => r.decision !== "GRANTED").length}</td>
              <td>{manage && p.status === "DRAFT" ? <ActButton action={submitConsentPurposeAction} hidden={{ id: p.id }} label="Submit to publish" /> : null}
                {manage && p.status === "PUBLISHED" ? <details><summary className="btn sm ghost">New version</summary><div style={{ marginTop: 8, minWidth: 320 }}><SpecForm action={saveConsentPurposeAction} hidden={{ fromId: p.id }} submitLabel="Draft version" columns={1} fields={[{ name: "title", label: "Title", required: true, defaultValue: p.title }, { name: "description", label: "What the data is used for", type: "textarea", required: true, defaultValue: p.description }, { name: "mandatory", label: "Required", type: "checkbox", placeholder: "Required to employ the person", defaultValue: p.mandatory }]} /></div></details> : null}</td></tr>;
          })}
        </Table>
      </Card>
      {manage ? (
        <Card title="New consent purpose">
          <SpecForm action={saveConsentPurposeAction} submitLabel="Draft" fields={[
            { name: "title", label: "Title", required: true, placeholder: "Background verification" },
            { name: "mandatory", label: "Required", type: "checkbox", placeholder: "Required to employ the person" },
            { name: "description", label: "What the data is used for", type: "textarea", required: true, wide: true },
          ]} />
        </Card>
      ) : null}
    </div>
  );
}

async function Retention({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const [rules, runs] = await Promise.all([
    prisma.retentionRule.findMany({ where: { tenantId }, orderBy: { dataType: "asc" } }),
    prisma.retentionRun.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50, include: { rule: { select: { dataType: true } } } }),
  ]);
  return (
    <div className="stack gap-4">
      <Callout title="How retention runs">A dry run counts what a rule would remove without changing anything. A purge is then sent for approval, or applied nightly when the rule is set to run automatically. Records under a legal hold are always kept.</Callout>
      <Card tight title="Retention rules" action={<a className="btn sm" href="/admin/governance/export?report=retention-runs">Export runs</a>}>
        <Table head={["Data", "Keep for", "Action", "Runs", "Status", ""]} empty={rules.length === 0}>
          {rules.map((r) => <tr key={r.id}><td>{RETENTION_DATA_TYPES[r.dataType as keyof typeof RETENTION_DATA_TYPES]?.label ?? r.dataType}{r.description ? <div className="text-xs muted">{r.description}</div> : null}</td><td>{r.retentionDays} days</td><td>{r.action === "ANONYMISE" ? "Anonymise" : "Delete"}</td><td>{r.autoApply ? "Nightly" : "On approval"}</td><td><Pill s={r.isActive ? "ACTIVE" : "PAUSED"} /></td>
            <td className="row gap-2">{manage ? <><ActButton action={retentionOpAction} hidden={{ id: r.id, op: "dry-run" }} label="Dry run" /><ActButton action={retentionOpAction} hidden={{ id: r.id, op: "purge" }} label="Request purge" variant="danger" confirmText="Send a purge of the dry-run records for approval?" /><ActButton action={retentionOpAction} hidden={{ id: r.id, op: "toggle" }} label={r.isActive ? "Pause" : "Resume"} variant="ghost" /></> : null}</td></tr>)}
        </Table>
      </Card>
      <Card tight title="Runs">
        <Table head={["When", "Data", "Cutoff", "Matched", "Held", "Changed", "Status", "Sample"]} empty={runs.length === 0}>
          {runs.map((r) => <tr key={r.id}><td className="text-xs">{fmtWhen(r.createdAt)}</td><td className="text-xs">{r.rule.dataType}</td><td className="text-xs">{fmtDate(r.cutoff)}</td><td className="num">{r.matched}</td><td className="num">{r.heldBack}</td><td className="num">{r.affected}</td>
            <td><Pill s={r.status} />{r.workflowRequestId ? <div><Link className="text-xs" href={`/me/requests/${r.workflowRequestId}`}>Approval</Link></div> : null}{r.error ? <div className="text-xs neg">{r.error}</div> : null}</td><td className="text-xs mono">{Array.isArray(r.sample) ? (r.sample as string[]).slice(0, 3).join(", ") : ""}</td></tr>)}
        </Table>
      </Card>
      {manage ? (
        <Card title="Set a retention rule" description="One rule per kind of data; saving again updates it.">
          <SpecForm action={saveRetentionRuleAction} submitLabel="Save rule" fields={[
            { name: "dataType", label: "Data", type: "select", options: DATA_TYPES.map((d) => ({ ...d, label: `${d.label} (min ${RETENTION_DATA_TYPES[d.value as keyof typeof RETENTION_DATA_TYPES].min} d)` })), required: true },
            { name: "retentionDays", label: "Keep for (days)", type: "number", required: true, defaultValue: 365 },
            { name: "autoApply", label: "Nightly", type: "checkbox", placeholder: "Apply automatically every night (no approval)" },
            { name: "description", label: "Basis", placeholder: "DPDP Act: no longer than necessary" },
          ]} />
        </Card>
      ) : null}
    </div>
  );
}

async function Holds({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const [holds, employees] = await Promise.all([prisma.legalHold.findMany({ where: { tenantId }, orderBy: [{ releasedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }] }), employeeOptions(tenantId)]);
  const emps = holds.some((h) => h.employeeId) ? await prisma.employee.findMany({ where: { tenantId, id: { in: holds.map((h) => h.employeeId).filter((x): x is string => !!x) } }, select: { id: true, firstName: true, lastName: true, employeeNumber: true } }) : [];
  const empName = new Map(emps.map((e) => [e.id, `${e.firstName} ${e.lastName} (${e.employeeNumber})`]));
  return (
    <div className="stack gap-4">
      <Card tight title="Legal holds" description="Held records are skipped by retention purges, and an employee's records under hold cannot be deleted.">
        <Table head={["Hold", "Scope", "Reason", "Placed", "Status", ""]} empty={holds.length === 0}>
          {holds.map((h) => <tr key={h.id}><td><strong>{h.name}</strong>{h.matterRef ? <div className="text-xs muted">{h.matterRef}</div> : null}</td><td className="text-xs">{[h.employeeId ? empName.get(h.employeeId) : "Everyone", h.dataType ? RETENTION_DATA_TYPES[h.dataType as keyof typeof RETENTION_DATA_TYPES]?.label : "All data"].join(" · ")}</td><td className="text-xs">{h.reason}</td><td className="text-xs">{fmtDate(h.createdAt)}</td><td><Pill s={h.releasedAt ? "CLOSED" : "ACTIVE"} /></td>
            <td>{manage && !h.releasedAt ? <ActButton action={releaseLegalHoldAction} hidden={{ id: h.id }} label="Release" variant="ghost" confirmText="Release this hold? Retention applies again." /> : null}</td></tr>)}
        </Table>
      </Card>
      {manage ? (
        <Card title="Place a hold">
          <SpecForm action={createLegalHoldAction} submitLabel="Place hold" fields={[
            { name: "name", label: "Name", required: true, placeholder: "Labour court matter" }, { name: "matterRef", label: "Matter reference" },
            { name: "employeeId", label: "Employee", type: "select", options: employees, placeholder: "Everyone" }, { name: "dataType", label: "Data", type: "select", options: DATA_TYPES, placeholder: "All data" },
            { name: "reason", label: "Reason", type: "textarea", required: true, wide: true },
          ]} />
        </Card>
      ) : null}
    </div>
  );
}

async function Findings({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const [rows, users, items] = await Promise.all([
    prisma.auditFinding.findMany({ where: { tenantId }, orderBy: [{ status: "asc" }, { dueOn: "asc" }] }),
    userOptions(tenantId), prisma.complianceItem.findMany({ where: { tenantId }, select: { id: true, title: true }, orderBy: { title: "asc" } }),
  ]);
  const names = await userNames(tenantId, rows.map((r) => r.ownerUserId));
  const now = new Date();
  return (
    <div className="stack gap-4">
      <Card tight title="Audit findings" description="Overdue findings are escalated to compliance managers by the nightly job." action={<a className="btn sm" href="/admin/governance/export?report=findings">Export CSV</a>}>
        <Table head={["Finding", "Severity", "Owner", "Due", "Status", "Corrective action", ""]} empty={rows.length === 0}>
          {rows.map((r) => <tr key={r.id}><td><strong>{r.title}</strong><div className="text-xs muted">{r.source.replace(/_/g, " ").toLowerCase()}</div></td><td><Pill s={r.severity} /></td><td>{names.get(r.ownerUserId)}</td>
            <td>{fmtDate(r.dueOn)}{r.status !== "CLOSED" && r.dueOn < now ? <> <Pill s="OVERDUE" /></> : null}{r.escalatedAt ? <div className="text-xs muted">escalated {fmtDate(r.escalatedAt)}</div> : null}</td><td><Pill s={r.status} /></td>
            <td className="text-xs">{r.correctiveAction}{r.closureNote ? <div>Closed: {r.closureNote}</div> : null}</td>
            <td className="stack gap-2">{r.status === "OPEN" ? <ActButton action={findingOpAction} hidden={{ id: r.id, op: "remediate" }} label="Start remediation" input={{ name: "note", placeholder: "Corrective action", required: true }} /> : null}
              {manage && r.status !== "CLOSED" ? <ActButton action={findingOpAction} hidden={{ id: r.id, op: "close" }} label="Close" variant="ghost" input={{ name: "note", placeholder: "How it was verified", required: true }} /> : null}</td></tr>)}
        </Table>
      </Card>
      {manage ? (
        <Card title="Log a finding">
          <SpecForm action={saveFindingAction} submitLabel="Log" fields={[
            { name: "title", label: "Finding", required: true }, { name: "severity", label: "Severity", type: "select", required: true, options: ["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((v) => ({ value: v, label: v.toLowerCase() })) },
            { name: "source", label: "Source", type: "select", required: true, options: ["INTERNAL_AUDIT", "EXTERNAL_AUDIT", "ACCESS_REVIEW", "SELF_ASSESSMENT"].map((v) => ({ value: v, label: v.replace("_", " ").toLowerCase() })) },
            { name: "ownerUserId", label: "Owner", type: "select", options: users, required: true }, { name: "dueOn", label: "Fix by", type: "date", required: true },
            { name: "complianceItemId", label: "Related obligation", type: "select", options: items.map((i) => ({ value: i.id, label: i.title })) },
            { name: "detail", label: "Detail", type: "textarea", wide: true },
          ]} />
        </Card>
      ) : null}
    </div>
  );
}

async function Integrity({ tenantId, manage, seed }: { tenantId: string; manage: boolean; seed?: string }) {
  const v = await verifyAuditLog(tenantId);
  const since = new Date(Date.now() - 90 * 86_400_000);
  const pool = await prisma.auditLog.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { id: true, createdAt: true, module: true, action: true, summary: true, actorLabel: true }, orderBy: { createdAt: "desc" }, take: 2000 });
  const s = seed && /^[\w-]{1,40}$/.test(seed) ? seed : new Date().toISOString().slice(0, 10);
  const sample = seededSample(pool, 25, s);
  return (
    <div className="stack gap-4">
      <div className="grid grid-3"><Stat label="Sealed entries checked" value={v.checked} /><Stat label="Waiting to be sealed" value={v.unsealed} meta="Sealed nightly" /><Stat label="Problems" value={v.problems.length} tone={v.problems.length ? "neg" : "pos"} /></div>
      <Callout tone={v.problems.length ? "danger" : "success"} title={v.problems.length ? "The audit log does not match its seals" : "Audit log intact"}>
        Each audit entry is hashed together with the previous seal, so changing or removing an entry breaks the chain from that point. {v.head ? <>Head: <span className="mono text-xs">{v.head.slice(0, 16)}…</span></> : "Nothing sealed yet."}
      </Callout>
      <Card tight title="Verification" action={<div className="row gap-2">{manage ? <ActButton action={sealAuditLogAction} hidden={{}} label="Seal and verify now" variant="primary" /> : null}<a className="btn sm" href="/admin/governance/export?report=audit-integrity">Export CSV</a></div>}>
        <Table head={["Seal", "Audit entry", "Problem"]} empty={v.problems.length === 0}>
          {v.problems.slice(0, 100).map((p) => <tr key={`${p.seq}-${p.problem}`}><td className="num">{p.seq}</td><td className="mono text-xs">{p.auditLogId}</td><td><Pill s={p.problem === "MISSING" ? "OVERDUE" : "FAILED"} /> {p.problem.replace("_", " ").toLowerCase()}</td></tr>)}
        </Table>
      </Card>
      <Card tight title={`Audit sample (${sample.length} of ${pool.length}, last 90 days)`} description="A reproducible random sample for auditors: the same seed always picks the same entries.">
        <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="integrity" /><input className="input" name="seed" defaultValue={s} /><button className="btn sm">Resample</button><a className="btn sm ghost" href={`/admin/governance/export?report=audit-sample&seed=${encodeURIComponent(s)}`}>Export CSV</a></form>
        <Table head={["When", "Module", "Action", "Summary", "By"]} empty={sample.length === 0}>
          {sample.map((a) => <tr key={a.id}><td className="text-xs">{fmtWhen(a.createdAt)}</td><td className="text-xs">{a.module}</td><td className="text-xs">{a.action}</td><td className="text-xs">{a.summary}</td><td className="text-xs">{a.actorLabel}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}
