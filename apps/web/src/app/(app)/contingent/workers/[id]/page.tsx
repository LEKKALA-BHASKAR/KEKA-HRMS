import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { contractExpiry, contractorPayout } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { orgNames, auditTrail } from "@/lib/workforce";
import { PageHead, Card, KeyValue, Empty, Badge } from "@/components/ui";
import { Disclosure, SimpleForm, ActionButton, F, Select } from "@/components/workforce-ui";
import { StatusPill, RequestsTable, AuditTable, inr } from "@/components/workforce-tables";
import {
  saveWorkerAction, saveAssignmentAction, requestContractChangeAction, revisePendingContractChangeAction, addMilestoneAction, setMilestoneStatusAction,
  savePaymentProfileAction, submitContractorTimesheetAction, decideContractorTimesheetAction, submitContractorExpenseAction, decideContractorExpenseAction,
  requestContractorAccessAction, revokeContractorAccessAction, addContractorFeedbackAction, requestConversionAction, convertContractorAction,
} from "@/app/actions/contingent";
import { WorkerFields } from "../fields";

const P = PERMISSIONS;

export default async function WorkerPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.CONTINGENT_VIEW);
  const { id } = await params;
  const w = await prisma.contingentWorker.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      vendor: true, paymentProfile: true, accessRequests: { orderBy: { createdAt: "desc" } }, feedback: { orderBy: { createdAt: "desc" } },
      assignments: { orderBy: { startDate: "desc" }, include: { milestones: { orderBy: { dueDate: "asc" } }, timesheets: { orderBy: { periodStart: "desc" } }, expenses: { orderBy: { date: "desc" } } } },
    },
  });
  if (!w) notFound();
  const canManage = can(viewer, P.CONTINGENT_MANAGE);
  const [names, requests, audit, users, vendors, projects, entities, titles] = await Promise.all([
    orgNames(viewer.tenantId),
    prisma.workforceRequest.findMany({ where: { tenantId: viewer.tenantId, OR: [{ entityId: w.id }, { entityId: { in: w.assignments.map((a) => a.id) } }, { entityId: { in: w.accessRequests.map((a) => a.id) } }] }, orderBy: { requestedAt: "desc" } }),
    auditTrail(viewer.tenantId, ["ContingentWorker", "ContractAssignment", "ContractorTimesheet", "ContractorExpense"], w.id),
    prisma.user.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, email: true } }),
    prisma.contingentVendor.findMany({ where: { tenantId: viewer.tenantId, status: "ACTIVE" }, select: { id: true, name: true } }),
    prisma.project.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.legalEntity.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } }),
    prisma.jobTitle.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const contractAudit = await prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, entityId: { in: [...w.assignments.map((a) => a.id), ...w.assignments.flatMap((a) => [...a.timesheets.map((t) => t.id), ...a.expenses.map((e) => e.id)])] } }, orderBy: { createdAt: "desc" }, take: 200 });
  const userMap = new Map(users.map((u) => [u.id, u.email]));
  const deptOpts = names.departments.map((d) => ({ value: d.id, label: d.name }));
  const empOpts = names.employees.filter((e) => e.status !== "EXITED").map((e) => ({ value: e.id, label: `${e.displayName ?? e.firstName} (${e.employeeNumber})` }));
  const pendingChange = (aid: string) => requests.find((r) => r.entityId === aid && r.status === "PENDING" && (r.kind === "CONTRACT_END" || r.kind === "CONTRACT_EXTEND"));
  const conversion = requests.find((r) => r.kind === "CONVERSION" && r.entityId === w.id && (r.status === "PENDING" || r.status === "APPROVED"));
  const isManager = !!viewer.employee && viewer.employee.id === w.managerEmployeeId;
  const mayDecide = (managerId: string | null) => can(viewer, P.CONTINGENT_APPROVE) || (!!viewer.employee && viewer.employee.id === managerId);
  const active = w.assignments.find((a) => a.status === "ACTIVE");
  const pp = w.paymentProfile;
  const payout = pp && active ? contractorPayout(Number(active.rate), { gstRegistered: pp.gstRegistered, gstRatePct: Number(pp.gstRatePct), tdsRatePct: Number(pp.tdsRatePct) }) : null;
  const rateTypes = ["HOURLY", "DAILY", "MONTHLY", "FIXED"].map((v) => ({ value: v, label: v.toLowerCase() }));
  const open = !["ENDED", "CONVERTED", "REJECTED"].includes(w.status);

  return (
    <>
      <PageHead title={<>{w.code} · {w.firstName} {w.lastName}</>} subtitle={<><StatusPill status={w.status} /> {w.workerKind === "VENDOR_WORKER" ? `Vendor worker via ${w.vendor?.name ?? "—"}` : "Independent contractor"} · {w.engagementType.toLowerCase().replace(/_/g, " ")}</>}
        actions={<Link className="btn sm" href="/contingent/workers">All workers</Link>} />
      <div className="grid grid-2">
        <Card title="Profile">
          <KeyValue items={[
            ["Email", w.email], ["Phone", w.phone], ["PAN", w.pan], ["Skills", w.skills.join(", ") || null],
            ["Department", w.departmentId ? names.dept.get(w.departmentId) : null], ["Manager", w.managerEmployeeId ? names.emp.get(w.managerEmployeeId) : null],
            ["Started", w.startedAt ? formatDate(w.startedAt) : null], ["Ended", w.endedAt ? formatDate(w.endedAt) : null],
            ["Converted to", w.convertedEmployeeId ? <Link href={`/employees/${w.convertedEmployeeId}`}>{names.emp.get(w.convertedEmployeeId)}</Link> : null], ["Notes", w.notes],
          ]} />
          {canManage && open ? (
            <Disclosure label="Edit profile" variant="default">
              <SimpleForm action={saveWorkerAction} hidden={{ id: w.id }}><WorkerFields d={w} opts={{ vendors: [...vendors, ...(w.vendor && !vendors.some((v) => v.id === w.vendor!.id) ? [w.vendor] : [])].map((v) => ({ value: v.id, label: v.name })), departments: deptOpts, employees: empOpts }} /></SimpleForm>
            </Disclosure>
          ) : null}
        </Card>
        <Card title="Payment profile" description="Rate type, GST and TDS, and where payment goes. Every change is verified again by a contingent approver.">
          {pp ? (
            <KeyValue items={[
              ["Status", <StatusPill key="s" status={pp.status} />], ["Paid to", pp.payee === "VENDOR" ? "Vendor (agency invoice)" : "Worker directly"], ["Rate type", pp.rateType.toLowerCase()],
              ["GST", pp.gstRegistered ? `${pp.gstin} @ ${Number(pp.gstRatePct)}%` : "Not registered"], ["TDS", `${pp.tdsSection} @ ${Number(pp.tdsRatePct)}%`],
              ["Bank", pp.bankName ? `${pp.bankName} ••••${pp.accountNumber?.slice(-4) ?? ""} (${pp.ifsc ?? ""})` : null],
              ["Per-period payout", payout && active ? `${inr(active.rate)} + GST ${inr(payout.gst)} − TDS ${inr(payout.tds)} = ${inr(payout.payable)}` : null],
            ]} />
          ) : <Empty title="No payment profile yet." />}
          {canManage && open ? (
            <Disclosure label={pp ? "Change payment profile" : "Set up payment profile"} variant="default">
              <SimpleForm action={savePaymentProfileAction} hidden={{ workerId: w.id }}>
                <div className="grid grid-2">
                  <F label="Paid to"><Select name="payee" options={[{ value: "WORKER", label: "Worker directly" }, { value: "VENDOR", label: "Vendor (agency)" }]} defaultValue={pp?.payee ?? (w.workerKind === "VENDOR_WORKER" ? "VENDOR" : "WORKER")} /></F>
                  <F label="Rate type"><Select name="rateType" options={rateTypes} defaultValue={pp?.rateType ?? "MONTHLY"} /></F>
                  <F label="GSTIN"><input className="input" name="gstin" defaultValue={pp?.gstin ?? undefined} /></F>
                  <F label="GST %"><input className="input" type="number" name="gstRatePct" step="0.01" defaultValue={pp ? Number(pp.gstRatePct) : 18} /></F>
                  <F label="TDS section"><Select name="tdsSection" options={[{ value: "194J", label: "194J — professional" }, { value: "194C", label: "194C — contract" }]} defaultValue={pp?.tdsSection ?? "194J"} /></F>
                  <F label="TDS %"><input className="input" type="number" name="tdsRatePct" step="0.01" defaultValue={pp ? Number(pp.tdsRatePct) : undefined} /></F>
                  <F label="Bank"><input className="input" name="bankName" defaultValue={pp?.bankName ?? undefined} /></F>
                  <F label="Account number"><input className="input" name="accountNumber" defaultValue={pp?.accountNumber ?? undefined} /></F>
                  <F label="IFSC"><input className="input" name="ifsc" defaultValue={pp?.ifsc ?? undefined} /></F>
                  <F label="Account holder"><input className="input" name="accountHolder" defaultValue={pp?.accountHolder ?? undefined} /></F>
                </div>
                <label className="checkbox-row"><input type="checkbox" name="gstRegistered" defaultChecked={pp?.gstRegistered} /> <span className="text-sm">GST registered</span></label>
              </SimpleForm>
            </Disclosure>
          ) : null}
        </Card>
      </div>

      <Card title="Contract assignments" action={canManage && open ? null : undefined}>
        {w.assignments.length === 0 ? <Empty title="No contracts yet." /> : w.assignments.map((a) => {
          const exp = contractExpiry(a.endDate, new Date());
          const change = pendingChange(a.id);
          return (
            <div key={a.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 14, marginBottom: 14 }}>
              <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                <strong>{a.role}</strong> <StatusPill status={a.status} />
                {a.status === "ACTIVE" && exp.state !== "ACTIVE" ? <Badge tone="danger">{exp.state === "EXPIRED" ? "past end date" : `ends in ${exp.days} days`}</Badge> : null}
                {a.extensions ? <Badge>extended ×{a.extensions}</Badge> : null}
              </div>
              <div className="text-sm" style={{ margin: "6px 0" }}>
                {formatDate(a.startDate)} → {formatDate(a.endDate)} · {inr(a.rate)} {a.rateType.toLowerCase()} · {a.departmentId ? names.dept.get(a.departmentId) : "—"}{a.projectId ? ` · project ${projects.find((p) => p.id === a.projectId)?.name ?? ""}` : ""} · manager {a.managerEmployeeId ? names.emp.get(a.managerEmployeeId) : "—"}
                {a.poNumber ? <> · PO <span className="mono">{a.poNumber}</span>{a.poAmount ? ` (${inr(a.poAmount)})` : ""}</> : null}
                {a.sowReference ? <> · SOW <span className="mono">{a.sowReference}</span></> : null}{a.endReason ? <> · {a.endReason}</> : null}
              </div>
              {a.sowDescription ? <div className="text-xs muted">{a.sowDescription}</div> : null}
              <div className="row gap-2 wrap" style={{ alignItems: "flex-start", marginTop: 8 }}>
                {canManage && a.status === "ACTIVE" && !change ? (
                  <Disclosure label="Extend or end" variant="default">
                    <SimpleForm action={requestContractChangeAction} hidden={{ id: a.id }} submitLabel="Send for approval">
                      <div className="grid grid-2">
                        <F label="Change"><Select name="change" options={[{ value: "extend", label: "Extend" }, { value: "end", label: "End" }]} /></F>
                        <F label="Reason *"><input className="input" name="reason" required /></F>
                        <F label="New end date (extend)"><input className="input" type="date" name="newEndDate" /></F>
                        <F label="New rate (extend, optional)"><input className="input" type="number" name="newRate" min={0} /></F>
                        <F label="Last day (end)"><input className="input" type="date" name="endDate" /></F>
                      </div>
                    </SimpleForm>
                  </Disclosure>
                ) : null}
                {canManage && change ? (
                  <Disclosure label={`Reschedule pending ${change.kind === "CONTRACT_END" ? "end" : "extension"}`} variant="default">
                    <SimpleForm action={revisePendingContractChangeAction} hidden={{ requestId: change.id }} submitLabel="Update request">
                      <F label="Date"><input className="input" type="date" name="date" required /></F>
                      <F label="Reason"><input className="input" name="reason" defaultValue={change.reason ?? undefined} /></F>
                    </SimpleForm>
                  </Disclosure>
                ) : null}
                {canManage && a.status !== "ENDED" ? (
                  <Disclosure label="Edit contract" variant="default">
                    <SimpleForm action={saveAssignmentAction} hidden={{ workerId: w.id, assignmentId: a.id, startDate: a.startDate.toISOString().slice(0, 10), endDate: a.endDate.toISOString().slice(0, 10), rateType: a.rateType, rate: String(Number(a.rate)) }}>
                      <div className="grid grid-3">
                        <F label="Role"><input className="input" name="role" required defaultValue={a.role} /></F>
                        <F label="Department"><Select name="departmentId" options={deptOpts} defaultValue={a.departmentId} placeholder="—" /></F>
                        <F label="Project"><Select name="projectId" options={projects.map((p) => ({ value: p.id, label: p.name }))} defaultValue={a.projectId} placeholder="—" /></F>
                        <F label="Manager"><Select name="managerEmployeeId" options={empOpts} defaultValue={a.managerEmployeeId} placeholder="—" /></F>
                        <F label="PO number"><input className="input" name="poNumber" defaultValue={a.poNumber ?? undefined} /></F>
                        <F label="PO amount"><input className="input" type="number" name="poAmount" defaultValue={a.poAmount ? Number(a.poAmount) : undefined} /></F>
                        <F label="SOW reference"><input className="input" name="sowReference" defaultValue={a.sowReference ?? undefined} /></F>
                        <F label="SOW description"><input className="input" name="sowDescription" defaultValue={a.sowDescription ?? undefined} /></F>
                      </div>
                    </SimpleForm>
                  </Disclosure>
                ) : null}
              </div>

              <div className="grid grid-3" style={{ marginTop: 10 }}>
                <div>
                  <div className="label">SOW milestones</div>
                  {a.milestones.length === 0 ? <div className="text-xs muted">None</div> : (
                    <table className="data"><tbody>{a.milestones.map((m) => (
                      <tr key={m.id}><td className="text-sm">{m.name}<div className="text-xs muted">due {formatDate(m.dueDate)}</div></td><td className="num">{inr(m.amount)}</td><td><StatusPill status={m.status} /></td>
                        <td>{canManage && m.status !== "PAID" ? <ActionButton action={setMilestoneStatusAction} hidden={{ id: m.id, status: m.status === "PENDING" ? "COMPLETED" : "PAID" }} label={m.status === "PENDING" ? "Complete" : "Mark paid"} /> : null}</td></tr>
                    ))}</tbody></table>
                  )}
                  {canManage && a.status === "ACTIVE" ? (
                    <Disclosure label="Add milestone" variant="default">
                      <SimpleForm action={addMilestoneAction} hidden={{ assignmentId: a.id }} submitLabel="Add">
                        <F label="Name"><input className="input" name="name" required /></F>
                        <F label="Due"><input className="input" type="date" name="dueDate" required /></F>
                        <F label="Amount"><input className="input" type="number" name="amount" min={0} required /></F>
                      </SimpleForm>
                    </Disclosure>
                  ) : null}
                </div>
                <div>
                  <div className="label">Timesheets & attendance</div>
                  {a.timesheets.length === 0 ? <div className="text-xs muted">None</div> : (
                    <table className="data"><tbody>{a.timesheets.map((t) => (
                      <tr key={t.id}><td className="text-xs">{formatDate(t.periodStart)}–{formatDate(t.periodEnd)}<div className="muted">{Number(t.hours)} h · {Number(t.daysPresent)} days</div></td><td className="num">{inr(t.amount)}</td><td><StatusPill status={t.status} /></td>
                        <td>{t.status === "SUBMITTED" && mayDecide(a.managerEmployeeId) ? <><ActionButton action={decideContractorTimesheetAction} hidden={{ id: t.id, decision: "approve" }} label="Approve" variant="primary" /><ActionButton action={decideContractorTimesheetAction} hidden={{ id: t.id, decision: "reject" }} label="Reject" /></> : null}</td></tr>
                    ))}</tbody></table>
                  )}
                  {canManage && (a.status === "ACTIVE" || a.status === "ENDED") ? (
                    <Disclosure label="Log timesheet" variant="default">
                      <SimpleForm action={submitContractorTimesheetAction} hidden={{ assignmentId: a.id }} submitLabel="Log">
                        <F label="From"><input className="input" type="date" name="periodStart" required /></F>
                        <F label="To"><input className="input" type="date" name="periodEnd" required /></F>
                        <F label="Hours"><input className="input" type="number" step="0.5" name="hours" min={0} required /></F>
                        <F label="Days present"><input className="input" type="number" step="0.5" name="daysPresent" min={0} /></F>
                      </SimpleForm>
                    </Disclosure>
                  ) : null}
                </div>
                <div>
                  <div className="label">Expenses</div>
                  {a.expenses.length === 0 ? <div className="text-xs muted">None</div> : (
                    <table className="data"><tbody>{a.expenses.map((e) => (
                      <tr key={e.id}><td className="text-xs">{formatDate(e.date)} {e.category}<div className="muted">{e.description}</div></td><td className="num">{inr(e.amount)}</td><td><StatusPill status={e.status} /></td>
                        <td>{e.status === "SUBMITTED" && mayDecide(a.managerEmployeeId) ? <><ActionButton action={decideContractorExpenseAction} hidden={{ id: e.id, decision: "approve" }} label="Approve" variant="primary" /><ActionButton action={decideContractorExpenseAction} hidden={{ id: e.id, decision: "reject" }} label="Reject" /></> : null}</td></tr>
                    ))}</tbody></table>
                  )}
                  {canManage && a.status === "ACTIVE" ? (
                    <Disclosure label="Log expense" variant="default">
                      <SimpleForm action={submitContractorExpenseAction} hidden={{ assignmentId: a.id }} submitLabel="Log">
                        <F label="Date"><input className="input" type="date" name="date" required /></F>
                        <F label="Category"><input className="input" name="category" required /></F>
                        <F label="Amount"><input className="input" type="number" name="amount" min={0} step="0.01" required /></F>
                        <F label="Description"><input className="input" name="description" /></F>
                      </SimpleForm>
                    </Disclosure>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
        {canManage && open ? (
          <Disclosure label="New contract assignment">
            <SimpleForm action={saveAssignmentAction} hidden={{ workerId: w.id }} submitLabel="Send for approval">
              <div className="grid grid-3">
                <F label="Role *"><input className="input" name="role" required /></F>
                <F label="Department"><Select name="departmentId" options={deptOpts} defaultValue={w.departmentId} placeholder="—" /></F>
                <F label="Project"><Select name="projectId" options={projects.map((p) => ({ value: p.id, label: p.name }))} placeholder="—" /></F>
                <F label="Manager"><Select name="managerEmployeeId" options={empOpts} defaultValue={w.managerEmployeeId} placeholder="—" /></F>
                <F label="Start *"><input className="input" type="date" name="startDate" required /></F>
                <F label="End *"><input className="input" type="date" name="endDate" required /></F>
                <F label="Rate type"><Select name="rateType" options={rateTypes} defaultValue="MONTHLY" /></F>
                <F label="Rate" hint="Leave empty to use the rate card"><input className="input" type="number" name="rate" min={0} /></F>
                <F label="PO number"><input className="input" name="poNumber" /></F>
                <F label="PO amount"><input className="input" type="number" name="poAmount" min={0} /></F>
                <F label="SOW reference"><input className="input" name="sowReference" /></F>
                <F label="SOW description"><input className="input" name="sowDescription" /></F>
              </div>
            </SimpleForm>
          </Disclosure>
        ) : null}
      </Card>

      <div className="grid grid-2">
        <Card title="Access requests">
          {w.accessRequests.length === 0 ? <Empty title="No access requested." /> : (
            <table className="data"><tbody>{w.accessRequests.map((r) => (
              <tr key={r.id}><td>{r.system}</td><td className="text-xs">{r.level.toLowerCase()}</td><td><StatusPill status={r.status} /></td><td>{canManage && r.status === "GRANTED" ? <ActionButton action={revokeContractorAccessAction} hidden={{ id: r.id }} label="Revoke" /> : null}</td></tr>
            ))}</tbody></table>
          )}
          {canManage && w.status === "ACTIVE" ? (
            <SimpleForm action={requestContractorAccessAction} hidden={{ workerId: w.id }} submitLabel="Request access" inline>
              <F label="System or site"><input className="input" name="system" required /></F>
              <F label="Level"><Select name="level" options={[{ value: "READ_ONLY", label: "Read only" }, { value: "STANDARD", label: "Standard" }, { value: "ADMIN", label: "Admin" }]} defaultValue="STANDARD" /></F>
            </SimpleForm>
          ) : null}
        </Card>
        <Card title="Performance feedback">
          {w.feedback.length === 0 ? <Empty title="No feedback yet." /> : (
            <table className="data"><tbody>{w.feedback.map((f) => <tr key={f.id}><td>{"★".repeat(f.rating)}{"☆".repeat(5 - f.rating)}</td><td className="text-sm">{f.comment}</td><td className="text-xs">{userMap.get(f.givenBy)} · {formatDate(f.createdAt)}</td></tr>)}</tbody></table>
          )}
          {canManage || isManager ? (
            <SimpleForm action={addContractorFeedbackAction} hidden={{ workerId: w.id }} submitLabel="Add feedback" inline>
              <F label="Rating"><Select name="rating" options={[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${n}/5` }))} defaultValue="4" /></F>
              <F label="Comment"><input className="input" name="comment" /></F>
            </SimpleForm>
          ) : null}
        </Card>
      </div>

      {canManage && w.status === "ACTIVE" ? (
        <Card title="Convert to employee" description="Approved conversions become an employee record through the regular joining flow; running contracts end.">
          {!conversion ? (
            <SimpleForm action={requestConversionAction} hidden={{ workerId: w.id }} submitLabel="Request conversion" inline>
              <F label="Reason"><input className="input" name="reason" required /></F>
            </SimpleForm>
          ) : conversion.status === "PENDING" ? <div className="text-sm">Conversion requested; waiting for approval.</div> : can(viewer, P.EMPLOYEE_CREATE) ? (
            <SimpleForm action={convertContractorAction} hidden={{ workerId: w.id }} submitLabel="Create employee">
              <div className="grid grid-3">
                <F label="Legal entity *"><Select name="legalEntityId" options={entities.map((e) => ({ value: e.id, label: e.name }))} placeholder="Choose" required /></F>
                <F label="Location *"><Select name="locationId" options={names.locations.map((l) => ({ value: l.id, label: l.name }))} placeholder="Choose" required /></F>
                <F label="Date of joining *"><input className="input" type="date" name="dateOfJoining" required /></F>
                <F label="Work email *"><input className="input" type="email" name="workEmail" defaultValue={w.email ?? undefined} required /></F>
                <F label="Department"><Select name="departmentId" options={deptOpts} defaultValue={w.departmentId} placeholder="—" /></F>
                <F label="Job title"><Select name="jobTitleId" options={titles.map((t) => ({ value: t.id, label: t.name }))} placeholder="—" /></F>
              </div>
            </SimpleForm>
          ) : <div className="text-sm">Approved — someone who can add employees completes it.</div>}
        </Card>
      ) : null}

      <Card title="Approval history"><RequestsTable rows={requests} viewer={viewer} users={userMap} /></Card>
      <Card title="Contractor audit history"><AuditTable rows={[...audit, ...contractAudit].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())} /></Card>
    </>
  );
}
