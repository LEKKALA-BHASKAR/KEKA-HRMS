/**
 * Tenant isolation, proved rather than asserted. A rival tenant is built with
 * its own records; Acme's Global Admin — who holds every permission — then
 * tries to change, delete, decide or link to each of them. Every attempt must
 * fail and leave the rival untouched. Finally the rival tenant is deleted and
 * not one row of it may remain in any table.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;

/** A state-returning action is refused when it answers ok:false or throws (403). */
async function refused(fn: () => Promise<{ ok?: boolean; message?: string }>): Promise<boolean> {
  try { return (await fn()).ok === false; } catch { return true; }
}
/** A void action refuses by throwing; returning normally means it went through. */
async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

async function main() {
  const org = await import("../apps/web/src/app/actions/org");
  const employee = await import("../apps/web/src/app/actions/employee");
  const time = await import("../apps/web/src/app/actions/time");
  const perf = await import("../apps/web/src/app/actions/performance");
  const proj = await import("../apps/web/src/app/actions/projects");
  const exp = await import("../apps/web/src/app/actions/expenses");
  const life = await import("../apps/web/src/app/actions/lifecycle");
  const hiring = await import("../apps/web/src/app/actions/hiring");
  const payroll = await import("../apps/web/src/app/actions/payroll");
  const payConfig = await import("../apps/web/src/app/actions/payroll-config");
  const work = await import("../apps/web/src/app/actions/workplace");
  const books = await import("../apps/web/src/app/actions/accounting");
  const feedbackActions = await import("../apps/web/src/app/actions/feedback");
  const taxActions = await import("../apps/web/src/app/actions/tax");
  const svc = await import("@keka/services");
  const { GET: fileGet } = await import("../apps/web/src/app/files/[id]/route");
  const { REPORTS } = await import("../apps/web/src/lib/reports");
  const { getViewer } = await import("../apps/web/src/lib/context");

  const acme = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  await prisma.tenant.deleteMany({ where: { subdomain: "rival-smoke" } });

  // --- The rival tenant ------------------------------------------------------
  const t = await prisma.tenant.create({ data: { subdomain: "rival-smoke", name: "Rival Corp" } });
  const le = await prisma.legalEntity.create({ data: { tenantId: t.id, name: "Rival", legalName: "Rival Corp Pvt Ltd" } });
  const loc = await prisma.location.create({ data: { tenantId: t.id, name: "Rival HQ", stateCode: "MH" } });
  const bu = await prisma.businessUnit.create({ data: { tenantId: t.id, legalEntityId: le.id, name: "Rival BU" } });
  const dept = await prisma.department.create({ data: { tenantId: t.id, name: "Rival Dept" } });
  const jt = await prisma.jobTitle.create({ data: { tenantId: t.id, name: "Rival Title" } });
  const user = await prisma.user.create({ data: { tenantId: t.id, email: "boss@rival.test" } });
  const emp = await prisma.employee.create({ data: { tenantId: t.id, userId: user.id, employeeNumber: "R001", firstName: "Rita", lastName: "Rival", displayName: "Rita Rival", dateOfJoining: new Date("2024-01-01"), legalEntityId: le.id, locationId: loc.id, departmentId: dept.id } });
  const lt = await prisma.leaveType.create({ data: { tenantId: t.id, name: "Rival Leave", code: "RL" } });
  const plan = await prisma.leavePlan.create({ data: { tenantId: t.id, name: "Rival Plan" } });
  const cal = await prisma.holidayCalendar.create({ data: { tenantId: t.id, name: "Rival Cal", year: 2026, holidays: { create: [{ name: "Rival Day", date: new Date("2026-12-01") }] } }, include: { holidays: true } });
  const lr = await prisma.leaveRequest.create({ data: { tenantId: t.id, employeeId: emp.id, leaveTypeId: lt.id, fromDate: new Date("2026-11-02"), toDate: new Date("2026-11-02"), totalDays: 1 } });
  const client = await prisma.client.create({ data: { tenantId: t.id, name: "Rival Client" } });
  const project = await prisma.project.create({ data: { tenantId: t.id, name: "Rival Project", clientId: client.id } });
  const cat = await prisma.expenseCategory.create({ data: { tenantId: t.id, name: "Rival Meals" } });
  const claim = await prisma.expenseClaim.create({ data: { tenantId: t.id, employeeId: emp.id, claimNumber: "EXP-1", title: "Rival claim", stage: "SUBMITTED", claimedTotal: 100, lines: { create: [{ categoryId: cat.id, expenseDate: new Date(), amount: 100, baseAmount: 100 }] } } });
  const hcat = await prisma.helpdeskCategory.create({ data: { tenantId: t.id, name: "Rival HD" } });
  const ticket = await prisma.helpdeskTicket.create({ data: { tenantId: t.id, number: 1, employeeId: emp.id, categoryId: hcat.id, subject: "Rival ticket", description: "x", dueAt: new Date(Date.now() + DAY) } });
  const journey = await prisma.journey.create({ data: { tenantId: t.id, employeeId: emp.id, trigger: "MANUAL", title: "Rival journey", anchorDate: new Date(), tasks: { create: [{ title: "Rival task", owner: "HR", dueDate: new Date() }] } }, include: { tasks: true } });
  const req = await prisma.requisition.create({ data: { tenantId: t.id, title: "Rival role", status: "APPROVED" } });
  const file = await prisma.storedFile.create({ data: { tenantId: t.id, filename: "secret.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: "x", storageKey: `rival/${Date.now()}`, relatedType: "EmployeeDocument", employeeId: emp.id } });
  const component = await prisma.salaryComponent.create({ data: { tenantId: t.id, code: "RIVAL", name: "Rival allowance", type: "EARNING" } });
  const rivalGroup = await prisma.payGroup.create({ data: { tenantId: t.id, legalEntityId: le.id, name: "Rival payroll" } });
  const rivalStructure = await prisma.salaryStructure.create({ data: { payGroupId: rivalGroup.id, name: "Rival structure" } });
  const adhoc = await prisma.adhocTransaction.create({ data: { employeeId: emp.id, type: "PAYMENT", name: "Rival bonus", amount: 5000, year: 2026, month: 9 } });
  const ttype = await prisma.trainingType.create({ data: { tenantId: t.id, name: "Rival training" } });
  const program = await prisma.trainingProgram.create({ data: { tenantId: t.id, trainingTypeId: ttype.id, title: "Rival course" } });
  const enrolment = await prisma.trainingEnrolment.create({ data: { programId: program.id, employeeId: emp.id } });
  const announcement = await prisma.announcement.create({ data: { tenantId: t.id, title: "Rival news", body: "x" } });
  const acat = await prisma.assetCategory.create({ data: { tenantId: t.id, name: "Rival kit" } });
  const atype = await prisma.assetType.create({ data: { categoryId: acat.id, name: "Rival laptop" } });
  const rivalDecl = await prisma.investmentDeclaration.create({ data: { employeeId: emp.id, fyStartYear: 2026, regime: "OLD", items: { create: [{ section: "80C", category: "Rival PPF", declaredAmount: 50000 }] } }, include: { items: true } });
  const rivalChart = await svc.ensureChart(t.id);
  const rivalEntry = await svc.postEntry({ tenantId: t.id, date: new Date(), narration: "Rival capital", source: "MANUAL", lines: [{ accountCode: "1100", debit: 1000, credit: 0 }, { accountCode: "3100", debit: 0, credit: 1000 }] });
  const before = { dept: dept.name, plan: plan.name, lr: lr.status, claim: claim.stage, ticket: ticket.status };

  console.log("\nTenant isolation\n" + "=".repeat(72));
  try {
    await signInAs("vikram.menon@acme.test"); // every permission, in Acme
    const acmeBu = await prisma.businessUnit.findFirstOrThrow({ where: { tenantId: acme.id } });
    const acmeEntity = await prisma.legalEntity.findFirstOrThrow({ where: { tenantId: acme.id } });
    const acmeLoc = await prisma.location.findFirstOrThrow({ where: { tenantId: acme.id } });
    const acmePlan = await prisma.leavePlan.findFirstOrThrow({ where: { tenantId: acme.id } });

    section("Changing or deleting the rival's records");
    check("Rename the rival's department", await refused(() => org.saveDepartment({}, fd({ id: dept.id, name: "Pwned" }))));
    check("Delete the rival's department", await refused(() => org.deleteDepartment({}, fd({ id: dept.id }))));
    check("Delete the rival's job title", await refused(() => org.deleteLookup({}, fd({ kind: "jobTitle", id: jt.id }))));
    check("Edit the rival's leave plan", await refused(() => time.saveLeavePlan({}, fd({ id: plan.id, name: "Pwned", yearBasis: "FINANCIAL_APR" }))));
    check("Delete the rival's leave type", await refused(() => time.deleteLeaveType({}, fd({ id: lt.id }))));
    check("Delete the rival's holiday", await refused(() => time.deleteHoliday({}, fd({ id: cal.holidays[0].id }))));
    check("Add a holiday to the rival's calendar", await refused(() => time.addHoliday({}, fd({ calendarId: cal.id, name: "Pwned", date: "2026-12-25" }))));
    check("Approve the rival's leave", await refused(() => time.decideLeaveAction({}, fd({ requestId: lr.id, decision: "approve" }))));
    check("Approve the rival's expense claim", await refused(() => exp.decideClaimAction({}, fd({ claimId: claim.id, decision: "approve" }))));
    check("Reply on the rival's helpdesk ticket", await refused(() => life.replyTicketAction({}, fd({ ticketId: ticket.id, body: "pwned" }))));
    check("Close the rival's journey task", await refused(() => life.setTaskAction({}, fd({ taskId: journey.tasks[0].id, status: "DONE" }))));
    check("Change the rival employee's job", await refused(() => employee.recordJobChange({}, fd({ employeeId: emp.id, effectiveFrom: "2026-10-01", reason: "PROMOTION" }))));
    check("Open a job on the rival's requisition", await refused(() => hiring.openJobAction({}, fd({ requisitionId: req.id }))));

    section("Linking our records to theirs");
    check("Our department under their business unit", await refused(() => org.saveDepartment({}, fd({ name: "Smoke dept", businessUnitId: bu.id }))));
    check("Our department headed by their employee", await refused(() => org.saveDepartment({}, fd({ name: "Smoke dept 2", headId: emp.id }))));
    check("A new hire in their department", await refused(() => employee.createEmployee({}, fd({ firstName: "Smoke", lastName: "Iso", workEmail: "smoke.iso@acme.test", dateOfJoining: "2026-11-01", legalEntityId: acmeEntity.id, locationId: acmeLoc.id, departmentId: dept.id }))));
    check("A new hire reporting to their employee", await refused(() => employee.createEmployee({}, fd({ firstName: "Smoke", lastName: "Iso", workEmail: "smoke.iso2@acme.test", dateOfJoining: "2026-11-01", legalEntityId: acmeEntity.id, locationId: acmeLoc.id, reportingManagerId: emp.id }))));
    check("Their employee onto our leave plan", await refused(() => time.assignLeavePlan({}, fd({ planId: acmePlan.id, employeeIds: emp.id }))));
    check("A department goal for their department", await refused(() => perf.saveGoalAction({}, fd({ title: "Smoke iso goal", level: "DEPARTMENT", departmentId: dept.id, metricType: "PERCENTAGE", startDate: "2026-04-01", dueDate: "2027-03-31" }))));
    check("A task in their project", await refused(() => proj.createTaskAction({}, fd({ projectId: project.id, title: "Smoke iso task" }))));
    check("A milestone in their project", await refused(() => proj.milestoneAction({}, fd({ projectId: project.id, name: "Smoke", dueDate: "2026-12-01" }))));
    check("Allocating someone to their project", await refused(() => proj.allocateAction({}, fd({ projectId: project.id, employeeId: emp.id, allocationPercent: 50, startDate: "2026-10-01" }))));
    check("Our project billed to their client", await refused(() => proj.saveProjectAction({}, fd({ name: "Smoke iso project", clientId: client.id, billingModel: "TIME_AND_MATERIAL" }))));
    check("A requisition placed in their department", await refused(() => hiring.raiseRequisitionAction({}, fd({ title: "Smoke iso req", type: "NEW_HIRE", departmentId: dept.id, positions: 1, justification: "x" }))));
    check("A journey template for their department", await refused(() => life.saveTemplateAction({}, fd({ name: "Smoke iso template", trigger: "JOINING", departmentId: dept.id }))));
    check("A helpdesk queue defaulting to their user", await refused(() => life.saveCategoryAction({}, fd({ name: "Smoke iso queue", slaHours: 24, defaultAssigneeUserId: user.id }))));
    const someone = await prisma.employee.findFirstOrThrow({ where: { tenantId: acme.id, status: "CONFIRMED" } });
    check("A balance adjustment in their leave type", await refused(() => time.adjustBalanceAction({}, fd({ employeeId: someone.id, leaveTypeId: lt.id, days: 1, note: "smoke" }))));
    const ptGroup = await prisma.payGroup.findFirstOrThrow({ where: { tenantId: acme.id } });
    check("A PT registration covering their location", await refused(() => payConfig.savePtRegistration({}, fd({ payGroupId: ptGroup.id, stateCode: "MH", stateName: "Maharashtra", frequency: "MONTHLY", locationIds: loc.id }))));
    const ourStructure = await prisma.salaryStructure.findFirstOrThrow({ where: { payGroup: { tenantId: acme.id } } });
    check("Their pay component on our salary structure", await refused(() => payConfig.saveStructureLine({}, fd({ structureId: ourStructure.id, componentId: component.id, calculationType: "FIXED", fixedAmount: 100 }))));
    const paid = await prisma.employee.findFirstOrThrow({ where: { tenantId: acme.id, status: "CONFIRMED", payGroupId: { not: null } } });
    check("Our employee paid on their salary structure", await refused(() => employee.reviseSalary({}, fd({ employeeId: paid.id, effectiveFrom: "2027-01-01", annualCtc: 1200000, structureId: rivalStructure.id }))));
    const asset = await prisma.asset.findFirst({ where: { tenantId: acme.id, status: "AVAILABLE" } });
    if (asset) check("Our laptop handed to their employee", await throws(() => work.assignAsset(fd({ assetId: asset.id, employeeId: emp.id }))) && (await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status === "AVAILABLE");
    check("An asset request for their asset type", await throws(() => work.requestAsset(fd({ assetTypeId: atype.id, reason: "smoke" }))));
    const ourProgram = await prisma.trainingProgram.findFirst({ where: { tenantId: acme.id } });
    if (ourProgram) check("Their employee enrolled on our course", await throws(() => work.enrolInTraining(fd({ programId: ourProgram.id, employeeIds: emp.id }))) && (await prisma.trainingEnrolment.count({ where: { employeeId: emp.id, programId: ourProgram.id } })) === 0);
    const ourMeeting = await prisma.meeting.findFirst({ where: { tenantId: acme.id } });
    if (ourMeeting) check("An action item owned by their employee", await throws(() => work.addMeetingActionItem(fd({ meetingId: ourMeeting.id, description: "smoke iso", ownerId: emp.id }))));
    check("Their holidays copied into our calendar", await refused(() => time.addHolidayCalendar({}, fd({ name: "Smoke iso calendar", year: 2027, copyFromId: cal.id }))) || (await prisma.holiday.count({ where: { calendar: { tenantId: acme.id, name: "Smoke iso calendar" } } })) === 0);

    section("Their people's feedback and tax");
    check("Praise for their employee", await refused(() => feedbackActions.givePraiseAction({}, fd({ toEmployeeId: emp.id, message: "smoke iso" }))) && (await prisma.praise.count({ where: { toEmployeeId: emp.id } })) === 0);
    check("Feedback about their employee", await refused(() => feedbackActions.giveFeedbackAction({}, fd({ aboutEmployeeId: emp.id, message: "smoke iso" }))) && (await prisma.feedback.count({ where: { aboutEmployeeId: emp.id } })) === 0);
    check("Removing their tax declaration", await refused(() => taxActions.removeDeclarationItemAction({}, fd({ itemId: rivalDecl.items[0].id }))) && (await prisma.declarationItem.count({ where: { id: rivalDecl.items[0].id } })) === 1);

    section("Their books");
    const ourBank = await prisma.account.findFirstOrThrow({ where: { tenantId: acme.id, code: "1100" } });
    const jf = new FormData();
    jf.set("date", new Date().toISOString().slice(0, 10)); jf.set("narration", "Smoke iso journal");
    jf.set("account_0", ourBank.id); jf.set("debit_0", "500"); jf.set("account_1", rivalChart.get("3100")!); jf.set("credit_1", "500");
    check("A journal line against their account", await refused(() => books.postJournalAction({}, jf)) && (await prisma.ledgerEntry.count({ where: { tenantId: acme.id, narration: "Smoke iso journal" } })) === 0);
    check("Reversing their entry", await refused(() => books.reverseEntryAction({}, fd({ entryId: rivalEntry.entryId!, reason: "smoke" }))) && (await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: rivalEntry.entryId! } })).status === "POSTED");
    check("Recording a salary payment for their run", await refused(() => books.salaryPaymentAction({}, fd({ runId: "x", date: "2026-10-01" }))));
    check("Our books never show their balances", Number((await prisma.account.findFirstOrThrow({ where: { tenantId: acme.id, code: "3100" } })).currentBalance) === 10_000_000);

    section("Their payroll and money");
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { tenantId: acme.id, status: { not: "FINALIZED" } }, orderBy: [{ year: "desc" }, { month: "desc" }] });
    check("A payment added to their employee's salary", await throws(() => payroll.addAdhoc(fd({ runId: run.id, employeeId: emp.id, type: "PAYMENT", name: "Smoke iso", amount: 1000 }))) && (await prisma.adhocTransaction.count({ where: { employeeId: emp.id, name: "Smoke iso" } })) === 0);
    check("Loss-of-pay days put on their employee", await throws(() => payroll.setLopAdjustment(fd({ runId: run.id, employeeId: emp.id, days: 3 }))) && (await prisma.lopAdjustment.count({ where: { employeeId: emp.id } })) === 0);
    check("Their employee's bonus deleted", await throws(() => payroll.deleteAdhoc(fd({ runId: run.id, id: adhoc.id }))) && (await prisma.adhocTransaction.count({ where: { id: adhoc.id } })) === 1);
    check("Their training progress changed", await throws(() => work.updateTrainingProgress(fd({ enrolmentId: enrolment.id, progress: 100 }))) && (await prisma.trainingEnrolment.findUniqueOrThrow({ where: { id: enrolment.id } })).progressPercent === 0);
    await work.markAnnouncementViewed(announcement.id);
    check("Reading their announcement leaves no trace", (await prisma.announcementRead.count({ where: { announcementId: announcement.id } })) === 0);

    section("Reading");
    const { GET: searchGet } = await import("../apps/web/src/app/api/search/route");
    const found = await (await searchGet({ nextUrl: new URL("http://x/api/search?q=Rita") } as never)).json() as { people: unknown[] };
    const ours = await (await searchGet({ nextUrl: new URL("http://x/api/search?q=Meera") } as never)).json() as { people: unknown[] };
    check("Search never finds their people (but does find ours)", found.people.length === 0 && ours.people.length === 1, JSON.stringify({ found, ours: ours.people.length }));
    check("Their file cannot be downloaded", (await fileGet(new Request("http://x") as never, { params: Promise.resolve({ id: file.id }) })).status === 404);
    const viewer = (await getViewer())!;
    const head = await REPORTS.find((r) => r.key === "headcount")!.run(viewer, { fy: 2026 });
    check("Reports never count their people", !head.rows.some((r) => r.department === "Rival Dept") && head.totals?.total === (await prisma.employee.count({ where: { tenantId: acme.id, status: { notIn: ["EXITED", "PREBOARDING"] } } })));

    section("Nothing changed on their side");
    const now = {
      dept: (await prisma.department.findUniqueOrThrow({ where: { id: dept.id } })).name,
      plan: (await prisma.leavePlan.findUniqueOrThrow({ where: { id: plan.id } })).name,
      lr: (await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } })).status,
      claim: (await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } })).stage,
      ticket: (await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status,
    };
    check("Every rival record is exactly as it was", JSON.stringify(now) === JSON.stringify(before), JSON.stringify(now));
    check("No Acme row points at a rival record",
      (await prisma.department.count({ where: { tenantId: acme.id, OR: [{ businessUnitId: bu.id }, { headId: emp.id }] } })) === 0 &&
      (await prisma.task.count({ where: { projectId: project.id } })) === 0 &&
      (await prisma.leavePlanAssignment.count({ where: { employeeId: emp.id } })) === 0 &&
      (await prisma.helpdeskComment.count({ where: { ticketId: ticket.id } })) === 0);
  } finally {
    await prisma.department.deleteMany({ where: { tenantId: acme.id, name: { startsWith: "Smoke dept" } } });
    await prisma.goal.deleteMany({ where: { tenantId: acme.id, title: "Smoke iso goal" } });
    await prisma.project.deleteMany({ where: { tenantId: acme.id, name: "Smoke iso project" } });
    await prisma.requisition.deleteMany({ where: { tenantId: acme.id, title: "Smoke iso req" } });
    await prisma.journeyTemplate.deleteMany({ where: { tenantId: acme.id, name: "Smoke iso template" } });
    await prisma.helpdeskCategory.deleteMany({ where: { tenantId: acme.id, name: "Smoke iso queue" } });
    await prisma.holidayCalendar.deleteMany({ where: { tenantId: acme.id, name: "Smoke iso calendar" } });
  }

  section("Deleting a tenant leaves nothing behind");
  await prisma.tenant.delete({ where: { id: t.id } });
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.columns WHERE column_name = 'tenantId' AND table_schema = 'public'`;
  let leftovers = 0;
  for (const { table_name } of tables) {
    const r = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${table_name}" WHERE "tenantId" = $1`, t.id);
    leftovers += Number(r[0].n);
  }
  check(`No row remains in any of the ${tables.length} tenant tables`, leftovers === 0, `${leftovers} left`);
  check("…including the rows reached only through relations", (await prisma.timeEntry.count({ where: { projectId: project.id } })) === 0 && (await prisma.journeyTask.count({ where: { journeyId: journey.id } })) === 0);

  report("Tenant isolation");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
