import type { PrismaClient } from "@prisma/client";

/**
 * Lifecycle seed: journey templates for joining, exit, promotion and
 * confirmation; journeys started from real events; helpdesk categories and a
 * spread of tickets; and exits at three stages, with a settlement drafted by
 * the real F&F computation.
 *
 * Like the time seed, everything that has a service goes through it.
 */

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

type Owner = "HR" | "MANAGER" | "EMPLOYEE" | "IT" | "FINANCE" | "ADMIN";
type T = [offset: number, owner: Owner, title: string, category: string, autoCheck?: string | null, required?: boolean];

const ONBOARDING: T[] = [
  [-7, "HR", "Send the offer letter and welcome email", "DOCUMENTS"],
  [-5, "IT", "Create the login and work email", "ACCESS", "USER_ACCOUNT"],
  [-3, "ADMIN", "Allocate a laptop and ID card", "ASSETS"],
  [-2, "HR", "Assign a salary structure", "PAYROLL", "SALARY_ASSIGNED"],
  [-2, "HR", "Assign a leave plan", "OTHER", "LEAVE_PLAN_ASSIGNED"],
  [-2, "HR", "Assign a shift and attendance policy", "OTHER", "TIME_POLICY_ASSIGNED"],
  [0, "EMPLOYEE", "Submit bank details", "PAYROLL", "BANK_DETAILS"],
  [0, "EMPLOYEE", "Upload identity and education documents", "DOCUMENTS"],
  [1, "MANAGER", "Welcome meeting and team introductions", "MEETING"],
  [3, "HR", "Verify the submitted documents", "COMPLIANCE", "DOCUMENTS_VERIFIED"],
  [7, "EMPLOYEE", "Acknowledge policies and complete POSH training", "TRAINING"],
  [7, "MANAGER", "First-week check-in", "MEETING"],
  [30, "MANAGER", "30-day check-in", "MEETING"],
  [60, "MANAGER", "Agree goals for the rest of probation", "OTHER", null, false],
  [90, "MANAGER", "Probation review", "OTHER"],
];

const ENGINEERING_EXTRA: T[] = [
  [-1, "IT", "Grant source control and cloud console access", "ACCESS"],
  [1, "MANAGER", "Assign an onboarding buddy", "OTHER"],
  [14, "MANAGER", "First production change, paired", "TRAINING", null, false],
];

const EXIT: T[] = [
  [-45, "HR", "Approve the resignation", "COMPLIANCE", "EXIT_APPROVED"],
  [-30, "MANAGER", "Plan the knowledge transfer", "OTHER"],
  [-7, "MANAGER", "Sign off the knowledge transfer", "OTHER"],
  [-3, "HR", "Exit interview", "MEETING", null, false],
  [-1, "ADMIN", "Collect laptop, ID and access cards", "ASSETS", "ASSETS_RETURNED"],
  [0, "IT", "Revoke email and system access", "ACCESS"],
  [0, "FINANCE", "Close or recover open loans", "PAYROLL", "LOANS_CLOSED"],
  [15, "FINANCE", "Full and final settlement", "PAYROLL", "FNF_SETTLED"],
  [15, "HR", "Issue relieving and experience letters", "DOCUMENTS"],
];

const PROMOTION: T[] = [
  [0, "HR", "Revise salary for the new role", "PAYROLL"],
  [0, "HR", "Issue the promotion letter", "DOCUMENTS"],
  [0, "IT", "Review system access for the new role", "ACCESS", null, false],
  [7, "MANAGER", "Reset goals for the new role", "OTHER"],
  [30, "MANAGER", "30-day check-in in the new role", "MEETING", null, false],
];

const CONFIRMATION: T[] = [
  [-7, "MANAGER", "Complete the probation review", "OTHER"],
  [0, "HR", "Issue the confirmation letter", "DOCUMENTS"],
  [0, "HR", "Update leave and benefits for confirmed staff", "OTHER", null, false],
];

export async function seedLifecycle(
  prisma: PrismaClient,
  ctx: { tenantId: string; empIdByNumber: Map<string, string>; departmentIdByName: Map<string, string> },
) {
  const svc = await import("@keka/services");
  const id = (n: string) => ctx.empIdByNumber.get(n)!;

  // --- Templates -----------------------------------------------------------
  const mk = async (name: string, trigger: "JOINING" | "EXIT" | "PROMOTION" | "CONFIRMATION", tasks: T[], description: string, departmentId?: string) =>
    prisma.journeyTemplate.create({
      data: {
        tenantId: ctx.tenantId, name, trigger, description, departmentId: departmentId ?? null,
        tasks: {
          create: tasks.map(([offsetDays, owner, title, category, autoCheck, required], i) => ({
            offsetDays, owner, title, category, autoCheck: autoCheck ?? null, isRequired: required ?? true, sortOrder: i,
          })),
        },
      },
    });
  await mk("Standard onboarding", "JOINING", ONBOARDING, "Everything from offer to probation review, for every new joiner.");
  for (const dept of ["Product Engineering", "Platform Engineering"]) {
    const deptId = ctx.departmentIdByName.get(dept);
    if (deptId) await mk(`${dept} onboarding`, "JOINING", [...ONBOARDING, ...ENGINEERING_EXTRA], `Standard onboarding plus access and a buddy for ${dept}.`, deptId);
  }
  await mk("Standard exit", "EXIT", EXIT, "Clearance from resignation to relieving letter, anchored on the last working day.");
  await mk("Promotion", "PROMOTION", PROMOTION, "What a promotion sets in motion.");
  await mk("Confirmation", "CONFIRMATION", CONFIRMATION, "Closing out probation.");
  const templates = 7;

  // --- Journeys from real events ------------------------------------------
  const sys = await prisma.user.findFirstOrThrow({ where: { tenantId: ctx.tenantId, email: "priya.sharma@acme.test" } });
  let journeys = 0;
  for (const [num, doj] of [["ACM0025", utc(2026, 8, 1)], ["ACM0026", utc(2026, 7, 1)], ["ACM0024", utc(2026, 6, 15)]] as const) {
    const r = await svc.startJourney({ employeeId: id(num), trigger: "JOINING", anchorDate: doj, createdBy: sys.id });
    if (!r.journeyId) continue;
    journeys++;
    // Work done so far: everything due more than a week ago, bar one each.
    const tasks = await prisma.journeyTask.findMany({ where: { journeyId: r.journeyId, status: "PENDING" }, orderBy: { dueDate: "asc" } });
    const cutoff = utc(2026, 9, 21).getTime();
    const doneable = tasks.filter((t) => t.dueDate.getTime() < cutoff && !t.autoCheck);
    for (const t of doneable.slice(0, Math.max(0, doneable.length - 1))) {
      await prisma.journeyTask.update({ where: { id: t.id }, data: { status: "DONE", completedAt: new Date(t.dueDate.getTime() + 86_400_000), completedBy: sys.id } });
    }
  }
  const promotion = await prisma.hrActivity.findFirst({ where: { tenantId: ctx.tenantId, type: "PROMOTION" }, orderBy: { occurredOn: "desc" } });
  if (promotion) {
    const r = await svc.startJourney({ employeeId: promotion.employeeId, trigger: "PROMOTION", anchorDate: promotion.occurredOn, sourceType: "HrActivity", sourceId: promotion.id, createdBy: sys.id });
    if (r.journeyId) journeys++;
  }

  // --- Exits at three stages ----------------------------------------------
  // Settled through clearance: resigned in July, left mid-September.
  await svc.initiateExit({ employeeId: id("ACM0028"), type: "RESIGNATION", noticeDate: utc(2026, 7, 20), lastWorkingDay: utc(2026, 9, 18), reason: "Relocating to Pune for family reasons.", initiatedByUserId: null });
  const x28 = await prisma.exitRecord.findUniqueOrThrow({ where: { employeeId: id("ACM0028") } });
  await svc.decideExit({ exitId: x28.id, decision: "APPROVE", byUserId: sys.id, note: "Discussed with the manager; amicable.", isRehireEligible: true });
  await prisma.assetAssignment.updateMany({ where: { employeeId: id("ACM0028"), returnedOn: null }, data: { returnedOn: utc(2026, 9, 17), conditionIn: "GOOD" } });
  const exitJourney = await prisma.journey.findFirst({ where: { employeeId: id("ACM0028"), trigger: "EXIT" } });
  if (exitJourney) {
    journeys++;
    await prisma.journeyTask.updateMany({
      where: { journeyId: exitJourney.id, autoCheck: null, title: { not: "Issue relieving and experience letters" } },
      data: { status: "DONE", completedAt: utc(2026, 9, 18), completedBy: sys.id },
    });
    await svc.runAutoChecks(exitJourney.id);
  }
  const fnf = await svc.draftSettlement(id("ACM0028"));

  // Serving notice: the seed already put Gaurav on notice; give it a record.
  await svc.initiateExit({ employeeId: id("ACM0027"), type: "RESIGNATION", noticeDate: utc(2026, 9, 1), reason: "Higher studies abroad.", initiatedByUserId: null });
  const x27 = await prisma.exitRecord.findUniqueOrThrow({ where: { employeeId: id("ACM0027") } });
  await svc.decideExit({ exitId: x27.id, decision: "APPROVE", byUserId: sys.id, note: "Counter-offer declined.", isRehireEligible: true });
  if (await prisma.journey.findFirst({ where: { employeeId: id("ACM0027"), trigger: "EXIT" } })) journeys++;

  // Just resigned, awaiting approval.
  await svc.initiateExit({ employeeId: id("ACM0029"), type: "RESIGNATION", noticeDate: utc(2026, 9, 25), reason: "Accepted an offer elsewhere.", initiatedByUserId: null });

  // --- Helpdesk -------------------------------------------------------------
  const vikram = await prisma.user.findFirstOrThrow({ where: { tenantId: ctx.tenantId, email: "vikram.menon@acme.test" } });
  const cats = new Map<string, string>();
  for (const [name, slaHours, assignee, description] of [
    ["Payroll & salary", 48, sys.id, "Payslips, deductions, tax and arrears"],
    ["Leave & attendance", 24, sys.id, "Balances, regularisation and holidays"],
    ["IT & access", 24, vikram.id, "Laptops, logins and system access"],
    ["Benefits & reimbursements", 72, sys.id, "Insurance, claims and allowances"],
    ["Documents & letters", 72, sys.id, "Employment, address and experience letters"],
    ["Policies", 72, sys.id, "Questions about company policy"],
  ] as const) {
    const c = await prisma.helpdeskCategory.create({ data: { tenantId: ctx.tenantId, name, slaHours, defaultAssigneeUserId: assignee, description } });
    cats.set(name, c.id);
  }
  const tickets: Array<[string, string, string, string, "LOW" | "MEDIUM" | "HIGH" | "URGENT", "OPEN" | "IN_PROGRESS" | "WAITING_ON_EMPLOYEE" | "RESOLVED" | "CLOSED", string[]]> = [
    ["ACM0009", "Payroll & salary", "Why is my September TDS higher than August?", "My TDS went up by about ₹1,200 this month though my salary is the same. Can someone explain?", "MEDIUM", "IN_PROGRESS", ["agent:Your annual projection was re-run after the arrears from the July revision; the extra tax is spread over the remaining months. I'll send the working shortly."]],
    ["ACM0012", "Leave & attendance", "Regularisation for 14 September not reflecting", "I raised a regularisation for the holiday mix-up but my attendance still shows LOP.", "HIGH", "WAITING_ON_EMPLOYEE", ["agent:14 September is a holiday on the default calendar — could you confirm which date you meant?"]],
    ["ACM0014", "IT & access", "VPN access for the new staging cluster", "Need VPN profile for staging-2 to debug the release.", "HIGH", "OPEN", []],
    ["ACM0016", "Documents & letters", "Address proof letter for a bank account", "Please issue an address proof letter on letterhead.", "LOW", "RESOLVED", ["agent:Letter issued and uploaded to your documents.", "employee:Received, thank you!"]],
    ["ACM0018", "Benefits & reimbursements", "Add spouse to the medical insurance", "Got married last month; how do I add my spouse to the group policy?", "MEDIUM", "OPEN", []],
    ["ACM0013", "Policies", "Is work from another city allowed for two weeks?", "Planning to work from Jaipur for two weeks in November.", "LOW", "CLOSED", ["agent:Yes, up to 30 days a year with manager approval — raise a work-from-home request for the dates.", "employee:Thanks."]],
    ["ACM0021", "Payroll & salary", "Form 16 for FY 2025-26", "Where can I download last year's Form 16?", "MEDIUM", "RESOLVED", ["agent:It is under My Tax → Documents. Part A is from TRACES, Part B generated by us."]],
    ["ACM0025", "IT & access", "Laptop keyboard keys sticking", "A few keys on my laptop keyboard are unresponsive.", "URGENT", "IN_PROGRESS", ["agent:Replacement keyboard ordered; you can pick up a loaner from the IT desk today."]],
  ];
  let ticketCount = 0;
  for (const [num, cat, subject, description, priority, status, thread] of tickets) {
    const r = await svc.raiseTicket({ employeeId: id(num), categoryId: cats.get(cat)!, subject, description, priority });
    if (!r.ticketId) continue;
    ticketCount++;
    const emp = await prisma.employee.findUniqueOrThrow({ where: { id: id(num) }, select: { userId: true, displayName: true } });
    for (const line of thread) {
      const asAgent = line.startsWith("agent:");
      const author = asAgent ? (cat === "IT & access" ? vikram : sys) : null;
      await svc.commentOnTicket({
        ticketId: r.ticketId, asAgent, body: line.slice(line.indexOf(":") + 1),
        authorUserId: asAgent ? author!.id : emp.userId!, authorLabel: asAgent ? author!.email : emp.displayName ?? num,
      });
    }
    if (status !== "OPEN" && status !== "IN_PROGRESS") {
      if (status === "CLOSED") await svc.setTicketStatus({ ticketId: r.ticketId, status: "RESOLVED" });
      await svc.setTicketStatus({ ticketId: r.ticketId, status });
    }
    if (status === "RESOLVED" || status === "CLOSED") {
      await prisma.helpdeskTicket.update({ where: { id: r.ticketId }, data: { satisfaction: status === "CLOSED" ? 5 : 4 } });
    }
  }

  return { templates, journeys, tickets: ticketCount, categories: cats.size, fnfMessage: fnf.message };
}
