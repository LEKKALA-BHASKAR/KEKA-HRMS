import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, employeeScopeFilter } from "@keka/rbac";
import { letterSearchWhere, templateUsage, getLetterSettings, formatLetterNumber, LETTER_TRIGGER_EVENTS, LETTER_CATEGORIES, LETTER_STATUS_LABEL } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { forbidden } from "next/navigation";
import { employeeOptions, userNames, fmtDate } from "@/lib/governance";
import { PageHead, Card, Callout } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { bulkLettersAction, saveLetterSeriesAction, saveLetterTriggerAction, saveLetterSettingsAction, resendLetterAction } from "@/app/actions/doc-ops";
import { DocumentsTabs } from "../tabs";

export const metadata = { title: "Letter operations" };
const TABS = { search: "Search letters", bulk: "Bulk generate", series: "Numbering", triggers: "Automatic letters", usage: "Template usage", settings: "Settings" };
type Tab = keyof typeof TABS;
const d = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null);

/**
 * Documents › Letter operations: search every issued letter (and export
 * it), generate letters in bulk, number them from series, issue them
 * automatically on exit, salary revision or confirmation, resend, and see
 * how each template is used. Template approval and owner reviews are on
 * each template's page.
 */
export default async function LettersAdminPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [PERMISSIONS.LETTER_GENERATE, PERMISSIONS.DOCUMENT_TEMPLATE_MANAGE])) forbidden();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "search";
  const t = viewer.tenantId;
  const manageTemplates = can(viewer, PERMISSIONS.DOCUMENT_TEMPLATE_MANAGE), generate = can(viewer, PERMISSIONS.LETTER_GENERATE);
  const scope = employeeScopeFilter(viewer, PERMISSIONS.LETTER_GENERATE) as Prisma.EmployeeWhereInput | null;
  const templates = await prisma.documentTemplate.findMany({ where: { tenantId: t, isArchived: false }, select: { id: true, name: true, category: true, approvalStatus: true }, orderBy: { name: "asc" } });
  const tplOpts = templates.map((x) => ({ value: x.id, label: `${x.name}${x.approvalStatus !== "APPROVED" ? ` (${x.approvalStatus.toLowerCase().replace("_", " ")})` : ""}` }));
  return (
    <>
      <PageHead title="Letter operations" subtitle="Search, bulk generation, numbering, automatic letters and template usage" />
      <DocumentsTabs />
      <Tabs base="/documents/letters-admin" tabs={TABS} active={tab} />
      {tab === "search" ? <Search tenantId={t} scope={scope} sp={sp} templates={tplOpts} canResend={generate} /> : null}
      {tab === "bulk" ? (generate ? <Bulk tenantId={t} templates={tplOpts.filter((o) => templates.find((x) => x.id === o.value)?.approvalStatus === "APPROVED")} /> : <Callout>Generating letters needs the generate-letters right.</Callout>) : null}
      {tab === "series" ? <Series tenantId={t} manage={manageTemplates} /> : null}
      {tab === "triggers" ? <Triggers tenantId={t} manage={manageTemplates} templates={tplOpts} /> : null}
      {tab === "usage" ? <Usage tenantId={t} /> : null}
      {tab === "settings" ? <Settings tenantId={t} manage={manageTemplates} /> : null}
    </>
  );
}

async function Search({ tenantId, scope, sp, templates, canResend }: { tenantId: string; scope: Prisma.EmployeeWhereInput | null; sp: Record<string, string | undefined>; templates: Array<{ value: string; label: string }>; canResend: boolean }) {
  const where = letterSearchWhere(tenantId, scope, { q: sp.q, category: sp.category, status: sp.status, templateId: sp.templateId, from: d(sp.from), to: d(sp.to) });
  const [rows, total] = await Promise.all([
    prisma.generatedDocument.findMany({ where, include: { template: { select: { name: true, category: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { issuedOn: "desc" }, take: 200 }),
    prisma.generatedDocument.count({ where }),
  ]);
  const qs = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => !!e[1] && e[0] !== "tab")).toString();
  return (
    <Card title={`Letters (${total})`} action={<Link className="btn sm" href={`/documents/letters-admin/export?${qs}`}>Export CSV</Link>}>
      <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
        <input type="hidden" name="tab" value="search" />
        <input className="input" name="q" defaultValue={sp.q ?? ""} placeholder="Number, employee or template" style={{ width: 220 }} />
        <select className="select" name="templateId" defaultValue={sp.templateId ?? ""}><option value="">Any template</option>{templates.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        <select className="select" name="category" defaultValue={sp.category ?? ""}><option value="">Any category</option>{LETTER_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}</select>
        <select className="select" name="status" defaultValue={sp.status ?? ""}><option value="">Any status</option>{Object.entries(LETTER_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input className="input" type="date" name="from" defaultValue={sp.from ?? ""} aria-label="Issued from" />
        <input className="input" type="date" name="to" defaultValue={sp.to ?? ""} aria-label="Issued to" />
        <button className="btn sm" type="submit">Search</button>
      </form>
      <Table head={["Number", "Letter", "Employee", "Issued", "Valid until", "Status", "Sent", ""]} empty={!rows.length}>
        {rows.map((l) => (
          <tr key={l.id}>
            <td className="text-sm">{l.letterNumber ?? "—"}</td>
            <td><Link href={`/documents/letters/${l.id}`}>{l.template.name}</Link>{l.triggerEvent ? <div className="muted text-xs">automatic: {LETTER_TRIGGER_EVENTS[l.triggerEvent as keyof typeof LETTER_TRIGGER_EVENTS] ?? l.triggerEvent}</div> : null}{l.batchId ? <div className="muted text-xs">bulk</div> : null}</td>
            <td>{l.employee.displayName} <span className="muted text-xs">{l.employee.employeeNumber}</span></td>
            <td>{fmtDate(l.issuedOn)}</td><td>{fmtDate(l.validUntil)}</td>
            <td><Pill s={l.status} /></td>
            <td className="num">{l.sentCount}</td>
            <td>{canResend && l.status !== "VOID" && l.status !== "REJECTED" && l.status !== "PENDING_APPROVAL" ? <ActButton action={resendLetterAction} hidden={{ id: l.id }} label="Resend" /> : null}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Bulk({ tenantId, templates }: { tenantId: string; templates: Array<{ value: string; label: string }> }) {
  const [emps, batches] = await Promise.all([employeeOptions(tenantId), prisma.letterBatch.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 20 })]);
  const tplName = new Map(templates.map((x) => [x.value, x.label]));
  return (
    <div className="stack gap-4">
      <Card title="Generate letters in bulk" description="One letter per employee from an approved template, each numbered from its series and following the template's approval/signature workflow. Up to 500 at a time.">
        <SpecForm action={bulkLettersAction} submitLabel="Generate" fields={[
          { name: "templateId", label: "Template", type: "select", options: templates, required: true },
          { name: "issuedOn", label: "Letter date", type: "date", hint: "Defaults to today; backdating is limited in Settings." },
          { name: "validUntil", label: "Valid until", type: "date" },
          { name: "employeeIds", label: "Employees", type: "multiselect", options: emps, wide: true },
        ]} />
      </Card>
      <Card title="Recent batches">
        <Table head={["When", "Template", "Generated", "Failed", "Problems"]} empty={!batches.length}>
          {batches.map((b) => <tr key={b.id}><td>{fmtDate(b.createdAt)}</td><td>{tplName.get(b.templateId) ?? "—"}</td><td className="num">{b.generated}/{b.total}</td><td className="num">{b.failed}</td><td className="text-xs">{(Array.isArray(b.results) ? (b.results as Array<{ ok: boolean; message: string }>) : []).filter((r) => !r.ok).map((r) => r.message).slice(0, 5).join("; ")}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Series({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const rows = await prisma.letterNumberSeries.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
  const now = new Date();
  return (
    <Card title="Number series" description="Each letter gets the next number from the series for its category (or the general series). Tokens: {YYYY} {YY} {MM} {CAT}.">
      <Table head={["Series", "Category", "Next number", "Yearly reset", "Active"]} empty={!rows.length}>
        {rows.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.category ?? "All others"}</td><td className="text-sm">{formatLetterNumber(s.prefix, s.digits, s.yearlyReset && s.lastYear !== null && s.lastYear !== now.getUTCFullYear() ? 1 : s.nextNumber, now, s.category)}</td><td>{s.yearlyReset ? "Yes" : "No"}</td><td>{s.isActive ? "Yes" : "No"}</td></tr>)}
      </Table>
      {manage ? (
        <div style={{ marginTop: 12 }}>
          <SpecForm action={saveLetterSeriesAction} submitLabel="Save series" columns={3} fields={[
            { name: "name", label: "Name", required: true },
            { name: "category", label: "Category", type: "select", options: LETTER_CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, " ").toLowerCase() })), placeholder: "All others" },
            { name: "prefix", label: "Prefix", defaultValue: "HR/{YYYY}/", required: true },
            { name: "digits", label: "Digits", type: "number", defaultValue: 4 },
            { name: "nextNumber", label: "Next number", type: "number", defaultValue: 1 },
            { name: "yearlyReset", label: "Yearly reset", type: "checkbox", defaultValue: true, placeholder: "Restart at 1 each year" },
          ]} />
        </div>
      ) : null}
    </Card>
  );
}

async function Triggers({ tenantId, manage, templates }: { tenantId: string; manage: boolean; templates: Array<{ value: string; label: string }> }) {
  const rows = await prisma.letterTrigger.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  const tplName = new Map(templates.map((x) => [x.value, x.label]));
  const issued = await prisma.generatedDocument.groupBy({ by: ["templateId", "triggerEvent"], where: { employee: { tenantId }, triggerEvent: { not: null } }, _count: true });
  return (
    <Card title="Automatic letters" description="Generate a letter when an exit is settled, a salary revision takes effect or an employee is confirmed. One letter per employee and event; failures are reported to template managers.">
      <Table head={["When", "Letter", "Issued so far", "Active", ""]} empty={!rows.length}>
        {rows.map((r) => <tr key={r.id}><td>{LETTER_TRIGGER_EVENTS[r.event as keyof typeof LETTER_TRIGGER_EVENTS] ?? r.event}</td><td>{tplName.get(r.templateId) ?? "(archived template)"}</td><td className="num">{issued.find((i) => i.templateId === r.templateId && i.triggerEvent === r.event)?._count ?? 0}</td><td>{r.isActive ? "Yes" : "Paused"}</td><td>{manage ? <ActButton action={saveLetterTriggerAction} hidden={{ event: r.event, templateId: r.templateId, ...(r.isActive ? { isActive: "false" } : { isActive: "true" }) }} label={r.isActive ? "Pause" : "Resume"} /> : null}</td></tr>)}
      </Table>
      {manage ? (
        <div style={{ marginTop: 12 }}>
          <SpecForm action={saveLetterTriggerAction} submitLabel="Add" fields={[
            { name: "event", label: "When", type: "select", options: Object.entries(LETTER_TRIGGER_EVENTS).map(([value, label]) => ({ value, label })), required: true },
            { name: "templateId", label: "Generate", type: "select", options: templates, required: true },
          ]} />
        </div>
      ) : null}
    </Card>
  );
}

async function Usage({ tenantId }: { tenantId: string }) {
  const since = new Date(Date.now() - 365 * 86_400_000);
  const rows = await templateUsage(tenantId, since);
  const owners = await userNames(tenantId, rows.map((r) => r.ownerUserId));
  const now = new Date();
  return (
    <Card title="Template usage, last 12 months" description="Owners review their templates on the cadence set in Settings; overdue reviews are flagged and the owner is reminded.">
      <Table head={["Template", "Version", "Approval", "Owner", "Next review", "Issued", "Signed/acked", "Pending", "Voided"]} empty={!rows.length}>
        {rows.map((r) => <tr key={r.id}><td><Link href={`/documents/templates/${r.id}`}>{r.name}</Link>{r.isArchived ? <span className="badge neutral" style={{ marginLeft: 6 }}>archived</span> : null}</td><td className="num">v{r.version}</td><td><Pill s={r.approvalStatus} /></td><td>{r.ownerUserId ? owners.get(r.ownerUserId) : "—"}</td><td className={r.nextReviewOn && r.nextReviewOn < now ? "neg" : ""}>{fmtDate(r.nextReviewOn)}</td><td className="num">{r.total}</td><td className="num">{r.signed}</td><td className="num">{r.pending}</td><td className="num">{r.voided}</td></tr>)}
      </Table>
    </Card>
  );
}

async function Settings({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const s = await getLetterSettings(tenantId);
  if (!manage) return <Callout>Only template managers change letter settings.</Callout>;
  return (
    <Card title="Letter settings">
      <SpecForm action={saveLetterSettingsAction} columns={3} fields={[
        { name: "requireTemplateApproval", label: "Template approval", type: "checkbox", defaultValue: s.requireTemplateApproval, placeholder: "New and edited templates need approval before use" },
        { name: "reviewEveryMonths", label: "Owner review every (months)", type: "number", defaultValue: s.reviewEveryMonths },
        { name: "maxBackdateDays", label: "Furthest backdating (days)", type: "number", defaultValue: s.maxBackdateDays },
      ]} />
    </Card>
  );
}
