import type { PrismaClient } from "@prisma/client";

/**
 * Self-service seed: what an employee sees about themselves — an "about me",
 * praise and feedback from colleagues, a manager's internal notes, and tax
 * declarations for the year. Idempotent: it clears its own rows first, so it
 * can run on its own against an existing database.
 */
const d = (s: string) => new Date(`${s}T09:30:00Z`);

export async function seedSelfService(prisma: PrismaClient, ctx: { tenantId: string }) {
  const t = ctx.tenantId;
  const emp = async (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: t, employeeNumber: n } });
  const [vikram, sneha, karthik, ananya, meera, aditya, divya, kavya, rohit, priya] = await Promise.all(
    ["ACM0001", "ACM0005", "ACM0006", "ACM0007", "ACM0009", "ACM0010", "ACM0011", "ACM0014", "ACM0008", "ACM0003"].map(emp),
  );

  // About me — some filled in, Meera's left for her to write.
  const about: Array<[{ id: string }, string]> = [
    [vikram, "Founded Acme to make payroll boring in the best way. Ask me about bikes, cricket stats or the best filter coffee in Indiranagar."],
    [sneha, "Engineering manager for Platform. I care about calm releases, honest retros and people growing into bigger problems."],
    [karthik, "Staff engineer — distributed systems, Postgres internals and mentoring. Weekend trail runner."],
    [ananya, "Senior engineer on Product. Accessibility nerd; I read every PR description twice."],
    [priya, "HR business partner for engineering and corporate teams. My door (and Slack) is always open."],
  ];
  for (const [e, text] of about) await prisma.employee.update({ where: { id: e.id }, data: { aboutMe: text } });
  await prisma.employee.update({ where: { id: meera.id }, data: { aboutMe: null } });

  // Praise for Meera, so her Performance tab has something to show.
  await prisma.praise.deleteMany({ where: { tenantId: t, OR: [{ toEmployeeId: meera.id }, { fromEmployeeId: meera.id }] } });
  await prisma.praise.createMany({ data: [
    { tenantId: t, fromEmployeeId: ananya.id, toEmployeeId: meera.id, badge: "Problem Solver", message: "Tracked down the timezone bug in payslip dates in an afternoon. Clean fix, great tests.", createdAt: d("2026-09-18") },
    { tenantId: t, fromEmployeeId: sneha.id, toEmployeeId: meera.id, badge: "Team Player", message: "Stepped in to cover the on-call rotation during the release week without being asked.", createdAt: d("2026-08-29") },
    { tenantId: t, fromEmployeeId: meera.id, toEmployeeId: aditya.id, badge: "Helping Hand", message: "Thanks for pairing on the checkout flow — your test fixtures saved me a day.", createdAt: d("2026-09-24") },
  ] });

  await prisma.feedback.deleteMany({ where: { tenantId: t } });
  await prisma.feedback.createMany({ data: [
    { tenantId: t, fromEmployeeId: ananya.id, aboutEmployeeId: meera.id, topic: "Code review", message: "Your PRs are easy to review — small, well described, tests first. Next step: weigh in on design discussions earlier; your instincts are good.", createdAt: d("2026-09-10") },
    { tenantId: t, fromEmployeeId: kavya.id, aboutEmployeeId: meera.id, topic: "Northwind POS", message: "Clear demos to the client and you flag risks before they become surprises. Keep doing that.", createdAt: d("2026-09-26") },
    { tenantId: t, fromEmployeeId: meera.id, aboutEmployeeId: divya.id, topic: "Regression suite", message: "The till regression suite caught two issues before UAT. Could we add the offline-sync cases next sprint?", createdAt: d("2026-09-22") },
    { tenantId: t, fromEmployeeId: ananya.id, aboutEmployeeId: meera.id, kind: "INTERNAL_NOTE", topic: "Growth", message: "Ready to own a module end to end next quarter. Discuss a mid-year rating of 4 with Sneha.", createdAt: d("2026-09-27") },
    { tenantId: t, fromEmployeeId: sneha.id, aboutEmployeeId: karthik.id, topic: "Offline sync", message: "The design doc for offline sync set the bar for the team. Thank you.", createdAt: d("2026-09-15") },
    { tenantId: t, fromEmployeeId: sneha.id, aboutEmployeeId: rohit.id, kind: "INTERNAL_NOTE", topic: "Attendance", message: "Several late starts in September; check in about the commute from Thane.", createdAt: d("2026-09-20") },
  ] });

  // Tax declarations for 2026-27: Meera on the old regime claims, others on the new.
  await prisma.investmentDeclaration.deleteMany({ where: { employee: { tenantId: t }, fyStartYear: 2026 } });
  const declare = async (e: { id: string }, regime: "OLD" | "NEW", items: Array<[string, string, number, number, "NOT_SUBMITTED" | "SUBMITTED" | "APPROVED" | "REJECTED"]>) => {
    const total = items.reduce((s, i) => s + i[2], 0), approved = items.reduce((s, i) => s + i[3], 0);
    await prisma.investmentDeclaration.create({
      data: {
        employeeId: e.id, fyStartYear: 2026, regime, status: "SUBMITTED", declaredTotal: total, approvedTotal: approved, submittedAt: d("2026-04-18"), isLocked: true,
        items: { create: items.map(([section, category, declared, ok, proof]) => ({ section, category, declaredAmount: declared, approvedAmount: ok, proofStatus: proof })) },
      },
    });
  };
  await declare(meera, "NEW", [["80CCD(2)", "Employer NPS contribution", 0, 0, "NOT_SUBMITTED"]]);
  await declare(ananya, "OLD", [
    ["80C", "Public Provident Fund", 90000, 90000, "APPROVED"],
    ["80C", "ELSS mutual funds", 60000, 0, "SUBMITTED"],
    ["80D", "Health insurance — self and parents", 25000, 25000, "APPROVED"],
    ["24B", "Home loan interest — self-occupied", 180000, 0, "NOT_SUBMITTED"],
  ]);
  await declare(kavya, "OLD", [["80C", "Life insurance premium", 48000, 48000, "APPROVED"], ["80E", "Education loan interest", 36000, 0, "REJECTED"]]);

  // A salary history for Meera: joined on less, two appraisals since.
  const joining = await prisma.salaryRevision.findFirstOrThrow({ where: { employeeId: meera.id }, orderBy: { effectiveFrom: "asc" } });
  await prisma.salaryRevision.deleteMany({ where: { employeeId: meera.id, id: { not: joining.id } } });
  await prisma.salaryRevision.update({ where: { id: joining.id }, data: { annualCtc: 840000, arrearsProcessed: true } });
  await prisma.salaryRevision.createMany({ data: [
    { employeeId: meera.id, structureId: joining.structureId, effectiveFrom: new Date("2024-04-01T00:00:00Z"), annualCtc: 1000000, previousCtc: 840000, reason: "Annual appraisal 2024", status: "APPLIED", arrearsProcessed: true },
    { employeeId: meera.id, structureId: joining.structureId, effectiveFrom: new Date("2025-04-01T00:00:00Z"), annualCtc: 1200000, previousCtc: 1000000, reason: "Annual appraisal 2025", status: "APPLIED", arrearsProcessed: true },
  ] });

  // Meera's expenses beyond the one in approval: a draft, one paid by bank
  // transfer and one rejected — none of them through payroll.
  const svc = await import("@keka/services");
  const cat = async (name: string) => (await prisma.expenseCategory.findFirstOrThrow({ where: { tenantId: t, name } })).id;
  const ago = (n: number) => new Date(Date.now() - n * 86_400_000);
  const ananyaUser = (await prisma.employee.findUniqueOrThrow({ where: { id: ananya.id }, select: { userId: true } })).userId!;
  await svc.createClaim({ employeeId: meera.id, title: "Home broadband — Oct", lines: [{ categoryId: await cat("Internet & phone"), expenseDate: ago(1), amount: 799, merchant: "Airtel Xstream", receiptUrl: "/files/seed-receipt" }], payViaPayroll: false, submit: false });
  const paid = await svc.createClaim({ employeeId: meera.id, title: "Team offsite travel", lines: [{ categoryId: await cat("Local conveyance"), expenseDate: ago(20), amount: 1240, merchant: "Uber", receiptUrl: "/files/seed-receipt" }], payViaPayroll: false, submit: true });
  if (paid.claimId) {
    await svc.decideClaim({ claimId: paid.claimId, level: "MANAGER", approve: true, byUserId: ananyaUser });
    await svc.markClaimPaid(paid.claimId);
  }
  const rejected = await svc.createClaim({ employeeId: meera.id, title: "Client dinner — Northwind", lines: [{ categoryId: await cat("Meals"), expenseDate: ago(9), amount: 1450, merchant: "Toit", receiptUrl: "/files/seed-receipt" }], payViaPayroll: false, submit: true });
  if (rejected.claimId) await svc.decideClaim({ claimId: rejected.claimId, level: "MANAGER", approve: false, byUserId: ananyaUser, reason: "Client entertainment goes under the project's budget — please re-file under Client entertainment." });

  // Store everyone's profile completeness under the one shared definition.
  for (const e of await prisma.employee.findMany({ where: { tenantId: t }, select: { id: true } })) await svc.recomputeProfileCompletion(e.id);

  return { about: about.length, praise: 3, feedback: 6, declarations: 3 };
}
