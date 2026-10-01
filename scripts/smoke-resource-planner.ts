/**
 * PSA resource planner: billing roles, hard allocations capped at 100% on any
 * day, soft allocations that may overlap but cannot be confirmed past 100%,
 * requests filled from the bench (closing when full) or sent to hiring, the
 * weekly grid and per-person utilisation. Employees without resource rights
 * are refused. Fixtures use the "Smoke Role" billing role and are removed.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}

async function main() {
  const act = await import("../apps/web/src/app/actions/psa-resources");
  const psa = await import("../packages/services/src/psa");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const project = await prisma.project.findFirstOrThrow({ where: { tenantId: tenant.id, status: "ACTIVE", billingModel: { not: "NON_BILLABLE" } } });
  // Someone with no allocations at all, far in the future so nothing else overlaps.
  const start = new Date(Date.UTC(2031, 0, 6)); // a Monday
  const end = new Date(start.getTime() + 27 * DAY);
  const [a, b] = await prisma.employee.findMany({ where: { tenantId: tenant.id, status: "CONFIRMED", projectAllocations: { none: {} } }, take: 2, select: { id: true, displayName: true } });
  if (!a || !b) throw new Error("Need two unallocated employees");
  const hadProfile = !!(await prisma.resourceProfile.findUnique({ where: { employeeId: b.id } }));
  const cleanup = async () => {
    const reqs = await prisma.resourceRequest.findMany({ where: { tenantId: tenant.id, billingRole: { name: "Smoke Role" } }, select: { id: true, requisitionId: true } });
    await prisma.resourceAllocation.deleteMany({ where: { OR: [{ billingRole: "Smoke Role" }, { requestId: { in: reqs.map((r) => r.id) } }] } });
    await prisma.resourceRequest.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } });
    await prisma.requisition.deleteMany({ where: { id: { in: reqs.map((r) => r.requisitionId).filter((x): x is string => !!x) } } });
    await prisma.billingRole.deleteMany({ where: { tenantId: tenant.id, name: "Smoke Role" } });
  };
  await cleanup();
  const alloc = (employeeId: string, pct: number, kind: "HARD" | "SOFT", from = start, to: Date | null = end, extra: Record<string, string> = {}) =>
    act.planAllocationAction({}, fd({ projectId: project.id, employeeId, billingRole: "Smoke Role", allocationPercent: pct, billRate: 1500, startDate: iso(from), endDate: to ? iso(to) : "", kind, ...extra }));
  try {
    section("Access");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot allocate", await denied(() => alloc(a.id, 50, "HARD")));
    check("An employee cannot add billing roles", await denied(() => act.saveBillingRoleAction({}, fd({ name: "Smoke Role" }))));

    section("Allocations");
    await signInAs("vikram.menon@acme.test");
    const role = await act.saveBillingRoleAction({}, fd({ name: "Smoke Role", description: "Test" }));
    check("A billing role is added", role.ok === true, role.message);
    const dup = await act.saveBillingRoleAction({}, fd({ name: "Smoke Role" }));
    check("…and cannot be added twice", dup.ok === false);
    const h1 = await alloc(a.id, 60, "HARD");
    check("A hard allocation at 60% is made", h1.ok === true, h1.message);
    const other = await prisma.project.findFirstOrThrow({ where: { tenantId: tenant.id, status: "ACTIVE", billingModel: { not: "NON_BILLABLE" }, NOT: { id: project.id } } });
    const over = await act.planAllocationAction({}, fd({ projectId: other.id, employeeId: a.id, billingRole: "Smoke Role", allocationPercent: 50, billRate: 1500, startDate: iso(new Date(start.getTime() + 7 * DAY)), endDate: "", kind: "HARD" }));
    check("A second hard allocation past 100% is refused", over.ok === false && /110%/.test(over.message ?? ""), over.message);
    const soft = await act.planAllocationAction({}, fd({ projectId: other.id, employeeId: a.id, billingRole: "Smoke Role", allocationPercent: 50, billRate: 1500, startDate: iso(new Date(start.getTime() + 7 * DAY)), endDate: iso(end), kind: "SOFT" }));
    check("…but a soft one may overlap", soft.ok === true, soft.message);
    const softRow = await prisma.resourceAllocation.findFirstOrThrow({ where: { employeeId: a.id, projectId: other.id, kind: "SOFT" } });
    const confirm = await act.allocationOpAction({}, fd({ id: softRow.id, op: "confirm" }));
    check("Confirming the soft one is refused while it would pass 100%", confirm.ok === false, confirm.message);
    const noRate = await act.planAllocationAction({}, fd({ projectId: project.id, employeeId: b.id, billingRole: "Smoke Role", allocationPercent: 20, startDate: iso(start), kind: "HARD" }));
    check("A billable allocation needs a bill rate", noRate.ok === false);

    section("Planner grid");
    const weeks = psa.planWeeks(start, 4);
    const people = await psa.plannerResources(tenant.id, weeks[0]!, new Date(weeks[3]!.getTime() + 6 * DAY));
    const pa = people.find((p) => p.id === a.id)!;
    const load = psa.weeklyLoad(pa.allocations, weeks, pa.capacity);
    check("The grid shows 60% hard each week", load.every((l) => l.hard === 60), JSON.stringify(load));
    check("…and the soft 50% from week two", load[0]!.soft === 0 && load[1]!.soft === 50, JSON.stringify(load));
    const bench = psa.benchFor(people, 50, start, end);
    check("The bench offers the free person, not the one at 60%", bench.some((p) => p.id === b.id) && !bench.some((p) => p.id === a.id));

    section("Requests");
    const roleRow = await prisma.billingRole.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke Role" } });
    const raise = await act.raiseRequestAction({}, fd({ projectId: project.id, type: "ROLE", billingRoleId: roleRow.id, count: 1, allocationPercent: 50, startDate: iso(start), endDate: iso(end), skills: "react, node", priority: "HIGH" }));
    check("A request is raised", raise.ok === true, raise.message);
    const req = await prisma.resourceRequest.findFirstOrThrow({ where: { tenantId: tenant.id, billingRoleId: roleRow.id, status: "OPEN" } });
    check("…with its skills", req.skills.join(",") === "react,node");
    const fill = await alloc(b.id, 50, "HARD", start, end, { requestId: req.id });
    check("Allocating from the request works", fill.ok === true, fill.message);
    check("…and closes it once full", (await prisma.resourceRequest.findUniqueOrThrow({ where: { id: req.id } })).status === "ALLOCATED");
    const raise2 = await act.raiseRequestAction({}, fd({ projectId: project.id, type: "ROLE", billingRoleId: roleRow.id, count: 2, allocationPercent: 100, startDate: iso(start) }));
    check("A second request is raised", raise2.ok === true);
    const req2 = await prisma.resourceRequest.findFirstOrThrow({ where: { tenantId: tenant.id, billingRoleId: roleRow.id, status: "OPEN" } });
    const noReason = await act.requestOpAction({}, fd({ id: req2.id, op: "reject", reason: "" }));
    check("Rejecting needs a reason", noReason.ok === false);
    const hire = await act.requestOpAction({}, fd({ id: req2.id, op: "hire" }));
    const after = await prisma.resourceRequest.findUniqueOrThrow({ where: { id: req2.id } });
    check("Sending to hiring raises a draft requisition", hire.ok === true && after.status === "HIRING" && !!after.requisitionId && (await prisma.requisition.findUniqueOrThrow({ where: { id: after.requisitionId! } })).status === "DRAFT", hire.message);

    section("Cost and utilisation");
    const prof = await act.saveResourceProfileAction({}, fd({ employeeId: b.id, costType: "MONTHLY", costAmount: 104000, targetUtilization: 80, cap0: 0, cap1: 8, cap2: 8, cap3: 8, cap4: 8, cap5: 8, cap6: 0 }));
    const p = await prisma.resourceProfile.findUniqueOrThrow({ where: { employeeId: b.id } });
    check("Cost and capacity save, with an hourly cost", prof.ok === true && Number(p.hourlyCost) === 600, `${prof.message} ${p.hourlyCost}`);
    const rows = await psa.utilisationByPerson(tenant.id, start, end);
    const ub = rows.find((r) => r.id === b.id);
    check("Utilisation lists the allocated person with planned hours", !!ub && ub.planned === 80 && ub.capacity === 160 && ub.target === 80, JSON.stringify(ub));

    section("Removing");
    const h1row = await prisma.resourceAllocation.findFirstOrThrow({ where: { employeeId: a.id, projectId: project.id, kind: "HARD" } });
    const rm = await act.allocationOpAction({}, fd({ id: h1row.id, op: "remove" }));
    check("An allocation with no time logged can be removed", rm.ok === true && !(await prisma.resourceAllocation.findUnique({ where: { id: h1row.id } })));
    const conf2 = await act.allocationOpAction({}, fd({ id: softRow.id, op: "confirm" }));
    check("…after which the soft one can be confirmed", conf2.ok === true && (await prisma.resourceAllocation.findUniqueOrThrow({ where: { id: softRow.id } })).kind === "HARD", conf2.message);
  } finally {
    await cleanup();
    if (!hadProfile) await prisma.resourceProfile.deleteMany({ where: { employeeId: b.id } });
    await prisma.$disconnect();
  }
  report("Resource planner");
}

main().catch((e) => { console.error(e); process.exit(1); });
