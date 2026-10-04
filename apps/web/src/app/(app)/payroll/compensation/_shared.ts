import { parseMeritMatrix, type CompGuardrails, type CompEligibility } from "@keka/services";
import type { FieldSpec } from "@/components/growth-forms";

export const PLAN_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { DRAFT: "neutral", PLANNING: "info", CALIBRATION: "info", PENDING_APPROVAL: "warning", APPROVED: "success", APPLIED: "success", REJECTED: "danger" };

/** Merit bands back to the "min-max:pct" text the form takes. */
export function matrixText(json: unknown): string {
  return parseMeritMatrix(json).map((b) => `${b.minRating}-${b.maxRating}:${b.pct}`).join(", ");
}

/** The settings fields shared by templates, new plans and plan settings. */
export function settingsFields(s: { meritMatrix?: unknown; defaultPct?: unknown; budgetPct?: unknown; prorate?: boolean; guardrails?: unknown; eligibility?: unknown } | null): FieldSpec[] {
  const g = (s?.guardrails ?? {}) as CompGuardrails;
  const e = (s?.eligibility ?? {}) as CompEligibility;
  return [
    { name: "meritMatrix", label: "Merit matrix (rating range : %)", required: true, wide: true, placeholder: "1-1.99:0, 2-2.99:4, 3-3.99:8, 4-5:12", defaultValue: s ? matrixText(s.meritMatrix) : "1-1.99:0, 2-2.99:4, 3-3.99:8, 4-5:12" },
    { name: "defaultPct", label: "Unrated employees get %", type: "number", required: true, defaultValue: s?.defaultPct !== undefined ? Number(s.defaultPct) : 3 },
    { name: "budgetPct", label: "Budget (% of payroll)", type: "number", required: true, defaultValue: s?.budgetPct !== undefined ? Number(s.budgetPct) : 8 },
    { name: "minPct", label: "Guardrail: min total %", type: "number", defaultValue: g.minPct ?? null },
    { name: "maxPct", label: "Guardrail: max total %", type: "number", defaultValue: g.maxPct ?? 20 },
    { name: "reasonAbovePct", label: "Note required above %", type: "number", defaultValue: g.reasonAbovePct ?? 12 },
    { name: "maxPromotionPct", label: "Max promotion %", type: "number", defaultValue: g.maxPromotionPct ?? 15 },
    { name: "minTenureDays", label: "Min tenure (days)", type: "number", defaultValue: e.minTenureDays ?? 90 },
    { name: "monthsSinceLastIncrease", label: "Months since last increase", type: "number", defaultValue: e.monthsSinceLastIncrease ?? null },
    { name: "prorate", label: "Prorate merit for joiners in the period", type: "checkbox", defaultChecked: s?.prorate ?? true },
    { name: "excludeProbation", label: "Leave out employees on probation", type: "checkbox", defaultChecked: e.excludeProbation ?? true },
    { name: "excludeNotice", label: "Leave out employees serving notice", type: "checkbox", defaultChecked: e.excludeNotice ?? true },
  ];
}

