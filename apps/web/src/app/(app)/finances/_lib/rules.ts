import { fyRange, MONTH_SHORT } from "@keka/shared";

/**
 * The rules behind My Finances → Manage Tax, kept free of I/O so the pages
 * and the server actions in app/actions/tax.ts judge a declaration the same
 * way: which sections a tab offers, what each one is capped at, and whether
 * the declaration and proof windows are open today.
 */

// --- Sections ---------------------------------------------------------------
// The section rules live in @keka/services so payroll's TDS uses them too.
export {
  SECTIONS, SECTION_BY_KEY, EIGHTY_C_GROUP, EIGHTY_C_CAP, HOUSE_LOSS_CAP, LANDLORD_PAN_THRESHOLD, DECL_TABS,
  sectionName, tabForSection, sectionAllowed, sectionCap, roomLeft, effectiveAmount, cappedDeductions,
} from "@keka/services";
export type { SectionInfo, TabKey, DeclTab, DeductionTotals } from "@keka/services";

// --- Windows ----------------------------------------------------------------

export interface WindowSettings {
  declarationOpenDay: number;
  declarationCloseDay: number;
  declarationFyCutoff: Date | null;
  newJoinerWindowDays: number;
  proofSubmissionDue: Date | null;
  allowLateDeclaration: boolean;
}

export interface WindowState {
  open: boolean;
  /** Last day of the current window, when open. */
  till: Date | null;
  /** One sentence for the employee. */
  note: string;
  /** Keka's label/value rows for an open window: "Current Window — Till …", "Monthly Window — …". */
  rows?: Array<[string, string]>;
}

const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;

const IST_OFFSET_MIN = 330;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const utc = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d));
const lastDay = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** Today's date in India, as a UTC-midnight Date like every date column. */
export function istToday(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  return utc(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
}

/**
 * Whether the employee may change declarations and upload proofs today,
 * derived from the pay group's settings:
 *  - declarations open between the open and close day of each month, until
 *    the FY cut-off; a new joiner gets N days from joining regardless; late
 *    declarations, when allowed, stay open to the end of the year;
 *  - proofs may be uploaded until the proof due date.
 */
export function declarationWindows(
  s: WindowSettings | null,
  opts: { fy: number; currentFy: number; now: Date; joinedOn: Date; locked: boolean; fyStartMonth?: number },
): { declaration: WindowState; proof: WindowState } {
  const closed = (note: string): WindowState => ({ open: false, till: null, note });
  if (!s) {
    const w = closed("You are not in a pay group yet, so there is no declaration window.");
    return { declaration: w, proof: w };
  }
  if (opts.fy < opts.currentFy) {
    const w = closed("This financial year is over. Declarations and proofs can no longer be changed.");
    return { declaration: w, proof: w };
  }
  if (opts.fy > opts.currentFy) {
    const w = closed("This financial year has not started yet.");
    return { declaration: w, proof: w };
  }

  const today = istToday(opts.now);
  const { end: fyEnd } = fyRange(opts.fy, opts.fyStartMonth ?? 4);
  const cutoff = s.declarationFyCutoff && s.declarationFyCutoff < fyEnd ? s.declarationFyCutoff : fyEnd;

  // --- Proofs ---
  const proofTill = s.proofSubmissionDue && s.proofSubmissionDue < fyEnd ? s.proofSubmissionDue : fyEnd;
  const proof: WindowState = dayKey(today) <= dayKey(proofTill)
    ? { open: true, till: proofTill, note: `Upload proof for each declaration by ${fmt(proofTill)}.` }
    : closed(`The proof submission window closed on ${fmt(proofTill)}.`);

  // --- Declarations ---
  let declaration: WindowState;
  const joinTill = new Date(opts.joinedOn.getTime() + s.newJoinerWindowDays * 86_400_000);
  if (opts.locked) {
    declaration = closed("Your payroll team has locked your declaration for this year.");
  } else if (s.allowLateDeclaration && dayKey(today) <= dayKey(fyEnd)) {
    declaration = { open: true, till: fyEnd, note: `Late declarations are allowed this year: you can add or edit declarations until ${fmt(fyEnd)}.`, rows: [["Current Window", `Till ${fmt(fyEnd)}`]] };
  } else if (opts.joinedOn <= today && dayKey(today) <= dayKey(joinTill)) {
    declaration = { open: true, till: joinTill, note: `As a new joiner you can add or edit declarations until ${fmt(joinTill)}.`, rows: [["Current Window", `Till ${fmt(joinTill)}`], ["New Joiner Window", `${s.newJoinerWindowDays} days from joining`]] };
  } else if (dayKey(today) > dayKey(cutoff)) {
    declaration = closed("You cannot add or edit declarations as the investment declaration window has lapsed.");
  } else {
    const y = today.getUTCFullYear(), m = today.getUTCMonth(), d = today.getUTCDate();
    const openD = Math.min(s.declarationOpenDay, lastDay(y, m));
    const closeD = Math.min(s.declarationCloseDay, lastDay(y, m));
    if (d >= openD && d <= closeD) {
      const end = utc(y, m, closeD);
      const till = end < cutoff ? end : cutoff;
      declaration = {
        open: true, till,
        note: `You can add or edit declarations until ${fmt(till)}. The window opens on day ${s.declarationOpenDay} and closes on day ${s.declarationCloseDay} of each month, until ${fmt(cutoff)}.`,
        rows: [["Current Window", `Till ${fmt(till)}`], ["Monthly Window", `${ordinal(s.declarationOpenDay)} to ${ordinal(s.declarationCloseDay)} of every month till ${fmt(cutoff)}`]],
      };
    } else {
      const next = d < openD ? utc(y, m, openD) : utc(y, m + 1, Math.min(s.declarationOpenDay, lastDay(y, m + 1)));
      declaration = closed(
        dayKey(next) <= dayKey(cutoff)
          ? `You cannot add or edit declarations as the investment declaration window has lapsed. It reopens on ${fmt(next)}.`
          : "You cannot add or edit declarations as the investment declaration window has lapsed.",
      );
    }
  }
  return { declaration, proof };
}

/** Whether the employee may still choose their tax regime for the year. */
export function regimeSwitchState(
  pg: { allowRegimeChoice: boolean; regimeChangeCutoff: Date | null } | null,
  regimeLockedAt: Date | null,
  opts: { isCurrentFy: boolean; now: Date },
): { allowed: boolean; note: string } {
  if (!opts.isCurrentFy) return { allowed: false, note: "The regime for a past year cannot be changed." };
  if (!pg) return { allowed: false, note: "You are not in a pay group yet." };
  if (!pg.allowRegimeChoice) return { allowed: false, note: "Your payroll team has not enabled a choice of regime." };
  if (regimeLockedAt) return { allowed: false, note: "Your regime for this year has been locked by your payroll team." };
  const today = istToday(opts.now);
  if (pg.regimeChangeCutoff && dayKey(today) > dayKey(pg.regimeChangeCutoff)) {
    return { allowed: false, note: `The last date to change your tax regime was ${fmt(pg.regimeChangeCutoff)}.` };
  }
  return { allowed: true, note: pg.regimeChangeCutoff ? `You can change your regime until ${fmt(pg.regimeChangeCutoff)}.` : "You can change your regime for this year." };
}

// --- Formatting -------------------------------------------------------------

/** "INR 7,02,000" — whole rupees in Indian grouping, as Keka prints them. */
export function inr(value: unknown): string {
  const n = Math.round(Number(value ?? 0));
  return `INR ${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;
}

/** "APR 2026 - MAR 2027" */
export function fySpan(fy: number, fyStartMonth = 4): string {
  const { start, end } = fyRange(fy, fyStartMonth);
  return `${MONTH_SHORT[start.getUTCMonth()].toUpperCase()} ${start.getUTCFullYear()} - ${MONTH_SHORT[end.getUTCMonth()].toUpperCase()} ${end.getUTCFullYear()}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const two = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`);
const three = (n: number) => {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? `${h ? "and " : ""}${two(r)}` : ""].filter(Boolean).join(" ");
};
function wholeWords(n: number): string {
  if (n === 0) return "Zero";
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thousand = Math.floor((n % 1e5) / 1e3), rest = n % 1e3;
  return [
    crore ? `${wholeWords(crore)} Crore` : "",
    lakh ? `${two(lakh)} Lakh` : "",
    thousand ? `${two(thousand)} Thousand` : "",
    rest ? three(rest) : "",
  ].filter(Boolean).join(" ");
}

/** "Fifty Four Thousand Two Hundred and One Rupees Only" */
export function rupeesInWords(value: unknown): string {
  const v = Math.abs(Number(value ?? 0));
  const rupees = Math.floor(v);
  const paise = Math.round((v - rupees) * 100);
  const words = `${wholeWords(rupees)} Rupees${paise ? ` and ${two(paise)} Paise` : ""} Only`;
  return Number(value ?? 0) < 0 ? `Minus ${words}` : words;
}
