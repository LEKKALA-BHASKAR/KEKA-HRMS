/**
 * Income tax reference data for the Indian financial year.
 *
 * Seeded into `income_tax_slabs` and `income_tax_configs`, both keyed by
 * regime and FY start year, so a prior-year recomputation uses that year's
 * rules rather than today's.
 *
 * VERIFY AGAINST THE CURRENT FINANCE ACT before go-live.
 */

export interface TaxSlabSeed {
  regime: "OLD" | "NEW";
  fyStartYear: number;
  minAge: number;
  maxAge: number;
  fromAmount: number;
  toAmount: number | null;
  ratePercent: number;
}

export interface TaxConfigSeed {
  regime: "OLD" | "NEW";
  fyStartYear: number;
  standardDeduction: number;
  /** Section 87A: full relief at or below this taxable income. */
  rebateLimit: number;
  rebateMaxAmount: number;
  cessPercent: number;
  surchargeBands: Array<{ from: number; to: number | null; percent: number }>;
  marginalReliefEnabled: boolean;
}

const FY = 2026;

export const TAX_SLABS: TaxSlabSeed[] = [
  // --- New regime (s.115BAC). No age differentiation. --------------------
  { regime: "NEW", fyStartYear: FY, minAge: 0, maxAge: 200, fromAmount: 0,        toAmount: 400000,  ratePercent: 0 },
  { regime: "NEW", fyStartYear: FY, minAge: 0, maxAge: 200, fromAmount: 400000,   toAmount: 800000,  ratePercent: 5 },
  { regime: "NEW", fyStartYear: FY, minAge: 0, maxAge: 200, fromAmount: 800000,   toAmount: 1200000, ratePercent: 10 },
  { regime: "NEW", fyStartYear: FY, minAge: 0, maxAge: 200, fromAmount: 1200000,  toAmount: 1600000, ratePercent: 15 },
  { regime: "NEW", fyStartYear: FY, minAge: 0, maxAge: 200, fromAmount: 1600000,  toAmount: 2000000, ratePercent: 20 },
  { regime: "NEW", fyStartYear: FY, minAge: 0, maxAge: 200, fromAmount: 2000000,  toAmount: 2400000, ratePercent: 25 },
  { regime: "NEW", fyStartYear: FY, minAge: 0, maxAge: 200, fromAmount: 2400000,  toAmount: null,    ratePercent: 30 },

  // --- Old regime, below 60 ----------------------------------------------
  { regime: "OLD", fyStartYear: FY, minAge: 0, maxAge: 59, fromAmount: 0,       toAmount: 250000,  ratePercent: 0 },
  { regime: "OLD", fyStartYear: FY, minAge: 0, maxAge: 59, fromAmount: 250000,  toAmount: 500000,  ratePercent: 5 },
  { regime: "OLD", fyStartYear: FY, minAge: 0, maxAge: 59, fromAmount: 500000,  toAmount: 1000000, ratePercent: 20 },
  { regime: "OLD", fyStartYear: FY, minAge: 0, maxAge: 59, fromAmount: 1000000, toAmount: null,    ratePercent: 30 },

  // --- Old regime, senior citizen (60-79) --------------------------------
  { regime: "OLD", fyStartYear: FY, minAge: 60, maxAge: 79, fromAmount: 0,       toAmount: 300000,  ratePercent: 0 },
  { regime: "OLD", fyStartYear: FY, minAge: 60, maxAge: 79, fromAmount: 300000,  toAmount: 500000,  ratePercent: 5 },
  { regime: "OLD", fyStartYear: FY, minAge: 60, maxAge: 79, fromAmount: 500000,  toAmount: 1000000, ratePercent: 20 },
  { regime: "OLD", fyStartYear: FY, minAge: 60, maxAge: 79, fromAmount: 1000000, toAmount: null,    ratePercent: 30 },

  // --- Old regime, super senior citizen (80+) ----------------------------
  { regime: "OLD", fyStartYear: FY, minAge: 80, maxAge: 200, fromAmount: 0,       toAmount: 500000,  ratePercent: 0 },
  { regime: "OLD", fyStartYear: FY, minAge: 80, maxAge: 200, fromAmount: 500000,  toAmount: 1000000, ratePercent: 20 },
  { regime: "OLD", fyStartYear: FY, minAge: 80, maxAge: 200, fromAmount: 1000000, toAmount: null,    ratePercent: 30 },
];

export const TAX_CONFIGS: TaxConfigSeed[] = [
  {
    regime: "NEW",
    fyStartYear: FY,
    standardDeduction: 75000,
    rebateLimit: 1200000,
    rebateMaxAmount: 60000,
    cessPercent: 4,
    // The new regime's surcharge is capped at 25% — there is no 37% band.
    surchargeBands: [
      { from: 5000000,  to: 10000000, percent: 10 },
      { from: 10000000, to: 20000000, percent: 15 },
      { from: 20000000, to: null,     percent: 25 },
    ],
    marginalReliefEnabled: true,
  },
  {
    regime: "OLD",
    fyStartYear: FY,
    standardDeduction: 50000,
    rebateLimit: 500000,
    rebateMaxAmount: 12500,
    cessPercent: 4,
    surchargeBands: [
      { from: 5000000,  to: 10000000, percent: 10 },
      { from: 10000000, to: 20000000, percent: 15 },
      { from: 20000000, to: 50000000, percent: 25 },
      { from: 50000000, to: null,     percent: 37 },
    ],
    marginalReliefEnabled: true,
  },
];

/**
 * Chapter VI-A and related deduction ceilings. Old regime only — the new
 * regime allows almost none of these, which the calculator enforces.
 */
export interface DeductionSectionSeed {
  section: string;
  label: string;
  maxAmount: number | null;
  /** 80C, 80CCC and 80CCD(1) share a single 1,50,000 ceiling. */
  sharedGroup?: string;
  /** Allowed under the new regime too. */
  allowedInNewRegime?: boolean;
  seniorMaxAmount?: number;
}

export const DEDUCTION_SECTIONS: DeductionSectionSeed[] = [
  { section: "80C",       label: "Life insurance, PPF, ELSS, principal repayment, tuition fees", maxAmount: 150000, sharedGroup: "80C_GROUP" },
  { section: "80CCC",     label: "Pension fund contributions", maxAmount: 150000, sharedGroup: "80C_GROUP" },
  { section: "80CCD(1)",  label: "NPS — employee contribution", maxAmount: 150000, sharedGroup: "80C_GROUP" },
  { section: "80CCD(1B)", label: "NPS — additional self contribution", maxAmount: 50000 },
  { section: "80CCD(2)",  label: "NPS — employer contribution", maxAmount: null, allowedInNewRegime: true },
  { section: "80D",       label: "Health insurance premium", maxAmount: 25000, seniorMaxAmount: 50000 },
  { section: "80DD",      label: "Maintenance of a dependant with disability", maxAmount: 125000 },
  { section: "80DDB",     label: "Treatment of specified diseases", maxAmount: 40000, seniorMaxAmount: 100000 },
  { section: "80E",       label: "Interest on an education loan", maxAmount: null },
  { section: "80EE",      label: "Interest on a first home loan", maxAmount: 50000 },
  { section: "80EEA",     label: "Interest on an affordable-housing loan", maxAmount: 150000 },
  { section: "80EEB",     label: "Interest on an electric-vehicle loan", maxAmount: 150000 },
  { section: "80G",       label: "Donations to approved funds", maxAmount: null },
  { section: "80GG",      label: "Rent paid where no HRA is received", maxAmount: 60000 },
  { section: "80TTA",     label: "Interest on a savings account", maxAmount: 10000 },
  { section: "80TTB",     label: "Interest income — senior citizens", maxAmount: 50000 },
  { section: "80U",       label: "Self disability", maxAmount: 125000 },
  { section: "24B",       label: "Interest on a home loan — self-occupied", maxAmount: 200000 },
  { section: "24B_LET",   label: "Interest on a home loan — let out", maxAmount: null },
];

export const DEDUCTION_SECTION_BY_KEY = new Map(
  DEDUCTION_SECTIONS.map((d) => [d.section, d]),
);
