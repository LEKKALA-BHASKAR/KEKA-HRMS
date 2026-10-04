/**
 * Core HR depth, through the server actions, routes and pages:
 *   1. Company profile, fiscal years and working rules — saved directly, or
 *      (once a kind of change needs approval) raised as a change request
 *      that only a second administrator can approve.
 *   2. Divisions, teams and members; dotted-line managers set in bulk
 *      (loops skipped); effective-dated org changes applied by the nightly job.
 *   3. Employees ask for profile changes (contact, dependent, bank) and data
 *      corrections; the manager — reporting, dotted-line or acting — or HR
 *      decides; nobody decides their own. The inbox lists them.
 *   4. Letters on request (salary certificate from a template), the digital
 *      ID card (issue, reissue, PDF, verify, revoke) and internal notes.
 *   5. Manager self-service: delegation, the manager's team and dashboard.
 *   6. HR operations: mass status update with rollback, HR checklists with
 *      sign-off by a second person.
 *   7. Directory: filters, saved searches, search log, export, visibility.
 *
 * Removes everything it created and restores what it changed.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TAG = `smk${Date.now().toString(36)}`;

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { const r = await fn() as { ok?: boolean } | undefined; return !!r && r.ok === false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    if (/HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`)) return true;
    throw err;
  }
}
function multi(values: Record<string, string | boolean | undefined>, lists: Record<string, string[]>): FormData {
  const f = fd(values);
  for (const [k, vs] of Object.entries(lists)) for (const v of vs) f.append(k, v);
  return f;
}

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
  const { NextRequest } = await import("next/server");

  const depth = await import("../apps/web/src/app/actions/core-hr-depth");
  const ss = await import("../apps/web/src/app/actions/self-service-depth");
  const ops = await import("../apps/web/src/app/actions/hr-ops");
  const svc = await import("@keka/services");
  const { viewerForUser } = await import("../apps/web/src/lib/context");
  const lib = await import("../apps/web/src/lib/core-hr");
  const { loadDirectory } = await import("../apps/web/src/lib/directory-search");
  const { changeRequestSources } = await import("../apps/web/src/app/(app)/inbox/_take/change-requests");
  const exportsRoute = await import("../apps/web/src/app/(app)/exports/core-hr/[kind]/route");
  const myDataRoute = await import("../apps/web/src/app/(app)/me/requests/export/route");
  const idPdfRoute = await import("../apps/web/src/app/(app)/me/id-card/pdf/route");
  const verifyPage = (await import("../apps/web/src/app/(app)/verify/id/[card]/page")).default;
  const changeRequestsPage = (await import("../apps/web/src/app/(app)/admin/change-requests/page")).default;
  const dashboardPage = (await import("../apps/web/src/app/(app)/team/dashboard/page")).default;
  const { HrRecordsTab } = await import("../apps/web/src/app/(app)/employees/[id]/hr-records");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const userOf = (email: string) => prisma.user.findFirstOrThrow({ where: { tenantId: t, email } });
  const empOf = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: t, user: { email } } });
  const [vikram, priya] = await Promise.all([userOf("vikram.menon@acme.test"), userOf("priya.sharma@acme.test")]);
  const [meera, sneha, ananya, karthik, rohit, priyaEmp] = await Promise.all(["meera.krishnan@acme.test", "sneha.reddy@acme.test", "ananya.ghosh@acme.test", "karthik.subramanian@acme.test", "rohit.deshmukh@acme.test", "priya.sharma@acme.test"].map(empOf));
  const adminRole = await prisma.role.findFirstOrThrow({ where: { tenantId: t, key: "GLOBAL_ADMIN" } });
  const unit = await prisma.businessUnit.findFirstOrThrow({ where: { tenantId: t } });
  const dept = await prisma.department.findFirstOrThrow({ where: { tenantId: t, id: meera.departmentId ?? undefined } });
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const tomorrow = new Date(today.getTime() + DAY);
  const before = {
    meera: await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } }),
    banks: await prisma.employeeBankAccount.findMany({ where: { employeeId: meera.id } }),
    dependents: (await prisma.dependent.findMany({ where: { employeeId: meera.id }, select: { id: true } })).map((d) => d.id),
    deptName: dept.name,
  };
  const made = { roleAssignment: "", templateId: "", letterIds: [] as string[], probationEmp: null as null | { id: string; status: string; confirmationDate: Date | null } };

  try {
    // -----------------------------------------------------------------
    section("1. Company profile, fiscal years, working rules and maker-checker");
    await signInAs("vikram.menon@acme.test");
    let r = await depth.saveCompanyProfileAction({}, fd({ legalName: `Acme ${TAG} Pvt Ltd`, brandName: "Acme", website: "https://acme.test", email: "hello@acme.test", brandColor: "#123456", locale: "en-IN", dateFormat: "DD/MM/YYYY", foundedYear: 2012 }));
    check("an administrator saves the company profile", r.ok === true, r.message);
    const profile = await prisma.companyProfile.findUnique({ where: { tenantId: t } });
    check("…and it is stored for this company", profile?.legalName === `Acme ${TAG} Pvt Ltd` && profile.brandColor === "#123456");
    check("…and audited", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "CompanyProfile" } })) > 0);
    r = await depth.saveCompanyProfileAction({}, fd({ website: "acme dot test", brandColor: "#123456", locale: "en-IN", dateFormat: "DD/MM/YYYY" }));
    check("a website that is not a web address is refused", r.ok === false && !!r.errors?.website);
    await signInAs("meera.krishnan@acme.test");
    check("an employee cannot change the company profile", await denied(() => depth.saveCompanyProfileAction({}, fd({ legalName: "Nope", brandColor: "#000000" }))));

    await signInAs("vikram.menon@acme.test");
    r = await depth.saveFiscalYearAction({}, fd({ name: `PERF ${TAG}`, calendarSet: "PERFORMANCE", startDate: "2031-01-01", endDate: "2031-12-31", status: "OPEN", isCurrent: true }));
    check("a fiscal year is added to a calendar set", r.ok === true, r.message);
    r = await depth.saveFiscalYearAction({}, fd({ name: `PERF2 ${TAG}`, calendarSet: "PERFORMANCE", startDate: "2031-06-01", endDate: "2032-05-31", status: "OPEN" }));
    check("an overlapping year in the same set is refused", r.ok === false, r.message);
    r = await depth.saveWorkingRulesAction({}, multi({ weekStartsOn: "MON", standardHoursPerDay: "8", standardHoursPerWeek: "40", halfDayMinHours: "4", maxConsecutiveWorkDays: "6", overtimeAfterHours: "9", maxSpanOfControl: "5" }, { workDays: ["MON", "TUE", "WED", "THU", "FRI"] }));
    check("working rules are saved", r.ok === true && (await prisma.workingRules.findUnique({ where: { tenantId: t } }))?.maxSpanOfControl === 5, r.message);
    r = await depth.saveWorkingRulesAction({}, multi({ weekStartsOn: "MON", standardHoursPerDay: "8", standardHoursPerWeek: "60", halfDayMinHours: "4", maxConsecutiveWorkDays: "6", overtimeAfterHours: "9", maxSpanOfControl: "5" }, { workDays: ["MON", "TUE", "WED", "THU", "FRI"] }));
    check("weekly hours above the working days' total are refused", r.ok === false && !!r.errors?.standardHoursPerWeek);

    r = await depth.saveChangeApprovalSettingAction({}, fd({ targetType: "WORKING_RULES", requireApproval: true }));
    check("working-rule changes can be made to need approval", r.ok === true && await svc.approvalRequired(t, "WORKING_RULES"));
    r = await depth.saveWorkingRulesAction({}, multi({ weekStartsOn: "MON", standardHoursPerDay: "9", standardHoursPerWeek: "45", halfDayMinHours: "4", maxConsecutiveWorkDays: "6", overtimeAfterHours: "10", maxSpanOfControl: "5", reason: "Longer days" }, { workDays: ["MON", "TUE", "WED", "THU", "FRI"] }));
    const rulesReq = await prisma.changeRequest.findFirst({ where: { tenantId: t, targetType: "WORKING_RULES", status: "PENDING" } });
    check("…so saving raises a change request instead of applying", r.ok === true && !!rulesReq && Number((await prisma.workingRules.findUnique({ where: { tenantId: t } }))!.standardHoursPerDay) === 8);
    r = await depth.decideChangeRequestAction({}, fd({ id: rulesReq!.id, decision: "approve" }));
    check("the administrator who raised it cannot approve it", r.ok === false, r.message);
    made.roleAssignment = (await prisma.userRoleAssignment.create({ data: { userId: priya.id, roleId: adminRole.id } })).id;
    await signInAs("priya.sharma@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: rulesReq!.id, decision: "reject" }));
    check("rejecting needs a reason", r.ok === false);
    r = await depth.decideChangeRequestAction({}, fd({ id: rulesReq!.id, decision: "approve", note: "Agreed" }));
    const rulesAfter = await prisma.workingRules.findUnique({ where: { tenantId: t } });
    check("a second administrator approves it and it applies", r.ok === true && Number(rulesAfter!.standardHoursPerDay) === 9 && (await prisma.changeRequest.findUniqueOrThrow({ where: { id: rulesReq!.id } })).status === "APPLIED", r.message);
    check("the applied change is in the audit log", (await prisma.auditLog.count({ where: { tenantId: t, summary: { contains: "Applied approved change request: Update the working rules" } } })) > 0);
    await prisma.userRoleAssignment.delete({ where: { id: made.roleAssignment } }); made.roleAssignment = "";

    // -----------------------------------------------------------------
    section("2. Divisions, teams, dotted-line managers and effective-dated org changes");
    await signInAs("priya.sharma@acme.test");
    r = await depth.saveDivisionAction({}, fd({ name: `Division ${TAG}`, code: "DV1", businessUnitId: unit.id, headId: sneha.id }));
    const division = await prisma.division.findFirst({ where: { tenantId: t, name: `Division ${TAG}` } });
    check("HR creates a division under a business unit", r.ok === true && !!division && division.isActive, r.message);
    r = await depth.setDepartmentDivisionAction({}, fd({ departmentId: dept.id, divisionId: division!.id }));
    check("a department is placed in the division", r.ok === true && (await prisma.department.findUniqueOrThrow({ where: { id: dept.id } })).divisionId === division!.id);
    r = await depth.deleteDivisionAction({}, fd({ id: division!.id }));
    check("a division with departments in it cannot be deleted", r.ok === false);
    r = await depth.saveTeamAction({}, fd({ name: `Team ${TAG}`, departmentId: dept.id, divisionId: division!.id, leadId: sneha.id, isCrossFunctional: true }));
    const team = await prisma.orgTeam.findFirst({ where: { tenantId: t, name: `Team ${TAG}` }, include: { members: true } });
    check("a team is created with its lead as a member", r.ok === true && !!team && team.members.some((m) => m.employeeId === sneha.id));
    r = await depth.addTeamMembersAction({}, multi({ teamId: team!.id, role: "Engineer" }, { employeeId: [meera.id, karthik.id] }));
    check("members are added to the team", r.ok === true && (await prisma.orgTeamMember.count({ where: { teamId: team!.id } })) === 3, r.message);
    await signInAs("meera.krishnan@acme.test");
    check("an employee cannot create a division", await denied(() => depth.saveDivisionAction({}, fd({ name: "Nope" }))));

    await signInAs("priya.sharma@acme.test");
    r = await depth.setSecondaryManagersAction({}, multi({ managerId: karthik.id, kind: "DOTTED_LINE", note: TAG }, { employeeId: [meera.id] }));
    check("a dotted-line manager is set", r.ok === true && (await prisma.secondaryManager.count({ where: { tenantId: t, employeeId: meera.id, managerId: karthik.id } })) === 1, r.message);
    r = await depth.setSecondaryManagersAction({}, multi({ managerId: meera.id, kind: "L2" }, { employeeId: [sneha.id] }));
    check("a dotted line that would loop the reporting line is skipped", r.ok === true && (await prisma.secondaryManager.count({ where: { tenantId: t, employeeId: sneha.id, managerId: meera.id } })) === 0, r.message);
    const mgrs = await svc.managersOf(t, meera.id);
    check("the dotted-line manager counts as one of the employee's managers", mgrs.includes(karthik.id) && mgrs.includes(ananya.id));
    const steps = svc.resolveApprovalSteps({ levels: ["REPORTING_MANAGER", "DOTTED_LINE_MANAGER"], skipSamePerson: true, autoApproveAfterDays: null }, { employeeId: meera.id, managerId: ananya.id, skipManagerId: sneha.id, departmentHeadId: null, dottedLineManagerId: karthik.id });
    check("a leave approval chain can name the dotted-line manager as a level", steps.length === 2 && steps[1]!.approverId === karthik.id);

    r = await depth.proposeOrgChangeAction({}, fd({ target: `DEPARTMENT:${dept.id}`, operation: "UPDATE", name: `${dept.name} ${TAG}`, effectiveDate: iso(tomorrow), reason: "Rename" }));
    const orgReq = await prisma.changeRequest.findFirst({ where: { tenantId: t, category: "ORG", targetId: dept.id, status: "PENDING" } });
    check("HR proposes an effective-dated rename", r.ok === true && !!orgReq && orgReq.effectiveDate?.getTime() === tomorrow.getTime(), r.message);
    await signInAs("vikram.menon@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: orgReq!.id, decision: "approve" }));
    check("another administrator approves it; it waits for its date", r.ok === true && (await prisma.changeRequest.findUniqueOrThrow({ where: { id: orgReq!.id } })).status === "SCHEDULED" && (await prisma.department.findUniqueOrThrow({ where: { id: dept.id } })).name === dept.name);
    await svc.applyDueChangeRequests(today);
    check("the nightly job does not apply it early", (await prisma.department.findUniqueOrThrow({ where: { id: dept.id } })).name === dept.name);
    await svc.applyDueChangeRequests(tomorrow);
    check("…and applies it on its date", (await prisma.department.findUniqueOrThrow({ where: { id: dept.id } })).name === `${dept.name} ${TAG}` && (await prisma.changeRequest.findUniqueOrThrow({ where: { id: orgReq!.id } })).status === "APPLIED");
    await prisma.department.update({ where: { id: dept.id }, data: { name: before.deptName } });

    let res = await exportsRoute.GET(new NextRequest("http://acme.localhost/exports/core-hr/divisions"), { params: Promise.resolve({ kind: "divisions" }) });
    let body = await res.text();
    check("divisions export as CSV", res.status === 200 && body.includes(`Division ${TAG}`) && body.includes(dept.name));
    res = await exportsRoute.GET(new NextRequest("http://acme.localhost/exports/core-hr/teams"), { params: Promise.resolve({ kind: "teams" }) });
    check("teams and members export as CSV", res.status === 200 && (await res.text()).includes(`Team ${TAG}`));
    await signInAs("meera.krishnan@acme.test");
    res = await exportsRoute.GET(new NextRequest("http://acme.localhost/exports/core-hr/fiscal-years"), { params: Promise.resolve({ kind: "fiscal-years" }) });
    check("an employee cannot export fiscal years", res.status === 403);

    // -----------------------------------------------------------------
    section("3. Profile change requests, decided by the right manager or HR");
    await signInAs("meera.krishnan@acme.test");
    r = await ss.requestProfileChangeAction({}, fd({ targetType: "CONTACT", personalEmail: `meera.${TAG}@mail.test`, mobile: before.meera.mobile ?? "", alternatePhone: before.meera.alternatePhone ?? "" }));
    const contactReq = await prisma.changeRequest.findFirst({ where: { tenantId: t, employeeId: meera.id, targetType: "CONTACT", status: "PENDING" } });
    check("an employee asks to change their contact details", r.ok === true && !!contactReq && contactReq.approverType === "MANAGER", r.message);
    check("…the record is unchanged until approved", (await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } })).personalEmail === before.meera.personalEmail);
    r = await ss.requestProfileChangeAction({}, fd({ targetType: "CONTACT", personalEmail: `again.${TAG}@mail.test` }));
    check("a second open request for the same thing is refused", r.ok === false, r.message);
    r = await depth.decideChangeRequestAction({}, fd({ id: contactReq!.id, decision: "approve" }));
    check("the employee cannot approve their own request", r.ok === false);
    await signInAs("rohit.deshmukh@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: contactReq!.id, decision: "approve" }));
    check("a colleague who does not manage her cannot decide it", r.ok === false, r.message);

    // Acting manager: Ananya (Meera's manager) delegates to Rohit for today.
    await signInAs("ananya.ghosh@acme.test");
    r = await ss.createDelegationAction({}, fd({ delegateId: rohit.id, kind: "DELEGATE", startDate: iso(today), endDate: iso(new Date(today.getTime() + 2 * DAY)), reason: TAG }));
    check("a manager delegates their approvals for a few days", r.ok === true, r.message);
    r = await ss.createDelegationAction({}, fd({ delegateId: rohit.id, startDate: iso(new Date(today.getTime() + DAY)), endDate: iso(new Date(today.getTime() + 3 * DAY)) }));
    check("an overlapping delegation is refused", r.ok === false, r.message);
    r = await ss.createDelegationAction({}, fd({ delegateId: rohit.id, startDate: iso(new Date(today.getTime() + 9 * DAY)), endDate: iso(new Date(today.getTime() + 8 * DAY)) }));
    check("a delegation that ends before it starts is refused", r.ok === false);
    const inbox = await changeRequestSources((await viewerForUser((await userOf("rohit.deshmukh@acme.test")).id))!);
    check("the delegate sees the request in their inbox", (await inbox[0]!.count()) >= 1 && (await inbox[0]!.list()).some((i) => i.id === contactReq!.id));
    const detail = await inbox[0]!.detail(contactReq!.id);
    check("…with what changes, old to new", html(detail).includes(`meera.${TAG}@mail.test`));
    await signInAs("rohit.deshmukh@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: contactReq!.id, decision: "approve", note: "OK" }));
    check("the delegate approves it and it is applied", r.ok === true && (await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } })).personalEmail === `meera.${TAG}@mail.test`, r.message);
    r = await depth.decideChangeRequestAction({}, fd({ id: contactReq!.id, decision: "approve" }));
    check("it cannot be decided twice", r.ok === false);

    // Dotted-line manager decides a dependent request.
    await signInAs("meera.krishnan@acme.test");
    r = await ss.requestProfileChangeAction({}, fd({ targetType: "DEPENDENT", operation: "CREATE", name: `Kid ${TAG}`, relationship: "CHILD", dateOfBirth: "2015-05-05" }));
    const depReq = await prisma.changeRequest.findFirst({ where: { tenantId: t, employeeId: meera.id, targetType: "DEPENDENT", status: "PENDING" } });
    check("an employee asks to add a dependent", r.ok === true && !!depReq, r.message);
    r = await ss.requestProfileChangeAction({}, fd({ targetType: "DEPENDENT", operation: "CREATE", name: "Future", relationship: "CHILD", dateOfBirth: iso(new Date(today.getTime() + 30 * DAY)) }));
    check("a dependent born in the future is refused", r.ok === false);
    await signInAs("karthik.subramanian@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: depReq!.id, decision: "approve" }));
    check("her dotted-line manager approves it and the dependent is added", r.ok === true && (await prisma.dependent.count({ where: { employeeId: meera.id, name: `Kid ${TAG}` } })) === 1, r.message);

    // Bank goes to HR with the financials right only.
    await signInAs("meera.krishnan@acme.test");
    r = await ss.requestProfileChangeAction({}, fd({ targetType: "BANK", bankName: "Test Bank", accountNumber: "123456789012", confirmAccountNumber: "123456789099", ifsc: "HDFC0001234" }));
    check("bank details whose account numbers differ are refused", r.ok === false && !!r.errors?.confirmAccountNumber);
    r = await ss.requestProfileChangeAction({}, fd({ targetType: "BANK", bankName: "Test Bank", accountNumber: "123456789012", confirmAccountNumber: "123456789012", ifsc: "HDFC0001234" }));
    const bankReq = await prisma.changeRequest.findFirst({ where: { tenantId: t, employeeId: meera.id, targetType: "BANK", status: "PENDING" } });
    check("a bank change goes to HR", r.ok === true && bankReq?.approverType === "HR");
    await signInAs("ananya.ghosh@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: bankReq!.id, decision: "approve" }));
    check("her manager cannot approve a bank change", r.ok === false, r.message);
    await signInAs("vikram.menon@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: bankReq!.id, decision: "approve" }));
    const primary = await prisma.employeeBankAccount.findFirst({ where: { employeeId: meera.id, isPrimary: true } });
    check("HR with the financials right approves it; it becomes the primary account", r.ok === true && primary?.accountNumber === "123456789012", r.message);
    const page = html(await changeRequestsPage({ searchParams: Promise.resolve({}) }));
    check("the change request queue lists requests with bank numbers masked", page.includes("Change requests") && !page.includes("123456789012"));
    res = await exportsRoute.GET(new NextRequest("http://acme.localhost/exports/core-hr/change-requests"), { params: Promise.resolve({ kind: "change-requests" }) });
    body = await res.text();
    check("change requests export as CSV, masked", res.status === 200 && body.includes("Update contact details") && !body.includes("123456789012"));

    // Data correction.
    await signInAs("meera.krishnan@acme.test");
    r = await ss.requestDataCorrectionAction({}, fd({ field: "dateOfBirth", correctValue: "31-12-1990", reason: "As on PAN" }));
    check("a correction with a malformed date is refused", r.ok === false);
    r = await ss.requestDataCorrectionAction({}, fd({ field: "nationality", correctValue: `Indian ${TAG}`, reason: "As on passport" }));
    const corr = await prisma.changeRequest.findFirst({ where: { tenantId: t, employeeId: meera.id, category: "CORRECTION", status: "PENDING" } });
    check("an employee reports a mistake on their record", r.ok === true && !!corr);
    r = await ss.requestDataCorrectionAction({}, fd({ employeeId: sneha.id, field: "nationality", correctValue: "X", reason: "x y z" }));
    check("…but not on someone else's", r.ok === false);
    await signInAs("priya.sharma@acme.test");
    r = await depth.decideChangeRequestAction({}, fd({ id: corr!.id, decision: "approve" }));
    check("HR approves the correction and the record is corrected", r.ok === true && (await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } })).nationality === `Indian ${TAG}`, r.message);

    // My data download.
    await signInAs("meera.krishnan@acme.test");
    res = await myDataRoute.GET();
    const mine = await res.json() as { employee: { bankAccounts: Array<{ accountNumber: string }> }; changeRequests: unknown[] };
    check("an employee downloads their own data, bank numbers masked", res.status === 200 && mine.changeRequests.length >= 4 && mine.employee.bankAccounts.every((b) => b.accountNumber.startsWith("••••")));

    // -----------------------------------------------------------------
    section("4. Letters on request, ID card and internal notes");
    const template = await prisma.documentTemplate.findFirst({ where: { tenantId: t, isArchived: false } });
    await signInAs("priya.sharma@acme.test");
    r = await ss.saveDocumentRequestTypeAction({}, fd({ name: `Salary certificate ${TAG}`, templateId: template!.id, requiresApproval: true }));
    const docType = await prisma.documentRequestType.findFirst({ where: { tenantId: t, name: `Salary certificate ${TAG}` } });
    check("HR offers a letter employees can request", r.ok === true && !!docType, r.message);
    await signInAs("meera.krishnan@acme.test");
    r = await ss.requestDocumentAction({}, fd({ typeId: docType!.id, purpose: "Visa application", addressedTo: "The Consul" }));
    const docReq = await prisma.selfServiceDocumentRequest.findFirst({ where: { tenantId: t, employeeId: meera.id, typeId: docType!.id } });
    check("an employee requests a salary certificate", r.ok === true && docReq?.status === "PENDING");
    r = await ss.requestDocumentAction({}, fd({ typeId: docType!.id, purpose: "Again please" }));
    check("a second open request for the same letter is refused", r.ok === false);
    check("the employee cannot issue it", await denied(() => ss.decideDocumentRequestAction({}, fd({ id: docReq!.id, decision: "approve" }))));
    await signInAs("priya.sharma@acme.test");
    r = await ss.decideDocumentRequestAction({}, fd({ id: docReq!.id, decision: "approve" }));
    const issued = await prisma.selfServiceDocumentRequest.findUniqueOrThrow({ where: { id: docReq!.id } });
    if (issued.letterId) made.letterIds.push(issued.letterId);
    check("HR issues it: the letter is generated from the template", r.ok === true && issued.status === "ISSUED" && !!issued.letterId && !!(await prisma.generatedDocument.findFirst({ where: { id: issued.letterId!, employeeId: meera.id } })), r.message);

    await signInAs("meera.krishnan@acme.test");
    r = await ss.issueIdCardAction({}, fd({}));
    const card1 = await prisma.employeeIdCard.findFirst({ where: { tenantId: t, employeeId: meera.id, status: "ACTIVE" } });
    check("an employee issues their own ID card", r.ok === true && !!card1 && card1.validUntil > today);
    r = await ss.issueIdCardAction({}, fd({ employeeId: sneha.id }));
    check("…but not someone else's", r.ok === false);
    r = await ss.issueIdCardAction({}, fd({}));
    const card2 = await prisma.employeeIdCard.findFirst({ where: { tenantId: t, employeeId: meera.id, status: "ACTIVE" } });
    check("reissuing revokes the old card", r.ok === true && card2!.id !== card1!.id && (await prisma.employeeIdCard.findUniqueOrThrow({ where: { id: card1!.id } })).status === "REVOKED");
    res = await idPdfRoute.GET(new NextRequest("http://acme.localhost/me/id-card/pdf"));
    const pdf = Buffer.from(await res.arrayBuffer());
    check("the ID card downloads as a PDF", res.status === 200 && res.headers.get("content-type") === "application/pdf" && pdf.subarray(0, 5).toString() === "%PDF-");
    await signInAs("rohit.deshmukh@acme.test");
    res = await idPdfRoute.GET(new NextRequest(`http://acme.localhost/me/id-card/pdf?employee=${meera.id}`));
    check("a colleague cannot download someone else's card", res.status === 403);
    let verify = html(await verifyPage({ params: Promise.resolve({ card: card2!.cardNumber }) }));
    check("security verifies the current card", verify.includes("Valid until") && verify.includes(meera.employeeNumber));
    verify = html(await verifyPage({ params: Promise.resolve({ card: card1!.cardNumber }) }));
    check("…and sees the old one is revoked", verify.includes("Revoked"));
    await signInAs("priya.sharma@acme.test");
    r = await ss.revokeIdCardAction({}, fd({ id: card2!.id }));
    check("HR revokes a card", r.ok === true && (await prisma.employeeIdCard.findUniqueOrThrow({ where: { id: card2!.id } })).status === "REVOKED");

    r = await ss.addInternalNoteAction({}, fd({ employeeId: meera.id, body: `HR only ${TAG}`, visibility: "HR_ONLY" }));
    check("HR adds an HR-only note", r.ok === true);
    await signInAs("sneha.reddy@acme.test");
    r = await ss.addInternalNoteAction({}, fd({ employeeId: meera.id, body: `Manager note ${TAG}` }));
    check("a manager in her line adds a note", r.ok === true, r.message);
    r = await ss.addInternalNoteAction({}, fd({ employeeId: meera.id, body: "Secret", visibility: "HR_ONLY" }));
    check("a manager cannot add an HR-only note", r.ok === false);
    const snehaViewer = (await viewerForUser((await userOf("sneha.reddy@acme.test")).id))!;
    const tab = html(await HrRecordsTab({ viewer: snehaViewer, employeeId: meera.id, isHr: false }));
    check("the manager sees managers' notes but not HR-only ones", tab.includes(`Manager note ${TAG}`) && !tab.includes(`HR only ${TAG}`));
    await signInAs("meera.krishnan@acme.test");
    r = await ss.addInternalNoteAction({}, fd({ employeeId: sneha.id, body: "About my manager's manager" }));
    check("an employee cannot write notes on others", r.ok === false);

    // -----------------------------------------------------------------
    section("5. Manager self-service");
    const team5 = await lib.managedTeam(snehaViewer);
    check("a manager's team includes indirect reports", team5.get(meera.id) === "INDIRECT" && team5.get(ananya.id) === "DIRECT");
    const karthikTeam = await lib.managedTeam((await viewerForUser((await userOf("karthik.subramanian@acme.test")).id))!);
    check("…and dotted-line reports", karthikTeam.get(meera.id) === "DOTTED");
    const rohitTeam = await lib.managedTeam((await viewerForUser((await userOf("rohit.deshmukh@acme.test")).id))!);
    check("…and the team of a manager they are covering for", rohitTeam.get(meera.id) === "ACTING");
    await signInAs("sneha.reddy@acme.test");
    const dash = html(await dashboardPage());
    check("the manager dashboard shows the team and the span-of-control limit", dash.includes("Manager dashboard") && dash.includes(meera.displayName ?? meera.firstName) && dash.includes("/ 5"));
    await signInAs("ananya.ghosh@acme.test");
    const deleg = await prisma.managerDelegation.findFirstOrThrow({ where: { tenantId: t, delegatorId: ananya.id, reason: TAG } });
    r = await ss.revokeDelegationAction({}, fd({ id: deleg.id }));
    check("the manager ends the delegation early", r.ok === true && !(await svc.managersOf(t, meera.id)).includes(rohit.id));

    // -----------------------------------------------------------------
    section("6. HR operations: mass update and checklists");
    const prob = await prisma.employee.findFirst({ where: { tenantId: t, status: "PROBATION" } });
    if (prob) {
      made.probationEmp = { id: prob.id, status: prob.status, confirmationDate: prob.confirmationDate };
      await signInAs("priya.sharma@acme.test");
      r = await ops.applyMassUpdateAction({}, fd({ kind: "STATUS", value: "CONFIRMED", numbers: prob.employeeNumber }));
      check("a mass update must be confirmed", r.ok === false);
      r = await ops.applyMassUpdateAction({}, fd({ kind: "STATUS", value: "CONFIRMED", numbers: `${prob.employeeNumber}, NOPE-1`, confirm: true, note: TAG }));
      const batch = await prisma.massUpdateBatch.findFirst({ where: { tenantId: t, note: TAG }, include: { items: true } });
      check("HR confirms people in bulk", r.ok === true && batch?.applied === 1 && (await prisma.employee.findUniqueOrThrow({ where: { id: prob.id } })).status === "CONFIRMED", r.message);
      r = await ops.rollbackMassUpdateAction({}, fd({ id: batch!.id }));
      check("…and rolls it back", r.ok === true && (await prisma.employee.findUniqueOrThrow({ where: { id: prob.id } })).status === "PROBATION");
      r = await ops.rollbackMassUpdateAction({}, fd({ id: batch!.id }));
      check("a batch cannot be rolled back twice", r.ok === false);
    } else check("a probationer exists for the mass update", false);
    await signInAs("deepak.chauhan@acme.test");
    // Vikram (ACM0001) is outside the two departments Deepak looks after.
    r = await ops.applyMassUpdateAction({}, fd({ kind: "STATUS", value: "INACTIVE", numbers: "ACM0001", confirm: true }));
    check("a scoped HR executive cannot reach people outside their departments", r.ok === false, r.message);

    await signInAs("priya.sharma@acme.test");
    r = await ops.saveChecklistTemplateAction({}, fd({ name: `Compliance ${TAG}`, category: "COMPLIANCE", items: "Verify documents\nSign the code of conduct | EMPLOYEE", requiresSignOff: true }));
    const tpl = await prisma.hrChecklistTemplate.findFirst({ where: { tenantId: t, name: `Compliance ${TAG}` } });
    check("HR creates a checklist template", r.ok === true && (tpl?.items as unknown[]).length === 2);
    r = await ops.assignChecklistAction({}, multi({ templateId: tpl!.id, dueDate: iso(new Date(today.getTime() + 7 * DAY)) }, { employeeId: [meera.id] }));
    const list = await prisma.hrChecklist.findFirst({ where: { tenantId: t, templateId: tpl!.id }, include: { items: { orderBy: { position: "asc" } } } });
    check("…and assigns it", r.ok === true && list?.items.length === 2 && list.status === "OPEN");
    await signInAs("meera.krishnan@acme.test");
    r = await ops.toggleChecklistItemAction({}, fd({ id: list!.items[0]!.id }));
    check("the employee cannot tick HR's item", r.ok === false);
    r = await ops.toggleChecklistItemAction({}, fd({ id: list!.items[1]!.id }));
    check("…but ticks their own", r.ok === true);
    await signInAs("priya.sharma@acme.test");
    r = await ops.toggleChecklistItemAction({}, fd({ id: list!.items[0]!.id }));
    check("when everything is done it waits for sign-off", r.ok === true && (await prisma.hrChecklist.findUniqueOrThrow({ where: { id: list!.id } })).status === "AWAITING_SIGN_OFF");
    r = await ops.signOffChecklistAction({}, fd({ id: list!.id, decision: "approve" }));
    check("whoever assigned it cannot sign it off", r.ok === false);
    await signInAs("vikram.menon@acme.test");
    r = await ops.signOffChecklistAction({}, fd({ id: list!.id, decision: "approve", note: "Checked" }));
    check("a second HR person signs it off", r.ok === true && (await prisma.hrChecklist.findUniqueOrThrow({ where: { id: list!.id } })).status === "SIGNED_OFF");
    res = await exportsRoute.GET(new NextRequest("http://acme.localhost/exports/core-hr/checklists"), { params: Promise.resolve({ kind: "checklists" }) });
    check("checklists export as CSV", res.status === 200 && (await res.text()).includes(`Compliance ${TAG}`));

    // -----------------------------------------------------------------
    section("7. Directory: filters, saved searches, log, export, visibility");
    const meeraViewer = (await viewerForUser((await userOf("meera.krishnan@acme.test")).id))!;
    const vikramViewer = (await viewerForUser(vikram.id))!;
    let dir = await loadDirectory(vikramViewer, { mgr: karthik.id }, { show: 100 });
    check("filtering by manager includes dotted-line reports", dir.people.some((p) => p.id === meera.id));
    dir = await loadDirectory(vikramViewer, { team: team!.id }, { show: 100 });
    check("filtering by team lists its members", dir.matched === 3);
    dir = await loadDirectory(vikramViewer, { div: division!.id }, { show: 100 });
    check("filtering by division lists its departments' people", dir.people.some((p) => p.id === meera.id));
    dir = await loadDirectory(vikramViewer, { tenure: "10plus", q: "zzzz-nobody" }, { show: 100 });
    check("a search that finds no one is logged with 0 results", dir.matched === 0 && (await prisma.directorySearchLog.count({ where: { tenantId: t, userId: vikram.id, resultCount: 0 } })) > 0);
    check("the filters offered include skill, tenure, team and shift", ["skill", "tenure", "team", "shift", "mgr", "wt"].every((k) => dir.filters.some((f) => f.key === k)));
    await signInAs("meera.krishnan@acme.test");
    r = await ops.saveDirectorySearchAction({}, fd({ name: "My team", query: `team=${team!.id}&evil=1` }));
    const saved = await prisma.directorySavedSearch.findFirst({ where: { tenantId: t, userId: meeraViewer.user.id, name: "My team" } });
    check("an employee saves a search (unknown keys dropped)", r.ok === true && saved?.query === `team=${team!.id}`);
    res = await exportsRoute.GET(new NextRequest(`http://acme.localhost/exports/core-hr/directory?team=${team!.id}`), { params: Promise.resolve({ kind: "directory" }) });
    body = await res.text();
    check("the directory exports what the filters show", res.status === 200 && body.split("\r\n").length === 4);
    const other = await prisma.employee.findFirst({ where: { tenantId: t, status: { notIn: ["EXITED", "PREBOARDING"] }, NOT: [{ legalEntityId: meera.legalEntityId }, { legalEntityId: null }] } });
    const vis = await prisma.tenantVisibilitySetting.findUnique({ where: { tenantId: t } });
    await prisma.tenantVisibilitySetting.upsert({ where: { tenantId: t }, create: { tenantId: t, restrictByLegalEntity: true }, update: { restrictByLegalEntity: true, managerReporteeOverride: false } });
    const restricted = (await viewerForUser(meeraViewer.user.id))!;
    const w = await lib.directoryVisibilityWhere(restricted);
    const seen = await prisma.employee.count({ where: { AND: [{ tenantId: t }, w, ...(other ? [{ id: other.id }] : [])] } });
    check("with the legal-entity restriction on, people in other entities are hidden", other ? seen === 0 : Object.keys(w).length > 0);
    if (vis) await prisma.tenantVisibilitySetting.update({ where: { tenantId: t }, data: { restrictByLegalEntity: vis.restrictByLegalEntity, restrictByBusinessUnit: vis.restrictByBusinessUnit, managerReporteeOverride: vis.managerReporteeOverride } });
    else await prisma.tenantVisibilitySetting.delete({ where: { tenantId: t } });

    // Team members leave; a team can be deleted.
    await signInAs("priya.sharma@acme.test");
    r = await depth.deleteTeamAction({}, fd({ id: team!.id }));
    check("a team is deleted with its memberships", r.ok === true && (await prisma.orgTeamMember.count({ where: { teamId: team!.id } })) === 0);
    void priyaEmp;
  } finally {
    // -----------------------------------------------------------------
    if (made.roleAssignment) await prisma.userRoleAssignment.delete({ where: { id: made.roleAssignment } }).catch(() => undefined);
    await prisma.department.update({ where: { id: dept.id }, data: { name: before.deptName, divisionId: null } });
    await prisma.employee.update({ where: { id: meera.id }, data: { personalEmail: before.meera.personalEmail, mobile: before.meera.mobile, alternatePhone: before.meera.alternatePhone, nationality: before.meera.nationality } });
    await prisma.employeeBankAccount.deleteMany({ where: { employeeId: meera.id, id: { notIn: before.banks.map((b) => b.id) } } });
    for (const b of before.banks) await prisma.employeeBankAccount.update({ where: { id: b.id }, data: { isPrimary: b.isPrimary } });
    await prisma.dependent.deleteMany({ where: { employeeId: meera.id, id: { notIn: before.dependents } } });
    if (made.probationEmp) await prisma.employee.update({ where: { id: made.probationEmp.id }, data: { status: made.probationEmp.status as never, confirmationDate: made.probationEmp.confirmationDate } });
    if (made.letterIds.length) await prisma.generatedDocument.deleteMany({ where: { id: { in: made.letterIds } } }).catch(() => undefined);
    for (const m of ["changeRequest", "changeApprovalSetting", "companyProfile", "fiscalYear", "workingRules", "division", "orgTeam", "secondaryManager", "managerDelegation", "selfServiceDocumentRequest", "documentRequestType", "massUpdateBatch", "hrChecklist", "hrChecklistTemplate", "employeeInternalNote", "employeeIdCard", "directorySavedSearch", "directorySearchLog", "employeeAddressHistory"] as const) {
      await (prisma[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { tenantId: t } });
    }
    await prisma.$disconnect();
  }
  report("smoke-core-hr-depth");
}

main().catch((err) => { console.error(err); process.exit(1); });
