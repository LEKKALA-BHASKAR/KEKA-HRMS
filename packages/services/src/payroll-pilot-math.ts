/**
 * Pure rules behind the attendance cut-off, salary payouts and the 24Q
 * statement. Kept free of the database so each can be unit tested; the
 * services in payroll-run.ts, payroll-payout.ts and tds-24q.ts feed them.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
//  Attendance cut-off
// ---------------------------------------------------------------------------

/**
 * The dates whose attendance and unpaid leave a run counts as LOP.
 *
 * It starts the day after the previous run's window ended (or the period
 * start for the first run) and ends on the cut-off day, clamped to the
 * period end — day 31 in a 30-day month means the month end. With no cut-off
 * the window ends at the period end. LOP after the cut-off therefore falls
 * into the next run's window instead of being lost.
 *
 * A previous window that ended long ago (a skipped month) is not reached
 * back into beyond the start of the previous calendar month.
 */
export function attendanceWindow(opts: {
  year: number; month: number; periodStart: Date; periodEnd: Date;
  cutoffDay: number | null | undefined; previousTo: Date | null | undefined;
}): { from: Date; to: Date } {
  const { year, month, periodStart, periodEnd } = opts;
  let to = periodEnd;
  if (opts.cutoffDay && opts.cutoffDay > 0) {
    const cut = new Date(Date.UTC(year, month - 1, opts.cutoffDay));
    // Date.UTC rolls day 31 of a 30-day month into the next; clamp instead.
    if (cut.getUTCMonth() === month - 1 && cut < periodEnd) to = cut;
  }
  let from = periodStart;
  if (opts.previousTo) {
    const floor = new Date(Date.UTC(year, month - 2, 1));
    const next = new Date(opts.previousTo.getTime() + DAY);
    from = next < floor ? floor : next;
  }
  return { from, to };
}

export interface PriorCount {
  year: number; month: number;
  /** LOP the closed run counted over its window. */
  counted: number;
  /** LOP over that same window as the records stand today. */
  current: number;
  /** Already carried into other finalised runs (signed days). */
  alreadyCarried: number;
  /** The closed month's day rate for LOP-applicable pay. */
  dayRate: number;
}

export interface CarryEntry { year: number; month: number; days: number; amount: number }

/**
 * Compare what closed runs counted with what the records now say.
 *
 * More LOP than was counted (attendance regularised as absent, leave turned
 * unpaid after the run) is charged as LOP days in this run. Less (LOP
 * reversed after the run) is paid back as arrears at the closed month's day
 * rate, because that is the rate it was deducted at.
 */
export function lopCarry(priors: PriorCount[]): { lateDays: number; reversalDays: number; arrears: number; entries: CarryEntry[] } {
  const entries: CarryEntry[] = [];
  let lateDays = 0, reversalDays = 0, arrears = 0;
  for (const p of priors) {
    const delta = r2(p.current - p.counted - p.alreadyCarried);
    if (Math.abs(delta) < 0.01) continue;
    if (delta > 0) {
      entries.push({ year: p.year, month: p.month, days: delta, amount: 0 });
      lateDays += delta;
    } else {
      const amount = r2(-delta * p.dayRate);
      entries.push({ year: p.year, month: p.month, days: delta, amount });
      reversalDays += -delta;
      arrears += amount;
    }
  }
  return { lateDays: r2(lateDays), reversalDays: r2(reversalDays), arrears: r2(arrears), entries };
}

/** A month's per-day value of the pay that LOP prorates. */
export function lopDayRate(lines: Array<{ type: string; code: string; fullAmount: number }>, lopCodes: Set<string>, totalDays: number): number {
  if (totalDays <= 0) return 0;
  const full = lines.filter((l) => l.type === "EARNING" && lopCodes.has(l.code)).reduce((s, l) => s + l.fullAmount, 0);
  return r2(full / totalDays);
}

// ---------------------------------------------------------------------------
//  Payouts
// ---------------------------------------------------------------------------

/** Something a run owes one person through the bank. */
export interface Payable { employeeId: string; holdId: string | null; amount: number }
export interface PaymentAttempt { employeeId: string; holdId: string | null; status: "PENDING" | "PAID" | "FAILED"; batchNumber: number }

export const payableKey = (p: { employeeId: string; holdId: string | null }) => `${p.employeeId}:${p.holdId ?? ""}`;

/**
 * Where each payable stands, judged by its latest attempt: never batched,
 * waiting on the bank, paid, or failed (and so ready to re-batch).
 */
export function payoutState(payables: Payable[], attempts: PaymentAttempt[]): {
  unbatched: Payable[]; pending: Payable[]; paid: Payable[]; failed: Payable[];
} {
  const latest = new Map<string, PaymentAttempt>();
  for (const a of [...attempts].sort((x, y) => x.batchNumber - y.batchNumber)) {
    const k = payableKey(a);
    const cur = latest.get(k);
    // Within one batch a settled outcome outranks a pending one.
    if (!cur || a.batchNumber > cur.batchNumber || cur.status === "PENDING") latest.set(k, a);
  }
  const out = { unbatched: [] as Payable[], pending: [] as Payable[], paid: [] as Payable[], failed: [] as Payable[] };
  for (const p of payables) {
    const a = latest.get(payableKey(p));
    if (!a) out.unbatched.push(p);
    else if (a.status === "PAID") out.paid.push(p);
    else if (a.status === "FAILED") out.failed.push(p);
    else out.pending.push(p);
  }
  return out;
}

/** Bank-file warnings for transfers to accounts nobody has verified. */
export function unverifiedWarnings(rows: Array<{ name: string; accountNumber: string | null; verified: boolean }>): string[] {
  return rows.filter((r) => !r.verified).map((r) => `${r.name}: bank account ${r.accountNumber ? `XXXX${r.accountNumber.slice(-4)}` : "(none)"} is not verified — check it before upload`);
}

// ---------------------------------------------------------------------------
//  Form 24Q statement
// ---------------------------------------------------------------------------

export interface ChallanRow {
  id: string; year: number; month: number; bsrCode: string; challanNumber: string; paymentDate: Date;
  tdsAmount: number; surcharge: number; cess: number; interest: number; fee: number;
}
export interface DeducteeRow {
  employeeId: string; employeeNumber: string; name: string; pan: string | null;
  year: number; month: number; paymentDate: Date; amountPaid: number; tds: number;
}

const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
const csvCell = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** Checks a challan the way the bank's counterfoil reads: 7-digit BSR, 5-digit serial. */
export function challanIssues(c: { bsrCode: string; challanNumber: string; tdsAmount: number }): string[] {
  const out: string[] = [];
  if (!/^\d{7}$/.test(c.bsrCode)) out.push("BSR code must be 7 digits");
  if (!/^\d{1,5}$/.test(c.challanNumber)) out.push("Challan serial number must be up to 5 digits");
  if (!(c.tdsAmount > 0)) out.push("Amount must be above zero");
  return out;
}

/**
 * The quarter's 24Q data: each month's deductee rows matched to that month's
 * challans, with the reconciliation an FVU would reject on — TDS deducted
 * versus deposited, and PANs.
 *
 * Deductee rows of a month are booked against its challans in order until
 * each challan's TDS is used up (the way return utilities allocate), so a
 * row may be split across two challans.
 */
export function form24qStatement(deductees: DeducteeRow[], challans: ChallanRow[]): {
  months: Array<{ year: number; month: number; deducted: number; deposited: number; challans: number; employees: number }>;
  allocations: Array<DeducteeRow & { challanId: string | null; challanSerial: string | null; bsrCode: string | null; depositDate: Date | null; tdsBooked: number }>;
  issues: string[];
  csv: string;
} {
  const issues: string[] = [];
  const monthKeys = [...new Set([...deductees, ...challans].map((r) => r.year * 100 + r.month))].sort((a, b) => a - b);
  const months: Array<{ year: number; month: number; deducted: number; deposited: number; challans: number; employees: number }> = [];
  const allocations: Array<DeducteeRow & { challanId: string | null; challanSerial: string | null; bsrCode: string | null; depositDate: Date | null; tdsBooked: number }> = [];

  for (const key of monthKeys) {
    const year = Math.floor(key / 100), month = key % 100;
    const label = `${String(month).padStart(2, "0")}/${year}`;
    const rows = deductees.filter((d) => d.year === year && d.month === month);
    const cs = challans.filter((c) => c.year === year && c.month === month).sort((a, b) => a.paymentDate.getTime() - b.paymentDate.getTime());
    const deducted = r2(rows.reduce((s, r) => s + r.tds, 0));
    const deposited = r2(cs.reduce((s, c) => s + c.tdsAmount, 0));
    months.push({ year, month, deducted, deposited, challans: cs.length, employees: new Set(rows.map((r) => r.employeeId)).size });
    if (deducted > 0 && cs.length === 0) issues.push(`${label}: ₹${deducted.toLocaleString("en-IN")} TDS deducted but no challan recorded`);
    else if (Math.abs(deducted - deposited) >= 1) issues.push(`${label}: TDS deducted ₹${deducted.toLocaleString("en-IN")} but challans total ₹${deposited.toLocaleString("en-IN")}`);
    for (const c of cs) for (const i of challanIssues(c)) issues.push(`${label} challan ${c.challanNumber || "?"}: ${i}`);

    // Book each row's TDS against the month's challans in order.
    const left = cs.map((c) => ({ c, left: c.tdsAmount }));
    let ci = 0;
    for (const r of rows) {
      if (r.tds <= 0) { allocations.push({ ...r, challanId: cs[0]?.id ?? null, challanSerial: cs[0]?.challanNumber ?? null, bsrCode: cs[0]?.bsrCode ?? null, depositDate: cs[0]?.paymentDate ?? null, tdsBooked: 0 }); continue; }
      let due = r.tds, paidBooked = 0;
      while (due > 0.004) {
        while (ci < left.length && left[ci].left <= 0.004) ci++;
        const slot = left[ci];
        if (!slot) { allocations.push({ ...r, amountPaid: r2(r.amountPaid - paidBooked), challanId: null, challanSerial: null, bsrCode: null, depositDate: null, tdsBooked: r2(due) }); break; }
        const take = Math.min(due, slot.left);
        slot.left = r2(slot.left - take);
        due = r2(due - take);
        // A split row splits its amount paid in the same proportion.
        const share = due > 0.004 ? r2(r.amountPaid * take / r.tds) : r2(r.amountPaid - paidBooked);
        paidBooked = r2(paidBooked + share);
        allocations.push({ ...r, amountPaid: share, challanId: slot.c.id, challanSerial: slot.c.challanNumber, bsrCode: slot.c.bsrCode, depositDate: slot.c.paymentDate, tdsBooked: r2(take) });
      }
    }
  }
  for (const d of deductees) {
    if (!d.pan || !PAN.test(d.pan.toUpperCase())) issues.push(`${d.employeeNumber} ${d.name}: no valid PAN — reported as PANNOTAVBL (20% rate under s.206AA)`);
  }

  // Two sections in one file: challans (the CD records of an FVU file) then
  // deductees against them (the DD records).
  const lines: string[][] = [
    ["Record", "Challan serial", "BSR code", "Date of deposit", "Salary month", "TDS", "Surcharge", "Cess", "Interest", "Fee", "Total deposited"],
    ...challans.map((c) => ["CHALLAN", c.challanNumber, c.bsrCode, ddmmyyyy(c.paymentDate), `${String(c.month).padStart(2, "0")}/${c.year}`, c.tdsAmount.toFixed(2), c.surcharge.toFixed(2), c.cess.toFixed(2), c.interest.toFixed(2), c.fee.toFixed(2), (c.tdsAmount + c.surcharge + c.cess + c.interest + c.fee).toFixed(2)]),
    [],
    ["Record", "Challan serial", "BSR code", "Date of deposit", "Section", "Employee number", "PAN", "Name", "Date of payment", "Amount paid", "TDS deducted", "TDS deposited", "Remark"],
    ...allocations.map((a) => {
      const pan = a.pan && PAN.test(a.pan.toUpperCase()) ? a.pan.toUpperCase() : "PANNOTAVBL";
      return ["DEDUCTEE", a.challanSerial ?? "", a.bsrCode ?? "", a.depositDate ? ddmmyyyy(a.depositDate) : "", "192", a.employeeNumber, pan, a.name, ddmmyyyy(a.paymentDate), a.amountPaid.toFixed(2), a.tds.toFixed(2), a.challanId ? a.tdsBooked.toFixed(2) : "0.00", a.challanId ? "" : "NO CHALLAN"];
    }),
  ];
  return { months, allocations, issues, csv: lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n" };
}
