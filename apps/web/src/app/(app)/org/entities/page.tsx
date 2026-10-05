import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { entityReadiness, ENTITY_TAX_TYPES, ACQUISITION_STEPS } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat, Progress } from "@/components/ui";
import { SpecForm, SpecDisclosure, ActionButton, type FieldSpec } from "@/components/spec-form";
import {
  saveEntityTaxRegistrationAction, deleteEntityRecordAction, linkEntityHolidayCalendarAction, generatePayrollCalendarAction, setPayrollCalendarStatusAction,
  saveBuJurisdictionAction, uploadEntityDocumentAction, saveComplianceDeadlineAction, completeComplianceDeadlineAction, requestIntercompanyAssignmentAction,
  endIntercompanyAssignmentAction, saveTransferRuleAction, createEntityTransitionAction, mapTransitionPeopleAction, toggleAcquisitionStepAction,
  submitEntityTransitionAction, applyEntityTransitionAction, setNumberSeriesEntityAction,
} from "@/app/actions/core2-org";

export const metadata = { title: "Entity operations — BooS-HR" };

const P = PERMISSIONS;
const TABS = { entity: "Entity workspace", intercompany: "Intercompany", rules: "Transfer rules", transitions: "Mergers & acquisitions", reconcile: "Cost centre check" } as const;
type Tab = keyof typeof TABS;
type SP = { tab?: string; id?: string };
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Running a legal entity: readiness to hold people and run payroll, its tax
 * registrations, holiday and payroll calendars, documents and compliance
 * deadlines, the tax jurisdictions of its business units and its number
 * series; people lent between entities; transfer rules; mergers, spin-offs
 * and acquisitions; and whether cost centres book to the right entity.
 */
export default async function EntitiesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const sp = await searchParams;
  const tab: Tab = sp.tab && sp.tab in TABS ? (sp.tab as Tab) : "entity";
  const entities = await prisma.legalEntity.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true, isActive: true }, orderBy: { name: "asc" } });
  return (
    <>
      <PageHead title="Entity operations" subtitle="Readiness, registrations, calendars, documents, deadlines and cross-entity moves" actions={<><Link className="btn" href="/org">Organisation</Link><a className="btn" href="/exports/core2/entities">Export entity data</a></>} />
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((k) => <Link key={k} href={`/org/entities?tab=${k}`} className={`tab${tab === k ? " active" : ""}`}>{TABS[k]}</Link>)}
      </div>
      {!entities.length ? <Empty title="No legal entities yet">Add one under Organisation first.</Empty> : null}
      {entities.length && tab === "entity" ? <Workspace tenantId={viewer.tenantId} entities={entities} id={sp.id} /> : null}
      {entities.length && tab === "intercompany" ? <Intercompany tenantId={viewer.tenantId} entities={entities} /> : null}
      {entities.length && tab === "rules" ? <Rules tenantId={viewer.tenantId} entities={entities} /> : null}
      {entities.length && tab === "transitions" ? <Transitions tenantId={viewer.tenantId} entities={entities} /> : null}
      {entities.length && tab === "reconcile" ? <Reconcile tenantId={viewer.tenantId} /> : null}
    </>
  );
}

type Ent = Array<{ id: string; name: string; isActive: boolean }>;

async function Workspace({ tenantId, entities, id }: { tenantId: string; entities: Ent; id?: string }) {
  const le = entities.find((e) => e.id === id) ?? entities[0]!;
  const now = new Date();
  const [full, regs, links, cals, payroll, docs, deadlines, units, juris, series, allSeries, people] = await Promise.all([
    prisma.legalEntity.findUniqueOrThrow({ where: { id: le.id }, include: { _count: { select: { signatories: true, bankAccounts: true, businessUnits: true } }, payGroups: { select: { id: true, filingDetail: { select: { id: true } } } } } }),
    prisma.entityTaxRegistration.findMany({ where: { tenantId, legalEntityId: le.id }, orderBy: { type: "asc" } }),
    prisma.entityHolidayCalendar.findMany({ where: { tenantId, legalEntityId: le.id } }),
    prisma.holidayCalendar.findMany({ where: { tenantId }, select: { id: true, name: true, year: true }, orderBy: [{ year: "desc" }, { name: "asc" }] }),
    prisma.entityPayrollCalendar.findMany({ where: { tenantId, legalEntityId: le.id }, orderBy: [{ year: "asc" }, { month: "asc" }] }),
    prisma.entityDocument.findMany({ where: { tenantId, legalEntityId: le.id }, orderBy: { createdAt: "desc" } }),
    prisma.entityComplianceDeadline.findMany({ where: { tenantId, legalEntityId: le.id }, orderBy: { dueDate: "asc" } }),
    prisma.businessUnit.findMany({ where: { tenantId, legalEntityId: le.id }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.businessUnitJurisdiction.findMany({ where: { tenantId } }),
    prisma.employeeNumberSeries.findMany({ where: { tenantId, legalEntityId: le.id }, select: { id: true, name: true, prefix: true } }),
    prisma.employeeNumberSeries.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, legalEntityId: true } }),
    prisma.employee.count({ where: { tenantId, legalEntityId: le.id, status: { not: "EXITED" } } }),
  ]);
  const unitIds = new Set(units.map((u) => u.id));
  const myJuris = juris.filter((j) => unitIds.has(j.businessUnitId));
  const ahead = payroll.filter((p) => p.payDate >= now).length;
  const ready = entityReadiness({
    hasAddress: !!full.addressLine1, hasCin: !!full.cin, signatories: full._count.signatories, bankAccounts: full._count.bankAccounts,
    payGroups: full.payGroups.length, payGroupsWithFiling: full.payGroups.filter((g) => g.filingDetail).length, taxTypes: regs.map((r) => r.type),
    holidayCalendars: links.length, payrollMonthsAhead: ahead, businessUnits: full._count.businessUnits, employees: people,
    overdueDeadlines: deadlines.filter((d) => d.status === "OPEN" && d.dueDate < now).length,
  });
  const calName = new Map(cals.map((c) => [c.id, `${c.name} (${c.year})`]));
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const del = (kind: string, rid: string) => <ActionButton action={deleteEntityRecordAction} hidden={{ kind, id: rid }} label="Remove" variant="danger" confirm="Remove this?" />;
  const leField = { legalEntityId: le.id };
  return (
    <>
      <form method="get" className="row gap-2" style={{ marginBottom: 12 }}>
        <input type="hidden" name="tab" value="entity" />
        <select className="select" name="id" defaultValue={le.id}>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}{e.isActive ? "" : " (inactive)"}</option>)}</select>
        <button className="btn" type="submit">Open</button>
      </form>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Readiness" value={`${ready.score}%`} meta={<Progress value={ready.score} tone={ready.score >= 80 ? "success" : "warning"} />} />
        <Stat label="People" value={people} />
        <Stat label="Payroll months planned ahead" value={ahead} />
        <Stat label="Open deadlines" value={deadlines.filter((d) => d.status === "OPEN").length} />
      </div>
      <Card title="Readiness checklist">
        <div className="table-wrap"><table className="data"><tbody>{ready.items.map((i) => <tr key={i.key}><td>{i.label}</td><td className="text-sm muted">{i.detail ?? ""}</td><td>{i.done ? <Badge tone="success">Done</Badge> : <Badge tone="warning">To do</Badge>}</td></tr>)}</tbody></table></div>
      </Card>
      <div className="grid grid-2">
        <Card title="Tax registrations" description="PAN, TAN, GSTIN and state registrations held by this entity.">
          <SpecDisclosure label="Add a registration"><SpecForm action={saveEntityTaxRegistrationAction} hidden={leField} fields={[
            { name: "type", label: "Type", kind: "select", required: true, options: ENTITY_TAX_TYPES.map((t) => ({ value: t, label: t })) },
            { name: "number", label: "Number", required: true }, { name: "stateCode", label: "State (for PT, LWF, GST)" },
            { name: "validFrom", label: "Valid from", kind: "date" }, { name: "validTo", label: "Valid to", kind: "date" }, { name: "note", label: "Note", wide: true },
          ]} /></SpecDisclosure>
          {regs.length ? <ul>{regs.map((r) => <li key={r.id} className="row gap-2"><Badge>{r.type}</Badge> <span className="mono">{r.number}</span>{r.stateCode ? ` · ${r.stateCode}` : ""}{r.validTo ? ` · until ${formatDate(r.validTo)}` : ""} {del("tax", r.id)}</li>)}</ul> : null}
        </Card>
        <Card title="Holiday calendars" description="Calendars this entity's people follow.">
          <SpecForm compact action={linkEntityHolidayCalendarAction} hidden={leField} submitLabel="Link" fields={[{ name: "holidayCalendarId", label: "Calendar", kind: "select", required: true, options: cals.map((c) => ({ value: c.id, label: `${c.name} (${c.year})` })) }]} />
          {links.length ? <ul>{links.map((l) => <li key={l.id} className="row gap-2">{calName.get(l.holidayCalendarId) ?? "?"} {del("calendar", l.id)}</li>)}</ul> : null}
        </Card>
      </div>
      <Card title="Payroll calendar" description="Input cut-off and pay date per month.">
        <SpecDisclosure label="Plan a year"><SpecForm action={generatePayrollCalendarAction} hidden={leField} fields={[
          { name: "year", label: "Year", kind: "number", required: true, defaultValue: now.getUTCFullYear() }, { name: "cutoffDay", label: "Input cut-off day", kind: "number", required: true, defaultValue: 20 },
          { name: "payDay", label: "Pay day (last day if the month is shorter)", kind: "number", required: true, defaultValue: 30 },
        ]} /></SpecDisclosure>
        {payroll.length ? (
          <div className="table-wrap" style={{ marginTop: 10 }}><table className="data">
            <thead><tr><th>Month</th><th>Input cut-off</th><th>Pay date</th><th>Status</th><th /></tr></thead>
            <tbody>{payroll.map((p) => <tr key={p.id}><td>{p.month}/{p.year}</td><td>{formatDate(p.inputCutoff)}</td><td>{formatDate(p.payDate)}</td><td><Badge>{p.status.toLowerCase()}</Badge></td><td><div className="row gap-1">{p.status === "PLANNED" ? <ActionButton action={setPayrollCalendarStatusAction} hidden={{ id: p.id, status: "LOCKED" }} label="Lock" /> : null}{p.status === "LOCKED" ? <ActionButton action={setPayrollCalendarStatusAction} hidden={{ id: p.id, status: "PAID" }} label="Mark paid" /> : null}</div></td></tr>)}</tbody>
          </table></div>
        ) : null}
      </Card>
      <div className="grid grid-2">
        <Card title="Documents" description="Incorporation papers, registrations, licences and agreements.">
          <SpecDisclosure label="Add a document"><SpecForm action={uploadEntityDocumentAction} hidden={leField} fields={[
            { name: "title", label: "Title", required: true }, { name: "category", label: "Category", kind: "select", defaultValue: "OTHER", options: ["INCORPORATION", "REGISTRATION", "LICENCE", "AGREEMENT", "POLICY", "OTHER"].map((c) => ({ value: c, label: c.charAt(0) + c.slice(1).toLowerCase() })) },
            { name: "reference", label: "Reference number" }, { name: "validUntil", label: "Valid until", kind: "date" }, { name: "file", label: "File", kind: "file", wide: true },
          ]} /></SpecDisclosure>
          {docs.length ? <ul>{docs.map((d) => <li key={d.id} className="row gap-2 wrap">{d.fileId ? <a href={`/files/${d.fileId}`}>{d.title}</a> : d.title} <Badge>{d.category.toLowerCase()}</Badge>{d.reference ? <span className="mono text-xs">{d.reference}</span> : null}{d.validUntil ? <Badge tone={d.validUntil < now ? "danger" : "neutral"}>until {formatDate(d.validUntil)}</Badge> : null} {del("document", d.id)}</li>)}</ul> : null}
        </Card>
        <Card title="Compliance deadlines" description="Filings and renewals for this entity; recurring ones roll forward when done.">
          <SpecDisclosure label="Add a deadline"><SpecForm action={saveComplianceDeadlineAction} hidden={leField} fields={[
            { name: "title", label: "What", required: true, placeholder: "PT return (Karnataka)" }, { name: "dueDate", label: "Due", kind: "date", required: true },
            { name: "category", label: "Category", kind: "select", defaultValue: "STATUTORY", options: ["STATUTORY", "TAX", "PAYROLL", "CORPORATE", "OTHER"].map((c) => ({ value: c, label: c.charAt(0) + c.slice(1).toLowerCase() })) },
            { name: "recurrence", label: "Repeats", kind: "select", defaultValue: "NONE", options: ["NONE", "MONTHLY", "QUARTERLY", "ANNUAL"].map((c) => ({ value: c, label: c.charAt(0) + c.slice(1).toLowerCase() })) },
          ]} /></SpecDisclosure>
          {deadlines.length ? <ul>{deadlines.map((d) => <li key={d.id} className="row gap-2 wrap">{d.title} · {formatDate(d.dueDate)} {d.status === "DONE" ? <Badge tone="success">done</Badge> : d.dueDate < now ? <Badge tone="danger">overdue</Badge> : <Badge>open</Badge>}{d.recurrence !== "NONE" ? <span className="text-xs muted">{d.recurrence.toLowerCase()}</span> : null}{d.status === "OPEN" ? <ActionButton action={completeComplianceDeadlineAction} hidden={{ id: d.id }} label="Done" /> : null}</li>)}</ul> : null}
        </Card>
      </div>
      <div className="grid grid-2">
        <Card title="Business unit tax jurisdictions" description="Where each unit is registered for PT, LWF, GST and shops & establishments.">
          {units.length ? <SpecDisclosure label="Map a jurisdiction"><SpecForm action={saveBuJurisdictionAction} fields={[
            { name: "businessUnitId", label: "Business unit", kind: "select", required: true, options: units.map((u) => ({ value: u.id, label: u.name })) },
            { name: "stateCode", label: "State", required: true, placeholder: "KA" },
            { name: "taxType", label: "Tax", kind: "select", required: true, options: ["PT", "LWF", "GST", "SHOPS", "OTHER"].map((c) => ({ value: c, label: c })) }, { name: "registrationNo", label: "Registration no." },
          ]} /></SpecDisclosure> : <Empty title="No business units in this entity" />}
          {myJuris.length ? <ul>{myJuris.map((j) => <li key={j.id} className="row gap-2">{unitName.get(j.businessUnitId)}: {j.taxType} in {j.stateCode}{j.registrationNo ? ` (${j.registrationNo})` : ""} {del("jurisdiction", j.id)}</li>)}</ul> : null}
        </Card>
        <Card title="Employee number series" description="New hires in this entity draw numbers from its own series.">
          <SpecForm compact action={setNumberSeriesEntityAction} hidden={leField} submitLabel="Use for this entity" fields={[{ name: "seriesId", label: "Series", kind: "select", required: true, options: allSeries.map((s) => ({ value: s.id, label: `${s.name}${s.legalEntityId && s.legalEntityId !== le.id ? " (another entity)" : ""}` })) }]} />
          {series.length ? <ul>{series.map((s) => <li key={s.id} className="row gap-2">{s.name} <span className="mono text-xs">{s.prefix}…</span><ActionButton action={setNumberSeriesEntityAction} hidden={{ seriesId: s.id, legalEntityId: "" }} label="Untie" /></li>)}</ul> : <div className="text-sm muted">Uses the company default series.</div>}
        </Card>
      </div>
    </>
  );
}

async function people(tenantId: string) {
  return prisma.employee.findMany({ where: { tenantId, status: { not: "EXITED" } }, select: { id: true, displayName: true, employeeNumber: true, legalEntityId: true }, orderBy: { firstName: "asc" } });
}

async function Intercompany({ tenantId, entities }: { tenantId: string; entities: Ent }) {
  const [rows, emps] = await Promise.all([prisma.intercompanyAssignment.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }), people(tenantId)]);
  const name = new Map<string, string>([...entities.map((e) => [e.id, e.name] as [string, string]), ...emps.map((e) => [e.id, e.displayName] as [string, string])]);
  return (
    <Card title="Intercompany assignments" description="Lend someone's time to another entity for a period; the host entity's administrator approves it." action={<a className="btn sm" href="/exports/core2/intercompany">Export</a>}>
      <SpecDisclosure label="Assign someone"><SpecForm action={requestIntercompanyAssignmentAction} fields={[
        { name: "employeeId", label: "Person", kind: "select", required: true, options: emps.map((e) => ({ value: e.id, label: `${e.displayName} (${e.employeeNumber})` })) },
        { name: "hostEntityId", label: "Host entity", kind: "select", required: true, options: entities.map((e) => ({ value: e.id, label: e.name })) },
        { name: "startDate", label: "From", kind: "date", required: true }, { name: "endDate", label: "Until", kind: "date" },
        { name: "allocationPct", label: "Share of time (%)", kind: "number", required: true, defaultValue: 50 }, { name: "purpose", label: "Purpose", wide: true },
      ]} /></SpecDisclosure>
      {rows.length ? (
        <div className="table-wrap" style={{ marginTop: 10 }}><table className="data">
          <thead><tr><th>Person</th><th>From → to entity</th><th>Period</th><th>Share</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{name.get(r.employeeId)}</td><td>{name.get(r.homeEntityId)} → {name.get(r.hostEntityId)}</td><td className="text-sm">{iso(r.startDate)} – {r.endDate ? iso(r.endDate) : "open"}</td><td>{r.allocationPct}%</td><td><Badge tone={r.status === "ACTIVE" ? "success" : r.status === "REJECTED" ? "danger" : "neutral"}>{r.status.toLowerCase().replace("_", " ")}</Badge></td><td>{r.status === "ACTIVE" ? <ActionButton action={endIntercompanyAssignmentAction} hidden={{ id: r.id }} label="End" /> : null}</td></tr>)}</tbody>
        </table></div>
      ) : <Empty title="No assignments" />}
    </Card>
  );
}

async function Rules({ tenantId, entities }: { tenantId: string; entities: Ent }) {
  const rules = await prisma.entityTransferRule.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  const name = new Map(entities.map((e) => [e.id, e.name]));
  const opts = entities.map((e) => ({ value: e.id, label: e.name }));
  const fields: FieldSpec[] = [
    { name: "fromEntityId", label: "From (blank = any)", kind: "select", options: opts }, { name: "toEntityId", label: "To (blank = any)", kind: "select", options: opts },
    { name: "minNoticeDays", label: "Minimum notice (days)", kind: "number", defaultValue: 0 }, { name: "requiresApproval", label: "Needs approval", kind: "checkbox", defaultChecked: true },
    { name: "carryForwardLeave", label: "Leave balances carry over", kind: "checkbox", defaultChecked: true }, { name: "restartProbation", label: "Probation restarts", kind: "checkbox" },
    { name: "newEmployeeNumber", label: "New employee number", kind: "checkbox" }, { name: "note", label: "Note", wide: true },
  ];
  return (
    <Card title="Cross-entity transfer rules" description="What a move between entities needs. The most specific rule wins; job changes that move entity are checked against it.">
      <SpecDisclosure label="Add a rule"><SpecForm action={saveTransferRuleAction} fields={fields} /></SpecDisclosure>
      {rules.length ? (
        <div className="table-wrap" style={{ marginTop: 10 }}><table className="data">
          <thead><tr><th>From</th><th>To</th><th>Notice</th><th>Approval</th><th>Leave</th><th>Probation</th><th>Number</th><th /></tr></thead>
          <tbody>{rules.map((r) => <tr key={r.id}><td>{r.fromEntityId ? name.get(r.fromEntityId) : "Any"}</td><td>{r.toEntityId ? name.get(r.toEntityId) : "Any"}</td><td>{r.minNoticeDays} days</td><td>{r.requiresApproval ? "Yes" : "No"}</td><td>{r.carryForwardLeave ? "Carries over" : "Resets"}</td><td>{r.restartProbation ? "Restarts" : "—"}</td><td>{r.newEmployeeNumber ? "New" : "Kept"}</td><td><ActionButton action={deleteEntityRecordAction} hidden={{ kind: "rule", id: r.id }} label="Remove" variant="danger" confirm="Remove the rule?" /></td></tr>)}</tbody>
        </table></div>
      ) : <Empty title="No rules">Moves between entities follow the normal job-change approval.</Empty>}
    </Card>
  );
}

async function Transitions({ tenantId, entities }: { tenantId: string; entities: Ent }) {
  const [rows, emps, units] = await Promise.all([prisma.entityTransition.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }), people(tenantId), prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true, legalEntityId: true } })]);
  const name = new Map<string, string>([...entities.map((e) => [e.id, e.name] as [string, string]), ...emps.map((e) => [e.id, e.displayName] as [string, string]), ...units.map((u) => [u.id, u.name] as [string, string])]);
  const opts = entities.map((e) => ({ value: e.id, label: e.name }));
  return (
    <>
      <Card title="Mergers, spin-offs and acquisitions" description="Map who moves where, get it approved, and apply it on the effective date as dated transfers.">
        <SpecDisclosure label="Plan a transition"><SpecForm action={createEntityTransitionAction} fields={[
          { name: "kind", label: "Kind", kind: "select", required: true, options: [{ value: "MERGER", label: "Merger (everyone in the source moves)" }, { value: "SPINOFF", label: "Spin-off (chosen people move)" }, { value: "ACQUISITION", label: "Acquisition (onboard an acquired team)" }] },
          { name: "name", label: "Name", required: true }, { name: "sourceEntityId", label: "From entity", kind: "select", options: opts }, { name: "targetEntityId", label: "To entity", kind: "select", required: true, options: opts },
          { name: "effectiveDate", label: "Effective", kind: "date", required: true }, { name: "deactivateSource", label: "Deactivate the source entity after a merger", kind: "checkbox" },
        ]} /></SpecDisclosure>
      </Card>
      {rows.map((t) => {
        const mapping = (t.mapping ?? []) as Array<{ employeeId: string; businessUnitId?: string | null }>;
        const editable = ["DRAFT", "REJECTED"].includes(t.status);
        const pool = emps.filter((e) => !t.sourceEntityId || e.legalEntityId === t.sourceEntityId);
        const targetUnits = units.filter((u) => u.legalEntityId === t.targetEntityId);
        return (
          <Card key={t.id} title={`${t.name}`} description={`${t.kind.toLowerCase()} · ${t.sourceEntityId ? `${name.get(t.sourceEntityId)} → ` : ""}${name.get(t.targetEntityId)} · effective ${formatDate(t.effectiveDate)}`} action={<Badge tone={t.status === "APPLIED" ? "success" : t.status === "REJECTED" ? "danger" : "neutral"}>{t.status.toLowerCase().replace("_", " ")}</Badge>}>
            <div className="text-sm">{mapping.length} people mapped: {mapping.slice(0, 12).map((m) => `${name.get(m.employeeId)}${m.businessUnitId ? ` → ${name.get(m.businessUnitId)}` : ""}`).join(", ")}{mapping.length > 12 ? " …" : ""}</div>
            {t.kind === "ACQUISITION" ? (
              <ul style={{ marginTop: 8 }}>{ACQUISITION_STEPS.map((s) => <li key={s.key} className="row gap-2">{t.stepsDone.includes(s.key) ? "✓" : "○"} {s.label} <ActionButton action={toggleAcquisitionStepAction} hidden={{ id: t.id, step: s.key }} label={t.stepsDone.includes(s.key) ? "Reopen" : "Done"} /></li>)}</ul>
            ) : null}
            {editable ? <div style={{ marginTop: 10 }}><SpecForm compact action={mapTransitionPeopleAction} hidden={{ transitionId: t.id }} submitLabel="Map" fields={[
              { name: "employeeIds", label: "People", kind: "multi", options: pool.map((e) => ({ value: e.id, label: `${e.displayName} (${e.employeeNumber})` })), wide: true },
              { name: "businessUnitId", label: "Into business unit", kind: "select", options: targetUnits.map((u) => ({ value: u.id, label: u.name })) },
              { name: "remove", label: "Remove them instead", kind: "select", options: [{ value: "1", label: "Yes, unmap" }] },
            ]} /></div> : null}
            <div className="row gap-2" style={{ marginTop: 8 }}>
              {editable ? <ActionButton action={submitEntityTransitionAction} hidden={{ id: t.id }} label="Send for approval" variant="primary" /> : null}
              {t.status === "APPROVED" ? <ActionButton action={applyEntityTransitionAction} hidden={{ id: t.id }} label="Apply" variant="primary" confirm="Move everyone mapped now?" /> : null}
            </div>
          </Card>
        );
      })}
    </>
  );
}

async function Reconcile({ tenantId }: { tenantId: string }) {
  const [emps, ccs, entities] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId, status: { not: "EXITED" }, costCenterId: { not: null } }, select: { id: true, displayName: true, employeeNumber: true, legalEntityId: true, costCenterId: true } }),
    prisma.costCenter.findMany({ where: { tenantId }, select: { id: true, name: true, legalEntityId: true } }),
    prisma.legalEntity.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);
  const cc = new Map(ccs.map((c) => [c.id, c]));
  const le = new Map(entities.map((e) => [e.id, e.name]));
  const mismatched = emps.filter((e) => { const c = cc.get(e.costCenterId!); return c?.legalEntityId && c.legalEntityId !== e.legalEntityId; });
  const unmapped = ccs.filter((c) => !c.legalEntityId);
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="People with a cost centre" value={emps.length} />
        <Stat label="Booking to another entity" value={mismatched.length} tone={mismatched.length ? "neg" : undefined} />
        <Stat label="Cost centres without an entity" value={unmapped.length} />
      </div>
      <Card title="People whose cost centre belongs to another entity" action={<a className="btn sm" href="/exports/core2/cost-centre-reconciliation">Export</a>}>
        {mismatched.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Person</th><th>Their entity</th><th>Cost centre</th><th>Cost centre's entity</th></tr></thead>
            <tbody>{mismatched.map((e) => { const c = cc.get(e.costCenterId!)!; return <tr key={e.id}><td><Link href={`/employees/${e.id}`}>{e.displayName}</Link> <span className="muted text-xs">{e.employeeNumber}</span></td><td>{e.legalEntityId ? le.get(e.legalEntityId) : "—"}</td><td>{c.name}</td><td>{le.get(c.legalEntityId!)}</td></tr>; })}</tbody>
          </table></div>
        ) : <Empty title="Everything reconciles" />}
      </Card>
      {unmapped.length ? <Card title="Cost centres not tied to an entity" description="Set the entity under Org hierarchy → Cost centres."><div className="row gap-2 wrap">{unmapped.map((c) => <Badge key={c.id}>{c.name}</Badge>)}</div></Card> : null}
    </>
  );
}
