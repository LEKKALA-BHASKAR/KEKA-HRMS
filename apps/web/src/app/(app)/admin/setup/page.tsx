import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import {
  setupCompleteness, captureConfig, diffConfigPayloads, parameterHistory, validateConfigPayload, configSummary, CONFIG_SECTIONS, CONFIG_ENVIRONMENTS,
  APPROVAL_POLICY_LIBRARY, REFERENCE_IMPORT_KINDS, type ConfigPayload, type ReferenceImportKind,
} from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout, Progress, Stat } from "@/components/ui";
import { SpecForm, SpecDisclosure, ActionButton, type FieldSpec } from "@/components/spec-form";
import {
  takeConfigSnapshotAction, restoreConfigSnapshotAction, deleteConfigSnapshotAction, importConfigAction, saveBrandingProfileAction, deleteBrandingProfileAction,
  saveCountryAvailabilityAction, deleteCountryAvailabilityAction, saveStatusCatalogAction, saveDictionaryAction, saveDictionaryEntryAction, deleteDictionaryEntryAction,
  installApprovalPolicyAction, importReferenceDataAction, saveIdCardPolicyAction,
} from "@/app/actions/core2-setup";

export const metadata = { title: "Company setup — BooS-HR" };

const P = PERMISSIONS;
const TABS = { health: "Setup health", config: "Configuration copies", reference: "Reference data", catalogs: "Catalogs", branding: "Branding", policies: "Approval policies" } as const;
type Tab = keyof typeof TABS;
type SP = { tab?: string; compare?: string; section?: string; key?: string; dep?: string };

const opt = (rows: Array<{ id: string; name: string }>) => rows.map((r) => ({ value: r.id, label: r.name }));
const MODULES = ["Core HR", "Leave", "Attendance", "Payroll", "Expenses", "Performance", "Recruitment", "Learning"].map((m) => ({ value: m, label: m }));

/**
 * Company setup, beyond the profile: how complete the setup is and what
 * depends on what; configuration checkpoints, environment copies, export,
 * import and rollback; reference data imported from a spreadsheet; the
 * employee status catalog, master dictionaries and the country matrix;
 * branding per business unit; and ready-made approval policies.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const allowed: Record<Tab, boolean> = {
    health: can(viewer, P.ORG_SETTINGS_MANAGE), config: can(viewer, P.ORG_SETTINGS_MANAGE), reference: can(viewer, P.ORG_MANAGE),
    catalogs: can(viewer, P.ORG_SETTINGS_MANAGE), branding: can(viewer, P.ORG_SETTINGS_MANAGE), policies: can(viewer, P.WORKFLOW_MANAGE) || can(viewer, P.ORG_SETTINGS_MANAGE),
  };
  const tabs = (Object.keys(TABS) as Tab[]).filter((k) => allowed[k]);
  if (!tabs.length) forbidden();
  const tab: Tab = tabs.includes(sp.tab as Tab) ? (sp.tab as Tab) : tabs[0]!;
  return (
    <>
      <PageHead title="Company setup" subtitle="Setup health, configuration copies, reference data and catalogs" actions={<Link className="btn" href="/admin/company">Company profile</Link>} />
      <div className="tabs">
        {tabs.map((k) => <Link key={k} href={`/admin/setup?tab=${k}`} className={`tab${tab === k ? " active" : ""}`}>{TABS[k]}</Link>)}
      </div>
      {tab === "health" ? <Health sp={sp} /> : null}
      {tab === "config" ? <Config sp={sp} /> : null}
      {tab === "reference" ? <Reference /> : null}
      {tab === "catalogs" ? <Catalogs /> : null}
      {tab === "branding" ? <Branding /> : null}
      {tab === "policies" ? <Policies /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------

async function Health({ sp }: { sp: SP }) {
  const viewer = await requireViewer();
  const t = viewer.tenantId;
  const active = { tenantId: t, status: { notIn: ["EXITED" as const] } };
  const [company, entities, units, depts, locs, cals, groups, leaveTypes, shifts, rules, years, emps, withMgr, withDept, series, flows, templates] = await Promise.all([
    prisma.companyProfile.findUnique({ where: { tenantId: t }, select: { id: true } }),
    prisma.legalEntity.findMany({ where: { tenantId: t }, select: { id: true, name: true, addressLine1: true, isActive: true } }),
    prisma.businessUnit.findMany({ where: { tenantId: t }, select: { id: true, name: true, isActive: true } }),
    prisma.department.findMany({ where: { tenantId: t }, select: { id: true, name: true, isActive: true, parentId: true } }),
    prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true, stateCode: true, isActive: true } }),
    prisma.holidayCalendar.count({ where: { tenantId: t } }),
    prisma.payGroup.findMany({ where: { tenantId: t }, select: { id: true, filingDetail: { select: { id: true } } } }),
    prisma.leaveType.count({ where: { tenantId: t } }),
    prisma.shift.count({ where: { tenantId: t } }),
    prisma.workingRules.findUnique({ where: { tenantId: t }, select: { id: true } }),
    prisma.fiscalYear.count({ where: { tenantId: t } }),
    prisma.employee.count({ where: active }),
    prisma.employee.count({ where: { ...active, reportingManagerId: { not: null } } }),
    prisma.employee.count({ where: { ...active, departmentId: { not: null } } }),
    prisma.employeeNumberSeries.count({ where: { tenantId: t, isActive: true } }),
    prisma.workflowDefinition.count({ where: { tenantId: t, isCurrent: true } }),
    prisma.documentTemplate.count({ where: { tenantId: t } }),
  ]);
  const { score, items } = setupCompleteness({
    companyProfile: !!company, legalEntities: entities.length, entitiesWithAddress: entities.filter((e) => e.addressLine1).length, businessUnits: units.length, departments: depts.length,
    locations: locs.length, locationsWithState: locs.filter((l) => l.stateCode).length, holidayCalendars: cals, payGroups: groups.length, payGroupsWithFiling: groups.filter((g) => g.filingDetail).length,
    leaveTypes, shifts, workingRules: !!rules, fiscalYears: years, employees: emps, employeesWithManager: withMgr, employeesWithDepartment: withDept, numberSeries: series, workflowDefinitions: flows, documentTemplates: templates,
  });
  // Inactive units that still hold people, or sub-units, are configuration that will surprise someone.
  const [byDept, byLoc, byUnit, byEntity] = await Promise.all([
    prisma.employee.groupBy({ by: ["departmentId"], where: active, _count: true }),
    prisma.employee.groupBy({ by: ["locationId"], where: active, _count: true }),
    prisma.employee.groupBy({ by: ["businessUnitId"], where: active, _count: true }),
    prisma.employee.groupBy({ by: ["legalEntityId"], where: active, _count: true }),
  ]);
  const count = (rows: Array<{ _count: number } & Record<string, unknown>>, key: string, id: string) => rows.find((r) => r[key] === id)?._count ?? 0;
  const impact = [
    ...depts.filter((d) => !d.isActive).map((d) => ({ type: "Department", name: d.name, people: count(byDept, "departmentId", d.id), children: depts.filter((c) => c.parentId === d.id && c.isActive).length })),
    ...locs.filter((d) => !d.isActive).map((d) => ({ type: "Location", name: d.name, people: count(byLoc, "locationId", d.id), children: 0 })),
    ...units.filter((d) => !d.isActive).map((d) => ({ type: "Business unit", name: d.name, people: count(byUnit, "businessUnitId", d.id), children: 0 })),
    ...entities.filter((d) => !d.isActive).map((d) => ({ type: "Legal entity", name: d.name, people: count(byEntity, "legalEntityId", d.id), children: units.filter((u) => u.isActive).length ? 0 : 0 })),
  ];
  // What depends on a unit before it is changed or retired.
  const [depType, depId] = (sp.dep ?? "").split(":");
  const depOptions = [...depts.map((d) => ({ value: `DEPARTMENT:${d.id}`, label: `Department · ${d.name}` })), ...locs.map((l) => ({ value: `LOCATION:${l.id}`, label: `Location · ${l.name}` })), ...units.map((u) => ({ value: `BUSINESS_UNIT:${u.id}`, label: `Business unit · ${u.name}` })), ...entities.map((e) => ({ value: `LEGAL_ENTITY:${e.id}`, label: `Legal entity · ${e.name}` }))];
  const deps = depType && depId ? await dependenciesOf(t, depType, depId) : null;
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Setup complete" value={`${score}%`} meta={<Progress value={score} tone={score >= 80 ? "success" : "warning"} />} />
        <Stat label="Legal entities" value={entities.length} />
        <Stat label="Departments" value={depts.length} />
        <Stat label="Inactive with people" value={impact.filter((i) => i.people > 0).length} tone={impact.some((i) => i.people > 0) ? "neg" : undefined} />
      </div>
      <Card title="Setup checklist" description="Weighted by how much each step matters to running HR and payroll.">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Step</th><th>Detail</th><th>Status</th><th /></tr></thead>
          <tbody>{items.map((i) => <tr key={i.key}><td>{i.label}</td><td className="text-sm muted">{i.detail ?? ""}</td><td>{i.done ? <Badge tone="success">Done</Badge> : <Badge tone="warning">To do</Badge>}</td><td>{i.link && !i.done ? <Link href={i.link}>Fix</Link> : null}</td></tr>)}</tbody>
        </table></div>
      </Card>
      <Card title="Inactive configuration still in use" description="Units switched off that people (or active sub-units) still sit in.">
        {impact.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Kind</th><th>Unit</th><th>Active people</th><th>Active sub-units</th></tr></thead>
            <tbody>{impact.map((i, n) => <tr key={n}><td>{i.type}</td><td>{i.name}</td><td>{i.people ? <Badge tone="danger">{i.people}</Badge> : 0}</td><td>{i.children}</td></tr>)}</tbody>
          </table></div>
        ) : <Empty title="No inactive units">Everything switched off is empty.</Empty>}
      </Card>
      <Card title="What depends on this?" description="Check what a unit carries before renaming, moving or retiring it.">
        <form method="get" className="row gap-2 wrap">
          <input type="hidden" name="tab" value="health" />
          <select className="select" name="dep" defaultValue={sp.dep ?? ""} style={{ minWidth: 280 }}>
            <option value="">Pick a unit…</option>
            {depOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button className="btn" type="submit">Check</button>
        </form>
        {deps ? (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
            <thead><tr><th>Depends on it</th><th>Count</th></tr></thead>
            <tbody>{deps.map(([label, n]) => <tr key={label}><td>{label}</td><td>{n ? <strong>{n}</strong> : <span className="muted">0</span>}</td></tr>)}</tbody>
          </table></div>
        ) : null}
      </Card>
    </>
  );
}

async function dependenciesOf(tenantId: string, type: string, id: string): Promise<Array<[string, number]>> {
  const active = { tenantId, status: { notIn: ["EXITED" as const] } };
  const units = { unitType: type, unitId: id };
  const [meta, packs, brand] = await Promise.all([
    prisma.orgUnitMetadataValue.count({ where: { tenantId, ...units } }),
    prisma.policyPackAssignment.count({ where: { ...units, pack: { tenantId } } }),
    prisma.brandingProfile.count({ where: { tenantId, ...(type === "LEGAL_ENTITY" ? { legalEntityId: id } : type === "BUSINESS_UNIT" ? { businessUnitId: id } : { id: "-" }) } }),
  ]);
  const common: Array<[string, number]> = [["Unit metadata values", meta], ["Policy packs assigned", packs], ["Branding profiles", brand]];
  if (type === "DEPARTMENT") {
    const [people, subs, positions, jobs, functions] = await Promise.all([
      prisma.employee.count({ where: { ...active, departmentId: id } }), prisma.department.count({ where: { tenantId, parentId: id } }),
      prisma.position.count({ where: { tenantId, departmentId: id } }), prisma.jobChange.count({ where: { tenantId, departmentId: id, status: { in: ["SCHEDULED", "PENDING_APPROVAL"] } } }),
      prisma.businessFunction.count({ where: { tenantId, departmentIds: { has: id } } }),
    ]);
    return [["Active employees", people], ["Sub-departments", subs], ["Positions", positions], ["Scheduled moves into it", jobs], ["Business functions", functions], ...common];
  }
  if (type === "LOCATION") {
    const [people, subs, jobs] = await Promise.all([prisma.employee.count({ where: { ...active, locationId: id } }), prisma.location.count({ where: { tenantId, parentId: id } }), prisma.jobChange.count({ where: { tenantId, locationId: id, status: { in: ["SCHEDULED", "PENDING_APPROVAL"] } } })]);
    return [["Active employees", people], ["Sub-locations", subs], ["Scheduled moves into it", jobs], ...common];
  }
  if (type === "BUSINESS_UNIT") {
    const [people, depts, subs, juris] = await Promise.all([prisma.employee.count({ where: { ...active, businessUnitId: id } }), prisma.department.count({ where: { tenantId, businessUnitId: id } }), prisma.businessUnit.count({ where: { tenantId, parentId: id } }), prisma.businessUnitJurisdiction.count({ where: { tenantId, businessUnitId: id } })]);
    return [["Active employees", people], ["Departments", depts], ["Sub-units", subs], ["Tax jurisdictions", juris], ...common];
  }
  const [people, bus, groups, ccs, regs, series] = await Promise.all([
    prisma.employee.count({ where: { ...active, legalEntityId: id } }), prisma.businessUnit.count({ where: { tenantId, legalEntityId: id } }), prisma.payGroup.count({ where: { tenantId, legalEntityId: id } }),
    prisma.costCenter.count({ where: { tenantId, legalEntityId: id } }), prisma.entityTaxRegistration.count({ where: { tenantId, legalEntityId: id } }), prisma.employeeNumberSeries.count({ where: { tenantId, legalEntityId: id } }),
  ]);
  return [["Active employees", people], ["Business units", bus], ["Pay groups", groups], ["Cost centres", ccs], ["Tax registrations", regs], ["Number series", series], ...common];
}

// ---------------------------------------------------------------------------

async function Config({ sp }: { sp: SP }) {
  const viewer = await requireViewer();
  const snaps = await prisma.configSnapshot.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { createdAt: "desc" }, take: 40 });
  const current = await captureConfig(viewer.tenantId);
  const compare = sp.compare ? snaps.find((s) => s.id === sp.compare) : null;
  const cmpPayload = compare ? validateConfigPayload(compare.payload) : null;
  const diff = cmpPayload?.ok ? diffConfigPayloads(cmpPayload.payload, current) : [];
  const objectSections = ["organisation", "company", "workingRules", "visibility"] as const;
  const section = objectSections.includes(sp.section as never) ? sp.section! : "workingRules";
  const keys = Object.keys(((current.sections as Record<string, unknown>)[section] ?? {}) as object).sort();
  const key = sp.key && keys.includes(sp.key) ? sp.key : keys[0] ?? "";
  const valid = snaps.map((s) => ({ s, v: validateConfigPayload(s.payload) })).filter((x) => x.v.ok).map((x) => ({ id: x.s.id, name: x.s.name, createdAt: x.s.createdAt, payload: (x.v as { payload: ConfigPayload }).payload }));
  const history = key ? parameterHistory([...valid, { id: "current", name: "Now", createdAt: new Date(), payload: current }], section, key) : [];
  const sectionOptions = Object.entries(CONFIG_SECTIONS).map(([value, label]) => ({ value, label }));
  const summary = configSummary(current);
  return (
    <>
      <Card title="Configuration copies" description="A checkpoint keeps the whole configuration as it is now; roll back to it, compare against it, or keep copies per environment." action={<div className="row gap-2"><a className="btn sm" href="/exports/core2/configuration-json">Export (JSON)</a><a className="btn sm" href="/exports/core2/configuration">Export (CSV)</a></div>}>
        <SpecDisclosure label="Save a checkpoint">
          <SpecForm action={takeConfigSnapshotAction} submitLabel="Save checkpoint" fields={[
            { name: "name", label: "Name", required: true, placeholder: "Before the April policy change" },
            { name: "environment", label: "Environment set", kind: "select", required: true, defaultValue: "PRODUCTION", options: CONFIG_ENVIRONMENTS.map((e) => ({ value: e, label: e.charAt(0) + e.slice(1).toLowerCase() })) },
            { name: "note", label: "Note", kind: "textarea", wide: true },
          ]} />
        </SpecDisclosure>
        {snaps.length ? (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
            <thead><tr><th>Name</th><th>Environment</th><th>Kind</th><th>Saved</th><th>Restored</th><th /></tr></thead>
            <tbody>{snaps.map((s) => (
              <tr key={s.id}>
                <td>{s.name}{s.note ? <div className="text-xs muted">{s.note}</div> : null}</td>
                <td><Badge>{s.environment.toLowerCase()}</Badge></td>
                <td className="text-sm">{s.kind.toLowerCase()}</td>
                <td className="text-sm">{formatDate(s.createdAt)}</td>
                <td className="text-sm">{s.restoredAt ? formatDate(s.restoredAt) : "—"}</td>
                <td><div className="row gap-1 wrap">
                  <Link className="btn sm" href={`/admin/setup?tab=config&compare=${s.id}`}>Compare</Link>
                  <ActionButton action={restoreConfigSnapshotAction} hidden={{ id: s.id }} label="Roll back" confirm={`Roll the configuration back to "${s.name}"? A copy of the current one is kept first.`} />
                  <ActionButton action={deleteConfigSnapshotAction} hidden={{ id: s.id }} label="Delete" variant="danger" confirm="Delete this copy?" />
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No checkpoints yet">Save one before a big change, so it can be undone.</Empty>}
      </Card>
      {compare ? (
        <Card title={`"${compare.name}" compared with now`} description={`${diff.length} setting(s) differ.`}>
          {diff.length ? (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Area</th><th>Setting</th><th>Then</th><th>Now</th></tr></thead>
              <tbody>{diff.slice(0, 200).map((d, i) => <tr key={i}><td className="text-sm">{CONFIG_SECTIONS[d.section as keyof typeof CONFIG_SECTIONS] ?? d.section}</td><td className="text-sm">{d.key}</td><td className="text-xs mono">{d.from ?? "—"}</td><td className="text-xs mono">{d.to ?? "—"}</td></tr>)}</tbody>
            </table></div>
          ) : <Callout tone="success">Nothing has changed since this copy.</Callout>}
        </Card>
      ) : null}
      <Card title="Import a configuration" description="Bring in a file exported from another environment. Check it first: nothing is written until you apply, and a copy of the current configuration is kept.">
        <SpecForm action={importConfigAction} submitLabel="Run" fields={[
          { name: "file", label: "Exported file (.json)", kind: "file" },
          { name: "intent", label: "Step", kind: "select", required: true, defaultValue: "check", options: [{ value: "check", label: "Check what would change" }, { value: "apply", label: "Apply the import" }] },
          { name: "sections", label: "Only these areas (none = all in the file)", kind: "checks", wide: true, options: sectionOptions },
          { name: "environment", label: "Label the imported copy as", kind: "select", defaultValue: "SANDBOX", options: CONFIG_ENVIRONMENTS.map((e) => ({ value: e, label: e.charAt(0) + e.slice(1).toLowerCase() })) },
          { name: "json", label: "…or paste the JSON", kind: "textarea", wide: true },
        ]} />
      </Card>
      <Card title="Setting history" description="Every value one setting has had, across the saved copies.">
        <form method="get" className="row gap-2 wrap">
          <input type="hidden" name="tab" value="config" />
          <select className="select" name="section" defaultValue={section}>{objectSections.map((s) => <option key={s} value={s}>{CONFIG_SECTIONS[s]}</option>)}</select>
          <select className="select" name="key" defaultValue={key}>{keys.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          <button className="btn" type="submit">Show</button>
        </form>
        <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
          <thead><tr><th>From copy</th><th>Saved</th><th>Value</th></tr></thead>
          <tbody>{history.map((h) => <tr key={h.snapshotId}><td>{h.name}</td><td className="text-sm">{formatDate(h.at)}</td><td className="mono text-sm">{h.value ?? "—"}</td></tr>)}</tbody>
        </table></div>
      </Card>
      <Card title="What a copy holds">
        <div className="row gap-2 wrap">{Object.entries(summary).map(([k, n]) => <Badge key={k}>{CONFIG_SECTIONS[k as keyof typeof CONFIG_SECTIONS] ?? k}: {n}</Badge>)}</div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

function Reference() {
  const kinds = Object.entries(REFERENCE_IMPORT_KINDS) as Array<[ReferenceImportKind, (typeof REFERENCE_IMPORT_KINDS)[ReferenceImportKind]]>;
  return (
    <>
      <Callout tone="info">Set up departments, locations, cost centres, business units and job titles from a spreadsheet. Download a template, fill it in, check it, then import. Rows whose name already exists update that unit; a parent can be a row earlier in the same file.</Callout>
      <Card title="Templates">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>What</th><th>Columns</th><th /></tr></thead>
          <tbody>{kinds.map(([k, v]) => <tr key={k}><td>{v.label}</td><td className="text-sm mono">{v.columns.join(", ")}</td><td><a className="btn sm" href={`/exports/core2/reference-template?kind=${k}`}>Template</a></td></tr>)}</tbody>
        </table></div>
      </Card>
      <Card title="Import reference data">
        <SpecForm action={importReferenceDataAction} submitLabel="Run" fields={[
          { name: "kind", label: "What", kind: "select", required: true, options: kinds.map(([k, v]) => ({ value: k, label: v.label })) },
          { name: "intent", label: "Step", kind: "select", required: true, defaultValue: "check", options: [{ value: "check", label: "Check the rows" }, { value: "apply", label: "Import them" }] },
          { name: "file", label: "CSV file", kind: "file" },
          { name: "csv", label: "…or paste the rows (with the header)", kind: "textarea", wide: true },
        ]} />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

async function Catalogs() {
  const viewer = await requireViewer();
  const t = viewer.tenantId;
  const [statuses, tags, dicts, countries] = await Promise.all([
    prisma.employeeStatusCatalog.findMany({ where: { tenantId: t }, orderBy: [{ baseStatus: "asc" }, { label: "asc" }] }),
    prisma.employeeStatusTag.groupBy({ by: ["catalogId"], where: { tenantId: t }, _count: true }),
    prisma.masterDictionary.findMany({ where: { tenantId: t }, include: { entries: { orderBy: [{ sortOrder: "asc" }, { label: "asc" }] } }, orderBy: { name: "asc" } }),
    prisma.countryAvailability.findMany({ where: { tenantId: t }, orderBy: { countryName: "asc" } }),
  ]);
  const base = ["ONBOARDING", "PROBATION", "CONFIRMED", "NOTICE_PERIOD", "ON_LEAVE", "SUSPENDED", "EXITED"].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase().replace("_", " ") }));
  return (
    <>
      <Card title="Employee status catalog" description="Your own statuses, each sitting under a system status (which still drives payroll and access). Set one on an employee's master data page.">
        <SpecDisclosure label="Add a status">
          <SpecForm action={saveStatusCatalogAction} fields={[
            { name: "code", label: "Code", required: true, placeholder: "SABBATICAL" }, { name: "label", label: "Label", required: true },
            { name: "baseStatus", label: "Sits under", kind: "select", required: true, options: base }, { name: "color", label: "Colour", kind: "color", defaultValue: "#6b7280" },
            { name: "description", label: "Description", wide: true }, { name: "isActive", label: "Active", kind: "checkbox", defaultChecked: true },
          ]} />
        </SpecDisclosure>
        {statuses.length ? (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
            <thead><tr><th>Status</th><th>Code</th><th>Under</th><th>People</th><th /></tr></thead>
            <tbody>{statuses.map((s) => (
              <tr key={s.id}>
                <td><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: s.color, marginRight: 6 }} />{s.label}{s.isActive ? null : <> <Badge>inactive</Badge></>}</td>
                <td className="mono text-sm">{s.code}</td><td className="text-sm">{s.baseStatus.toLowerCase().replace("_", " ")}</td>
                <td>{tags.find((x) => x.catalogId === s.id)?._count ?? 0}</td>
                <td><SpecDisclosure label="Edit"><SpecForm action={saveStatusCatalogAction} hidden={{ id: s.id }} fields={[
                  { name: "code", label: "Code", required: true, defaultValue: s.code }, { name: "label", label: "Label", required: true, defaultValue: s.label },
                  { name: "baseStatus", label: "Sits under", kind: "select", required: true, options: base, defaultValue: s.baseStatus }, { name: "color", label: "Colour", kind: "color", defaultValue: s.color },
                  { name: "description", label: "Description", wide: true, defaultValue: s.description }, { name: "isActive", label: "Active", kind: "checkbox", defaultChecked: s.isActive },
                ]} /></SpecDisclosure></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : null}
      </Card>
      <Card title="Master dictionaries" description="Company lists (grades of travel, uniform sizes, blood groups…) kept in one place.">
        <SpecDisclosure label="Add a dictionary">
          <SpecForm action={saveDictionaryAction} fields={[
            { name: "key", label: "Key", required: true, placeholder: "uniform_size" }, { name: "name", label: "Name", required: true },
            { name: "description", label: "Description", wide: true }, { name: "isActive", label: "Active", kind: "checkbox", defaultChecked: true },
          ]} />
        </SpecDisclosure>
        {dicts.map((d) => (
          <div key={d.id} style={{ marginTop: 14 }}>
            <div className="row gap-2"><strong>{d.name}</strong> <span className="mono text-xs muted">{d.key}</span>{d.isActive ? null : <Badge>inactive</Badge>}</div>
            <div className="row gap-2 wrap" style={{ margin: "6px 0" }}>
              {d.entries.map((e) => <span key={e.id} className="row gap-1"><Badge tone={e.isActive ? "info" : "neutral"}>{e.code} · {e.label}</Badge><ActionButton action={deleteDictionaryEntryAction} hidden={{ id: e.id }} label="×" confirm={`Remove ${e.label}?`} /></span>)}
            </div>
            <SpecForm compact action={saveDictionaryEntryAction} hidden={{ dictionaryId: d.id }} submitLabel="Add / update entry" fields={[
              { name: "code", label: "Code", required: true }, { name: "label", label: "Label", required: true }, { name: "sortOrder", label: "Order", kind: "number" }, { name: "isActive", label: "Active", kind: "checkbox", defaultChecked: true },
            ]} />
          </div>
        ))}
      </Card>
      <Card title="Country availability" description="Which countries the company operates in and which modules are switched on in each." action={<a className="btn sm" href="/exports/core2/countries">Export</a>}>
        <SpecDisclosure label="Add or update a country">
          <SpecForm action={saveCountryAvailabilityAction} fields={[
            { name: "countryCode", label: "Country code", required: true, placeholder: "IN" }, { name: "countryName", label: "Country", required: true },
            { name: "currency", label: "Currency", placeholder: "INR" }, { name: "isActive", label: "Active", kind: "checkbox", defaultChecked: true },
            { name: "modules", label: "Modules", kind: "checks", wide: true, options: MODULES }, { name: "note", label: "Note", wide: true },
          ]} />
        </SpecDisclosure>
        {countries.length ? (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
            <thead><tr><th>Country</th>{MODULES.map((m) => <th key={m.value} className="text-xs">{m.label}</th>)}<th /></tr></thead>
            <tbody>{countries.map((c) => (
              <tr key={c.id}>
                <td>{c.countryName} <span className="muted text-xs">{c.countryCode}{c.currency ? ` · ${c.currency}` : ""}</span>{c.isActive ? null : <> <Badge>inactive</Badge></>}</td>
                {MODULES.map((m) => <td key={m.value}>{c.modules.includes(m.value) ? "✓" : ""}</td>)}
                <td><ActionButton action={deleteCountryAvailabilityAction} hidden={{ id: c.id }} label="Remove" variant="danger" confirm={`Remove ${c.countryName}?`} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

async function Branding() {
  const viewer = await requireViewer();
  const t = viewer.tenantId;
  const [rows, entities, units] = await Promise.all([
    prisma.brandingProfile.findMany({ where: { tenantId: t }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
    prisma.legalEntity.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.businessUnit.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const fields = (b?: (typeof rows)[number]): FieldSpec[] => [
    { name: "name", label: "Profile name", required: true, defaultValue: b?.name }, { name: "portalTitle", label: "Portal title", required: true, defaultValue: b?.portalTitle ?? "BooS-HR" },
    { name: "primaryColor", label: "Primary colour", kind: "color", defaultValue: b?.primaryColor ?? "#1266a8" }, { name: "accentColor", label: "Accent colour", kind: "color", defaultValue: b?.accentColor ?? "#0f8a5f" },
    { name: "logoText", label: "Logo text", defaultValue: b?.logoText }, { name: "welcomeMessage", label: "Welcome message", defaultValue: b?.welcomeMessage },
    { name: "legalEntityId", label: "For legal entity", kind: "select", options: opt(entities), defaultValue: b?.legalEntityId }, { name: "businessUnitId", label: "For business unit", kind: "select", options: opt(units), defaultValue: b?.businessUnitId },
    { name: "isDefault", label: "Company default", kind: "checkbox", defaultChecked: b?.isDefault ?? false }, { name: "isActive", label: "Active", kind: "checkbox", defaultChecked: b?.isActive ?? true },
  ];
  const nameOf = new Map([...entities, ...units].map((x) => [x.id, x.name]));
  return (
    <Card title="Branding profiles" description="Each business unit (or entity) can have its own portal title and colours; people see their unit's brand, else their entity's, else the default.">
      <SpecDisclosure label="Add a profile"><SpecForm action={saveBrandingProfileAction} fields={fields()} /></SpecDisclosure>
      {rows.length ? (
        <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
          <thead><tr><th>Profile</th><th>Title</th><th>Colours</th><th>Applies to</th><th /></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.id}>
              <td>{b.name} {b.isDefault ? <Badge tone="info">default</Badge> : null}{b.isActive ? null : <Badge>inactive</Badge>}</td>
              <td>{b.portalTitle}</td>
              <td><span style={{ display: "inline-block", width: 16, height: 16, background: b.primaryColor, borderRadius: 3 }} /> <span style={{ display: "inline-block", width: 16, height: 16, background: b.accentColor, borderRadius: 3 }} /></td>
              <td className="text-sm">{b.businessUnitId ? nameOf.get(b.businessUnitId) : b.legalEntityId ? nameOf.get(b.legalEntityId) : "Everyone else"}</td>
              <td><div className="row gap-1"><SpecDisclosure label="Edit"><SpecForm action={saveBrandingProfileAction} hidden={{ id: b.id }} fields={fields(b)} /></SpecDisclosure><ActionButton action={deleteBrandingProfileAction} hidden={{ id: b.id }} label="Delete" variant="danger" confirm="Delete this profile?" /></div></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty title="One brand for everyone">Add a profile to brand a business unit differently.</Empty>}
    </Card>
  );
}

// ---------------------------------------------------------------------------

async function Policies() {
  const viewer = await requireViewer();
  const [installed, idCard] = await Promise.all([
    prisma.workflowDefinition.findMany({ where: { tenantId: viewer.tenantId, isCurrent: true }, select: { name: true } }),
    prisma.changeApprovalSetting.findUnique({ where: { tenantId_targetType: { tenantId: viewer.tenantId, targetType: "ID_CARD" } } }),
  ]);
  const names = new Set(installed.map((d) => d.name));
  return (
    <>
      <Card title="Approval policy library" description="Ready-made approval routes. Install one, then adjust its steps under Workflows.">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Policy</th><th>Approves</th><th>Steps</th><th /></tr></thead>
          <tbody>{APPROVAL_POLICY_LIBRARY.map((p) => (
            <tr key={p.key}>
              <td>{p.name}<div className="text-xs muted">{p.description}</div></td>
              <td className="text-sm">{p.entityType.toLowerCase().replace(/_/g, " ")}</td>
              <td className="text-sm">{p.steps.map((s) => s.name).join(" → ")}</td>
              <td>{names.has(p.name) ? <Badge tone="success">Installed</Badge> : can(viewer, P.WORKFLOW_MANAGE) ? <ActionButton action={installApprovalPolicyAction} hidden={{ key: p.key }} label="Install" variant="primary" /> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </Card>
      {can(viewer, P.ORG_SETTINGS_MANAGE) ? (
        <Card title="ID cards" description="Let employees issue their own card, or have them request one that HR approves.">
          <SpecForm action={saveIdCardPolicyAction} fields={[{ name: "requireApproval", label: "Employees request ID cards for approval", kind: "checkbox", defaultChecked: !!idCard?.requireApproval }]} />
        </Card>
      ) : null}
    </>
  );
}
