/**
 * The global salary-component repository.
 *
 * Step 1 of the documented three-step flow:
 *   global repository -> assign to pay group -> include in a structure.
 */

export interface ComponentSeed {
  code: string;
  name: string;
  type: "EARNING" | "DEDUCTION" | "EMPLOYER_CONTRIBUTION" | "REIMBURSEMENT" | "PERK";
  calculationType: "FIXED" | "PERCENTAGE" | "FORMULA" | "BALANCE";
  taxTreatment: "FULLY_TAXABLE" | "PARTIALLY_EXEMPT" | "FULLY_EXEMPT";
  isRecurring: boolean;
  isSystem?: boolean;
  isPartOfFbp?: boolean;
  isOutsideCtc?: boolean;
  isLopApplicable?: boolean;
  isArrearApplicable?: boolean;
  affectsPfWage?: boolean;
  affectsEsiGross?: boolean;
  annualExemptLimit?: number;
  taxSection?: string;
  displayOrder: number;
}

export const SALARY_COMPONENTS: ComponentSeed[] = [
  // --- Recurring earnings -------------------------------------------------
  {
    code: "BASIC", name: "Basic", type: "EARNING", calculationType: "FORMULA",
    taxTreatment: "FULLY_TAXABLE", isRecurring: true, isSystem: true,
    affectsPfWage: true, affectsEsiGross: true, displayOrder: 1,
  },
  {
    code: "DA", name: "Dearness Allowance", type: "EARNING", calculationType: "FORMULA",
    taxTreatment: "FULLY_TAXABLE", isRecurring: true,
    affectsPfWage: true, affectsEsiGross: true, displayOrder: 2,
  },
  {
    code: "HRA", name: "House Rent Allowance", type: "EARNING", calculationType: "FORMULA",
    taxTreatment: "PARTIALLY_EXEMPT", isRecurring: true,
    affectsEsiGross: true, taxSection: "10(13A)", displayOrder: 3,
  },
  {
    code: "CONVEYANCE", name: "Conveyance Allowance", type: "EARNING", calculationType: "FIXED",
    taxTreatment: "FULLY_TAXABLE", isRecurring: true,
    affectsEsiGross: true, displayOrder: 4,
  },
  {
    code: "MEDICAL", name: "Medical Allowance", type: "EARNING", calculationType: "FIXED",
    taxTreatment: "FULLY_TAXABLE", isRecurring: true,
    affectsEsiGross: true, displayOrder: 5,
  },
  {
    code: "LTA", name: "Leave Travel Allowance", type: "EARNING", calculationType: "FORMULA",
    taxTreatment: "PARTIALLY_EXEMPT", isRecurring: true, isPartOfFbp: true,
    affectsEsiGross: true, taxSection: "10(5)", displayOrder: 6,
  },
  {
    code: "SPECIAL", name: "Special Allowance", type: "EARNING", calculationType: "BALANCE",
    taxTreatment: "FULLY_TAXABLE", isRecurring: true, isSystem: true,
    affectsEsiGross: true, displayOrder: 20,
  },

  // --- Employer contributions --------------------------------------------
  {
    code: "PF_EMPLOYER", name: "Employer PF Contribution", type: "EMPLOYER_CONTRIBUTION",
    calculationType: "FORMULA", taxTreatment: "FULLY_EXEMPT", isRecurring: true, isSystem: true,
    displayOrder: 30,
  },
  {
    code: "GRATUITY_PROVISION", name: "Gratuity Provision", type: "EMPLOYER_CONTRIBUTION",
    calculationType: "FORMULA", taxTreatment: "FULLY_EXEMPT", isRecurring: true,
    displayOrder: 31,
  },
  {
    code: "ESI_EMPLOYER", name: "Employer ESI Contribution", type: "EMPLOYER_CONTRIBUTION",
    calculationType: "FORMULA", taxTreatment: "FULLY_EXEMPT", isRecurring: true, isSystem: true,
    isOutsideCtc: true, displayOrder: 32,
  },

  // --- Tax-saving reimbursements (FBP) ------------------------------------
  // Not taxable income, not reported on Form 16, paid on a segregated payslip.
  // Unclaimed amounts convert to taxable Special Allowance at year end.
  {
    code: "FUEL_REIMB", name: "Fuel Reimbursement", type: "REIMBURSEMENT",
    calculationType: "FIXED", taxTreatment: "FULLY_EXEMPT", isRecurring: false,
    isPartOfFbp: true, annualExemptLimit: 28800, displayOrder: 40,
  },
  {
    code: "TELEPHONE_REIMB", name: "Telephone & Internet Reimbursement", type: "REIMBURSEMENT",
    calculationType: "FIXED", taxTreatment: "FULLY_EXEMPT", isRecurring: false,
    isPartOfFbp: true, annualExemptLimit: 24000, displayOrder: 41,
  },
  {
    code: "DRIVER_REIMB", name: "Driver Salary Reimbursement", type: "REIMBURSEMENT",
    calculationType: "FIXED", taxTreatment: "FULLY_EXEMPT", isRecurring: false,
    isPartOfFbp: true, annualExemptLimit: 10800, displayOrder: 42,
  },
  {
    code: "BOOKS_REIMB", name: "Books & Periodicals", type: "REIMBURSEMENT",
    calculationType: "FIXED", taxTreatment: "FULLY_EXEMPT", isRecurring: false,
    isPartOfFbp: true, annualExemptLimit: 12000, displayOrder: 43,
  },
  {
    code: "MEAL_CARD", name: "Meal Card", type: "REIMBURSEMENT",
    calculationType: "FIXED", taxTreatment: "FULLY_EXEMPT", isRecurring: false,
    isPartOfFbp: true, annualExemptLimit: 26400, displayOrder: 44,
  },

  // --- Ad-hoc components --------------------------------------------------
  {
    code: "JOINING_BONUS", name: "Joining Bonus", type: "EARNING", calculationType: "FIXED",
    taxTreatment: "FULLY_TAXABLE", isRecurring: false, isLopApplicable: false,
    displayOrder: 50,
  },
  {
    code: "REFERRAL_BONUS", name: "Referral Bonus", type: "EARNING", calculationType: "FIXED",
    taxTreatment: "FULLY_TAXABLE", isRecurring: false, isLopApplicable: false,
    displayOrder: 51,
  },
  {
    code: "SALARY_ADVANCE_RECOVERY", name: "Salary Advance Recovery", type: "DEDUCTION",
    calculationType: "FIXED", taxTreatment: "FULLY_TAXABLE", isRecurring: false,
    isLopApplicable: false, displayOrder: 60,
  },
  {
    code: "ASSET_DAMAGE_RECOVERY", name: "Asset Damage Recovery", type: "DEDUCTION",
    calculationType: "FIXED", taxTreatment: "FULLY_TAXABLE", isRecurring: false,
    isLopApplicable: false, displayOrder: 61,
  },

  // --- Statutory deductions (system-managed) ------------------------------
  {
    code: "PF_EMPLOYEE", name: "Provident Fund", type: "DEDUCTION", calculationType: "FORMULA",
    taxTreatment: "FULLY_EXEMPT", isRecurring: true, isSystem: true,
    taxSection: "80C", displayOrder: 70,
  },
  {
    code: "VPF", name: "Voluntary Provident Fund", type: "DEDUCTION", calculationType: "FIXED",
    taxTreatment: "FULLY_EXEMPT", isRecurring: true, taxSection: "80C", displayOrder: 71,
  },
  {
    code: "ESI_EMPLOYEE", name: "ESI", type: "DEDUCTION", calculationType: "FORMULA",
    taxTreatment: "FULLY_EXEMPT", isRecurring: true, isSystem: true, displayOrder: 72,
  },
  {
    code: "PT", name: "Professional Tax", type: "DEDUCTION", calculationType: "FORMULA",
    taxTreatment: "FULLY_EXEMPT", isRecurring: true, isSystem: true, displayOrder: 73,
  },
  {
    code: "LWF_EMPLOYEE", name: "Labour Welfare Fund", type: "DEDUCTION", calculationType: "FIXED",
    taxTreatment: "FULLY_EXEMPT", isRecurring: true, isSystem: true, displayOrder: 74,
  },
  {
    code: "TDS", name: "Income Tax (TDS)", type: "DEDUCTION", calculationType: "FORMULA",
    taxTreatment: "FULLY_TAXABLE", isRecurring: true, isSystem: true, displayOrder: 75,
  },
];

/**
 * Range-based salary structures, grouped by annual CTC.
 * Mirrors the documented "Class A-D" default suggestion.
 */
export interface StructureSeed {
  name: string;
  type: "RANGE_BASED" | "CUSTOM" | "DAILY_WAGE";
  minAnnualCtc: number | null;
  maxAnnualCtc: number | null;
  isDefault?: boolean;
  /** Employees on it may declare a flexible benefit plan. */
  isPartOfFbp?: boolean;
  basicPercent: number;
  components: Array<{
    code: string;
    calculationType: "FIXED" | "PERCENTAGE" | "FORMULA" | "BALANCE";
    formula?: string;
    fixedAmount?: number;
    sequence: number;
  }>;
}

const standardLines = (basicPercent: number) => [
  { code: "BASIC", calculationType: "FORMULA" as const, formula: `[CTC_MONTHLY] * ${basicPercent}`, sequence: 1 },
  { code: "HRA", calculationType: "FORMULA" as const, formula: "[BASIC] * 0.50", sequence: 2 },
  { code: "CONVEYANCE", calculationType: "FIXED" as const, fixedAmount: 1600, sequence: 3 },
  { code: "MEDICAL", calculationType: "FIXED" as const, fixedAmount: 1250, sequence: 4 },
  { code: "LTA", calculationType: "FORMULA" as const, formula: "[BASIC] * 0.0833", sequence: 5 },
  // Nested IF: PF switches to the statutory cap once Basic clears the ceiling.
  { code: "PF_EMPLOYER", calculationType: "FORMULA" as const, formula: "IF([BASIC] > 15000, 1800, [BASIC] * 0.12)", sequence: 10 },
  { code: "GRATUITY_PROVISION", calculationType: "FORMULA" as const, formula: "[BASIC] * 0.0481", sequence: 11 },
  { code: "SPECIAL", calculationType: "BALANCE" as const, sequence: 20 },
];

export const SALARY_STRUCTURES: StructureSeed[] = [
  {
    name: "Class D — up to 3L",
    type: "RANGE_BASED", minAnnualCtc: 0, maxAnnualCtc: 300000,
    basicPercent: 0.5, components: standardLines(0.5),
  },
  {
    name: "Class C — 3L to 8L",
    type: "RANGE_BASED", minAnnualCtc: 300001, maxAnnualCtc: 800000,
    basicPercent: 0.45, components: standardLines(0.45),
  },
  {
    name: "Class B — 8L to 20L",
    type: "RANGE_BASED", minAnnualCtc: 800001, maxAnnualCtc: 2000000,
    isDefault: true,
    basicPercent: 0.4, components: standardLines(0.4),
  },
  {
    name: "Class A — above 20L",
    type: "RANGE_BASED", minAnnualCtc: 2000001, maxAnnualCtc: null,
    isPartOfFbp: true,
    basicPercent: 0.35, components: standardLines(0.35),
  },
];
