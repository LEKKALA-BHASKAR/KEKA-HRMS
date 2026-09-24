import {
  Decimal, money, nonNegative, roundRupees, clamp, type Numeric,
} from "@keka/shared";
import { evaluateFormula, topologicalOrder } from "./formula";

/**
 * Salary structure resolution — turning an annual CTC into monthly component
 * amounts.
 *
 * THE UNIT RULE, which everything downstream depends on:
 *   every formula produces a MONTHLY amount.
 *
 * The evaluation context exposes both bases so formulas can be written
 * either way without ambiguity:
 *
 *   [CTC]            annual cost to company
 *   [CTC_ANNUAL]     same
 *   [CTC_MONTHLY]    CTC / 12
 *   [BASIC]          Basic, monthly
 *   [BASIC_ANNUAL]   Basic x 12
 *   [GROSS]          running total of earnings resolved so far, monthly
 *
 * So "PF = 12% of Basic Annual" is written [BASIC] * 0.12 for the monthly
 * figure, or [BASIC_ANNUAL] * 0.12 / 12 if you prefer to spell it out.
 */

export type ComponentTypeLiteral =
  | "EARNING" | "DEDUCTION" | "EMPLOYER_CONTRIBUTION" | "REIMBURSEMENT" | "PERK";

export type CalculationTypeLiteral = "FIXED" | "PERCENTAGE" | "FORMULA" | "BALANCE";

export interface StructureComponentSpec {
  code: string;
  name: string;
  type: ComponentTypeLiteral;
  calculationType: CalculationTypeLiteral;
  formula?: string | null;
  fixedAmount?: Numeric | null;
  percentage?: Numeric | null;
  percentageOf?: string | null;
  sequence?: number;
  minAmount?: Numeric | null;
  maxAmount?: Numeric | null;
  /** Components outside the CTC do not consume the BALANCE pool. */
  isOutsideCtc?: boolean;
  isLopApplicable?: boolean;
  affectsPfWage?: boolean;
  affectsEsiGross?: boolean;
  showOnPayslip?: boolean;
  isPartOfFbp?: boolean;
}

export interface ResolveStructureInput {
  annualCtc: Numeric;
  components: StructureComponentSpec[];
  /** Round each component to whole rupees. */
  roundComponents?: boolean;
  /** Extra values injected into the formula context, e.g. AGE or TENURE. */
  extraContext?: Record<string, Numeric>;
}

export interface ResolvedComponent {
  code: string;
  name: string;
  type: ComponentTypeLiteral;
  /** Monthly entitlement at full attendance. */
  monthly: Decimal;
  annual: Decimal;
  isOutsideCtc: boolean;
  isLopApplicable: boolean;
  affectsPfWage: boolean;
  affectsEsiGross: boolean;
  showOnPayslip: boolean;
  isPartOfFbp: boolean;
  sequence: number;
}

export interface ResolvedStructure {
  components: ResolvedComponent[];
  byCode: Map<string, ResolvedComponent>;
  monthlyGross: Decimal;
  monthlyDeductions: Decimal;
  monthlyEmployerContributions: Decimal;
  /** Sum of everything inside CTC, monthly. */
  monthlyCtcValue: Decimal;
  annualCtc: Decimal;
  /** Difference between the configured CTC and what the structure adds up to. */
  reconciliationGap: Decimal;
  warnings: string[];
}

export function resolveStructure(input: ResolveStructureInput): ResolvedStructure {
  const warnings: string[] = [];
  const annualCtc = nonNegative(input.annualCtc);
  const monthlyCtc = annualCtc.dividedBy(12);
  const round = input.roundComponents !== false;

  // Balance components absorb the remainder, so they must evaluate last no
  // matter where they sit in the configured sequence.
  const balanceComponents = input.components.filter((c) => c.calculationType === "BALANCE");
  const normalComponents = input.components.filter((c) => c.calculationType !== "BALANCE");

  if (balanceComponents.length > 1) {
    warnings.push(
      `${balanceComponents.length} components are set to BALANCE; only "${balanceComponents[0].code}" will absorb the remainder`,
    );
  }

  // Order by dependency, then by the configured sequence as a tie-break.
  const { order, cycles } = topologicalOrder(
    normalComponents.map((c) => ({ code: c.code, formula: c.formula })),
  );
  if (cycles.length > 0) {
    warnings.push(
      `Circular reference between components: ${cycles.join(", ")}. These resolve to zero.`,
    );
  }

  const specByCode = new Map(
    normalComponents.map((c) => [c.code.toUpperCase(), c]),
  );

  // Formula evaluation context. Rebuilt as each component resolves so later
  // formulas can reference earlier results.
  const ctx: Record<string, Decimal> = {
    CTC: annualCtc,
    CTC_ANNUAL: annualCtc,
    CTC_MONTHLY: monthlyCtc,
    GROSS: new Decimal(0),
    ...Object.fromEntries(
      Object.entries(input.extraContext ?? {}).map(([k, v]) => [k.toUpperCase(), money(v)]),
    ),
  };

  const resolved: ResolvedComponent[] = [];

  const evaluateOne = (spec: StructureComponentSpec): Decimal => {
    switch (spec.calculationType) {
      case "FIXED":
        return money(spec.fixedAmount);
      case "PERCENTAGE": {
        const baseCode = (spec.percentageOf ?? "CTC_MONTHLY").toUpperCase();
        const base = ctx[baseCode] ?? new Decimal(0);
        if (!ctx[baseCode]) {
          warnings.push(
            `"${spec.code}" is a percentage of "${baseCode}", which has no value yet`,
          );
        }
        return base.times(money(spec.percentage)).dividedBy(100);
      }
      case "FORMULA":
        return evaluateFormula(spec.formula ?? "0", { values: ctx });
      default:
        return new Decimal(0);
    }
  };

  const push = (spec: StructureComponentSpec, rawMonthly: Decimal) => {
    let monthly = clamp(rawMonthly, spec.minAmount, spec.maxAmount);
    if (round) monthly = roundRupees(monthly);
    monthly = nonNegative(monthly);

    const entry: ResolvedComponent = {
      code: spec.code.toUpperCase(),
      name: spec.name,
      type: spec.type,
      monthly,
      annual: monthly.times(12),
      isOutsideCtc: spec.isOutsideCtc ?? false,
      isLopApplicable: spec.isLopApplicable ?? true,
      affectsPfWage: spec.affectsPfWage ?? false,
      affectsEsiGross: spec.affectsEsiGross ?? spec.type === "EARNING",
      showOnPayslip: spec.showOnPayslip ?? true,
      isPartOfFbp: spec.isPartOfFbp ?? false,
      sequence: spec.sequence ?? 0,
    };

    resolved.push(entry);
    ctx[entry.code] = monthly;
    ctx[`${entry.code}_ANNUAL`] = entry.annual;
    if (entry.type === "EARNING") {
      ctx.GROSS = (ctx.GROSS ?? new Decimal(0)).plus(monthly);
    }
  };

  for (const code of order) {
    const spec = specByCode.get(code);
    if (!spec) continue;
    push(spec, evaluateOne(spec));
  }
  // Anything the topological pass missed (a component in a cycle) still needs
  // a row, at zero, so the payslip shows the gap rather than hiding it.
  for (const spec of normalComponents) {
    if (!resolved.some((r) => r.code === spec.code.toUpperCase())) {
      push(spec, new Decimal(0));
    }
  }

  // --- BALANCE: absorb whatever is left of the monthly CTC ----------------
  if (balanceComponents.length > 0) {
    const spec = balanceComponents[0];
    const consumed = resolved
      .filter((c) => !c.isOutsideCtc)
      .reduce((sum, c) => {
        // Employee-side deductions are funded out of gross, so they do not
        // consume CTC a second time. Employer contributions do.
        if (c.type === "DEDUCTION") return sum;
        return sum.plus(c.monthly);
      }, new Decimal(0));

    const remainder = monthlyCtc.minus(consumed);
    if (remainder.isNegative()) {
      warnings.push(
        `Configured components exceed the CTC by ${remainder.abs().toFixed(2)}/month; "${spec.code}" is set to zero`,
      );
    }
    push(spec, nonNegative(remainder));

    // Any further BALANCE components get a zero row rather than double-dipping.
    for (const extra of balanceComponents.slice(1)) push(extra, new Decimal(0));
  }

  resolved.sort((a, b) => a.sequence - b.sequence || a.code.localeCompare(b.code));

  const monthlyGross = resolved
    .filter((c) => c.type === "EARNING")
    .reduce((s, c) => s.plus(c.monthly), new Decimal(0));
  const monthlyDeductions = resolved
    .filter((c) => c.type === "DEDUCTION")
    .reduce((s, c) => s.plus(c.monthly), new Decimal(0));
  const monthlyEmployerContributions = resolved
    .filter((c) => c.type === "EMPLOYER_CONTRIBUTION")
    .reduce((s, c) => s.plus(c.monthly), new Decimal(0));

  const monthlyCtcValue = resolved
    .filter((c) => !c.isOutsideCtc && c.type !== "DEDUCTION")
    .reduce((s, c) => s.plus(c.monthly), new Decimal(0));

  const reconciliationGap = monthlyCtc.minus(monthlyCtcValue);
  if (reconciliationGap.abs().greaterThan(1)) {
    warnings.push(
      `Structure totals ${monthlyCtcValue.toFixed(2)}/month against a CTC of ${monthlyCtc.toFixed(2)} — a gap of ${reconciliationGap.toFixed(2)}`,
    );
  }

  return {
    components: resolved,
    byCode: new Map(resolved.map((c) => [c.code, c])),
    monthlyGross,
    monthlyDeductions,
    monthlyEmployerContributions,
    monthlyCtcValue,
    annualCtc,
    reconciliationGap,
    warnings,
  };
}

/**
 * Pick the structure whose annual-CTC range contains this salary.
 * Used by range-based structures.
 */
export function selectStructureForCtc<T extends { minAnnualCtc?: Numeric | null; maxAnnualCtc?: Numeric | null; isDefault?: boolean }>(
  structures: T[],
  annualCtc: Numeric,
): T | undefined {
  const ctc = money(annualCtc);
  const inRange = structures.find((s) => {
    const min = s.minAnnualCtc != null ? money(s.minAnnualCtc) : null;
    const max = s.maxAnnualCtc != null ? money(s.maxAnnualCtc) : null;
    if (min && ctc.lessThan(min)) return false;
    if (max && ctc.greaterThan(max)) return false;
    return min !== null || max !== null;
  });
  return inRange ?? structures.find((s) => s.isDefault) ?? structures[0];
}
