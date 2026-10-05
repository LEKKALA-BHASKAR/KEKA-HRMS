/**
 * Core HR, second pass: the flows that already existed but were untested,
 * plus the approvals added for configuration changes. Through the real
 * server actions, pages and CSV exports:
 *   1. Approvals for organisation settings, registration profiles and
 *      establishment registrations (approved by a second administrator, or
 *      rejected).
 *   2. Withdrawals: profile changes (with a future effective date), letter
 *      requests; their reports.
 *   3. Mass updates with a future date: manager, location, department and
 *      employment type, and the job-change approval chain they go through.
 *   4. Managers: bulk approval of attendance requests, overtime and shift
 *      requests, an acting manager taking over a team, HR shortcuts on the
 *      team page.
 *   5. HR exception alerts: empty units, departments without a head, work
 *      authorisation running out.
 *   6. Directory: every filter, saved searches and history, the search log,
 *      the profile's context panel and quick actions, own job history.
 *
 * Removes everything it created and restores what it changed.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TAG = `cv${Date.now().toString(36)}`;

function fdl(values: Record<string, string | number | boolean | undefined | null>, lists: Record<string, string[]> = {}): FormData {
  const f = fd(values);
  for (const [k, vs] of Object.entries(lists)) for (const v of vs) f.append(k, v);
  return f;
}

/** The next working day (Monday to Friday) at least `ahead` days from `from`. */
function weekday(from: Date, ahead: number): Date {
  let d = new Date(from.getTime() + ahead * DAY);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + DAY);
  return d;
}

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToReadableStream } = await import("react-dom/server");
  const html = async (node: unknown) => { const stream = await renderToReadableStream(node as never); await stream.allReady; return new Response(stream).text(); };
  const { NextRequest } = await import("next/server");

  const settings = await import("../apps/web/src/app/actions/settings");
  const cfg = await import("../apps/web/src/app/actions/payroll-config");
  const depth = await import("../apps/web/src/app/actions/core-hr-depth");
  const ss = await import("../apps/web/src/app/actions/self-service-depth");
  const ops = await import("../apps/web/src/app/actions/hr-ops");
  const approvals = await import("../apps/web/src/app/actions/payroll-approvals");
  const time = await import("../apps/web/src/app/actions/time");
  const treq = await import("../apps/web/src/app/actions/time-requests");
  const people = await import("../apps/web/src/app/actions/core2-people");
  const svc = await import("@keka/services");
  const { viewerForUser } = await import("../apps/web/src/lib/context");
  const { loadDirectory } = await import("../apps/web/src/lib/directory-search");
  const coreHrExports = await import("../apps/web/src/app/(app)/exports/core-hr/[kind]/route");
  const core2Exports = await import("../apps/web/src/app/(app)/exports/core2/[kind]/route");
  const page = async (path: string) => (await import(`../apps/web/src/app/(app)/${path}/page`)).default;
  const sp = (v: Record<string, string> = {}) => ({ searchParams: Promise.resolve(v) });

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const userOf = (email: string) => prisma.user.findFirstOrThrow({ where: { tenantId: t, email } });
  const empOf = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: t, user: { email } } });
  const [vikram, priya] = await Promise.all(["vikram.menon@acme.test", "priya.sharma@acme.test"].map(userOf));
  const [meera, sneha, ananya, karthik, rohit, divya] = await Promise.all(["meera.krishnan@acme.test", "sneha.reddy@acme.test", "ananya.ghosh@acme.test", "karthik.subramanian@acme.test", "rohit.deshmukh@acme.test", "divya.pillai@acme.test"].map(empOf));
  const adminRole = await prisma.role.findFirstOrThrow({ where: { tenantId: t, key: "GLOBAL_ADMIN" } });
  const entity = await prisma.legalEntity.findFirstOrThrow({ where: { tenantId: t } });
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const csv = async (route: typeof coreHrExports | typeof core2Exports, base: string, kind: string, qs = "") => {
    const res = await route.GET(new NextRequest(`http://acme.localhost/exports/${base}/${kind}${qs}`), { params: Promise.resolve({ kind }) });
    return { status: res.status, body: await res.text() };
  };

  const before = {
    tenantName: tenant.name,
    rohit: await prisma.employee.findUniqueOrThrow({ where: { id: rohit.id } }),
    divya: await prisma.employee.findUniqueOrThrow({ where: { id: divya.id } }),
    meera: await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } }),
  };
  const made = {
    roleAssignment: "", payGroup: "", changeRequests: [] as string[], docType: "", docRequests: [] as string[], batches: [] as string[],
    timeRequests: { AttendanceRequest: [] as string[], OvertimeRequest: [] as string[], ShiftRequest: [] as string[] }, delegation: "",
    depts: [] as string[], identity: "", otEntryBefore: null as null | { id: string; hours: unknown; amount: unknown; rate: unknown }, course: "", savedSearches: [] as string[], headCleared: null as null | { id: string; headId: string },
  };

  try {
    // -----------------------------------------------------------------
    section("1. Configuration changes that need a second administrator");
    made.roleAssignment = (await prisma.userRoleAssignment.create({ data: { userId: priya.id, roleId: adminRole.id } })).id;
    await signInAs("vikram.menon@acme.test");
    let r = await settings.saveTenantProfile({}, fd({ name: `Acme ${TAG}`, timezone: tenant.timezone, fyStartMonth: tenant.fyStartMonth, propose: true, reason: "Rebrand" }));
    let cr = await prisma.recordChangeRequest.findFirst({ where: { tenantId: t, targetType: "ORGANISATION", status: "PENDING" }, orderBy: { createdAt: "desc" } });
    if (cr) made.changeRequests.push(cr.id);
    check("organisation settings can be sent for approval instead of saved", r.ok === true && !!cr && (await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).name === before.tenantName, r.message);
    r = await depth.decideChangeRequestAction({}, fd({ id: cr!.id, decision: "approve" }));
    check("…the administrator who asked cannot approve it", r.ok === false);
    await signInAs("priya.sharma@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: cr!.id, decision: "approve", note: "Fine" }));
    check("…a second administrator approves and it takes effect", r.ok === true && (await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).name === `Acme ${TAG}`, r.message);
    await prisma.tenant.update({ where: { id: t }, data: { name: before.tenantName } });

    const pg = await prisma.payGroup.create({ data: { tenantId: t, legalEntityId: entity.id, name: `Coverage ${TAG}`, approvalWorkflowEnabled: true } });
    made.payGroup = pg.id;
    await signInAs("vikram.menon@acme.test");
    r = await cfg.saveFilingDetails({}, fd({
      payGroupId: pg.id, pan: "aaccb1234k", tan: "blrb12345c", pfWageCeiling: "15000", pfCapAtCeiling: true, pfEmployeeRate: "12", pfEmployerRate: "12",
      epsRate: "8.33", epsWageCeiling: "15000", edliRate: "0.5", pfAdminRate: "0.5", esiWageLimit: "21000", esiEmployeeRate: "0.75", esiEmployerRate: "3.25", propose: true,
    }));
    cr = await prisma.recordChangeRequest.findFirst({ where: { tenantId: t, targetType: "REGISTRATION_PROFILE", targetId: pg.id, status: "PENDING" } });
    if (cr) made.changeRequests.push(cr.id);
    check("a registration profile change waits for approval", r.ok === true && !!cr && !(await prisma.payGroupFilingDetail.findUnique({ where: { payGroupId: pg.id } })), r.message);
    await signInAs("priya.sharma@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: cr!.id, decision: "approve" }));
    check("…approved, the filing details are saved", r.ok === true && (await prisma.payGroupFilingDetail.findUnique({ where: { payGroupId: pg.id } }))?.pan === "AACCB1234K", r.message);
    await signInAs("vikram.menon@acme.test");
    r = await cfg.saveLwfRegistration({}, fd({ payGroupId: pg.id, stateCode: "KA", stateName: "Karnataka", prorateNewJoiners: true, propose: true }));
    cr = await prisma.recordChangeRequest.findFirst({ where: { tenantId: t, targetType: "ESTABLISHMENT", targetId: `LWF:${pg.id}:KA`, status: "PENDING" } });
    if (cr) made.changeRequests.push(cr.id);
    check("an establishment registration waits for approval", r.ok === true && !!cr, r.message);
    await signInAs("priya.sharma@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: cr!.id, decision: "reject", note: "Wrong state" }));
    check("…rejected, nothing is registered", r.ok === true && (await prisma.lwfStateRegistration.count({ where: { payGroupId: pg.id } })) === 0, r.message);
    const out = await csv(coreHrExports, "core-hr", "change-requests");
    check("the decisions are in the change request report", out.status === 200 && out.body.includes("Registration profile") || out.body.includes("Establishment"));
    check("…and audited", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "ChangeRequest", entityId: cr!.id, action: "REJECT" } })) === 1);

    // -----------------------------------------------------------------
    // Priya was an administrator only to be the second approver above.
    await prisma.userRoleAssignment.delete({ where: { id: made.roleAssignment } });
    made.roleAssignment = "";

    section("2. Withdrawals and effective-dated personal changes");
    await signInAs("meera.krishnan@acme.test");
    const later = new Date(today.getTime() + 14 * DAY);
    r = await ss.requestProfileChangeAction({}, fd({ targetType: "CONTACT", personalEmail: `meera.${TAG}@mail.test`, mobile: before.meera.mobile ?? "", alternatePhone: before.meera.alternatePhone ?? "", effectiveDate: iso(new Date(today.getTime() - DAY)) }));
    check("a personal change cannot be dated in the past", r.ok === false);
    r = await ss.requestProfileChangeAction({}, fd({ targetType: "CONTACT", personalEmail: `meera.${TAG}@mail.test`, mobile: before.meera.mobile ?? "", alternatePhone: before.meera.alternatePhone ?? "", effectiveDate: iso(later) }));
    let pc = await prisma.recordChangeRequest.findFirst({ where: { tenantId: t, employeeId: meera.id, targetType: "CONTACT", status: "PENDING" }, orderBy: { createdAt: "desc" } });
    if (pc) made.changeRequests.push(pc.id);
    check("an employee asks for a contact change from a future date", r.ok === true && !!pc && iso(pc.effectiveDate!) === iso(later), r.message);
    await signInAs("priya.sharma@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: pc!.id, decision: "approve" }));
    pc = await prisma.recordChangeRequest.findUniqueOrThrow({ where: { id: pc!.id } });
    check("…approved, it waits for its date and the record is unchanged", r.ok === true && pc.status === "SCHEDULED" && (await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } })).personalEmail === before.meera.personalEmail, `${r.message} ${pc.status}`);
    await prisma.recordChangeRequest.update({ where: { id: pc.id }, data: { status: "WITHDRAWN" } });
    await signInAs("meera.krishnan@acme.test");
    r = await ss.requestProfileChangeAction({}, fd({ targetType: "CONTACT", personalEmail: `again.${TAG}@mail.test`, mobile: before.meera.mobile ?? "", alternatePhone: before.meera.alternatePhone ?? "" }));
    const pc2 = await prisma.recordChangeRequest.findFirstOrThrow({ where: { tenantId: t, employeeId: meera.id, targetType: "CONTACT", status: "PENDING" }, orderBy: { createdAt: "desc" } });
    made.changeRequests.push(pc2.id);
    await signInAs("karthik.subramanian@acme.test");
    r = await depth.withdrawChangeRequestAction({}, fd({ id: pc2.id }));
    check("a colleague cannot withdraw someone's change", r.ok === false);
    await signInAs("meera.krishnan@acme.test");
    r = await depth.withdrawChangeRequestAction({}, fd({ id: pc2.id }));
    check("the employee withdraws her own change", r.ok === true && (await prisma.recordChangeRequest.findUniqueOrThrow({ where: { id: pc2.id } })).status === "WITHDRAWN", r.message);
    r = await depth.withdrawChangeRequestAction({}, fd({ id: pc2.id }));
    check("…only once", r.ok === false);
    check("…and the withdrawal is audited", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "ChangeRequest", entityId: pc2.id, action: "UPDATE" } })) === 1);

    const template = await prisma.documentTemplate.findFirst({ where: { tenantId: t, isArchived: false } });
    await signInAs("priya.sharma@acme.test");
    r = await ss.saveDocumentRequestTypeAction({}, fd({ name: `Address proof ${TAG}`, templateId: template!.id, requiresApproval: true }));
    const docType = await prisma.documentRequestType.findFirstOrThrow({ where: { tenantId: t, name: `Address proof ${TAG}` } });
    made.docType = docType.id;
    r = await ss.saveDocumentRequestTypeAction({}, fd({ id: docType.id, name: `Address proof ${TAG}`, templateId: template!.id, requiresApproval: true, isActive: true, description: "For banks" }));
    check("HR updates a letter type", r.ok === true, r.message);
    await signInAs("meera.krishnan@acme.test");
    r = await ss.requestDocumentAction({}, fd({ typeId: docType.id, purpose: `Bank account ${TAG}` }));
    const dr = await prisma.selfServiceDocumentRequest.findFirstOrThrow({ where: { tenantId: t, employeeId: meera.id, typeId: docType.id } });
    made.docRequests.push(dr.id);
    await signInAs("karthik.subramanian@acme.test");
    r = await ss.withdrawDocumentRequestAction({}, fd({ id: dr.id }));
    check("a colleague cannot withdraw her letter request", r.ok === false && (await prisma.selfServiceDocumentRequest.findUniqueOrThrow({ where: { id: dr.id } })).status === "PENDING");
    await signInAs("meera.krishnan@acme.test");
    r = await ss.withdrawDocumentRequestAction({}, fd({ id: dr.id }));
    check("the employee withdraws her letter request", r.ok === true && (await prisma.selfServiceDocumentRequest.findUniqueOrThrow({ where: { id: dr.id } })).status === "WITHDRAWN", r.message);
    check("…audited", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "DocumentRequest", entityId: dr.id } })) > 0);
    await signInAs("priya.sharma@acme.test");
    let o = await csv(coreHrExports, "core-hr", "document-requests");
    check("letter requests export with their status", o.status === 200 && o.body.includes(`Bank account ${TAG}`) && o.body.includes("WITHDRAWN"));
    await signInAs("meera.krishnan@acme.test");
    check("…not for an employee", (await csv(coreHrExports, "core-hr", "document-requests")).status === 403);

    // -----------------------------------------------------------------
    section("3. Mass updates with a future date, and their approval");
    await signInAs("priya.sharma@acme.test");
    const future = new Date(today.getTime() + 30 * DAY);
    const otherLoc = await prisma.location.findFirstOrThrow({ where: { tenantId: t, isActive: true, id: { not: before.meera.locationId ?? "-" } } });
    const otherDept = await prisma.department.findFirstOrThrow({ where: { tenantId: t, isActive: true, id: { not: before.meera.departmentId ?? "-" } } });
    const otherType = await prisma.workerType.findFirst({ where: { tenantId: t, id: { not: before.meera.workerTypeId ?? "-" } } });
    const kinds: Array<[string, string, string]> = [["MANAGER", karthik.id, "reportingManagerId"], ["LOCATION", otherLoc.id, "locationId"], ["DEPARTMENT", otherDept.id, "departmentId"], ...(otherType ? [["WORKER_TYPE", otherType.id, "workerTypeId"] as [string, string, string]] : [])];
    for (const [kind, value, field] of kinds) {
      r = await ops.applyMassUpdateAction({}, fd({ kind, value, effectiveFrom: iso(future), numbers: before.meera.employeeNumber, confirm: true, note: `${TAG} ${kind}` }));
      const batch = await prisma.massUpdateBatch.findFirst({ where: { tenantId: t, note: `${TAG} ${kind}` }, include: { items: true } });
      if (batch) made.batches.push(batch.id);
      const jc = batch?.items[0]?.jobChangeId ? await prisma.jobChange.findUnique({ where: { id: batch.items[0].jobChangeId } }) : null;
      const now = await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } });
      check(`a future ${kind.toLowerCase().replace("_", " ")} change is scheduled, not applied`, r.ok === true && jc?.status === "SCHEDULED" && (jc as Record<string, unknown>)[field] === value && (now as Record<string, unknown>)[field] === (before.meera as Record<string, unknown>)[field], r.message);
    }
    o = await csv(coreHrExports, "core-hr", "mass-updates");
    check("mass updates export with each person's outcome", o.status === 200 && o.body.includes("MANAGER") && o.body.includes(karthik.displayName ?? "-") && o.body.includes(before.meera.employeeNumber));
    o = await csv(core2Exports, "core2", "movements", `?from=${iso(today)}&to=${iso(new Date(today.getTime() + 60 * DAY))}&status=SCHEDULED`);
    check("…and the scheduled moves are in the movement report", o.status === 200 && o.body.includes(before.meera.employeeNumber));

    // An approval chain on the pay group: each person's change waits for it.
    await prisma.payrollApprovalRule.create({ data: { payGroupId: pg.id, name: `Job changes ${TAG}`, action: "JOB_CHANGE", approverRoleIds: [adminRole.id] } });
    await prisma.employee.updateMany({ where: { id: { in: [rohit.id, divya.id] } }, data: { payGroupId: pg.id } });
    r = await ops.applyMassUpdateAction({}, fd({ kind: "MANAGER", value: karthik.id, effectiveFrom: iso(future), numbers: `${rohit.employeeNumber}, ${divya.employeeNumber}`, confirm: true, note: `${TAG} chain` }));
    const chain = await prisma.massUpdateBatch.findFirstOrThrow({ where: { tenantId: t, note: `${TAG} chain` }, include: { items: true } });
    made.batches.push(chain.id);
    check("with an approval chain, a mass manager change waits for approval", r.ok === true && chain.items.length === 2 && chain.items.every((i) => i.status === "PENDING_APPROVAL"), r.message);
    const reqOf = (jobChangeId: string) => prisma.payrollApprovalRequest.findFirstOrThrow({ where: { action: "JOB_CHANGE", payload: { path: ["jobChangeId"], equals: jobChangeId } } });
    const [i1, i2] = chain.items;
    r = await approvals.decideApprovalAction({}, fd({ requestId: (await reqOf(i1!.jobChangeId!)).id, decision: "approve" }));
    check("…HR (who asked) cannot approve it", r.ok !== true);
    await signInAs("vikram.menon@acme.test");
    r = await approvals.decideApprovalAction({}, fd({ requestId: (await reqOf(i1!.jobChangeId!)).id, decision: "approve" }));
    check("…an administrator approves one; it is scheduled for its date", r.ok === true && (await prisma.jobChange.findUniqueOrThrow({ where: { id: i1!.jobChangeId! } })).status === "SCHEDULED", r.message);
    r = await approvals.decideApprovalAction({}, fd({ requestId: (await reqOf(i2!.jobChangeId!)).id, decision: "reject", comment: `Not yet ${TAG}` }));
    check("…and rejects the other", r.ok === true && (await prisma.jobChange.findUniqueOrThrow({ where: { id: i2!.jobChangeId! } })).status === "REJECTED", r.message);
    check("…neither person changed manager today", (await prisma.employee.count({ where: { id: { in: [rohit.id, divya.id] }, reportingManagerId: karthik.id } })) === 0);

    // -----------------------------------------------------------------
    section("4. Managers: bulk decisions, overtime, shifts, acting managers, shortcuts");
    await signInAs("meera.krishnan@acme.test");
    const wfh1 = weekday(today, 20), wfh2 = weekday(wfh1, 1);
    for (const d of [wfh1, wfh2]) {
      r = await time.raiseAttendanceRequestAction({}, fd({ type: "WORK_FROM_HOME", fromDate: iso(d), toDate: iso(d), portion: "FULL_DAY", reason: `WFH ${TAG}` }));
      check(`an employee asks to work from home on ${iso(d)}`, r.ok === true, r.message);
    }
    const wfh = await prisma.attendanceRequest.findMany({ where: { employeeId: meera.id, reason: `WFH ${TAG}` } });
    made.timeRequests.AttendanceRequest.push(...wfh.map((w) => w.id));
    await signInAs("ananya.ghosh@acme.test");
    r = await treq.decideManyAction({}, fdl({ entity: "AttendanceRequest", decision: "reject" }, { ids: wfh.map((w) => w.id) }));
    check("a bulk rejection needs a reason", r.ok === false);
    r = await treq.decideManyAction({}, fdl({ entity: "AttendanceRequest", decision: "reject", note: "Team day in the office" }, { ids: wfh.map((w) => w.id) }));
    check("her manager rejects both at once", r.ok === true && (await prisma.attendanceRequest.count({ where: { id: { in: wfh.map((w) => w.id) }, status: "REJECTED" } })) === 2, r.message);
    await signInAs("ananya.ghosh@acme.test");
    o = await csv(core2Exports, "core2", "attendance-requests");
    check("the manager exports her team's attendance requests", o.status === 200 && o.body.includes(`WFH ${TAG}`) && o.body.includes("REJECTED"));

    await signInAs("meera.krishnan@acme.test");
    const otDay = weekday(today, -7 < 0 ? 0 : 0);
    r = await treq.raiseOvertimeAction({}, fd({ fromDate: iso(new Date(otDay.getTime() - 2 * DAY)), hours: "02:00", note: `OT ${TAG}` }));
    const ot = await prisma.overtimeRequest.findFirst({ where: { employeeId: meera.id, note: `OT ${TAG}` } });
    if (ot) made.timeRequests.OvertimeRequest.push(ot.id);
    if (r.ok && ot) {
      // Approving adds the hours to her open overtime entry for the month; remember it to put it back.
      made.otEntryBefore = await prisma.overtimeEntry.findFirst({ where: { tenantId: t, employeeId: meera.id, payAction: "PAY", isProcessed: false, year: ot.toDate.getUTCFullYear(), month: ot.toDate.getUTCMonth() + 1 } });
      await signInAs("karthik.subramanian@acme.test");
      r = await treq.decideTimeRequestAction({}, fd({ entity: "OvertimeRequest", requestId: ot.id, decision: "approve" }));
      check("someone who is not her manager cannot approve her overtime", r.ok === false);
      await signInAs("ananya.ghosh@acme.test");
      r = await treq.decideTimeRequestAction({}, fd({ entity: "OvertimeRequest", requestId: ot.id, decision: "approve" }));
      check("her manager approves the overtime from the team queue", r.ok === true && (await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: ot.id } })).status === "APPROVED", r.message);
    } else check("an employee claims overtime", false, r.message);

    await signInAs("meera.krishnan@acme.test");
    const shift = await prisma.shift.findFirst({ where: { tenantId: t, isActive: true } });
    const shiftDay = weekday(today, 25);
    const assignBefore = await prisma.shiftAssignment.findMany({ where: { employeeId: meera.id, date: shiftDay } });
    r = await treq.raiseShiftRequestAction({}, fd({ kind: "SHIFT_CHANGE", fromDate: iso(shiftDay), shiftId: shift?.id ?? "", reason: `Shift ${TAG}` }));
    const sr = await prisma.shiftRequest.findFirst({ where: { employeeId: meera.id, reason: `Shift ${TAG}` } });
    if (sr) made.timeRequests.ShiftRequest.push(sr.id);
    check("an employee asks for a different shift on her rostered day", r.ok === true && !!sr, r.message);
    await signInAs("ananya.ghosh@acme.test");
    r = await treq.decideManyAction({}, fdl({ entity: "ShiftRequest", decision: "approve" }, { ids: [sr!.id] }));
    check("…her manager approves it and the roster follows", r.ok === true && (await prisma.shiftRequest.findUniqueOrThrow({ where: { id: sr!.id } })).status === "APPROVED" && (await prisma.shiftAssignment.findFirst({ where: { employeeId: meera.id, date: shiftDay } }))?.shiftId === shift?.id, r.message);
    await prisma.shiftAssignment.deleteMany({ where: { employeeId: meera.id, date: shiftDay } });
    if (assignBefore.length) await prisma.shiftAssignment.createMany({ data: assignBefore });

    // HR names an acting manager for Sneha's team.
    await signInAs("priya.sharma@acme.test");
    r = await ss.createDelegationAction({}, fd({ delegatorId: sneha.id, delegateId: karthik.id, kind: "ACTING", startDate: iso(today), endDate: iso(new Date(today.getTime() + 5 * DAY)), reason: `Acting ${TAG}` }));
    const deleg = await prisma.managerDelegation.findFirst({ where: { tenantId: t, delegatorId: sneha.id, reason: `Acting ${TAG}` } });
    made.delegation = deleg?.id ?? "";
    check("HR names an acting manager", r.ok === true && deleg?.kind === "ACTING", r.message);
    check("…the acting manager now counts as one of the team's managers", (await svc.managersOf(t, ananya.id)).includes(karthik.id));
    await signInAs("karthik.subramanian@acme.test");
    const rosterDay = weekday(today, 12);
    const rosterBefore = await prisma.shiftAssignment.findMany({ where: { employeeId: ananya.id, date: rosterDay } });
    r = await people.managerSaveRosterAction({}, fd({ [`cell:${ananya.id}:${iso(rosterDay)}`]: "OFF" }));
    check("…and can roster the team he is acting for", r.ok === true, r.message);
    await prisma.shiftAssignment.deleteMany({ where: { employeeId: ananya.id, date: rosterDay } });
    if (rosterBefore.length) await prisma.shiftAssignment.createMany({ data: rosterBefore });
    check("…the roster page shows the team", (await html(await (await page("team/roster"))(sp()))).includes(ananya.displayName ?? ananya.firstName));
    await signInAs("priya.sharma@acme.test");
    r = await ss.revokeDelegationAction({}, fd({ id: deleg!.id }));
    check("HR ends the acting period", r.ok === true && !(await svc.managersOf(t, ananya.id)).includes(karthik.id), r.message);

    await signInAs("sneha.reddy@acme.test");
    const teamHtml = await html(await (await page("team"))(sp()));
    check("the team page offers HR shortcuts for each report", teamHtml.includes(`/employees/${ananya.id}`) && teamHtml.includes(`/team/activity?who=${ananya.id}`) && teamHtml.includes('data-shortcut="roster"'));

    // -----------------------------------------------------------------
    section("5. HR exception alerts");
    await signInAs("priya.sharma@acme.test");
    const empty = await prisma.department.create({ data: { tenantId: t, name: `Empty ${TAG}` } });
    made.depts.push(empty.id);
    const headed = await prisma.department.findFirst({ where: { tenantId: t, isActive: true, headId: { not: null }, employees: { some: {} } } });
    if (headed) { made.headCleared = { id: headed.id, headId: headed.headId! }; await prisma.department.update({ where: { id: headed.id }, data: { headId: null } }); }
    const passport = await prisma.employeeIdentity.findUnique({ where: { employeeId_type: { employeeId: meera.id, type: "PASSPORT" } } });
    if (!passport) made.identity = (await prisma.employeeIdentity.create({ data: { employeeId: meera.id, type: "PASSPORT", number: `P${TAG}`.slice(0, 12), expiryDate: new Date(today.getTime() + 45 * DAY) } })).id;
    const findings = await svc.findHrOpsExceptions(t);
    check("an active department with nobody in it is flagged", findings.some((f) => f.kind === "ORPHAN_UNIT" && f.fingerprint.endsWith(empty.id)));
    check("a department with people but no head is flagged", !headed || findings.some((f) => f.kind === "VACANT_HEAD" && f.fingerprint.endsWith(headed.id)));
    check("a passport running out within 90 days is flagged", !!passport || findings.some((f) => f.kind === "WORK_AUTH_EXPIRING" && f.employeeId === meera.id));
    r = await people.runHrOpsChecksAction({}, fd({}));
    check("running the checks opens alerts HR can work", r.ok === true && (await prisma.hrOpsAlert.count({ where: { tenantId: t, fingerprint: `ORPHAN_UNIT:${empty.id}`, status: "OPEN" } })) === 1, r.message);
    const desk = await html(await (await page("hr-ops/desk"))(sp({ tab: "alerts" })));
    check("…they are on the HR desk", desk.includes(`Empty ${TAG}`));
    const structure = await html(await (await page("org/structure"))(sp({ tab: "ownership" })));
    check("the ownership view lists units without a head", !headed || structure.includes(headed.name));

    // -----------------------------------------------------------------
    section("6. Directory");
    const vikramViewer = (await viewerForUser(vikram.id))!;
    const has = async (params: Record<string, string>, id: string) => (await loadDirectory(vikramViewer, params, { show: 200 })).people.some((p) => p.id === id);
    const skill = await prisma.employeeSkill.findFirstOrThrow({ where: { employee: { tenantId: t, status: { notIn: ["EXITED", "PREBOARDING"] } } } });
    check("search by skill", await has({ skill: skill.skillId }, skill.employeeId));
    const course = await prisma.course.create({ data: { tenantId: t, title: `Certified ${TAG}`, category: "Compliance" } });
    made.course = course.id;
    const enr = await prisma.courseEnrolment.create({ data: { tenantId: t, courseId: course.id, employeeId: meera.id } });
    await prisma.learningCertificate.create({ data: { tenantId: t, employeeId: meera.id, courseId: course.id, enrolmentId: enr.id, number: `C-${TAG}` } });
    check("search by certification", (await has({ cert: course.id }, meera.id)) && !(await has({ cert: course.id }, ananya.id)));
    await prisma.employeeProfileExtra.upsert({ where: { employeeId: meera.id }, create: { tenantId: t, employeeId: meera.id, languages: [`Lang ${TAG}`] }, update: { languages: [`Lang ${TAG}`] } });
    check("search by language", (await has({ lang: `Lang ${TAG}` }, meera.id)) && !(await has({ lang: `Lang ${TAG}` }, ananya.id)));
    const alloc = await prisma.resourceAllocation.findFirst({ where: { project: { tenantId: t }, startDate: { lte: today }, OR: [{ endDate: null }, { endDate: { gte: today } }] } });
    check("search by project", !alloc || await has({ proj: alloc.projectId }, alloc.employeeId));
    check("search by location", (await has({ loc: before.meera.locationId ?? "" }, meera.id)) && !(await has({ loc: otherLoc.id }, meera.id)));
    check("search by employment type", !before.meera.workerTypeId || await has({ wt: before.meera.workerTypeId }, meera.id));
    const onLeave = await prisma.leaveRequest.findFirst({ where: { tenantId: t, status: "APPROVED", fromDate: { lte: today }, toDate: { gte: today } } });
    check("search by availability", (await has({ avail: "available" }, meera.id) || !!onLeave) && (!onLeave || ((await has({ avail: "away" }, onLeave.employeeId)) && !(await has({ avail: "available" }, onLeave.employeeId)))));
    const todayShift = await prisma.shiftAssignment.findFirst({ where: { date: today, shift: { tenantId: t } } });
    if (todayShift) check("search by shift today", await has({ shift: todayShift.shiftId }, todayShift.employeeId));
    else {
      const s = await prisma.shift.findFirstOrThrow({ where: { tenantId: t } });
      const a = await prisma.shiftAssignment.create({ data: { employeeId: meera.id, date: today, shiftId: s.id } });
      check("search by shift today", await has({ shift: s.id }, meera.id));
      await prisma.shiftAssignment.delete({ where: { id: a.id } });
    }
    const temps = (await loadDirectory(vikramViewer, { temp: "1" }, { show: 200 })).people;
    const contingent = await prisma.employee.count({ where: { tenantId: t, status: { notIn: ["EXITED", "PREBOARDING"] }, workerType: { isContingent: true } } });
    check("a temporary-worker view lists only contract and temporary staff", temps.length <= contingent && temps.length > 0 === contingent > 0);
    const filters = (await loadDirectory(vikramViewer, {}, { show: 1 })).filters.map((f) => f.key);
    check("all the new filters are offered", ["cert", "lang", "proj", "avail", "temp", "loc", "wt", "shift", "skill"].every((k) => filters.includes(k)));

    await signInAs("meera.krishnan@acme.test");
    const meeraUser = await userOf("meera.krishnan@acme.test");
    r = await ops.saveDirectorySearchAction({}, fd({ name: `Tamil ${TAG}`, query: `lang=Tamil&loc=${before.meera.locationId}` }));
    const saved = await prisma.directorySavedSearch.findFirstOrThrow({ where: { tenantId: t, userId: meeraUser.id, name: `Tamil ${TAG}` } });
    made.savedSearches.push(saved.id);
    check("a search on the new filters is saved", r.ok === true && saved.query.includes("lang=Tamil"), r.message);
    await signInAs("karthik.subramanian@acme.test");
    await ops.deleteDirectorySearchAction({}, fd({ id: saved.id }));
    check("someone else cannot delete it", (await prisma.directorySavedSearch.count({ where: { id: saved.id } })) === 1);
    await signInAs("meera.krishnan@acme.test");
    r = await ops.deleteDirectorySearchAction({}, fd({ id: saved.id }));
    check("she deletes her saved search", r.ok === true && (await prisma.directorySavedSearch.count({ where: { id: saved.id } })) === 0, r.message);
    await loadDirectory((await viewerForUser(meeraUser.id))!, { q: `nobody-${TAG}` }, { show: 10, log: true });
    check("her searches are kept as history", (await prisma.directorySearchLog.count({ where: { tenantId: t, userId: meeraUser.id } })) > 0);
    r = await ops.clearDirectoryHistoryAction({});
    check("…and she clears it", r.ok === true && (await prisma.directorySearchLog.count({ where: { tenantId: t, userId: meeraUser.id } })) === 0, r.message);
    await loadDirectory(vikramViewer, { q: `zz-${TAG}` }, { show: 10, log: true });
    await signInAs("vikram.menon@acme.test");
    o = await csv(coreHrExports, "core-hr", "search-log");
    check("searches export for administrators, including ones that found nobody", o.status === 200 && o.body.includes(`zz-${TAG}`));
    await signInAs("meera.krishnan@acme.test");
    check("…not for employees", (await csv(coreHrExports, "core-hr", "search-log")).status === 403);

    const profile = await html(await (await page("directory/[id]"))({ params: Promise.resolve({ id: ananya.id }), ...sp() }));
    check("a directory profile shows the person's manager and team (context panel)", profile.includes("Reporting manager") && profile.includes("Work details"));
    check("…with quick actions: email, save contact", profile.includes(`mailto:${ananya.workEmail}`) && profile.includes(`/directory/${ananya.id}/vcard`));
    const own = await html(await (await page("employees/[id]"))({ params: Promise.resolve({ id: meera.id }), ...sp({ tab: "job" }) }));
    check("an employee sees her own employment history", own.includes("Job history") || own.includes("Employment history") || own.includes(before.meera.jobTitleName ?? "—"));
    await signInAs("karthik.subramanian@acme.test");
    const notMine = await html(await (await page("employees/[id]"))({ params: Promise.resolve({ id: meera.id }), ...sp({ tab: "job" }) }));
    check("…a colleague cannot open it", notMine.includes("access") || notMine.includes("permission"));
  } finally {
    section("cleanup");
    const quiet = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { console.log("  cleanup:", (e as Error).message.replace(/\s+/g, " ").slice(-300)); } };
    await quiet(() => prisma.tenant.update({ where: { id: t }, data: { name: before.tenantName } }));
    if (made.roleAssignment) await quiet(() => prisma.userRoleAssignment.delete({ where: { id: made.roleAssignment } }));
    await quiet(() => prisma.recordChangeRequest.deleteMany({ where: { id: { in: made.changeRequests } } }));
    // Mass updates: their job changes, approvals, items and batches.
    await quiet(async () => {
      const items = await prisma.massUpdateItem.findMany({ where: { batchId: { in: made.batches } }, select: { jobChangeId: true } });
      const jcs = items.map((i) => i.jobChangeId).filter((x): x is string => !!x);
      for (const id of jcs) await prisma.payrollApprovalRequest.deleteMany({ where: { action: "JOB_CHANGE", payload: { path: ["jobChangeId"], equals: id } } });
      await prisma.jobChange.deleteMany({ where: { id: { in: jcs } } });
      await prisma.massUpdateItem.deleteMany({ where: { batchId: { in: made.batches } } });
      await prisma.massUpdateBatch.deleteMany({ where: { id: { in: made.batches } } });
    });
    await quiet(() => prisma.employee.update({ where: { id: rohit.id }, data: { payGroupId: before.rohit.payGroupId, reportingManagerId: before.rohit.reportingManagerId } }));
    await quiet(() => prisma.employee.update({ where: { id: divya.id }, data: { payGroupId: before.divya.payGroupId, reportingManagerId: before.divya.reportingManagerId } }));
    if (made.payGroup) await quiet(async () => {
      await prisma.payrollApprovalRule.deleteMany({ where: { payGroupId: made.payGroup } });
      await prisma.payGroupFilingDetail.deleteMany({ where: { payGroupId: made.payGroup } });
      await prisma.payGroup.delete({ where: { id: made.payGroup } });
    });
    await quiet(() => prisma.selfServiceDocumentRequest.deleteMany({ where: { id: { in: made.docRequests } } }));
    if (made.docType) await quiet(() => prisma.documentRequestType.delete({ where: { id: made.docType } }));
    await quiet(() => prisma.attendanceRequest.deleteMany({ where: { id: { in: made.timeRequests.AttendanceRequest } } }));
    await quiet(async () => {
      const reqs = await prisma.overtimeRequest.findMany({ where: { id: { in: made.timeRequests.OvertimeRequest } }, select: { overtimeEntryId: true } });
      for (const { overtimeEntryId: id } of reqs) {
        if (!id) continue;
        const b = made.otEntryBefore;
        if (b && b.id === id) await prisma.overtimeEntry.update({ where: { id }, data: { hours: b.hours as never, amount: b.amount as never, rate: b.rate as never } });
        else await prisma.overtimeEntry.deleteMany({ where: { id } });
      }
      await prisma.overtimeRequest.deleteMany({ where: { id: { in: made.timeRequests.OvertimeRequest } } });
    });
    await quiet(() => prisma.shiftRequest.deleteMany({ where: { id: { in: made.timeRequests.ShiftRequest } } }));
    if (made.delegation) await quiet(() => prisma.managerDelegation.delete({ where: { id: made.delegation } }));
    await quiet(() => prisma.hrOpsAlert.deleteMany({ where: { tenantId: t, fingerprint: { in: made.depts.map((d) => `ORPHAN_UNIT:${d}`) } } }));
    await quiet(() => prisma.department.deleteMany({ where: { id: { in: made.depts } } }));
    if (made.headCleared) await quiet(() => prisma.department.update({ where: { id: made.headCleared!.id }, data: { headId: made.headCleared!.headId } }));
    if (made.identity) await quiet(() => prisma.employeeIdentity.delete({ where: { id: made.identity } }));
    if (made.course) await quiet(() => prisma.course.delete({ where: { id: made.course } }));
    await quiet(() => prisma.employeeProfileExtra.deleteMany({ where: { employeeId: meera.id } }));
    await quiet(() => prisma.directorySavedSearch.deleteMany({ where: { id: { in: made.savedSearches } } }));
    await quiet(() => prisma.directorySearchLog.deleteMany({ where: { tenantId: t, query: { contains: TAG } } }));
    await quiet(() => svc.recomputeProfileCompletion(meera.id));
    await prisma.$disconnect();
    report("smoke-core2-coverage");
  }
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
