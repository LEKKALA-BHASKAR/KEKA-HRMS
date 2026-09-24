/**
 * Professional Tax slab reference data.
 *
 * PT is a state levy, so there is no single national table — each state
 * publishes its own schedule and revises it independently. These rows are
 * seeded into the `pt_slabs` table, which is effective-dated so a historical
 * payroll run reproduces exactly even after a state revises its slabs.
 *
 * VERIFY BEFORE GO-LIVE. Slabs change by state notification and the values
 * below are a starting set, not a legal authority. The engine reads from the
 * database, so correcting a slab is a data change, not a code change.
 *
 * Amounts are per the stated frequency:
 *   MONTHLY      — amount deducted each month, tested against monthly gross
 *   HALF_YEARLY  — tested against half-yearly gross, collected twice a year
 *   ANNUAL       — tested against annual gross, collected once
 *
 * `specialMonth` / `specialAmount` encode the states that levy a different
 * amount in one month of the year to make the annual total land on a round
 * figure (Maharashtra's February being the best-known case).
 */

export type PtFrequencyLiteral = "MONTHLY" | "HALF_YEARLY" | "ANNUAL";

export interface PtSlabSeed {
  stateCode: string;
  stateName: string;
  localBodyType?: string;
  gender?: "MALE" | "FEMALE";
  frequency: PtFrequencyLiteral;
  fromAmount: number;
  toAmount: number | null;
  amount: number;
  specialMonth?: number;
  specialAmount?: number;
}

/** States and union territories that levy no professional tax at all. */
export const NO_PT_STATES = [
  "DL", "HR", "UP", "UK", "RJ", "AN", "CH", "DH", "JK", "LA", "GA", "AR",
] as const;

export const PT_SLABS: PtSlabSeed[] = [
  // --- Karnataka: nil below 25,000, flat 200 above -------------------------
  { stateCode: "KA", stateName: "Karnataka", frequency: "MONTHLY", fromAmount: 0, toAmount: 24999.99, amount: 0 },
  { stateCode: "KA", stateName: "Karnataka", frequency: "MONTHLY", fromAmount: 25000, toAmount: null, amount: 200 },

  // --- Maharashtra: gendered thresholds; 300 in February ------------------
  { stateCode: "MH", stateName: "Maharashtra", gender: "MALE", frequency: "MONTHLY", fromAmount: 0, toAmount: 7500, amount: 0 },
  { stateCode: "MH", stateName: "Maharashtra", gender: "MALE", frequency: "MONTHLY", fromAmount: 7500.01, toAmount: 10000, amount: 175 },
  { stateCode: "MH", stateName: "Maharashtra", gender: "MALE", frequency: "MONTHLY", fromAmount: 10000.01, toAmount: null, amount: 200, specialMonth: 2, specialAmount: 300 },
  { stateCode: "MH", stateName: "Maharashtra", gender: "FEMALE", frequency: "MONTHLY", fromAmount: 0, toAmount: 25000, amount: 0 },
  { stateCode: "MH", stateName: "Maharashtra", gender: "FEMALE", frequency: "MONTHLY", fromAmount: 25000.01, toAmount: null, amount: 200, specialMonth: 2, specialAmount: 300 },

  // --- Tamil Nadu: half-yearly, and split by local body -------------------
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "CORPORATION", frequency: "HALF_YEARLY", fromAmount: 0, toAmount: 21000, amount: 0 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "CORPORATION", frequency: "HALF_YEARLY", fromAmount: 21001, toAmount: 30000, amount: 135 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "CORPORATION", frequency: "HALF_YEARLY", fromAmount: 30001, toAmount: 45000, amount: 315 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "CORPORATION", frequency: "HALF_YEARLY", fromAmount: 45001, toAmount: 60000, amount: 690 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "CORPORATION", frequency: "HALF_YEARLY", fromAmount: 60001, toAmount: 75000, amount: 1025 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "CORPORATION", frequency: "HALF_YEARLY", fromAmount: 75001, toAmount: null, amount: 1250 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "PANCHAYAT", frequency: "HALF_YEARLY", fromAmount: 0, toAmount: 21000, amount: 0 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "PANCHAYAT", frequency: "HALF_YEARLY", fromAmount: 21001, toAmount: 30000, amount: 100 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "PANCHAYAT", frequency: "HALF_YEARLY", fromAmount: 30001, toAmount: 45000, amount: 235 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "PANCHAYAT", frequency: "HALF_YEARLY", fromAmount: 45001, toAmount: 60000, amount: 510 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "PANCHAYAT", frequency: "HALF_YEARLY", fromAmount: 60001, toAmount: 75000, amount: 760 },
  { stateCode: "TN", stateName: "Tamil Nadu", localBodyType: "PANCHAYAT", frequency: "HALF_YEARLY", fromAmount: 75001, toAmount: null, amount: 1095 },

  // --- West Bengal --------------------------------------------------------
  { stateCode: "WB", stateName: "West Bengal", frequency: "MONTHLY", fromAmount: 0, toAmount: 10000, amount: 0 },
  { stateCode: "WB", stateName: "West Bengal", frequency: "MONTHLY", fromAmount: 10001, toAmount: 15000, amount: 110 },
  { stateCode: "WB", stateName: "West Bengal", frequency: "MONTHLY", fromAmount: 15001, toAmount: 25000, amount: 130 },
  { stateCode: "WB", stateName: "West Bengal", frequency: "MONTHLY", fromAmount: 25001, toAmount: 40000, amount: 150 },
  { stateCode: "WB", stateName: "West Bengal", frequency: "MONTHLY", fromAmount: 40001, toAmount: null, amount: 200 },

  // --- Andhra Pradesh -----------------------------------------------------
  { stateCode: "AP", stateName: "Andhra Pradesh", frequency: "MONTHLY", fromAmount: 0, toAmount: 15000, amount: 0 },
  { stateCode: "AP", stateName: "Andhra Pradesh", frequency: "MONTHLY", fromAmount: 15001, toAmount: 20000, amount: 150 },
  { stateCode: "AP", stateName: "Andhra Pradesh", frequency: "MONTHLY", fromAmount: 20001, toAmount: null, amount: 200 },

  // --- Telangana ----------------------------------------------------------
  { stateCode: "TS", stateName: "Telangana", frequency: "MONTHLY", fromAmount: 0, toAmount: 15000, amount: 0 },
  { stateCode: "TS", stateName: "Telangana", frequency: "MONTHLY", fromAmount: 15001, toAmount: 20000, amount: 150 },
  { stateCode: "TS", stateName: "Telangana", frequency: "MONTHLY", fromAmount: 20001, toAmount: null, amount: 200 },

  // --- Gujarat ------------------------------------------------------------
  { stateCode: "GJ", stateName: "Gujarat", frequency: "MONTHLY", fromAmount: 0, toAmount: 12000, amount: 0 },
  { stateCode: "GJ", stateName: "Gujarat", frequency: "MONTHLY", fromAmount: 12001, toAmount: null, amount: 200 },

  // --- Madhya Pradesh: 212 in the final month to make the annual 2,500 ----
  { stateCode: "MP", stateName: "Madhya Pradesh", frequency: "MONTHLY", fromAmount: 0, toAmount: 18750, amount: 0 },
  { stateCode: "MP", stateName: "Madhya Pradesh", frequency: "MONTHLY", fromAmount: 18751, toAmount: 25000, amount: 125 },
  { stateCode: "MP", stateName: "Madhya Pradesh", frequency: "MONTHLY", fromAmount: 25001, toAmount: 33333, amount: 167 },
  { stateCode: "MP", stateName: "Madhya Pradesh", frequency: "MONTHLY", fromAmount: 33334, toAmount: null, amount: 208, specialMonth: 3, specialAmount: 212 },

  // --- Kerala: half-yearly ------------------------------------------------
  { stateCode: "KL", stateName: "Kerala", frequency: "HALF_YEARLY", fromAmount: 0, toAmount: 11999, amount: 0 },
  { stateCode: "KL", stateName: "Kerala", frequency: "HALF_YEARLY", fromAmount: 12000, toAmount: 17999, amount: 120 },
  { stateCode: "KL", stateName: "Kerala", frequency: "HALF_YEARLY", fromAmount: 18000, toAmount: 29999, amount: 180 },
  { stateCode: "KL", stateName: "Kerala", frequency: "HALF_YEARLY", fromAmount: 30000, toAmount: 44999, amount: 300 },
  { stateCode: "KL", stateName: "Kerala", frequency: "HALF_YEARLY", fromAmount: 45000, toAmount: 59999, amount: 450 },
  { stateCode: "KL", stateName: "Kerala", frequency: "HALF_YEARLY", fromAmount: 60000, toAmount: 74999, amount: 600 },
  { stateCode: "KL", stateName: "Kerala", frequency: "HALF_YEARLY", fromAmount: 75000, toAmount: 99999, amount: 750 },
  { stateCode: "KL", stateName: "Kerala", frequency: "HALF_YEARLY", fromAmount: 100000, toAmount: 124999, amount: 1000 },
  { stateCode: "KL", stateName: "Kerala", frequency: "HALF_YEARLY", fromAmount: 125000, toAmount: null, amount: 1250 },

  // --- Odisha: 300 in the final month -------------------------------------
  { stateCode: "OR", stateName: "Odisha", frequency: "MONTHLY", fromAmount: 0, toAmount: 13304, amount: 0 },
  { stateCode: "OR", stateName: "Odisha", frequency: "MONTHLY", fromAmount: 13305, toAmount: 25000, amount: 125 },
  { stateCode: "OR", stateName: "Odisha", frequency: "MONTHLY", fromAmount: 25001, toAmount: null, amount: 200, specialMonth: 3, specialAmount: 300 },

  // --- Assam --------------------------------------------------------------
  { stateCode: "AS", stateName: "Assam", frequency: "MONTHLY", fromAmount: 0, toAmount: 10000, amount: 0 },
  { stateCode: "AS", stateName: "Assam", frequency: "MONTHLY", fromAmount: 10001, toAmount: 15000, amount: 150 },
  { stateCode: "AS", stateName: "Assam", frequency: "MONTHLY", fromAmount: 15001, toAmount: 25000, amount: 180 },
  { stateCode: "AS", stateName: "Assam", frequency: "MONTHLY", fromAmount: 25001, toAmount: null, amount: 208 },

  // --- Bihar: annual ------------------------------------------------------
  { stateCode: "BR", stateName: "Bihar", frequency: "ANNUAL", fromAmount: 0, toAmount: 300000, amount: 0 },
  { stateCode: "BR", stateName: "Bihar", frequency: "ANNUAL", fromAmount: 300001, toAmount: 500000, amount: 1000 },
  { stateCode: "BR", stateName: "Bihar", frequency: "ANNUAL", fromAmount: 500001, toAmount: 1000000, amount: 2000 },
  { stateCode: "BR", stateName: "Bihar", frequency: "ANNUAL", fromAmount: 1000001, toAmount: null, amount: 2500 },

  // --- Jharkhand: annual --------------------------------------------------
  { stateCode: "JH", stateName: "Jharkhand", frequency: "ANNUAL", fromAmount: 0, toAmount: 300000, amount: 0 },
  { stateCode: "JH", stateName: "Jharkhand", frequency: "ANNUAL", fromAmount: 300001, toAmount: 500000, amount: 1200 },
  { stateCode: "JH", stateName: "Jharkhand", frequency: "ANNUAL", fromAmount: 500001, toAmount: 800000, amount: 1800 },
  { stateCode: "JH", stateName: "Jharkhand", frequency: "ANNUAL", fromAmount: 800001, toAmount: 1000000, amount: 2100 },
  { stateCode: "JH", stateName: "Jharkhand", frequency: "ANNUAL", fromAmount: 1000001, toAmount: null, amount: 2500 },

  // --- Chhattisgarh -------------------------------------------------------
  { stateCode: "CG", stateName: "Chhattisgarh", frequency: "MONTHLY", fromAmount: 0, toAmount: 16666, amount: 0 },
  { stateCode: "CG", stateName: "Chhattisgarh", frequency: "MONTHLY", fromAmount: 16667, toAmount: 25000, amount: 130 },
  { stateCode: "CG", stateName: "Chhattisgarh", frequency: "MONTHLY", fromAmount: 25001, toAmount: 33333, amount: 150 },
  { stateCode: "CG", stateName: "Chhattisgarh", frequency: "MONTHLY", fromAmount: 33334, toAmount: null, amount: 200 },

  // --- Punjab: flat, on those liable to income tax ------------------------
  { stateCode: "PB", stateName: "Punjab", frequency: "MONTHLY", fromAmount: 0, toAmount: 20833, amount: 0 },
  { stateCode: "PB", stateName: "Punjab", frequency: "MONTHLY", fromAmount: 20834, toAmount: null, amount: 200 },

  // --- Sikkim -------------------------------------------------------------
  { stateCode: "SK", stateName: "Sikkim", frequency: "MONTHLY", fromAmount: 0, toAmount: 20000, amount: 0 },
  { stateCode: "SK", stateName: "Sikkim", frequency: "MONTHLY", fromAmount: 20001, toAmount: 30000, amount: 125 },
  { stateCode: "SK", stateName: "Sikkim", frequency: "MONTHLY", fromAmount: 30001, toAmount: 40000, amount: 150 },
  { stateCode: "SK", stateName: "Sikkim", frequency: "MONTHLY", fromAmount: 40001, toAmount: null, amount: 200 },

  // --- Meghalaya ----------------------------------------------------------
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 0, toAmount: 4166, amount: 0 },
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 4167, toAmount: 8333, amount: 16.5 },
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 8334, toAmount: 12500, amount: 25 },
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 12501, toAmount: 16666, amount: 41.5 },
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 16667, toAmount: 20833, amount: 62.5 },
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 20834, toAmount: 25000, amount: 83.33 },
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 25001, toAmount: 29166, amount: 104.16 },
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 29167, toAmount: 33333, amount: 125 },
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 33334, toAmount: 37500, amount: 150 },
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 37501, toAmount: 41666, amount: 175 },
  { stateCode: "ML", stateName: "Meghalaya", frequency: "MONTHLY", fromAmount: 41667, toAmount: null, amount: 208 },

  // --- Puducherry ---------------------------------------------------------
  { stateCode: "PY", stateName: "Puducherry", frequency: "HALF_YEARLY", fromAmount: 0, toAmount: 99999, amount: 0 },
  { stateCode: "PY", stateName: "Puducherry", frequency: "HALF_YEARLY", fromAmount: 100000, toAmount: 200000, amount: 250 },
  { stateCode: "PY", stateName: "Puducherry", frequency: "HALF_YEARLY", fromAmount: 200001, toAmount: 300000, amount: 500 },
  { stateCode: "PY", stateName: "Puducherry", frequency: "HALF_YEARLY", fromAmount: 300001, toAmount: 400000, amount: 750 },
  { stateCode: "PY", stateName: "Puducherry", frequency: "HALF_YEARLY", fromAmount: 400001, toAmount: null, amount: 1000 },
];

/** Every state code that has at least one slab row. */
export const PT_STATES = [...new Set(PT_SLABS.map((s) => s.stateCode))];

export const PT_STATE_NAMES: Record<string, string> = Object.fromEntries(
  PT_SLABS.map((s) => [s.stateCode, s.stateName]),
);
