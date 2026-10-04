import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { CHANGE_TARGETS, delegationActive, spanOfControl } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { SpecForm, SpecDisclosure, ActionButton, type FieldSpec } from "@/components/spec-form";
import {
  saveDivisionAction, deleteDivisionAction, setDepartmentDivisionAction, saveTeamAction, deleteTeamAction,
  addTeamMembersAction, removeTeamMemberAction, setSecondaryManagersAction, removeSecondaryManagerAction,
  proposeOrgChangeAction, withdrawChangeRequestAction,
} from "@/app/actions/core-hr-depth";
import { createDelegationAction, revokeDelegationAction } from "@/app/actions/self-service-depth";

export const metadata = { title: "Divisions & teams — BooS-HR" };

const P = PERMISSIONS;
const TABS = { divisions: "Divisions", teams: "Teams", managers: "Dotted-line & acting managers", changes: "Scheduled org changes", health: "Structure health" } as const;
type Tab = keyof typeof TABS;

/**
 * Org › Org Structure › Divisions & teams: the levels between business unit
 * and department (divisions) and the people-centred units (teams), dotted-line
 * and acting managers, effective-dated changes waiting for approval or their
 * date, and the structure's health: span of control, vacant heads, empty units.
 */
export default async function OrgUnitsPage({ searchParams }: { searchParams: Promise<{ tab?: string; edit?: string; q?: string }> }) {
  const viewer = await requireAuth(P.ORG_VIEW);
  const sp = await searchParams;
  const tab = (sp.tab && sp.tab in TABS ? sp.tab : "divisions") as Tab;
  const manage = can(viewer, P.ORG_MANAGE);
  const t = viewer.tenantId;
  const q = (sp.q ?? "").trim().slice(0, 60);

  const [divisions, departments, units, teams, people] = await Promise.all([
    prisma.division.findMany({ where: { tenantId: t, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) }, orderBy: [{ isActive: "desc" }, { name: "asc" }] }),
    prisma.department.findMany({ where: { tenantId: t }, select: { id: true, name: true, divisionId: true, headId: true, _count: { select: { employees: true } } }, orderBy: { name: "asc" } }),
    prisma.businessUnit.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.orgTeam.findMany({ where: { tenantId: t, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) }, include: { members: { orderBy: { addedAt: "asc" } } }, orderBy: [{ isActive: "desc" }, { name: "asc" }] }),
    prisma.employee.findMany({ where: { tenantId: t, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true, reportingManagerId: true, departmentId: true }, orderBy: { firstName: "asc" } }),
  ]);
  const name = new Map(people.map((p) => [p.id, p.displayName ?? `${p.firstName} ${p.lastName}`]));
  const who = (id: string | null | undefined) => (id ? name.get(id) ?? "—" : "—");
  const empOpts = people.map((p) => ({ value: p.id, label: `${name.get(p.id)} (${p.employeeNumber})` }));
  const unitOpts = units.map((u) => ({ value: u.id, label: u.name }));
  const deptOpts = departments.map((d) => ({ value: d.id, label: d.name }));
  const divOpts = divisions.map((d) => ({ value: d.id, label: d.name }));
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const editDiv = sp.edit ? divisions.find((d) => d.id === sp.edit) : undefined;
  const editTeam = sp.edit ? teams.find((x) => x.id === sp.edit) : undefined;
  const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

  const divisionFields = (d?: typeof editDiv): FieldSpec[] => [
    { name: "name", label: "Name", required: true, defaultValue: d?.name },
    { name: "code", label: "Code", defaultValue: d?.code },
    { name: "businessUnitId", label: "Business unit", kind: "select", options: unitOpts, defaultValue: d?.businessUnitId },
    { name: "headId", label: "Division head", kind: "select", options: empOpts, defaultValue: d?.headId },
    { name: "effectiveFrom", label: "In effect from", kind: "date", defaultValue: iso(d?.effectiveFrom) },
    ...(d ? [{ name: "isActive", label: "Active", kind: "checkbox" as const, defaultChecked: d.isActive }] : []),
    { name: "description", label: "Description", kind: "textarea", defaultValue: d?.description },
  ];
  const teamFields = (x?: typeof editTeam): FieldSpec[] => [
    { name: "name", label: "Name", required: true, defaultValue: x?.name },
    { name: "code", label: "Code", defaultValue: x?.code },
    { name: "departmentId", label: "Department", kind: "select", options: deptOpts, defaultValue: x?.departmentId },
    { name: "divisionId", label: "Division", kind: "select", options: divOpts, defaultValue: x?.divisionId },
    { name: "leadId", label: "Team lead", kind: "select", options: empOpts, defaultValue: x?.leadId },
    { name: "effectiveFrom", label: "In effect from", kind: "date", defaultValue: iso(x?.effectiveFrom) },
    { name: "isCrossFunctional", label: "Cross-unit collaboration group", kind: "checkbox", defaultChecked: x?.isCrossFunctional, hint: "Members can sit in any department." },
    ...(x ? [{ name: "isActive", label: "Active", kind: "checkbox" as const, defaultChecked: x.isActive }] : []),
    { name: "description", label: "Description", kind: "textarea", defaultValue: x?.description },
  ];

  return (
    <>
      <PageHead title="Divisions & teams" subtitle="Divisions group departments within a business unit; teams group people, across departments if needed."
        actions={<><Link className="btn" href="/org">Org structure</Link><Link className="btn" href={`/exports/core-hr/${tab === "teams" ? "teams" : tab === "managers" ? "secondary-managers" : tab === "changes" ? "org-changes" : "divisions"}`}>Export CSV</Link></>} />
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((k) => <Link key={k} href={`/org/units?tab=${k}`} className={`tab${tab === k ? " active" : ""}`}>{TABS[k]}</Link>)}
      </div>

      {tab === "divisions" || tab === "teams" ? (
        <form method="get" className="row gap-2" style={{ marginBottom: 14 }}>
          <input type="hidden" name="tab" value={tab} />
          <input className="input" name="q" defaultValue={q} placeholder={`Search ${tab}`} style={{ maxWidth: 280 }} />
          <button className="btn sm" type="submit">Search</button>
          {q ? <Link className="btn ghost sm" href={`/org/units?tab=${tab}`}>Clear</Link> : null}
        </form>
      ) : null}

      {tab === "divisions" ? (
        <div className="stack gap-4">
          {manage ? (
            <Card title={editDiv ? `Edit ${editDiv.name}` : "Add a division"}>
              {editDiv ? <><SpecForm action={saveDivisionAction} hidden={{ id: editDiv.id }} fields={divisionFields(editDiv)} submitLabel="Save division" /><Link className="btn ghost sm" href="/org/units">Done editing</Link></>
                : <SpecDisclosure label="+ New division"><SpecForm action={saveDivisionAction} fields={divisionFields()} submitLabel="Create division" /></SpecDisclosure>}
            </Card>
          ) : null}
          <Card title={`Divisions (${divisions.length})`} tight>
            {divisions.length === 0 ? <Empty title={q ? "No division matches" : "No divisions yet"}>Divisions sit between a business unit and its departments.</Empty> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Division</th><th>Code</th><th>Business unit</th><th>Head</th><th>Departments</th><th className="num">People</th><th>Status</th>{manage ? <th /> : null}</tr></thead>
                <tbody>
                  {divisions.map((d) => {
                    const ds = departments.filter((x) => x.divisionId === d.id);
                    return (
                      <tr key={d.id}>
                        <td className="strong">{d.name}{d.effectiveFrom ? <div className="text-xs muted">since {formatDate(d.effectiveFrom)}</div> : null}</td>
                        <td className="mono text-xs">{d.code ?? "—"}</td>
                        <td>{d.businessUnitId ? unitName.get(d.businessUnitId) ?? "—" : "—"}</td>
                        <td>{d.headId ? <Link href={`/employees/${d.headId}`}>{who(d.headId)}</Link> : <Badge tone="warning">Vacant</Badge>}</td>
                        <td className="text-sm">{ds.map((x) => x.name).join(", ") || <span className="muted">None</span>}</td>
                        <td className="num">{ds.reduce((a, x) => a + x._count.employees, 0)}</td>
                        <td>{d.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</td>
                        {manage ? <td className="right"><div className="row gap-1" style={{ justifyContent: "flex-end" }}><Link className="btn sm" href={`/org/units?tab=divisions&edit=${d.id}`}>Edit</Link><ActionButton action={deleteDivisionAction} hidden={{ id: d.id }} label="Delete" confirm={`Delete ${d.name}?`} /></div></td> : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            )}
          </Card>
          {manage && divisions.length ? (
            <Card title="Place a department in a division">
              <SpecForm action={setDepartmentDivisionAction} submitLabel="Save" fields={[
                { name: "departmentId", label: "Department", kind: "select", options: deptOpts, required: true },
                { name: "divisionId", label: "Division", kind: "select", options: divOpts, placeholder: "No division" },
              ]} />
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === "teams" ? (
        <div className="stack gap-4">
          {manage ? (
            <Card title={editTeam ? `Edit ${editTeam.name}` : "Add a team"}>
              {editTeam ? <><SpecForm action={saveTeamAction} hidden={{ id: editTeam.id }} fields={teamFields(editTeam)} submitLabel="Save team" /><Link className="btn ghost sm" href="/org/units?tab=teams">Done editing</Link></>
                : <SpecDisclosure label="+ New team"><SpecForm action={saveTeamAction} fields={teamFields()} submitLabel="Create team" /></SpecDisclosure>}
            </Card>
          ) : null}
          {teams.length === 0 ? <Card><Empty title={q ? "No team matches" : "No teams yet"}>Teams group people who work together, whoever they report to.</Empty></Card> : null}
          {teams.map((x) => (
            <Card key={x.id} tight title={<>{x.name} {x.isCrossFunctional ? <Badge tone="brand">Cross-unit</Badge> : null} {!x.isActive ? <Badge>Inactive</Badge> : null}</>}
              description={`${x.code ? `${x.code} · ` : ""}Lead: ${who(x.leadId)}${x.departmentId ? ` · ${departments.find((d) => d.id === x.departmentId)?.name ?? ""}` : ""} · ${x.members.length} member(s)`}
              action={manage ? <div className="row gap-1"><Link className="btn sm" href={`/org/units?tab=teams&edit=${x.id}`}>Edit</Link><Link className="btn sm" href={`/directory?team=${x.id}`}>In directory</Link><ActionButton action={deleteTeamAction} hidden={{ id: x.id }} label="Delete" confirm={`Delete ${x.name}?`} /></div> : <Link className="btn sm" href={`/directory?team=${x.id}`}>In directory</Link>}>
              {x.members.length === 0 ? <Empty title="No members yet" /> : (
                <div className="table-wrap"><table className="data">
                  <thead><tr><th>Member</th><th>Role</th><th>Added</th>{manage ? <th /> : null}</tr></thead>
                  <tbody>{x.members.map((m) => (
                    <tr key={m.id}><td><Link href={`/employees/${m.employeeId}`}>{who(m.employeeId)}</Link></td><td>{m.role ?? "—"}</td><td>{formatDate(m.addedAt)}</td>
                      {manage ? <td className="right"><ActionButton action={removeTeamMemberAction} hidden={{ id: m.id }} label="Remove" /></td> : null}</tr>
                  ))}</tbody>
                </table></div>
              )}
              {manage ? <div style={{ padding: 14 }}><SpecForm compact action={addTeamMembersAction} hidden={{ teamId: x.id }} submitLabel="Add members" fields={[
                { name: "employeeId", label: "People", kind: "multi", options: empOpts, hint: "Ctrl/⌘-click to pick several." },
                { name: "role", label: "Role in team", placeholder: "e.g. Reviewer" },
              ]} /></div> : null}
            </Card>
          ))}
        </div>
      ) : null}

      {tab === "managers" ? <ManagersTab tenantId={t} manage={manage} empOpts={empOpts} deptOpts={deptOpts} who={who} /> : null}
      {tab === "changes" ? <ChangesTab tenantId={t} manage={manage} canEntity={can(viewer, P.ORG_ENTITY_MANAGE)} userId={viewer.user.id} empOpts={empOpts} unitOpts={unitOpts} divOpts={divOpts} who={who} /> : null}
      {tab === "health" ? <HealthTab tenantId={t} who={who} people={people} departments={departments} divisions={divisions} teams={teams} /> : null}
    </>
  );
}

async function ManagersTab({ tenantId, manage, empOpts, deptOpts, who }: { tenantId: string; manage: boolean; empOpts: Array<{ value: string; label: string }>; deptOpts: Array<{ value: string; label: string }>; who: (id: string | null) => string }) {
  const [lines, delegations] = await Promise.all([
    prisma.secondaryManager.findMany({ where: { tenantId }, orderBy: [{ managerId: "asc" }, { createdAt: "asc" }] }),
    prisma.managerDelegation.findMany({ where: { tenantId }, orderBy: { startDate: "desc" }, take: 100 }),
  ]);
  return (
    <div className="stack gap-4">
      <Callout title="Dotted-line managers">A dotted-line manager sees the person on My Team, can be named as a leave approval level (Time › Leave › Approval chains), and can approve their profile change requests. An L2 manager is recorded for reporting only.</Callout>
      {manage ? (
        <Card title="Set a dotted-line or L2 manager" description="For people you pick, or a whole department at once.">
          <SpecForm action={setSecondaryManagersAction} submitLabel="Save" fields={[
            { name: "managerId", label: "Manager", kind: "select", options: empOpts, required: true },
            { name: "kind", label: "Kind", kind: "select", options: [{ value: "DOTTED_LINE", label: "Dotted line" }, { value: "L2", label: "L2 manager" }], required: true },
            { name: "employeeId", label: "Employees", kind: "multi", options: empOpts },
            { name: "departmentId", label: "…or everyone in department", kind: "select", options: deptOpts },
            { name: "effectiveFrom", label: "From", kind: "date" },
            { name: "effectiveTo", label: "Until", kind: "date" },
            { name: "note", label: "Note", wide: true },
          ]} />
        </Card>
      ) : null}
      <Card title={`Secondary reporting lines (${lines.length})`} tight>
        {lines.length === 0 ? <Empty title="No dotted-line or L2 managers yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Employee</th><th>Manager</th><th>Kind</th><th>From</th><th>Until</th><th>Note</th>{manage ? <th /> : null}</tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.id}><td><Link href={`/employees/${l.employeeId}`}>{who(l.employeeId)}</Link></td><td>{who(l.managerId)}</td><td>{l.kind === "L2" ? "L2" : "Dotted line"}</td>
                <td>{formatDate(l.effectiveFrom)}</td><td>{formatDate(l.effectiveTo)}</td><td className="text-sm">{l.note ?? "—"}</td>
                {manage ? <td className="right"><ActionButton action={removeSecondaryManagerAction} hidden={{ id: l.id }} label="Remove" /></td> : null}</tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {manage ? (
        <Card title="Name an acting manager" description="While a manager is away, someone else approves for and looks after their team.">
          <SpecForm action={createDelegationAction} hidden={{ kind: "ACTING" }} submitLabel="Name acting manager" fields={[
            { name: "delegatorId", label: "Manager who is away", kind: "select", options: empOpts, required: true },
            { name: "delegateId", label: "Acting manager", kind: "select", options: empOpts, required: true },
            { name: "startDate", label: "From", kind: "date", required: true },
            { name: "endDate", label: "Until", kind: "date", required: true },
            { name: "reason", label: "Reason", wide: true },
          ]} />
        </Card>
      ) : null}
      <Card title="Delegations and acting managers" tight>
        {delegations.length === 0 ? <Empty title="None yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Manager</th><th>Handled by</th><th>Kind</th><th>Dates</th><th>Status</th>{manage ? <th /> : null}</tr></thead>
            <tbody>{delegations.map((d) => (
              <tr key={d.id}><td>{who(d.delegatorId)}</td><td>{who(d.delegateId)}</td><td>{d.kind === "ACTING" ? "Acting manager" : "Delegated approvals"}</td>
                <td>{formatDate(d.startDate)} – {formatDate(d.endDate)}</td>
                <td>{d.revokedAt ? <Badge>Ended</Badge> : delegationActive(d) ? <Badge tone="success">In force</Badge> : d.startDate > new Date() ? <Badge tone="brand">Upcoming</Badge> : <Badge>Past</Badge>}</td>
                {manage ? <td className="right">{!d.revokedAt && d.endDate >= new Date() ? <ActionButton action={revokeDelegationAction} hidden={{ id: d.id }} label="End now" /> : null}</td> : null}</tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

async function ChangesTab({ tenantId, manage, canEntity, userId, empOpts, unitOpts, divOpts, who }: {
  tenantId: string; manage: boolean; canEntity: boolean; userId: string; empOpts: Array<{ value: string; label: string }>; unitOpts: Array<{ value: string; label: string }>; divOpts: Array<{ value: string; label: string }>; who: (id: string | null) => string;
}) {
  const [requests, depts, divs, teams, ccs, les, bus, locs] = await Promise.all([
    prisma.changeRequest.findMany({ where: { tenantId, category: "ORG" }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.division.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.orgTeam.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.costCenter.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.legalEntity.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);
  const unitOptions = [
    ...depts.map((d) => ({ value: `DEPARTMENT:${d.id}`, label: `Department · ${d.name}` })),
    ...divs.map((d) => ({ value: `DIVISION:${d.id}`, label: `Division · ${d.name}` })),
    ...teams.map((d) => ({ value: `TEAM:${d.id}`, label: `Team · ${d.name}` })),
    ...ccs.map((d) => ({ value: `COST_CENTRE:${d.id}`, label: `Cost centre · ${d.name}` })),
    ...bus.map((d) => ({ value: `BUSINESS_UNIT:${d.id}`, label: `Business unit · ${d.name}` })),
    ...locs.map((d) => ({ value: `LOCATION:${d.id}`, label: `Location · ${d.name}` })),
    ...(canEntity ? les.map((d) => ({ value: `LEGAL_ENTITY:${d.id}`, label: `Legal entity · ${d.name}` })) : []),
  ];
  const tone = (s: string) => (s === "APPLIED" ? "success" : s === "PENDING" || s === "SCHEDULED" ? "brand" : s === "FAILED" || s === "REJECTED" ? "danger" : "neutral") as "success";
  return (
    <div className="stack gap-4">
      {manage ? (
        <Card title="Propose an org change" description="Rename a unit, give it a new head, move it, or retire it — from a date. A second administrator approves it; it applies on its date.">
          <OrgChangeForm units={unitOptions} empOpts={empOpts} unitOpts={unitOpts} divOpts={divOpts} />
        </Card>
      ) : null}
      <Card title="Org change requests" tight action={<Link className="btn sm" href="/admin/change-requests?category=ORG">Approval queue</Link>}>
        {requests.length === 0 ? <Empty title="No org changes proposed yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Change</th><th>What changes</th><th>Effective</th><th>Status</th><th>Raised</th><th /></tr></thead>
            <tbody>{requests.map((r) => (
              <tr key={r.id}><td className="strong">{r.title}<div className="text-xs muted">{CHANGE_TARGETS[r.targetType as keyof typeof CHANGE_TARGETS]?.label ?? r.targetType}</div></td>
                <td className="text-sm">{r.operation === "DELETE" ? "Retire (mark inactive)" : Object.entries(r.changes as Record<string, unknown>).map(([k, v]) => `${k.replace(/Id$/, "")}: ${k.endsWith("Id") ? who(v as string) : String(v)}`).join("; ")}</td>
                <td>{r.effectiveDate ? formatDate(r.effectiveDate) : "On approval"}</td>
                <td><Badge tone={tone(r.status)}>{r.status.toLowerCase()}</Badge>{r.error ? <div className="text-xs" style={{ color: "var(--danger)" }}>{r.error}</div> : null}</td>
                <td className="text-sm">{formatDate(r.createdAt)}</td>
                <td className="right">{r.requestedBy === userId && (r.status === "PENDING" || r.status === "SCHEDULED") ? <ActionButton action={withdrawChangeRequestAction} hidden={{ id: r.id }} label="Withdraw" /> : null}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

function OrgChangeForm({ units, empOpts, unitOpts, divOpts }: { units: Array<{ value: string; label: string }>; empOpts: Array<{ value: string; label: string }>; unitOpts: Array<{ value: string; label: string }>; divOpts: Array<{ value: string; label: string }> }) {
  return (
    <SpecForm action={proposeOrgChangeAction} submitLabel="Send for approval" fields={[
      { name: "target", label: "Unit", kind: "select", options: units, required: true, hint: "Pick the unit to change." },
      { name: "operation", label: "Change", kind: "select", options: [{ value: "UPDATE", label: "Update it" }, { value: "DELETE", label: "Retire it (mark inactive)" }], required: true },
      { name: "name", label: "New name" },
      { name: "code", label: "New code" },
      { name: "headId", label: "New head / lead", kind: "select", options: empOpts },
      { name: "businessUnitId", label: "Move under business unit", kind: "select", options: unitOpts },
      { name: "divisionId", label: "Move into division", kind: "select", options: divOpts },
      { name: "effectiveDate", label: "Effective from", kind: "date", hint: "Leave blank to apply on approval." },
      { name: "reason", label: "Why", kind: "textarea" },
    ]} />
  );
}

async function HealthTab({ tenantId, who, people, departments, divisions, teams }: {
  tenantId: string; who: (id: string | null) => string;
  people: Array<{ id: string; reportingManagerId: string | null; departmentId: string | null }>;
  departments: Array<{ id: string; name: string; headId: string | null; divisionId: string | null; _count: { employees: number } }>;
  divisions: Array<{ id: string; name: string; headId: string | null; isActive: boolean }>;
  teams: Array<{ id: string; name: string; leadId: string | null; isActive: boolean; members: unknown[] }>;
}) {
  const rules = await prisma.workingRules.findUnique({ where: { tenantId } });
  const max = rules?.maxSpanOfControl ?? 12;
  const counts = new Map<string, number>();
  for (const p of people) if (p.reportingManagerId) counts.set(p.reportingManagerId, (counts.get(p.reportingManagerId) ?? 0) + 1);
  const spans = spanOfControl([...counts.entries()].map(([managerId, reports]) => ({ managerId, name: who(managerId), reports })), max);
  const exitedManagers = await prisma.employee.findMany({ where: { tenantId, status: "EXITED", directReports: { some: { status: { not: "EXITED" } } } }, select: { id: true, displayName: true, _count: { select: { directReports: true } } } });
  const vacantDepts = departments.filter((d) => !d.headId);
  const emptyDepts = departments.filter((d) => d._count.employees === 0);
  const orphanDivs = divisions.filter((d) => d.isActive && !departments.some((x) => x.divisionId === d.id));
  const emptyTeams = teams.filter((x) => x.isActive && x.members.length === 0);
  const noManager = people.filter((p) => !p.reportingManagerId).length;
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <div className="stat"><div className="stat-label">Managers over {max} reports</div><div className="stat-value">{spans.filter((s) => s.over).length}</div></div>
        <div className="stat"><div className="stat-label">Departments without a head</div><div className="stat-value">{vacantDepts.length}</div></div>
        <div className="stat"><div className="stat-label">Units with no one in them</div><div className="stat-value">{emptyDepts.length + orphanDivs.length + emptyTeams.length}</div></div>
        <div className="stat"><div className="stat-label">People with no manager</div><div className="stat-value">{noManager}</div></div>
      </div>
      {exitedManagers.length ? <Callout tone="danger" title="Reports still pointing at people who have left">{exitedManagers.map((m) => `${m.displayName} (${m._count.directReports})`).join(", ")}. Reassign them with a mass update (HR Operations).</Callout> : null}
      <Card title="Span of control" description={`The limit (${max}) comes from Settings › Company › Working rules.`} tight>
        {spans.length === 0 ? <Empty title="No reporting lines yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Manager</th><th className="num">Direct reports</th><th /></tr></thead>
            <tbody>{spans.slice(0, 30).map((s) => <tr key={s.managerId}><td><Link href={`/employees/${s.managerId}`}>{s.name}</Link></td><td className="num">{s.reports}</td><td>{s.over ? <Badge tone="danger">Over limit</Badge> : null}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Vacant heads" tight>{vacantDepts.length === 0 ? <Empty title="Every department has a head" /> : <ul className="stack gap-1" style={{ padding: 14 }}>{vacantDepts.map((d) => <li key={d.id}>{d.name}</li>)}</ul>}</Card>
        <Card title="Empty or orphaned units" tight>{emptyDepts.length + orphanDivs.length + emptyTeams.length === 0 ? <Empty title="None" /> : (
          <ul className="stack gap-1" style={{ padding: 14 }}>
            {emptyDepts.map((d) => <li key={d.id}>Department {d.name}: no employees</li>)}
            {orphanDivs.map((d) => <li key={d.id}>Division {d.name}: no departments</li>)}
            {emptyTeams.map((x) => <li key={x.id}>Team {x.name}: no members</li>)}
          </ul>
        )}</Card>
      </div>
    </div>
  );
}
