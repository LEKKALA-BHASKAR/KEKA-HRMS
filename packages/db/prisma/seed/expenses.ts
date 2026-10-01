import type { PrismaClient } from "@prisma/client";

/**
 * Expenses seed: categories with limits and receipt rules, a policy that
 * escalates large claims to finance, claims at every stage, an advance part
 * settled by a claim, and trips through the travel desk — via the services,
 * with dates relative to today so the 60-day rule holds.
 */
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - d * DAY);

export async function seedExpenses(prisma: PrismaClient, ctx: { tenantId: string; empIdByNumber: Map<string, string> }) {
  const svc = await import("@keka/services");
  const t = ctx.tenantId, id = (n: string) => ctx.empIdByNumber.get(n)!;
  const cats: Record<string, string> = {};
  for (const [name, max, receipt] of [["Flights", 25000, 0], ["Hotel", 6000, 0], ["Local conveyance", 2000, 500], ["Meals", 1500, 500], ["Internet & phone", 1000, 300], ["Client entertainment", 10000, 0]] as const) {
    cats[name] = (await prisma.expenseCategory.create({ data: { tenantId: t, name, maxAmount: max, receiptRequiredAbove: receipt } })).id;
  }
  await prisma.expensePolicy.create({ data: { tenantId: t, name: "Standard", isDefault: true, escalationAboveAmount: 25000, categories: { create: [{ categoryId: cats["Hotel"], maxAmount: 5000 }] } } });
  const receipt = "/files/seed-receipt"; // stands in for an uploaded file in demo data
  const vikram = await prisma.user.findFirstOrThrow({ where: { tenantId: t, email: "vikram.menon@acme.test" } });

  // An advance for Sneha's client visit, disbursed and then part-settled.
  await svc.requestAdvance({ employeeId: id("ACM0005"), amount: 15000, purpose: "Client visit to Mumbai", neededBy: ago(-2) });
  const adv = await prisma.cashAdvance.findFirstOrThrow({ where: { employeeId: id("ACM0005") } });
  await svc.advanceOp(adv.id, "approve", vikram.id);
  await svc.advanceOp(adv.id, "disburse", vikram.id);

  const claims: Array<[string, string, Array<[string, number, number, string]>, string | null, "draft" | "submit" | "approve" | "escalate"]> = [
    ["ACM0009", "Conference — Bengaluru", [["Local conveyance", 3, 640, "Uber"], ["Meals", 3, 820, "Toit"]], null, "submit"],
    ["ACM0012", "Late-night release travel", [["Local conveyance", 10, 1450, "Ola"]], null, "approve"],
    ["ACM0005", "Client visit, Mumbai", [["Flights", 12, 8900, "IndiGo"], ["Hotel", 11, 5600, "Trident"], ["Meals", 11, 1300, "Hotel"]], "advance", "approve"],
    ["ACM0006", "Customer workshop, Pune", [["Flights", 20, 11200, "Vistara"], ["Hotel", 19, 4800, "Marriott"], ["Client entertainment", 19, 9500, "JW Kitchen"]], null, "escalate"],
    ["ACM0014", "Home broadband — Sep", [["Internet & phone", 5, 999, "ACT Fibernet"]], null, "draft"],
  ];
  let n = 0;
  for (const [num, title, lines, useAdvance, stage] of claims) {
    const r = await svc.createClaim({
      employeeId: id(num), title, advanceId: useAdvance ? adv.id : null, submit: stage !== "draft",
      lines: lines.map(([cat, d, amount, merchant]) => ({ categoryId: cats[cat], expenseDate: ago(d), amount, merchant, receiptUrl: amount > 0 ? receipt : null })),
    });
    if (!r.ok) throw new Error(`Seeding claim ${title}: ${r.message}`);
    n++;
    if (stage === "approve" || stage === "escalate") {
      await svc.decideClaim({ claimId: r.claimId!, level: "MANAGER", approve: true, byUserId: vikram.id });
    }
  }

  // Trips at each stage of the travel desk.
  for (const [num, from, to, depart, back, status] of [["ACM0008", "Bengaluru", "Delhi", -6, -8, "REQUESTED"], ["ACM0015", "Bengaluru", "Hyderabad", -3, -4, "APPROVED"], ["ACM0005", "Bengaluru", "Mumbai", -1, -3, "BOOKED"]] as const) {
    await svc.requestTrip({ employeeId: id(num), purpose: `Customer meetings in ${to}`, fromCity: from, toCity: to, departDate: ago(depart), returnDate: ago(back), travelType: "DOMESTIC", needsAccommodation: true, estimatedCost: 18000 });
    const trip = await prisma.travelRequest.findFirstOrThrow({ where: { employeeId: id(num), toCity: to } });
    if (status !== "REQUESTED") await svc.tripOp(trip.id, "approve", vikram.id);
    if (status === "BOOKED") await svc.tripOp(trip.id, "book", vikram.id, { bookingRef: "6E-PNR4XK2Q", actualCost: 16450 });
  }
  return { claims: n, categories: Object.keys(cats).length };
}
