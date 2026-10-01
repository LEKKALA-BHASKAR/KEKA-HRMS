/**
 * The employee's own screens, through their actions: introducing yourself,
 * praise and feedback (with the internal-note boundary), submitting a saved
 * expense draft, and tax declarations — whose ceilings hold and which reach
 * the month's TDS in payroll, both ways.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { purgeLedgerSince } from "./_ledger";

const prisma = new PrismaClient();

async function main() {
  const profile = await import("../apps/web/src/app/actions/profile");
  const feedback = await import("../apps/web/src/app/actions/feedback");
  const expenses = await import("../apps/web/src/app/actions/expenses");
  const tax = await import("../apps/web/src/app/actions/tax");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n } });
  const [meera, ananya, aditya] = await Promise.all([emp("ACM0009"), emp("ACM0007"), emp("ACM0010")]);
  const started = new Date();
  const made = { claims: [] as string[], items: [] as string[] };

  console.log("\nSelf-service\n" + "=".repeat(72));
  try {
    section("Introduce yourself");
    await signInAs("meera.krishnan@acme.test");
    const before = (await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } })).profileCompletion;
    const saved = await profile.saveAboutMeAction({}, fd({ aboutMe: "Engineer on the checkout flow. Ask me about offline-first tills." }));
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } });
    check("Saving an About adds it to the profile", saved.ok === true && !!after.aboutMe, saved.message);
    check("…and raises the stored completeness, by the shared definition", after.profileCompletion > before && after.profileCompletion === (await svc.recomputeProfileCompletion(meera.id)), `${before} → ${after.profileCompletion}`);
    const tooLong = await profile.saveAboutMeAction({}, fd({ aboutMe: "x".repeat(1001) }));
    check("More than 1,000 characters is refused", tooLong.ok === false);

    section("Praise and feedback");
    const self = await feedback.givePraiseAction({}, fd({ toEmployeeId: meera.id, badge: "Team Player", message: "Me!" }));
    check("Nobody praises themselves", self.ok === false, self.message);
    const praise = await feedback.givePraiseAction({}, fd({ toEmployeeId: aditya.id, badge: "Team Player", message: "Smoke praise" }));
    check("Praising a colleague works", praise.ok === true && (await prisma.praise.count({ where: { fromEmployeeId: meera.id, toEmployeeId: aditya.id, message: "Smoke praise" } })) === 1, praise.message);
    const fb = await feedback.giveFeedbackAction({}, fd({ aboutEmployeeId: aditya.id, topic: "Smoke", message: "Smoke feedback" }));
    check("So does feedback", fb.ok === true, fb.message);
    const upward = await feedback.giveFeedbackAction({}, fd({ aboutEmployeeId: ananya.id, kind: "INTERNAL_NOTE", message: "Smoke note" }));
    check("An internal note about someone outside your reporting line is refused", upward.ok === false, upward.message);
    await signInAs("ananya.ghosh@acme.test");
    const note = await feedback.giveFeedbackAction({}, fd({ aboutEmployeeId: meera.id, kind: "INTERNAL_NOTE", message: "Smoke private note" }));
    check("A manager can note something about their report", note.ok === true, note.message);
    // Nothing in this test addresses Meera except the private note.
    check("…and the report is not told", (await prisma.notification.count({ where: { userId: meera.userId!, createdAt: { gte: started } } })) === 0);

    section("A saved expense draft");
    await signInAs("meera.krishnan@acme.test");
    const meals = (await prisma.expenseCategory.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Meals" } })).id;
    const f = new FormData();
    f.set("title", "Smoke draft"); f.set("intent", "draft");
    f.set("categoryId_0", meals); f.set("expenseDate_0", new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)); f.set("amount_0", "320");
    await expenses.submitClaimAction({}, f);
    const draft = await prisma.expenseClaim.findFirstOrThrow({ where: { tenantId: tenant.id, employeeId: meera.id, title: "Smoke draft" } });
    made.claims.push(draft.id);
    check("A claim can be saved as a draft", draft.stage === "DRAFT");
    const sub = await expenses.claimOpAction({}, fd({ claimId: draft.id, op: "submit" }));
    check("…and submitted later, policy checked again", sub.ok === true && (await prisma.expenseClaim.findUniqueOrThrow({ where: { id: draft.id } })).stage === "SUBMITTED", sub.message);
    const twice = await expenses.claimOpAction({}, fd({ claimId: draft.id, op: "submit" }));
    check("A submitted claim cannot be submitted again", twice.ok === false, twice.message);
    await signInAs("aditya.verma@acme.test");
    const other = await expenses.claimOpAction({}, fd({ claimId: draft.id, op: "submit" }));
    check("Nobody submits someone else's draft", other.ok === false, other.message);

    section("Tax declarations");
    await signInAs("meera.krishnan@acme.test");
    const newRegime = await tax.addDeclarationItemAction({}, fd({ section: "80C", category: "PPF", amount: 50000 }));
    check("The new regime offers no 80C", newRegime.ok === false && /new tax regime/i.test(newRegime.message ?? ""), newRegime.message);
    await signInAs("ananya.ghosh@acme.test");
    const overCap = await tax.addDeclarationItemAction({}, fd({ section: "80C", category: "Smoke ELSS", amount: 10000 }));
    check("Past the ₹1.5 lakh 80C ceiling is refused", overCap.ok === false, overCap.message);
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { tenantId: tenant.id, status: "IN_PROGRESS" } });
    const tds = async () => { await svc.calculateRun(run.id); return Number((await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId: run.id, employeeId: ananya.id } } })).tds); };
    const tdsBefore = await tds();
    const nps = await tax.addDeclarationItemAction({}, fd({ section: "80CCD(1B)", category: "Smoke NPS tier 1", amount: 50000 }));
    const npsItem = await prisma.declarationItem.findFirst({ where: { category: "Smoke NPS tier 1", declaration: { employeeId: ananya.id } } });
    if (npsItem) made.items.push(npsItem.id);
    check("An NPS declaration within its own ceiling is accepted", nps.ok === true && !!npsItem, nps.message);
    const tdsWith = await tds();
    check("…and lowers this month's TDS in payroll", tdsWith < tdsBefore, `${tdsBefore} → ${tdsWith}`);
    const removed = await tax.removeDeclarationItemAction({}, fd({ itemId: npsItem!.id }));
    const tdsAfter = await tds();
    check("Removing it puts TDS back exactly", removed.ok === true && tdsAfter === tdsBefore, `${tdsWith} → ${tdsAfter}`);
    await signInAs("meera.krishnan@acme.test");
    const foreign = await tax.removeDeclarationItemAction({}, fd({ itemId: (await prisma.declarationItem.findFirstOrThrow({ where: { declaration: { employeeId: ananya.id } } })).id }));
    check("Nobody removes someone else's declaration", foreign.ok === false, foreign.message);
  } finally {
    await prisma.employee.update({ where: { id: meera.id }, data: { aboutMe: null } });
    await svc.recomputeProfileCompletion(meera.id);
    await prisma.praise.deleteMany({ where: { message: "Smoke praise" } });
    await prisma.feedback.deleteMany({ where: { message: { in: ["Smoke feedback", "Smoke note", "Smoke private note"] } } });
    await prisma.expenseClaim.deleteMany({ where: { id: { in: made.claims } } });
    await prisma.declarationItem.deleteMany({ where: { id: { in: made.items } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, OR: [{ summary: { contains: "Smoke" } }, { entityType: "InvestmentDeclaration" }] } });
    await purgeLedgerSince(prisma, tenant.id, started);
  }
  report("Self-service");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
