import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import {
  MOVEMENT_KINDS, movementReport, statusChangeReport, employmentTimeline, rehireEligibilityList, fteReport, confirmationEligibility, contractRenewalBoard, reasonCodes,
} from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { departmentOptions, locationOptions, employeeOptions, userNames, fmtDate } from "@/lib/governance";
import { PageHead, Card, Stat, Callout } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { OpsRequests, ymdOf } from "@/components/ops-ui";
import {
  editJobChangeAction, correctJobRecordAction, requestAssignmentAction, moveAssignmentAction, changeStatusAction, rehireAction, setRehireEligibilityAction,
  requestFteAction, saveConfirmationRuleAction,
} from "@/app/actions/ops-lifecycle";

export const metadata = { title: "Lifecycle" };
const TABS = { movements: "Movements", assignments: "Assignments", status: "Status changes", rehire: "Rehire & timeline", fte: "FTE changes", confirmation: "Confirmation rules", contracts: "Contract renewals" };
type Tab = keyof typeof TABS;
type Kind = keyof typeof MOVEMENT_KINDS;
const STATUSES = [{ value: "PROBATION", label: "Probation" }, { value: "CONFIRMED", label: "Confirmed" }, { value: "NOTICE_PERIOD", label: "Notice period" }, { value: "INACTIVE", label: "Inactive" }];

/**
 * Org › Lifecycle: promotions, transfers and designation changes (with edits
 * and corrections), temporary assignments and secondments, status changes
 * with reason codes, rehire and the employment timeline, FTE conversion,
 * confirmation rules and contract renewal milestones.
 */
export default async function LifecyclePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireViewer();
  if (!canAny(v, [P.EMPLOYEE_UPDATE, P.EXIT_MANAGE, P.PROBATION_MANAGE, P.CONTRACT_MANAGE, P.SALARY_REVISE])) forbidden();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "movements";
  const now = new Date();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? new Date(`${sp.from}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? new Date(`${sp.to}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const t = v.tenantId;
  const edit = can(v, P.EMPLOYEE_UPDATE);
  const kind: Kind = (sp.kind ?? "") in MOVEMENT_KINDS ? (sp.kind as Kind) : "PROMOTION";
  const range = (
    <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
      <input type="hidden" name="tab" value={tab} />{tab === "movements" ? <input type="hidden" name="kind" value={kind} /> : null}
      <input className="input" type="date" name="from" defaultValue={ymdOf(from)} style={{ width: 160 }} /><input className="input" type="date" name="to" defaultValue={ymdOf(to)} style={{ width: 160 }} />
      <button className="btn sm" type="submit">Show</button>
    </form>
  );
  return (
    <>
      <PageHead title="Lifecycle" subtitle="Movements, assignments, status, rehire, FTE, confirmation and contracts" actions={<a className="btn" href={`/lifecycle/export?tab=${tab}&kind=${kind}&from=${ymdOf(from)}&to=${ymdOf(to)}`}>Download CSV</a>} />
      <Tabs base="/lifecycle" tabs={TABS} active={tab} />
      {tab === "movements" || tab === "status" ? range : null}
      {tab === "movements" ? <Movements tenantId={t} kind={kind} from={from} to={to} edit={edit} /> : null}
      {tab === "assignments" ? <Assignments tenantId={t} edit={edit} /> : null}
      {tab === "status" ? <Status tenantId={t} from={from} to={to} edit={edit} /> : null}
      {tab === "rehire" ? <Rehire tenantId={t} employeeId={sp.emp} filter={sp.filter} edit={edit || can(v, P.EXIT_MANAGE)} /> : null}
      {tab === "fte" ? <Fte tenantId={t} edit={edit} /> : null}
      {tab === "confirmation" ? <Confirmation tenantId={t} manage={can(v, P.PROBATION_MANAGE)} employeeId={sp.emp} /> : null}
      {tab === "contracts" ? <Contracts tenantId={t} /> : null}
    </>
  );
}

async function Movements({ tenantId, kind, from, to, edit }: { tenantId: string; kind: Kind; from: Date; to: Date; edit: boolean }) {
  const r = await movementReport(tenantId, kind, from, to);
  const en = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: r.pending.map((p) => p.employeeId) } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  return (
    <div className="stack gap-4">
      <div className="tabs">{(Object.keys(MOVEMENT_KINDS) as Kind[]).map((k) => <a key={k} className={`tab${k === kind ? " active" : ""}`} href={`/lifecycle?tab=movements&kind=${k}&from=${ymdOf(from)}&to=${ymdOf(to)}`}>{MOVEMENT_KINDS[k]}</a>)}</div>
      <Card title="Pending and scheduled" description="Change the effective date or note before a change applies. Applied changes are corrected on the record below." tight>
        <Table head={["Employee", "Change", "Effective", "Status", ""]} empty={r.pending.length === 0}>
          {r.pending.map((p) => <tr key={p.id}><td className="text-sm">{en.get(p.employeeId) ?? ""}</td><td className="text-sm">{String(p.reason).toLowerCase().replace(/_/g, " ")}</td><td className="text-sm">{fmtDate(p.effectiveFrom)}</td><td><Pill s={p.status} /></td>
            <td>{edit ? <SpecForm action={editJobChangeAction} hidden={{ id: p.id }} columns={2} submitLabel="Update" fields={[{ name: "effectiveFrom", label: "Effective", type: "date", required: true, defaultValue: ymdOf(p.effectiveFrom) }, { name: "note", label: "Note", defaultValue: p.note ?? "" }]} /> : null}</td></tr>)}
        </Table>
      </Card>
      <div className="grid grid-3"><Stat label={MOVEMENT_KINDS[kind]} value={r.rows.length} meta={`${fmtDate(from)} – ${fmtDate(to)}`} /></div>
      <Card title={MOVEMENT_KINDS[kind]} tight>
        <Table head={["Employee", "Effective", "Reason", "Title", "Department", "Location", "Note", ""]} empty={r.rows.length === 0}>
          {r.rows.map((x) => <tr key={x.id}><td className="text-sm">{x.employee}</td><td className="text-sm">{fmtDate(x.effectiveFrom)}</td><td className="text-sm">{x.reason}</td><td className="text-xs">{x.fromTitle} → {x.toTitle}</td><td className="text-xs">{x.fromDepartment} → {x.toDepartment}</td><td className="text-xs">{x.fromLocation} → {x.toLocation}</td><td className="text-xs">{x.note}</td>
            <td>{edit ? <SpecForm action={correctJobRecordAction} hidden={{ recordId: x.id }} columns={2} submitLabel="Correct" fields={[{ name: "effectiveFrom", label: "Effective", type: "date", required: true, defaultValue: ymdOf(x.effectiveFrom) }, { name: "note", label: "Correction note", required: true }]} /> : null}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Assignments({ tenantId, edit }: { tenantId: string; edit: boolean }) {
  const [rows, emps, depts, locs, reqs] = await Promise.all([
    prisma.opsAssignment.findMany({ where: { tenantId }, orderBy: [{ status: "asc" }, { startDate: "desc" }], take: 200 }),
    employeeOptions(tenantId), departmentOptions(tenantId), locationOptions(tenantId),
    prisma.opsApprovalRequest.findMany({ where: { tenantId, kind: "OPS_ASSIGNMENT" }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const en = new Map(emps.map((e) => [e.value, e.label])), dn = new Map(depts.map((d) => [d.value, d.label]));
  const names = await userNames(tenantId, reqs.map((r) => r.requestedBy));
  return (
    <div className="stack gap-4">
      {edit ? <Card title="Request a temporary assignment or secondment" description="The manager and HR approve. It starts on the start date and the employee's record shows the host team; at the end, HR completes it with a return note.">
        <SpecForm action={requestAssignmentAction} columns={3} fields={[
          { name: "employeeId", label: "Employee", type: "select", required: true, options: emps }, { name: "kind", label: "Kind", type: "select", required: true, options: [{ value: "TEMPORARY", label: "Temporary assignment" }, { value: "SECONDMENT", label: "Secondment" }] },
          { name: "role", label: "Role while assigned" },
          { name: "hostDepartmentId", label: "Host team", type: "select", options: depts }, { name: "hostLocationId", label: "Host location", type: "select", options: locs }, { name: "hostOrganisation", label: "Host organisation (secondment)" },
          { name: "hostManagerId", label: "Host manager", type: "select", options: emps },
          { name: "startDate", label: "From", type: "date", required: true }, { name: "endDate", label: "To", type: "date", required: true },
          { name: "costSharePct", label: "Host pays (%)", type: "number" }, { name: "note", label: "Note", wide: true },
        ]} />
      </Card> : null}
      <Card title="Assignments" tight>
        <Table head={["Employee", "Kind", "Host", "Window", "Extensions", "Status", ""]} empty={rows.length === 0}>
          {rows.map((a) => <tr key={a.id}><td className="text-sm">{en.get(a.employeeId) ?? ""}</td><td className="text-sm">{a.kind === "SECONDMENT" ? "Secondment" : "Temporary"}{a.role ? <div className="text-xs subtle">{a.role}</div> : null}</td>
            <td className="text-sm">{a.hostOrganisation ?? (a.hostDepartmentId ? dn.get(a.hostDepartmentId) : "") ?? ""}{a.costSharePct !== null ? <div className="text-xs subtle">host pays {a.costSharePct}%</div> : null}</td>
            <td className="text-sm nowrap">{fmtDate(a.startDate)} – {fmtDate(a.endDate)}{a.endDate.getTime() !== a.originalEndDate.getTime() ? <div className="text-xs subtle">was {fmtDate(a.originalEndDate)}</div> : null}</td>
            <td className="num">{a.extensions}</td><td><Pill s={a.status} /></td>
            <td>{edit ? <div className="row gap-1 wrap">
              {a.status === "APPROVED" ? <ActButton action={moveAssignmentAction} hidden={{ id: a.id, to: "ACTIVE" }} label="Start" /> : null}
              {["APPROVED", "ACTIVE"].includes(a.status) ? <SpecForm action={moveAssignmentAction} hidden={{ id: a.id, to: "EXTEND" }} columns={2} submitLabel="Extend" fields={[{ name: "endDate", label: "New end", type: "date", required: true }, { name: "note", label: "Why" }]} /> : null}
              {a.status === "ACTIVE" ? <ActButton action={moveAssignmentAction} hidden={{ id: a.id, to: "COMPLETED" }} label="Complete" input={{ name: "note", placeholder: "Return note" }} /> : null}
              {["REQUESTED", "APPROVED"].includes(a.status) ? <ActButton action={moveAssignmentAction} hidden={{ id: a.id, to: "CANCELLED" }} label="Cancel" variant="ghost" confirmText="Cancel this assignment?" /> : null}
            </div> : null}</td></tr>)}
        </Table>
      </Card>
      <Card title="Approval requests" tight><OpsRequests rows={reqs} names={names} /></Card>
    </div>
  );
}

async function Status({ tenantId, from, to, edit }: { tenantId: string; from: Date; to: Date; edit: boolean }) {
  const [r, emps, codes] = await Promise.all([statusChangeReport(tenantId, from, to), employeeOptions(tenantId), reasonCodes(tenantId, "STATUS", true)]);
  return (
    <div className="stack gap-4">
      {edit ? <Card title="Change an employee's status" description="Every change needs a reason from the status catalogue (Time controls › Reason catalogues › Employee status reasons).">
        {codes.length ? <SpecForm action={changeStatusAction} columns={3} fields={[
          { name: "employeeId", label: "Employee", type: "select", required: true, options: emps }, { name: "toStatus", label: "New status", type: "select", required: true, options: STATUSES },
          { name: "reasonCode", label: "Reason", type: "select", required: true, options: codes.map((c) => ({ value: c.code, label: `${c.label}${c.appliesTo ? ` (${c.appliesTo})` : ""}` })) },
          { name: "effectiveOn", label: "Effective", type: "date" }, { name: "note", label: "Note", wide: true },
        ]} /> : <Callout tone="warning" title="No status reasons yet">Add reasons to the employee status catalogue first.</Callout>}
      </Card> : null}
      <div className="grid grid-2">
        <Card title="By reason" tight><Table head={["Reason", "Changes"]} empty={r.byReason.length === 0}>{r.byReason.map((x) => <tr key={x.reason}><td className="text-sm">{x.reason}</td><td className="num">{x.count}</td></tr>)}</Table></Card>
        <Card title="Changes" tight>
          <Table head={["Effective", "Employee", "From → to", "Reason", "Note"]} empty={r.rows.length === 0}>
            {r.rows.map((x) => <tr key={x.id}><td className="text-sm">{fmtDate(x.effectiveOn)}</td><td className="text-sm">{x.employee}</td><td className="text-xs">{x.fromStatus} → {x.toStatus}</td><td className="text-sm">{x.reasonLabel}</td><td className="text-xs">{x.note ?? ""}</td></tr>)}
          </Table>
        </Card>
      </div>
    </div>
  );
}

async function Rehire({ tenantId, employeeId, filter, edit }: { tenantId: string; employeeId?: string; filter?: string; edit: boolean }) {
  const f = filter === "ELIGIBLE" || filter === "NOT_ELIGIBLE" || filter === "UNKNOWN" ? filter : null;
  const list = await rehireEligibilityList(tenantId, f);
  const tl = employeeId ? await employmentTimeline(tenantId, employeeId) : null;
  return (
    <div className="stack gap-4">
      <div className="tabs">{[["", "All leavers"], ["ELIGIBLE", "Eligible"], ["NOT_ELIGIBLE", "Not eligible"], ["UNKNOWN", "Not recorded"]].map(([k, l]) => <a key={k} className={`tab${(f ?? "") === k ? " active" : ""}`} href={`/lifecycle?tab=rehire${k ? `&filter=${k}` : ""}`}>{l}</a>)}</div>
      {tl ? <Card title={`Employment timeline: ${tl.employee.displayName} (${tl.employee.employeeNumber})`} description={`Status ${tl.employee.status.toLowerCase().replace(/_/g, " ")} · ${tl.stints.length || 1} stint(s) · rehire ${tl.rehireEligible === null ? "not recorded" : tl.rehireEligible ? "eligible" : "not eligible"}`}>
        <Table head={["Date", "Event", "Detail"]} empty={tl.events.length === 0}>{tl.events.map((e, i) => <tr key={i}><td className="text-sm nowrap">{fmtDate(e.date)}</td><td><Pill s={e.kind} /></td><td className="text-sm">{e.text}</td></tr>)}</Table>
        {edit && tl.employee.status === "EXITED" ? <div style={{ marginTop: 12 }}><SpecForm action={rehireAction} hidden={{ employeeId: tl.employee.id }} columns={3} submitLabel="Rehire" fields={[
          { name: "joinDate", label: "New joining date", type: "date", required: true }, { name: "override", label: "Override reason", hint: tl.rehireEligible === false ? "Required: marked not eligible" : undefined }, { name: "note", label: "Note" },
        ]} /></div> : null}
      </Card> : null}
      <Card title="Leavers" tight>
        <Table head={["Employee", "Left", "Exit", "Rehire", ""]} empty={list.length === 0}>
          {list.map((r) => <tr key={r.id}><td className="text-sm"><a href={`/lifecycle?tab=rehire&emp=${r.id}${f ? `&filter=${f}` : ""}`}>{r.name} ({r.employeeNumber})</a></td><td className="text-sm">{fmtDate(r.lastWorkingDay)}</td><td className="text-sm">{r.exitType ? String(r.exitType).toLowerCase() : ""}</td><td><Pill s={r.eligibility} /></td>
            <td>{edit ? <div className="row gap-1">{r.eligibility !== "ELIGIBLE" ? <ActButton action={setRehireEligibilityAction} hidden={{ employeeId: r.id, eligible: "yes" }} label="Eligible" variant="ghost" /> : null}{r.eligibility !== "NOT_ELIGIBLE" ? <ActButton action={setRehireEligibilityAction} hidden={{ employeeId: r.id, eligible: "no" }} label="Not eligible" variant="ghost" input={{ name: "note", placeholder: "Why" }} /> : null}</div> : null}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Fte({ tenantId, edit }: { tenantId: string; edit: boolean }) {
  const [rows, emps, types] = await Promise.all([fteReport(tenantId), employeeOptions(tenantId), prisma.workerType.findMany({ where: { tenantId }, select: { id: true, name: true } })]);
  return (
    <div className="stack gap-4">
      {edit ? <Card title="Convert full-time / part-time" description="Hours and CTC scale with the FTE. Payroll approves; approval applies a salary revision (and a worker type change if chosen) from the effective date.">
        <SpecForm action={requestFteAction} columns={3} fields={[
          { name: "employeeId", label: "Employee", type: "select", required: true, options: emps }, { name: "toFte", label: "New FTE (0.1 – 1)", type: "number", required: true }, { name: "effectiveFrom", label: "Effective", type: "date", required: true },
          { name: "workerTypeId", label: "Worker type", type: "select", options: types.map((x) => ({ value: x.id, label: x.name })), placeholder: "Unchanged" }, { name: "reason", label: "Reason", required: true, wide: true },
        ]} />
      </Card> : null}
      <Card title="FTE changes" tight>
        <Table head={["Employee", "Direction", "FTE", "Weekly hours", "CTC", "Effective", "Status"]} empty={rows.length === 0}>
          {rows.map((r) => <tr key={r.id}><td className="text-sm">{r.employee}</td><td className="text-sm">{r.direction.toLowerCase().replace(/_/g, " ")}</td><td className="text-sm">{Number(r.fromFte)} → {Number(r.toFte)}</td><td className="text-sm">{Number(r.fromWeeklyHours)} → {Number(r.toWeeklyHours)}</td><td className="text-sm">{Number(r.fromCtc).toLocaleString("en-IN")} → {Number(r.toCtc).toLocaleString("en-IN")}</td><td className="text-sm">{fmtDate(r.effectiveFrom)}</td><td><Pill s={r.status} /></td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Confirmation({ tenantId, manage, employeeId }: { tenantId: string; manage: boolean; employeeId?: string }) {
  const [rules, policies, onProbation] = await Promise.all([
    prisma.opsConfirmationRule.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.probationPolicy.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { tenantId, status: "PROBATION" }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" } }),
  ]);
  const check = employeeId ? await confirmationEligibility(tenantId, employeeId) : null;
  const pn = new Map(policies.map((p) => [p.id, p.name]));
  return (
    <div className="stack gap-4">
      {manage ? <Card title="Add a confirmation rule" description="Confirming someone on probation checks these rules: service, LOP, late marks, recent warnings and the probation evaluation.">
        <SpecForm action={saveConfirmationRuleAction} columns={3} fields={[
          { name: "name", label: "Name", required: true }, { name: "probationPolicyId", label: "Probation policy", type: "select", options: policies.map((p) => ({ value: p.id, label: p.name })), placeholder: "All policies" },
          { name: "minServiceDays", label: "Minimum service (days)", type: "number", defaultValue: 90 }, { name: "maxLopDays", label: "Max LOP days", type: "number" }, { name: "maxLateMarks", label: "Max late marks", type: "number" },
          { name: "noWarningsMonths", label: "No warnings in (months)", type: "number" }, { name: "requireEvaluation", label: "Evaluation", type: "checkbox", placeholder: "Submitted evaluation needed" }, { name: "minRating", label: "Minimum rating", type: "number" },
        ]} />
      </Card> : null}
      <Card title="Rules" tight>
        <Table head={["Rule", "Policy", "Service", "LOP", "Late", "Warnings", "Evaluation", "Rating", "Active"]} empty={rules.length === 0}>
          {rules.map((r) => <tr key={r.id}><td className="text-sm">{r.name}</td><td className="text-sm">{r.probationPolicyId ? pn.get(r.probationPolicyId) ?? "" : "All"}</td><td className="num">{r.minServiceDays}</td><td className="num">{r.maxLopDays === null ? "—" : Number(r.maxLopDays)}</td><td className="num">{r.maxLateMarks ?? "—"}</td><td className="num">{r.noWarningsMonths ? `${r.noWarningsMonths} mo` : "—"}</td><td>{r.requireEvaluation ? "Yes" : ""}</td><td className="num">{r.minRating === null ? "—" : Number(r.minRating)}</td><td><Pill s={r.isActive ? "ACTIVE" : "INACTIVE"} /></td></tr>)}
        </Table>
      </Card>
      <Card title="Check eligibility">
        <form method="get" className="row gap-2"><input type="hidden" name="tab" value="confirmation" /><select className="select" name="emp" defaultValue={employeeId ?? ""} style={{ width: 280 }}>{onProbation.map((e) => <option key={e.id} value={e.id}>{e.displayName} ({e.employeeNumber})</option>)}</select><button className="btn sm" type="submit">Check</button></form>
        {check ? <div style={{ marginTop: 12 }}><Callout tone={check.eligible ? "success" : "warning"} title={`${check.employee}: ${check.eligible ? "eligible for confirmation" : "not yet eligible"}`}>{check.reasons.length ? check.reasons.join(" ") : "Every rule is met."}</Callout></div> : null}
      </Card>
    </div>
  );
}

async function Contracts({ tenantId }: { tenantId: string }) {
  const rows = await contractRenewalBoard(tenantId, 120);
  return (
    <Card title="Contracts ending in the next 120 days" description="The HR owner and the employee's manager are reminded at each milestone set under Time controls › Settings › Lifecycle (nightly)." tight>
      <Table head={["Employee", "Contract", "Ends", "Days left", "Renewed", "Reminders sent"]} empty={rows.length === 0}>
        {rows.map((r) => <tr key={r.id}><td className="text-sm">{r.employee}</td><td className="text-sm">{r.contractNumber ?? ""}</td><td className="text-sm">{fmtDate(r.endDate)}</td><td className={`num${r.daysLeft <= 7 ? " neg" : ""}`}>{r.daysLeft}</td><td>{r.renewed ? <Pill s="RENEWED" /> : null}</td><td className="text-xs">{r.alertsSent.sort((a, b) => b - a).map((d) => `${d}d`).join(", ")}</td></tr>)}
      </Table>
    </Card>
  );
}
