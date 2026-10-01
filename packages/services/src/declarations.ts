import { DEDUCTION_SECTIONS, type DeductionSectionSeed } from "@keka/payroll";

/**
 * What an investment declaration is worth: the sections, their ceilings and
 * the amount each line counts for. Pure, so the declaration screens, the
 * server actions and the payroll run's TDS all judge a declaration alike.
 */

// --- Sections ---------------------------------------------------------------

export interface SectionInfo extends DeductionSectionSeed {
  /** Income rather than a deduction: added to taxable income. */
  kind: "deduction" | "house" | "income" | "tds";
}

/**
 * Chapter VI-A and house-property sections come from the payroll engine's
 * table. Income from other sources and tax already deducted on it are not
 * deductions, so they live here: both apply in either regime.
 */
const EXTRA_SECTIONS: SectionInfo[] = [
  { section: "OTHER_INCOME", label: "Income from other sources (interest, dividends, rent received)", maxAmount: null, allowedInNewRegime: true, kind: "income" },
  { section: "OTHER_TDS", label: "TDS / TCS already deducted on other income", maxAmount: null, allowedInNewRegime: true, kind: "tds" },
];

export const SECTIONS: SectionInfo[] = [
  ...DEDUCTION_SECTIONS.map((d): SectionInfo => ({ ...d, kind: d.section.startsWith("24B") ? "house" : "deduction" })),
  ...EXTRA_SECTIONS,
];
export const SECTION_BY_KEY = new Map(SECTIONS.map((s) => [s.section, s]));

/** The 80C family shares one ceiling. */
export const EIGHTY_C_GROUP = "80C_GROUP";
export const EIGHTY_C_CAP = 150000;
/** Loss from a self-occupied house property set off against salary is capped. */
export const HOUSE_LOSS_CAP = 200000;
/** Landlord PAN becomes mandatory above this annual rent. */
export const LANDLORD_PAN_THRESHOLD = 100000;

export type TabKey = "summary" | "80c" | "other" | "allowances" | "house" | "income";

export interface DeclTab {
  key: TabKey;
  label: string;
  /** How the tab is named in the My Declarations summary table. */
  rowLabel: string;
  sections: string[];
}

const eightyC = SECTIONS.filter((s) => s.sharedGroup === EIGHTY_C_GROUP).map((s) => s.section);
const otherDeductions = SECTIONS.filter((s) => s.kind === "deduction" && s.sharedGroup !== EIGHTY_C_GROUP).map((s) => s.section);

export const DECL_TABS: DeclTab[] = [
  { key: "80c", label: "1.5 Lac Deductions", rowLabel: "1.5 Lac Deductions", sections: eightyC },
  { key: "other", label: "Other Deductions", rowLabel: "Other Deductions", sections: otherDeductions },
  { key: "allowances", label: "Tax Saving Allowances", rowLabel: "Tax Saving Allowances", sections: [] },
  { key: "house", label: "House Property", rowLabel: "House Property", sections: ["24B", "24B_LET"] },
  { key: "income", label: "Income & TDS/TCS From Other Sources", rowLabel: "Income from Other Sources", sections: ["OTHER_INCOME", "OTHER_TDS"] },
];

const DISPLAY: Record<string, string> = { OTHER_INCOME: "Other income", OTHER_TDS: "TDS / TCS", "24B_LET": "24B (let out)" };
/** The section as people write it: "80C", "24B (let out)", "Other income". */
export function sectionName(section: string): string {
  return DISPLAY[section] ?? section;
}

export function tabForSection(section: string): DeclTab | undefined {
  return DECL_TABS.find((t) => t.sections.includes(section));
}

export function sectionAllowed(section: string, regime: "OLD" | "NEW"): boolean {
  const s = SECTION_BY_KEY.get(section);
  if (!s) return false;
  return regime === "OLD" || !!s.allowedInNewRegime;
}

/** The ceiling for one section, taking the senior-citizen limit into account. */
export function sectionCap(section: string, age: number): number | null {
  const s = SECTION_BY_KEY.get(section);
  if (!s) return null;
  if (age >= 60 && s.seniorMaxAmount) return s.seniorMaxAmount;
  return s.maxAmount;
}

/**
 * Room left under a section for a new declaration, considering both the
 * section's own ceiling and the shared 80C ceiling. Null means no limit.
 */
export function roomLeft(section: string, items: Array<{ section: string; declaredAmount: number }>, age: number): number | null {
  const s = SECTION_BY_KEY.get(section);
  if (!s) return 0;
  const sum = (pred: (x: string) => boolean) => items.filter((i) => pred(i.section)).reduce((a, i) => a + i.declaredAmount, 0);
  const caps: number[] = [];
  const own = sectionCap(section, age);
  if (own !== null) caps.push(own - sum((x) => x === section));
  if (s.sharedGroup === EIGHTY_C_GROUP) caps.push(EIGHTY_C_CAP - sum((x) => SECTION_BY_KEY.get(x)?.sharedGroup === EIGHTY_C_GROUP));
  if (section === "24B") caps.push(HOUSE_LOSS_CAP - sum((x) => x === "24B"));
  return caps.length ? Math.max(0, Math.min(...caps)) : null;
}

/**
 * The amount a line counts for in the tax projection: once a reviewer has
 * ruled on the proof, what they accepted; until then, what was declared —
 * which is how Keka computes TDS during the year.
 */
export function effectiveAmount(item: { declaredAmount: number; approvedAmount: number; proofStatus: string }): number {
  return item.proofStatus === "APPROVED" || item.proofStatus === "REJECTED" ? item.approvedAmount : item.declaredAmount;
}

export interface DeductionTotals {
  /** Chapter VI-A after every ceiling, excluding 80CCD(2). */
  chapterVia: number;
  /** 80CCD(2), the one deduction the new regime keeps. */
  employerNps: number;
  /** Negative: interest on a home loan set off against salary. */
  houseProperty: number;
  otherIncome: number;
  otherTds: number;
  bySection: Array<{ section: string; label: string; counted: number; allowed: number }>;
}

/** Apply the section ceilings to what counts from each line. */
export function cappedDeductions(
  items: Array<{ section: string; declaredAmount: number; approvedAmount: number; proofStatus: string }>,
  age: number,
): DeductionTotals {
  const counted = new Map<string, number>();
  for (const i of items) counted.set(i.section, (counted.get(i.section) ?? 0) + effectiveAmount(i));

  const bySection: DeductionTotals["bySection"] = [];
  let groupLeft = EIGHTY_C_CAP;
  let chapterVia = 0, employerNps = 0, interest = 0, otherIncome = 0, otherTds = 0;
  // Walk in table order so the 80C group fills from 80C first.
  for (const s of SECTIONS) {
    const amt = counted.get(s.section);
    if (amt === undefined) continue;
    let allowed = amt;
    const cap = sectionCap(s.section, age);
    if (cap !== null) allowed = Math.min(allowed, cap);
    if (s.sharedGroup === EIGHTY_C_GROUP) {
      allowed = Math.min(allowed, groupLeft);
      groupLeft -= allowed;
    }
    allowed = Math.max(0, allowed);
    if (s.kind === "deduction") {
      if (s.section === "80CCD(2)") employerNps += allowed;
      else chapterVia += allowed;
    } else if (s.kind === "house") interest += allowed;
    else if (s.kind === "income") otherIncome += allowed;
    else otherTds += allowed;
    bySection.push({ section: s.section, label: s.label, counted: amt, allowed });
  }
  return { chapterVia, employerNps, houseProperty: -Math.min(interest, HOUSE_LOSS_CAP), otherIncome, otherTds, bySection };
}
