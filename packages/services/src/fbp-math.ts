import type { StructureComponentSpec } from "@keka/payroll";

/**
 * Flexible benefit plan arithmetic, kept pure so it can be tested alone.
 *
 * An employee splits part of their salary across the plan's reimbursement
 * components (fuel, telephone, meal card, ...). Each component has its own
 * annual cap, and the total cannot exceed the flexible amount available: the
 * balancing component (Special Allowance) the split is carved out of.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface FbpComponent { id: string; code: string; name: string; limit: number }

export function checkFbpSplit(o: { pool: number; components: FbpComponent[]; amounts: Record<string, number | null | undefined> }):
  { lines: Array<{ componentId: string; amount: number }>; total: number } | { error: string; field?: string } {
  const lines: Array<{ componentId: string; amount: number }> = [];
  for (const c of o.components) {
    const raw = o.amounts[c.id];
    if (raw === null || raw === undefined || raw === 0) continue;
    const amount = r2(raw);
    if (!Number.isFinite(amount) || amount < 0) return { error: `Enter an amount of zero or more for ${c.name}.`, field: c.id };
    if (amount > c.limit + 0.001) return { error: `${c.name} allows at most ₹${c.limit.toLocaleString("en-IN")} a year.`, field: c.id };
    lines.push({ componentId: c.id, amount });
  }
  const unknown = Object.keys(o.amounts).filter((id) => (o.amounts[id] ?? 0) !== 0 && !o.components.some((c) => c.id === id));
  if (unknown.length) return { error: "One of the components is not part of your plan." };
  const total = r2(lines.reduce((s, l) => s + l.amount, 0));
  if (total === 0) return { error: "Allot an amount to at least one component." };
  if (total > o.pool + 0.001) return { error: `The total of ₹${total.toLocaleString("en-IN")} is more than the ₹${o.pool.toLocaleString("en-IN")} available to you.` };
  return { lines, total };
}

/**
 * The declared split as structure rows: fixed monthly amounts inside the CTC,
 * so the balancing component shrinks by the same amount. The payroll engine
 * does not pay these rows; they are paid as and when they are claimed.
 */
export function fbpCarveSpecs(lines: Array<{ code: string; name: string; annual: number }>): StructureComponentSpec[] {
  return lines.filter((l) => l.annual > 0).map((l, i) => ({
    code: l.code, name: l.name, type: "REIMBURSEMENT", calculationType: "FIXED", fixedAmount: r2(l.annual / 12),
    sequence: 800 + i, isOutsideCtc: false, isLopApplicable: false, affectsPfWage: false, affectsEsiGross: false,
    showOnPayslip: false, isPartOfFbp: true,
  }));
}

/** What is left unclaimed across components: paid as taxable salary at year end. */
export function unclaimedFbp(rows: Array<{ accrued: number; claimed: number }>): number {
  return r2(rows.reduce((s, r) => s + Math.max(0, r.accrued - r.claimed), 0));
}
