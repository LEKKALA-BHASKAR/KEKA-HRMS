import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { flattenTree, descendantsOf, inheritLocationFields, compareOrgSnapshots, reorgImpact, orgAsOf, type OrgSnapshotPayload, type ReorgMove } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { policyPacksFor, effectiveMetadata, unitChain } from "@/lib/core2";
import { PageHead, Card, Badge, Empty, Callout, Stat } from "@/components/ui";
import { SpecForm, SpecDisclosure, ActionButton, type FieldSpec } from "@/components/spec-form";
import {
  setUnitParentAction, saveBusinessFunctionAction, deleteBusinessFunctionAction, saveMetadataFieldAction, deleteMetadataFieldAction, setMetadataValueAction,
  savePolicyPackAction, assignPolicyPackAction, takeOrgSnapshotAction, deleteOrgSnapshotAction, createReorgScenarioAction, addReorgMoveAction, removeReorgMoveAction,
  submitReorgScenarioAction, withdrawReorgScenarioAction, applyReorgScenarioAction, splitDepartmentAction, mergeDepartmentAction,
} from "@/app/actions/core2-org";

export const metadata = { title: "Org hierarchy — BooS-HR" };

const P = PERMISSIONS;
const TABS = { hierarchy: "Hierarchy", ownership: "Ownership", functions: "Business functions", metadata: "Unit fields", policies: "Policy packs", history: "History & as-of", reorg: "Reorganise" } as const;
type Tab = keyof typeof TABS;
type SP = { tab?: string; type?: string; q?: string; bu?: string; active?: string; a?: string; b?: string; asOf?: string; unit?: string; scenario?: string };
const UNIT_TYPES = { DEPARTMENT: "Departments", COST_CENTRE: "Cost centres", LOCATION: "Locations", BUSINESS_UNIT: "Business units" } as const;
type HierUnit = keyof typeof UNIT_TYPES;

/**
 * The organisation as a hierarchy: nested departments, cost centres,
 * locations (with inherited settings) and business units (with P&L codes);
 * who owns each unit and what is vacant or orphaned; business functions;
 * custom fields and policy packs that sub-units inherit; snapshots,
 * comparisons and the org as of any date; and reorganisation scenarios,
 * splits and merges.
 */
export default async function StructurePage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireAuth(P.ORG_VIEW);
  const sp = await searchParams;
  const manage = can(viewer, P.ORG_MANAGE);
  const tab: Tab = sp.tab && sp.tab in TABS ? (sp.tab as Tab) : "hierarchy";
  return (
    <>
      <PageHead title="Org hierarchy" subtitle="Nested units, ownership, inheritance, history and reorganisation" actions={<><Link className="btn" href="/org">Organisation</Link><a className="btn" href={`/exports/core2/org-as-of${sp.asOf ? `?asOf=${sp.asOf}` : ""}`}>Export org{sp.asOf ? ` as of ${sp.asOf}` : ""}</a></>} />
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((k) => <Link key={k} href={`/org/structure?tab=${k}`} className={`tab${tab === k ? " active" : ""}`}>{TABS[k]}</Link>)}
      </div>
      {tab === "hierarchy" ? <Hierarchy sp={sp} tenantId={viewer.tenantId} manage={manage} /> : null}
      {tab === "ownership" ? <Ownership tenantId={viewer.tenantId} /> : null}
      {tab === "functions" ? <Functions tenantId={viewer.tenantId} manage={manage} /> : null}
      {tab === "metadata" ? <Metadata sp={sp} tenantId={viewer.tenantId} manage={manage} /> : null}
      {tab === "policies" ? <Policies sp={sp} tenantId={viewer.tenantId} manage={manage} /> : null}
      {tab === "history" ? <History sp={sp} tenantId={viewer.tenantId} manage={manage} /> : null}
      {tab === "reorg" ? <Reorg sp={sp} tenantId={viewer.tenantId} manage={manage} /> : null}
    </>
  );
}

type HierRow = { id: string; name: string; parentId: string | null; isActive: boolean; businessUnitId: string | null; headId: string | null; extra: string };
async function units(tenantId: string, type: HierUnit): Promise<HierRow[]> {
  const w = { where: { tenantId } };
  switch (type) {
    case "DEPARTMENT": return (await prisma.department.findMany({ ...w, select: { id: true, name: true, parentId: true, isActive: true, businessUnitId: true, code: true, headId: true } })).map((d) => ({ ...d, extra: d.code ?? "" }));
    case "COST_CENTRE": return (await prisma.costCenter.findMany({ ...w, select: { id: true, name: true, parentId: true, isActive: true, code: true, legalEntityId: true } })).map((d) => ({ ...d, businessUnitId: null, headId: null, extra: d.code ?? "" }));
    case "LOCATION": {
      // A sub-location shows its parent's city, state and timezone where it has none of its own.
      const locs = await prisma.location.findMany({ ...w, select: { id: true, name: true, parentId: true, isActive: true, city: true, stateCode: true, timezone: true } });
      const byId = new Map(locs.map((l) => [l.id, l]));
      return locs.map((d) => {
        const eff = inheritLocationFields(d, byId, ["city", "stateCode", "timezone"]);
        const show = (["city", "stateCode", "timezone"] as const).map((f) => eff[f] ? `${eff[f]!.value}${eff[f]!.from !== d.id ? " (inherited)" : ""}` : null);
        return { ...d, businessUnitId: null, headId: null, extra: show.filter(Boolean).join(" · ") };
      });
    }
    case "BUSINESS_UNIT": return (await prisma.businessUnit.findMany({ ...w, select: { id: true, name: true, parentId: true, isActive: true, plCode: true, headId: true } })).map((d) => ({ ...d, businessUnitId: d.id, extra: d.plCode ? `P&L ${d.plCode}` : "" }));
  }
}

async function Hierarchy({ sp, tenantId, manage }: { sp: SP; tenantId: string; manage: boolean }) {
  const type = (sp.type && sp.type in UNIT_TYPES ? sp.type : "DEPARTMENT") as HierUnit;
  const [rows, bus, entities, people] = await Promise.all([
    units(tenantId, type),
    prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.legalEntity.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.groupBy({ by: [type === "DEPARTMENT" ? "departmentId" : type === "LOCATION" ? "locationId" : type === "COST_CENTRE" ? "costCenterId" : "businessUnitId"], where: { tenantId, status: { not: "EXITED" } }, _count: true }),
  ]);
  const key = type === "DEPARTMENT" ? "departmentId" : type === "LOCATION" ? "locationId" : type === "COST_CENTRE" ? "costCenterId" : "businessUnitId";
  const direct = new Map(people.map((p) => [(p as Record<string, unknown>)[key] as string, p._count]));
  // Visual filters: by business unit, by name (keeping the matching unit's parents so the tree stays readable), active only.
  let shown = rows;
  if (sp.active === "1") shown = shown.filter((r) => r.isActive);
  if (sp.bu && type === "DEPARTMENT") shown = shown.filter((r) => r.businessUnitId === sp.bu);
  if (sp.q) {
    const q = sp.q.toLowerCase();
    const hits = new Set(shown.filter((r) => r.name.toLowerCase().includes(q)).map((r) => r.id));
    const parent = new Map(rows.map((r) => [r.id, r.parentId]));
    for (const id of [...hits]) { let p = parent.get(id); while (p && !hits.has(p)) { hits.add(p); p = parent.get(p); } }
    shown = shown.filter((r) => hits.has(r.id));
  }
  const tree = flattenTree(shown);
  const total = (id: string) => [id, ...descendantsOf(id, rows)].reduce((s, x) => s + (direct.get(x) ?? 0), 0);
  const opts = rows.map((r) => ({ value: r.id, label: r.name }));
  return (
    <>
      <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
        <input type="hidden" name="tab" value="hierarchy" />
        <select className="select" name="type" defaultValue={type}>{Object.entries(UNIT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        {type === "DEPARTMENT" ? <select className="select" name="bu" defaultValue={sp.bu ?? ""}><option value="">All business units</option>{bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select> : null}
        <input className="input" name="q" placeholder="Find a unit" defaultValue={sp.q ?? ""} />
        <label className="row gap-1 text-sm"><input type="checkbox" name="active" value="1" defaultChecked={sp.active === "1"} /> Active only</label>
        <button className="btn" type="submit">Filter</button>
      </form>
      <Card title={UNIT_TYPES[type]} description="Indented under their parent. People counts include sub-units." action={<a className="btn sm" href={`/exports/core2/hierarchy?type=${type}`}>Export</a>}>
        {tree.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Unit</th><th>Detail</th><th>People (own / with sub-units)</th>{manage ? <th>Parent</th> : null}</tr></thead>
            <tbody>{tree.map(({ node, depth }) => (
              <tr key={node.id}>
                <td><span style={{ paddingLeft: depth * 18 }}>{depth ? "└ " : ""}{node.name}</span>{node.isActive ? null : <> <Badge>inactive</Badge></>}</td>
                <td className="text-sm muted">{node.extra}</td>
                <td>{direct.get(node.id) ?? 0} / {total(node.id)}</td>
                {manage ? <td><SpecDisclosure label="Move"><SpecForm compact action={setUnitParentAction} hidden={{ unitType: type, id: node.id }} fields={[
                  { name: "parentId", label: "Parent", kind: "select", options: opts.filter((o) => o.value !== node.id), defaultValue: node.parentId },
                  ...(type === "BUSINESS_UNIT" ? [{ name: "plCode", label: "P&L code", defaultValue: node.extra.replace("P&L ", "") || null } as FieldSpec] : []),
                  ...(type === "COST_CENTRE" ? [{ name: "legalEntityId", label: "Books to entity", kind: "select", options: entities.map((e) => ({ value: e.id, label: e.name })), defaultValue: (node as { legalEntityId?: string | null }).legalEntityId ?? null } as FieldSpec] : []),
                ]} /></SpecDisclosure></td> : null}
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="Nothing matches">Clear the filters.</Empty>}
      </Card>
      {type === "LOCATION" ? <Callout tone="info">A sub-location with no state, timezone or city of its own uses its parent location&apos;s.</Callout> : null}
    </>
  );
}

async function Ownership({ tenantId }: { tenantId: string }) {
  const [depts, bus, divisions, people, positions] = await Promise.all([
    prisma.department.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, headId: true, parentId: true, businessUnitId: true, head: { select: { id: true, displayName: true, status: true } } } }),
    prisma.businessUnit.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, headId: true, head: { select: { displayName: true, status: true } } } }),
    prisma.division.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, headId: true } }),
    prisma.employee.groupBy({ by: ["departmentId"], where: { tenantId, status: { not: "EXITED" } }, _count: true }),
    prisma.position.findMany({ where: { tenantId, status: "VACANT" }, select: { id: true, title: true, departmentId: true } }),
  ]);
  const heads = await prisma.employee.groupBy({ by: ["reportingManagerId"], where: { tenantId, status: { not: "EXITED" }, reportingManagerId: { not: null } }, _count: true });
  const span = new Map(heads.map((h) => [h.reportingManagerId!, h._count]));
  const count = new Map(people.map((p) => [p.departmentId, p._count]));
  const ids = new Set(depts.map((d) => d.id));
  const vacant = [...depts.filter((d) => !d.headId || d.head?.status === "EXITED").map((d) => ({ type: "Department", name: d.name })), ...bus.filter((b) => !b.headId || b.head?.status === "EXITED").map((b) => ({ type: "Business unit", name: b.name })), ...divisions.filter((d) => !d.headId).map((d) => ({ type: "Division", name: d.name }))];
  const empty = depts.filter((d) => !(count.get(d.id) ?? 0) && !depts.some((c) => c.parentId === d.id));
  const orphaned = depts.filter((d) => (d.parentId && !ids.has(d.parentId)) || (!d.businessUnitId && !d.parentId));
  const byHead = new Map<string, { name: string; units: string[] }>();
  for (const d of depts) if (d.head) byHead.set(d.head.id, { name: d.head.displayName ?? "", units: [...(byHead.get(d.head.id)?.units ?? []), d.name] });
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Units with a head" value={`${depts.length - depts.filter((d) => !d.headId).length} / ${depts.length}`} />
        <Stat label="Vacant heads" value={vacant.length} tone={vacant.length ? "neg" : undefined} />
        <Stat label="Empty units" value={empty.length} />
        <Stat label="Vacant positions" value={positions.length} />
      </div>
      <Card title="Unit owners" description="Who heads what, and how many people report to them directly.">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Head</th><th>Units</th><th>Direct reports</th></tr></thead>
          <tbody>{[...byHead].map(([id, h]) => <tr key={id}><td><Link href={`/employees/${id}`}>{h.name}</Link></td><td className="text-sm">{h.units.join(", ")}</td><td>{span.get(id) ?? 0}</td></tr>)}</tbody>
        </table></div>
      </Card>
      <div className="grid grid-2">
        <Card title="Vacant heads">{vacant.length ? <ul>{vacant.map((v, i) => <li key={i}>{v.type}: {v.name}</li>)}</ul> : <Empty title="Every unit has a head" />}</Card>
        <Card title="Empty or orphaned units" description="No people and no sub-units, or a parent that no longer exists.">
          {empty.length + orphaned.length ? <ul>{empty.map((d) => <li key={`e${d.id}`}>{d.name} <Badge>empty</Badge></li>)}{orphaned.map((d) => <li key={`o${d.id}`}>{d.name} <Badge tone="warning">orphaned</Badge></li>)}</ul> : <Empty title="None" />}
        </Card>
      </div>
      <Card title="Vacant positions by department">{positions.length ? <ul>{positions.map((p) => <li key={p.id}>{p.title} — {depts.find((d) => d.id === p.departmentId)?.name ?? "no department"}</li>)}</ul> : <Empty title="No vacant positions" />}</Card>
    </>
  );
}

async function Functions({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const [fns, depts] = await Promise.all([
    prisma.businessFunction.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const deptOpts = depts.map((d) => ({ value: d.id, label: d.name }));
  const fields = (f?: (typeof fns)[number]): FieldSpec[] => [
    { name: "name", label: "Function", required: true, defaultValue: f?.name }, { name: "code", label: "Code", defaultValue: f?.code },
    { name: "parentId", label: "Part of", kind: "select", options: fns.filter((x) => x.id !== f?.id).map((x) => ({ value: x.id, label: x.name })), defaultValue: f?.parentId },
    { name: "isActive", label: "Active", kind: "checkbox", defaultChecked: f?.isActive ?? true },
    { name: "departmentIds", label: "Departments doing this work", kind: "multi", options: deptOpts, defaultValues: f?.departmentIds ?? [], wide: true },
    { name: "description", label: "Description", kind: "textarea", defaultValue: f?.description },
  ];
  return (
    <Card title="Business functions" description="A taxonomy of what the company does (Finance › Payables), independent of reporting lines, mapped to the departments that do it.">
      {manage ? <SpecDisclosure label="Add a function"><SpecForm action={saveBusinessFunctionAction} fields={fields()} /></SpecDisclosure> : null}
      {fns.length ? (
        <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
          <thead><tr><th>Function</th><th>Departments</th>{manage ? <th /> : null}</tr></thead>
          <tbody>{flattenTree(fns).map(({ node: f, depth }) => (
            <tr key={f.id}>
              <td><span style={{ paddingLeft: depth * 18 }}>{depth ? "└ " : ""}{f.name}</span> {f.code ? <span className="muted text-xs">{f.code}</span> : null}{f.isActive ? null : <Badge>inactive</Badge>}</td>
              <td className="text-sm">{f.departmentIds.map((id) => depts.find((d) => d.id === id)?.name).filter(Boolean).join(", ") || "—"}</td>
              {manage ? <td><div className="row gap-1"><SpecDisclosure label="Edit"><SpecForm action={saveBusinessFunctionAction} hidden={{ id: f.id }} fields={fields(f)} /></SpecDisclosure><ActionButton action={deleteBusinessFunctionAction} hidden={{ id: f.id }} label="Delete" variant="danger" confirm={`Delete ${f.name}? Its sub-functions move up.`} /></div></td> : null}
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty title="No functions yet" />}
    </Card>
  );
}

async function unitOptions(tenantId: string) {
  const [les, bus, divs, depts] = await Promise.all([
    prisma.legalEntity.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true }, orderBy: { name: "asc" } }),
    prisma.division.findMany({ where: { tenantId }, select: { id: true, name: true, businessUnitId: true }, orderBy: { name: "asc" } }),
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true, divisionId: true, businessUnitId: true }, orderBy: { name: "asc" } }),
  ]);
  const all = [...les.map((x) => ({ value: `LEGAL_ENTITY:${x.id}`, label: `Entity · ${x.name}` })), ...bus.map((x) => ({ value: `BUSINESS_UNIT:${x.id}`, label: `Business unit · ${x.name}` })), ...divs.map((x) => ({ value: `DIVISION:${x.id}`, label: `Division · ${x.name}` })), ...depts.map((x) => ({ value: `DEPARTMENT:${x.id}`, label: `Department · ${x.name}` }))];
  return { les, bus, divs, depts, all };
}

/** The chain of units above (and including) a unit, nearest first. */
async function chainFor(tenantId: string, unit: string) {
  const [type, id] = unit.split(":");
  if (!type || !id) return [];
  if (type === "DEPARTMENT") {
    const [depts, bus] = await Promise.all([prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true, divisionId: true, businessUnitId: true } }), prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true, legalEntityId: true } })]);
    const d = depts.find((x) => x.id === id);
    const bu = bus.find((b) => b.id === d?.businessUnitId);
    return unitChain({ departmentId: id, businessUnitId: d?.businessUnitId ?? null, legalEntityId: bu?.legalEntityId ?? null }, depts, bus);
  }
  if (type === "BUSINESS_UNIT") {
    const bus = await prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true, legalEntityId: true } });
    return unitChain({ departmentId: null, businessUnitId: id, legalEntityId: bus.find((b) => b.id === id)?.legalEntityId ?? null }, [], bus);
  }
  if (type === "DIVISION") {
    const dv = await prisma.division.findFirst({ where: { id, tenantId }, select: { businessUnitId: true } });
    const bus = await prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true, legalEntityId: true } });
    const rest = dv?.businessUnitId ? unitChain({ departmentId: null, businessUnitId: dv.businessUnitId, legalEntityId: bus.find((b) => b.id === dv.businessUnitId)?.legalEntityId ?? null }, [], bus) : [];
    return [{ unitType: "DIVISION", unitId: id }, ...rest];
  }
  return [{ unitType: "LEGAL_ENTITY", unitId: id }];
}

async function Metadata({ sp, tenantId, manage }: { sp: SP; tenantId: string; manage: boolean }) {
  const [fields, opts] = await Promise.all([prisma.orgUnitMetadataField.findMany({ where: { tenantId }, orderBy: [{ unitType: "asc" }, { label: "asc" }] }), unitOptions(tenantId)]);
  const unit = sp.unit && opts.all.some((o) => o.value === sp.unit) ? sp.unit : null;
  const chain = unit ? await chainFor(tenantId, unit) : [];
  const values = unit ? await effectiveMetadata(tenantId, chain) : [];
  const label = (u: { unitType: string; unitId: string } | null) => (u ? opts.all.find((o) => o.value === `${u.unitType}:${u.unitId}`)?.label ?? u.unitType : "");
  const [uType, uId] = (unit ?? ":").split(":");
  return (
    <>
      <Card title="Fields on org units" description="Extra fields for entities, business units, divisions and departments. An inherited field falls back to the parent unit's value.">
        {manage ? <SpecDisclosure label="Add a field"><SpecForm action={saveMetadataFieldAction} fields={[
          { name: "unitType", label: "On", kind: "select", required: true, options: [{ value: "LEGAL_ENTITY", label: "Legal entities" }, { value: "BUSINESS_UNIT", label: "Business units" }, { value: "DIVISION", label: "Divisions" }, { value: "DEPARTMENT", label: "Departments" }] },
          { name: "key", label: "Key", required: true, placeholder: "cost_owner" }, { name: "label", label: "Label", required: true },
          { name: "fieldType", label: "Type", kind: "select", required: true, defaultValue: "TEXT", options: [{ value: "TEXT", label: "Text" }, { value: "NUMBER", label: "Number" }, { value: "SELECT", label: "Choice" }] },
          { name: "options", label: "Choices (comma-separated)" }, { name: "required", label: "Required", kind: "checkbox" }, { name: "inheritable", label: "Sub-units inherit it", kind: "checkbox", defaultChecked: true },
        ]} /></SpecDisclosure> : null}
        {fields.length ? (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
            <thead><tr><th>Field</th><th>On</th><th>Type</th><th>Inherited</th>{manage ? <th /> : null}</tr></thead>
            <tbody>{fields.map((f) => <tr key={f.id}><td>{f.label} <span className="mono text-xs muted">{f.key}</span></td><td className="text-sm">{f.unitType.toLowerCase().replace("_", " ")}</td><td className="text-sm">{f.fieldType.toLowerCase()}{f.options.length ? `: ${f.options.join(", ")}` : ""}</td><td>{f.inheritable ? "Yes" : "No"}</td>{manage ? <td><ActionButton action={deleteMetadataFieldAction} hidden={{ id: f.id }} label="Remove" variant="danger" confirm="Remove the field and its values?" /></td> : null}</tr>)}</tbody>
          </table></div>
        ) : null}
      </Card>
      <Card title="Values for a unit">
        <form method="get" className="row gap-2 wrap">
          <input type="hidden" name="tab" value="metadata" />
          <select className="select" name="unit" defaultValue={unit ?? ""} style={{ minWidth: 280 }}><option value="">Pick a unit…</option>{opts.all.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          <button className="btn" type="submit">Show</button>
        </form>
        {unit ? (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
            <thead><tr><th>Field</th><th>Value</th><th>From</th>{manage ? <th>Set here</th> : null}</tr></thead>
            <tbody>{values.map((v) => (
              <tr key={v.key}>
                <td>{v.label}</td><td>{v.value ?? <span className="muted">—</span>}</td>
                <td className="text-sm">{v.from ? (v.inherited ? <Badge tone="info">inherited from {label(v.from)}</Badge> : "this unit") : ""}</td>
                {manage && fields.some((f) => f.key === v.key && f.unitType === uType) ? <td><SpecForm compact action={setMetadataValueAction} hidden={{ unitType: uType!, unitId: uId!, key: v.key }} submitLabel="Set" fields={[{ name: "value", label: "Value (blank inherits)", defaultValue: v.inherited ? null : v.value }]} /></td> : manage ? <td /> : null}
              </tr>
            ))}</tbody>
          </table></div>
        ) : null}
      </Card>
    </>
  );
}

async function Policies({ sp, tenantId, manage }: { sp: SP; tenantId: string; manage: boolean }) {
  const [packs, opts] = await Promise.all([prisma.policyPack.findMany({ where: { tenantId }, include: { assignments: true }, orderBy: { name: "asc" } }), unitOptions(tenantId)]);
  const unit = sp.unit && opts.all.some((o) => o.value === sp.unit) ? sp.unit : null;
  const eff = unit ? await policyPacksFor(tenantId, await chainFor(tenantId, unit)) : null;
  const label = (t: string, id: string) => opts.all.find((o) => o.value === `${t}:${id}`)?.label ?? t;
  return (
    <>
      <Card title="Policy packs" description="A bundle of policies (leave, attendance, conduct…) assigned to a unit; every sub-unit inherits it unless it has its own.">
        {manage ? <SpecDisclosure label="New pack"><SpecForm action={savePolicyPackAction} fields={[
          { name: "name", label: "Name", required: true }, { name: "isActive", label: "Active", kind: "checkbox", defaultChecked: true },
          { name: "items", label: "Policies, one per line (Kind: Name)", kind: "textarea", required: true, placeholder: "Leave: Standard leave\nAttendance: Office hours 9–6" },
          { name: "description", label: "Description", wide: true },
        ]} /></SpecDisclosure> : null}
        {packs.map((p) => (
          <div key={p.id} style={{ marginTop: 14 }}>
            <div className="row gap-2"><strong>{p.name}</strong>{p.isActive ? null : <Badge>inactive</Badge>}</div>
            <div className="text-sm">{((p.items ?? []) as Array<{ kind: string; name: string }>).map((i) => `${i.kind}: ${i.name}`).join(" · ")}</div>
            <div className="row gap-2 wrap" style={{ margin: "6px 0" }}>{p.assignments.map((a) => <span key={a.id} className="row gap-1"><Badge tone="info">{label(a.unitType, a.unitId)}</Badge>{manage ? <ActionButton action={assignPolicyPackAction} hidden={{ packId: p.id, unitType: a.unitType, unitId: a.unitId, remove: "1" }} label="×" /> : null}</span>)}</div>
            {manage ? <AssignForm packId={p.id} options={opts.all} /> : null}
          </div>
        ))}
      </Card>
      <Card title="Packs in force for a unit">
        <form method="get" className="row gap-2 wrap">
          <input type="hidden" name="tab" value="policies" />
          <select className="select" name="unit" defaultValue={unit ?? ""} style={{ minWidth: 280 }}><option value="">Pick a unit…</option>{opts.all.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          <button className="btn" type="submit">Show</button>
        </form>
        {eff ? (eff.packs.length ? <div style={{ marginTop: 10 }}>{eff.packs.map((p) => <Badge key={p.id} tone="success">{p.name}</Badge>)} {eff.inherited && eff.from ? <span className="text-sm muted">inherited from {label(eff.from.unitType, eff.from.unitId)}</span> : <span className="text-sm muted">assigned here</span>}</div> : <Empty title="No pack applies" />) : null}
      </Card>
    </>
  );
}

function AssignForm({ packId, options }: { packId: string; options: Array<{ value: string; label: string }> }) {
  return (
    <SpecForm compact action={assignPolicyPackAction} hidden={{ packId }} submitLabel="Assign" fields={[
      { name: "unitType", label: "Kind", kind: "select", required: true, options: [{ value: "LEGAL_ENTITY", label: "Legal entity" }, { value: "BUSINESS_UNIT", label: "Business unit" }, { value: "DIVISION", label: "Division" }, { value: "DEPARTMENT", label: "Department" }] },
      { name: "unitId", label: "Unit", kind: "select", required: true, options: options.map((o) => ({ value: o.value.split(":")[1]!, label: o.label })) },
    ]} />
  );
}

async function History({ sp, tenantId, manage }: { sp: SP; tenantId: string; manage: boolean }) {
  const snaps = await prisma.orgSnapshot.findMany({ where: { tenantId }, orderBy: { asOf: "desc" }, select: { id: true, name: true, asOf: true, headcount: true, createdAt: true } });
  const asOf = sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? new Date(`${sp.asOf}T00:00:00Z`) : null;
  const view = asOf ? await orgAsOf(tenantId, asOf) : null;
  const a = sp.a ? await prisma.orgSnapshot.findFirst({ where: { id: sp.a, tenantId } }) : null;
  const bRow = sp.b && sp.b !== "now" ? await prisma.orgSnapshot.findFirst({ where: { id: sp.b, tenantId } }) : null;
  const bPayload = sp.a ? (bRow ? (bRow.payload as unknown as OrgSnapshotPayload) : await orgAsOf(tenantId, new Date())) : null;
  const cmp = a && bPayload ? compareOrgSnapshots(a.payload as unknown as OrgSnapshotPayload, bPayload) : null;
  const names = new Map<string, string>();
  for (const p of [...(a ? (a.payload as unknown as OrgSnapshotPayload).people : []), ...(bPayload?.people ?? []), ...(view?.people ?? [])]) names.set(p.id, p.name);
  for (const u of [...(a ? (a.payload as unknown as OrgSnapshotPayload).units : []), ...(bPayload?.units ?? []), ...(view?.units ?? [])]) names.set(u.id, u.name);
  const n = (id: string | null) => (id ? names.get(id) ?? id : "—");
  const deptCount = view ? [...view.people.reduce((m, p) => m.set(p.departmentId ?? "", (m.get(p.departmentId ?? "") ?? 0) + 1), new Map<string, number>())].sort((x, y) => y[1] - x[1]) : [];
  return (
    <>
      <Card title="The org on a date" description="Who was where on any past date, from the job history.">
        <form method="get" className="row gap-2 wrap">
          <input type="hidden" name="tab" value="history" />
          <input className="input" type="date" name="asOf" defaultValue={sp.asOf ?? ""} />
          <button className="btn" type="submit">Show</button>
          {sp.asOf ? <a className="btn" href={`/exports/core2/org-as-of?asOf=${sp.asOf}`}>Export</a> : null}
        </form>
        {view ? (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
            <thead><tr><th>Department on {view.asOf}</th><th>People</th></tr></thead>
            <tbody>{deptCount.map(([d, c]) => <tr key={d}><td>{d ? n(d) : "No department"}</td><td>{c}</td></tr>)}</tbody>
          </table><div className="text-sm muted" style={{ marginTop: 6 }}>{view.people.length} people in all.</div></div>
        ) : null}
      </Card>
      <Card title="Snapshots" description="Freeze the org on a date to compare against later.">
        {manage ? <SpecDisclosure label="Take a snapshot"><SpecForm action={takeOrgSnapshotAction} fields={[{ name: "name", label: "Name", required: true, placeholder: "Year end 2026" }, { name: "asOf", label: "As of (blank = today)", kind: "date" }]} /></SpecDisclosure> : null}
        {snaps.length ? (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
            <thead><tr><th>Snapshot</th><th>As of</th><th>People</th><th /></tr></thead>
            <tbody>{snaps.map((s) => <tr key={s.id}><td>{s.name}</td><td>{formatDate(s.asOf)}</td><td>{s.headcount}</td><td><div className="row gap-1"><Link className="btn sm" href={`/org/structure?tab=history&a=${s.id}&b=now`}>Compare with now</Link>{manage ? <ActionButton action={deleteOrgSnapshotAction} hidden={{ id: s.id }} label="Delete" variant="danger" confirm="Delete this snapshot?" /> : null}</div></td></tr>)}</tbody>
          </table></div>
        ) : <Empty title="No snapshots yet" />}
        {snaps.length > 1 ? (
          <form method="get" className="row gap-2 wrap" style={{ marginTop: 12 }}>
            <input type="hidden" name="tab" value="history" />
            <select className="select" name="a" defaultValue={sp.a ?? ""}>{snaps.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <span>→</span>
            <select className="select" name="b" defaultValue={sp.b ?? "now"}><option value="now">Now</option>{snaps.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <button className="btn" type="submit">Compare</button>
          </form>
        ) : null}
      </Card>
      {cmp && a ? (
        <Card title={`What changed since "${a.name}"`} description={`${cmp.joined.length} joined · ${cmp.left.length} left · ${cmp.moved.length} moves · ${cmp.unitsAdded.length + cmp.unitsRemoved.length + cmp.unitChanges.length} unit changes`}>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Who / what</th><th>Change</th><th>From</th><th>To</th></tr></thead>
            <tbody>
              {cmp.joined.map((p) => <tr key={`j${p.id}`}><td>{p.name}</td><td><Badge tone="success">joined</Badge></td><td /><td>{n(p.departmentId)}</td></tr>)}
              {cmp.left.map((p) => <tr key={`l${p.id}`}><td>{p.name}</td><td><Badge tone="danger">left</Badge></td><td>{n(p.departmentId)}</td><td /></tr>)}
              {cmp.moved.map((m, i) => <tr key={`m${i}`}><td>{m.name}</td><td>{m.field}</td><td>{m.field === "title" ? m.from ?? "—" : n(m.from)}</td><td>{m.field === "title" ? m.to ?? "—" : n(m.to)}</td></tr>)}
              {cmp.unitsAdded.map((u) => <tr key={`ua${u.id}`}><td>{u.name}</td><td>{u.type.toLowerCase().replace("_", " ")} added</td><td /><td /></tr>)}
              {cmp.unitsRemoved.map((u) => <tr key={`ur${u.id}`}><td>{u.name}</td><td>{u.type.toLowerCase().replace("_", " ")} removed</td><td /><td /></tr>)}
              {cmp.unitChanges.map((c, i) => <tr key={`uc${i}`}><td>{c.name}</td><td>{c.field}</td><td>{c.field === "parent" || c.field === "head" ? n(c.from) : c.from}</td><td>{c.field === "parent" || c.field === "head" ? n(c.to) : c.to}</td></tr>)}
            </tbody>
          </table></div>
        </Card>
      ) : null}
    </>
  );
}

async function Reorg({ sp, tenantId, manage }: { sp: SP; tenantId: string; manage: boolean }) {
  const [scenarios, depts, people] = await Promise.all([
    prisma.reorgScenario.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }),
    prisma.department.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { tenantId, status: { not: "EXITED" } }, select: { id: true, displayName: true, employeeNumber: true, departmentId: true, reportingManagerId: true }, orderBy: { firstName: "asc" } }),
  ]);
  const cur = scenarios.find((s) => s.id === sp.scenario) ?? scenarios[0] ?? null;
  const moves = (cur?.moves ?? []) as unknown as ReorgMove[];
  const impact = cur ? reorgImpact(people.map((p) => ({ id: p.id, departmentId: p.departmentId, managerId: p.reportingManagerId })), moves) : null;
  const name = new Map<string, string>([...people.map((p) => [p.id, p.displayName] as [string, string]), ...depts.map((d) => [d.id, d.name] as [string, string])]);
  const personOpts = people.map((p) => ({ value: p.id, label: `${p.displayName} (${p.employeeNumber})` }));
  const deptOpts = depts.map((d) => ({ value: d.id, label: d.name }));
  const editable = cur && ["DRAFT", "REJECTED"].includes(cur.status);
  return (
    <>
      <Card title="Reorganisation scenarios" description="Plan moves without touching anyone, see the effect on headcount and spans, send the plan for approval, then apply it as dated job changes.">
        {manage ? <SpecDisclosure label="New scenario"><SpecForm action={createReorgScenarioAction} fields={[{ name: "name", label: "Name", required: true }, { name: "description", label: "Why", kind: "textarea" }]} /></SpecDisclosure> : null}
        <div className="row gap-2 wrap" style={{ marginTop: 10 }}>{scenarios.map((s) => <Link key={s.id} href={`/org/structure?tab=reorg&scenario=${s.id}`} className={`btn sm${cur?.id === s.id ? " primary" : ""}`}>{s.name} · {s.status.toLowerCase().replace("_", " ")}</Link>)}</div>
      </Card>
      {cur && impact ? (
        <Card title={cur.name} description={cur.description ?? undefined} action={<Badge tone={cur.status === "APPLIED" ? "success" : cur.status === "APPROVED" ? "info" : cur.status === "REJECTED" ? "danger" : "neutral"}>{cur.status.toLowerCase().replace("_", " ")}</Badge>}>
          <div className="grid grid-4" style={{ marginBottom: 12 }}>
            <Stat label="People moving" value={impact.changed} />
            <Stat label="Departments changing size" value={impact.headcount.length} />
            <Stat label="Managers over 12 reports" value={impact.span.filter((s) => s.overLimit).length} tone={impact.span.some((s) => s.overLimit) ? "neg" : undefined} />
            <Stat label="Reporting loops" value={impact.cycles.length} tone={impact.cycles.length ? "neg" : undefined} />
          </div>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Person</th><th>New department</th><th>New manager</th>{manage && editable ? <th /> : null}</tr></thead>
            <tbody>{moves.map((m) => <tr key={m.employeeId}><td>{name.get(m.employeeId)}</td><td>{m.departmentId ? name.get(m.departmentId) : "—"}</td><td>{m.reportingManagerId ? name.get(m.reportingManagerId) : "—"}</td>{manage && editable ? <td><ActionButton action={removeReorgMoveAction} hidden={{ scenarioId: cur.id, employeeId: m.employeeId }} label="Remove" /></td> : null}</tr>)}</tbody>
          </table></div>
          {impact.headcount.length ? <div className="text-sm" style={{ marginTop: 8 }}>Headcount: {impact.headcount.map((h) => `${name.get(h.id) ?? h.id} ${h.before}→${h.after}`).join(" · ")}</div> : null}
          {impact.span.length ? <div className="text-sm">Spans: {impact.span.map((s) => `${name.get(s.id) ?? s.id} ${s.before}→${s.after}${s.overLimit ? " (over limit)" : ""}`).join(" · ")}</div> : null}
          {manage ? (
            <div style={{ marginTop: 12 }}>
              {editable ? <SpecForm compact action={addReorgMoveAction} hidden={{ scenarioId: cur.id }} submitLabel="Plan move" fields={[
                { name: "employeeId", label: "Person", kind: "select", required: true, options: personOpts },
                { name: "departmentId", label: "New department", kind: "select", options: deptOpts },
                { name: "reportingManagerId", label: "New manager", kind: "select", options: personOpts },
              ]} /> : null}
              <div className="row gap-2" style={{ marginTop: 8 }}>
                {editable ? <ActionButton action={submitReorgScenarioAction} hidden={{ id: cur.id }} label="Send for approval" variant="primary" /> : null}
                {cur.status === "PENDING_APPROVAL" ? <ActionButton action={withdrawReorgScenarioAction} hidden={{ id: cur.id }} label="Withdraw" /> : null}
                {cur.status === "APPROVED" ? <ActionButton action={applyReorgScenarioAction} hidden={{ id: cur.id }} label="Apply now" variant="primary" confirm="Move everyone in this scenario today?" /> : null}
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}
      {manage ? (
        <div className="grid grid-2">
          <Card title="Split a department" description="Create a new department beside it and move the chosen people across.">
            <SpecForm action={splitDepartmentAction} submitLabel="Split" fields={[
              { name: "sourceId", label: "Department to split", kind: "select", required: true, options: deptOpts },
              { name: "name", label: "New department", required: true }, { name: "code", label: "Code" },
              { name: "headId", label: "Head of the new one", kind: "select", options: personOpts },
              { name: "employeeIds", label: "People who move (must be in the department split)", kind: "multi", options: personOpts, wide: true },
            ]} />
          </Card>
          <Card title="Merge departments" description="Everyone moves to the target; sub-departments re-parent; the old one is deactivated.">
            <SpecForm action={mergeDepartmentAction} submitLabel="Merge" fields={[
              { name: "sourceId", label: "Merge this", kind: "select", required: true, options: deptOpts },
              { name: "targetId", label: "Into this", kind: "select", required: true, options: deptOpts },
            ]} />
          </Card>
        </div>
      ) : null}
    </>
  );
}
