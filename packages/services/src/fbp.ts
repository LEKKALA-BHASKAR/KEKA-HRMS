import { prisma } from "@keka/db";
import { resolveStructure } from "@keka/payroll";
import { fyRange, fyStartYear } from "@keka/shared";
import { revisionSpecs } from "./finances";
import { checkFbpSplit, type FbpComponent } from "./fbp-math";

/**
 * Flexible benefit plan declarations: an employee on a structure that is part
 * of the plan splits part of their Special Allowance across the plan's
 * reimbursement components for the year. Payroll carves the declared total
 * out of each month's salary (see calculateRun); the employee claims it back
 * against bills; anything unclaimed is paid as taxable salary in the last
 * month of the year. A declaration is locked once submitted, until payroll
 * reopens it.
 */

const n = (v: unknown) => Number(v ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface FbpPlan {
  fy: number;
  eligible: boolean;
  reason?: string;
  /** The flexible amount available a year: the balancing component. */
  pool: number;
  poolComponent?: string;
  components: Array<FbpComponent & { declared: number }>;
  declaration: { id: string; total: number; isLocked: boolean; submittedAt: Date } | null;
  /** Editable now: eligible, and not locked. */
  editable: boolean;
}

export async function fbpPlan(employeeId: string, today = new Date()): Promise<FbpPlan> {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { tenantId: true, payGroupId: true, status: true, tenant: { select: { fyStartMonth: true } } },
  });
  const fy = fyStartYear(today, emp.tenant.fyStartMonth);
  const [rev, components, decl] = await Promise.all([
    prisma.salaryRevision.findFirst({
      where: { employeeId, status: "APPLIED", effectiveFrom: { lte: today } },
      orderBy: { effectiveFrom: "desc" },
      include: { structure: { include: { components: { where: { isActive: true }, include: { component: true } } } } },
    }),
    emp.payGroupId
      ? prisma.salaryComponent.findMany({
          where: { tenantId: emp.tenantId, type: "REIMBURSEMENT", isPartOfFbp: true, isActive: true, annualExemptLimit: { gt: 0 }, payGroupLinks: { some: { payGroupId: emp.payGroupId } } },
          orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
          select: { id: true, code: true, name: true, annualExemptLimit: true },
        })
      : Promise.resolve([]),
    prisma.fbpDeclaration.findUnique({ where: { employeeId_fyStartYear: { employeeId, fyStartYear: fy } }, include: { lines: true } }),
  ]);
  const declared = new Map((decl?.lines ?? []).map((l) => [l.componentId, n(l.annualAmount)]));
  const rows = components.map((c) => ({ id: c.id, code: c.code, name: c.name, limit: n(c.annualExemptLimit), declared: declared.get(c.id) ?? 0 }));
  const base: Omit<FbpPlan, "eligible" | "pool" | "editable"> = {
    fy, components: rows,
    declaration: decl ? { id: decl.id, total: n(decl.totalAmount), isLocked: decl.isLocked, submittedAt: decl.submittedAt } : null,
  };
  const no = (reason: string): FbpPlan => ({ ...base, eligible: false, reason, pool: 0, editable: false });
  if (emp.status === "EXITED") return no("The plan closes when you leave.");
  if (!rev?.structure) return no("You do not have a salary structure yet.");
  if (!rev.structure.isPartOfFbp) return no("Your salary structure is not part of the flexible benefit plan.");
  if (rows.length === 0) return no("No reimbursement components are set up under the plan for your pay group.");
  // The pool is the balancing component before any carve-out.
  const specs = revisionSpecs(rev as never).filter((s) => !(s.type === "REIMBURSEMENT" && s.isPartOfFbp));
  const balance = specs.find((s) => s.calculationType === "BALANCE");
  if (!balance) return no("Your salary structure has no balancing component to draw the plan from.");
  const resolved = resolveStructure({ annualCtc: n(rev.annualCtc), components: specs, roundComponents: rev.structure.roundComponents });
  const pool = r2(n(resolved.byCode.get(balance.code.toUpperCase())?.annual));
  return { ...base, eligible: pool > 0, reason: pool > 0 ? undefined : "There is no flexible amount left in your salary.", pool, poolComponent: balance.name, editable: pool > 0 && !(decl?.isLocked ?? false) };
}

export async function saveFbpDeclaration(employeeId: string, amounts: Record<string, number | null>, today = new Date()):
  Promise<{ ok: boolean; message: string; field?: string }> {
  const plan = await fbpPlan(employeeId, today);
  if (!plan.eligible) return { ok: false, message: plan.reason ?? "You cannot declare under the plan." };
  if (plan.declaration?.isLocked) return { ok: false, message: "Your declaration for this year is locked. Ask the payroll team to reopen it." };
  const checked = checkFbpSplit({ pool: plan.pool, components: plan.components, amounts });
  if ("error" in checked) return { ok: false, message: checked.error, field: checked.field };
  await prisma.$transaction(async (tx) => {
    const d = await tx.fbpDeclaration.upsert({
      where: { employeeId_fyStartYear: { employeeId, fyStartYear: plan.fy } },
      create: { employeeId, fyStartYear: plan.fy, totalAmount: checked.total },
      update: { totalAmount: checked.total, isLocked: true, submittedAt: new Date() },
    });
    await tx.fbpDeclarationLine.deleteMany({ where: { declarationId: d.id } });
    await tx.fbpDeclarationLine.createMany({ data: checked.lines.map((l) => ({ declarationId: d.id, componentId: l.componentId, annualAmount: l.amount })) });
  });
  return { ok: true, message: `Declared ₹${checked.total.toLocaleString("en-IN")} a year under the plan. It is taken out of your ${plan.poolComponent ?? "Special Allowance"} from the next payroll, and you claim it back against bills.` };
}

/** Payroll reopens a locked declaration so the employee can change it. */
export async function reopenFbpDeclaration(tenantId: string, declarationId: string): Promise<{ ok: boolean; message: string; employeeUserId?: string | null }> {
  const d = await prisma.fbpDeclaration.findFirst({ where: { id: declarationId, employee: { tenantId } }, include: { employee: { select: { displayName: true, userId: true, tenant: { select: { fyStartMonth: true } } } } } });
  if (!d) return { ok: false, message: "That declaration was not found." };
  if (!d.isLocked) return { ok: false, message: "It is already open." };
  const { end } = fyRange(d.fyStartYear, d.employee.tenant.fyStartMonth);
  if (end < new Date()) return { ok: false, message: "That year has ended." };
  await prisma.fbpDeclaration.update({ where: { id: d.id }, data: { isLocked: false } });
  return { ok: true, message: `Reopened ${d.employee.displayName}'s declaration.`, employeeUserId: d.employee.userId };
}
