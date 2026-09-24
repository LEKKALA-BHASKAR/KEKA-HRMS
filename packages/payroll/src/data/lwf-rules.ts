/**
 * Labour Welfare Fund reference data.
 *
 * LWF is a state levy with wildly inconsistent shapes — some states collect
 * monthly, some half-yearly in June and December, some once a year in
 * December — and contribution amounts are small flat figures rather than
 * percentages. A handful of states have no LWF scheme at all.
 *
 * VERIFY BEFORE GO-LIVE, same caveat as the PT slabs. These rows seed the
 * `lwf_rules` table and are effective-dated.
 */

export type LwfFrequencyLiteral = "MONTHLY" | "HALF_YEARLY" | "ANNUAL";

export interface LwfRuleSeed {
  stateCode: string;
  stateName: string;
  frequency: LwfFrequencyLiteral;
  /** Months in which the contribution is deducted, 1-12. */
  deductionMonths: number[];
  employeeAmount: number;
  employerAmount: number;
  /** Only employees at or below this monthly gross contribute, where applicable. */
  wageLimit?: number | null;
  note?: string;
}

/** States with no labour welfare fund scheme. */
export const NO_LWF_STATES = [
  "AS", "BR", "JH", "UP", "UK", "RJ", "JK", "AR", "MN", "ML", "MZ", "NL",
  "TR", "SK", "AN", "LA", "DH",
] as const;

export const LWF_RULES: LwfRuleSeed[] = [
  { stateCode: "KA", stateName: "Karnataka", frequency: "ANNUAL", deductionMonths: [12], employeeAmount: 20, employerAmount: 40 },
  { stateCode: "TN", stateName: "Tamil Nadu", frequency: "ANNUAL", deductionMonths: [12], employeeAmount: 20, employerAmount: 40 },
  { stateCode: "AP", stateName: "Andhra Pradesh", frequency: "ANNUAL", deductionMonths: [12], employeeAmount: 30, employerAmount: 70 },
  { stateCode: "TS", stateName: "Telangana", frequency: "ANNUAL", deductionMonths: [12], employeeAmount: 2, employerAmount: 5 },
  { stateCode: "MH", stateName: "Maharashtra", frequency: "HALF_YEARLY", deductionMonths: [6, 12], employeeAmount: 12, employerAmount: 36, note: "Employees earning up to 3,000/month contribute 6 with an employer share of 18" },
  { stateCode: "GJ", stateName: "Gujarat", frequency: "HALF_YEARLY", deductionMonths: [6, 12], employeeAmount: 6, employerAmount: 12 },
  { stateCode: "WB", stateName: "West Bengal", frequency: "HALF_YEARLY", deductionMonths: [6, 12], employeeAmount: 3, employerAmount: 15 },
  { stateCode: "MP", stateName: "Madhya Pradesh", frequency: "HALF_YEARLY", deductionMonths: [6, 12], employeeAmount: 10, employerAmount: 30 },
  { stateCode: "CG", stateName: "Chhattisgarh", frequency: "HALF_YEARLY", deductionMonths: [6, 12], employeeAmount: 15, employerAmount: 45 },
  { stateCode: "OR", stateName: "Odisha", frequency: "HALF_YEARLY", deductionMonths: [6, 12], employeeAmount: 10, employerAmount: 20 },
  { stateCode: "DL", stateName: "Delhi", frequency: "HALF_YEARLY", deductionMonths: [6, 12], employeeAmount: 0.75, employerAmount: 2.25 },
  { stateCode: "GA", stateName: "Goa", frequency: "HALF_YEARLY", deductionMonths: [6, 12], employeeAmount: 60, employerAmount: 180 },
  { stateCode: "HR", stateName: "Haryana", frequency: "MONTHLY", deductionMonths: [1,2,3,4,5,6,7,8,9,10,11,12], employeeAmount: 31, employerAmount: 62 },
  { stateCode: "PB", stateName: "Punjab", frequency: "MONTHLY", deductionMonths: [1,2,3,4,5,6,7,8,9,10,11,12], employeeAmount: 5, employerAmount: 20 },
  { stateCode: "CH", stateName: "Chandigarh", frequency: "MONTHLY", deductionMonths: [1,2,3,4,5,6,7,8,9,10,11,12], employeeAmount: 5, employerAmount: 20 },
  { stateCode: "KL", stateName: "Kerala", frequency: "MONTHLY", deductionMonths: [1,2,3,4,5,6,7,8,9,10,11,12], employeeAmount: 50, employerAmount: 50 },
];

export const LWF_STATES = LWF_RULES.map((r) => r.stateCode);
