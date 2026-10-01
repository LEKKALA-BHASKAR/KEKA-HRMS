import { prisma } from "@keka/db";

/**
 * "Why?" for pay. Compares two months line by line and attributes the change
 * to causes a person recognises — a salary revision, loss of pay, a one-off
 * payment, someone joining or leaving, a deduction moving — such that the
 * causes add up to the change exactly. Nothing is estimated: every rupee in
 * an explanation is a rupee on a payslip.
 */

export interface Cause {
  /** Short label: "Salary revision", "Loss of pay", "Diwali bonus". */
  label: string;
  /** Effect on the figure being explained, signed. */
  amount: number;
  detail?: string;
  kind: "REVISION" | "ATTENDANCE" | "ONE_OFF" | "DEDUCTION" | "HEADCOUNT" | "OTHER";
}

export interface Explanation {
  from: { year: number; month: number; value: number } | null;
  to: { year: number; month: number; value: number };
  change: number;
  causes: Cause[];
  context: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const period = (y: number, m: number) => `${MONTHS[m]} ${y}`;

const DEDUCTION_REASON: Record<string, string> = {
  PF_EMPLOYEE: "12% of your PF wage, which moves with Basic",
  VPF: "your voluntary PF election",
  ESI_EMPLOYEE: "0.75% of ESI gross",
  PT: "your state's professional tax slab for the month",
  LWF_EMPLOYEE: "the state labour welfare fund schedule",
  TDS: "your projected annual tax spread over the months left in the year",
};

type RunLine = Awaited<ReturnType<typeof loadLine>>;

async function loadLine(runEmployeeId: string) {
  return prisma.payrollRunEmployee.findUniqueOrThrow({
    where: { id: runEmployeeId },
    include: { lines: true, run: { select: { year: true, month: true, payGroupId: true } } },
  });
}

/** Earnings change for one employee, split into revision, attendance and one-offs. */
function earningCauses(prev: RunLine | null, cur: RunLine | null) {
  const earn = (l: RunLine | null) => new Map((l?.lines ?? []).filter((x) => x.type === "EARNING").map((x) => [x.code, x]));
  const P = earn(prev), C = earn(cur);
  let revision = 0, attendance = 0;
  const oneOffs: Cause[] = [];
  for (const code of new Set([...P.keys(), ...C.keys()])) {
    const p = P.get(code), c = C.get(code);
    if (p && c) {
      revision += Number(c.fullAmount) - Number(p.fullAmount);
      attendance += (Number(c.amount) - Number(c.fullAmount)) - (Number(p.amount) - Number(p.fullAmount));
    } else if (c) {
      oneOffs.push({ label: c.name, amount: Number(c.amount), kind: "ONE_OFF", detail: `Paid in ${period(cur!.run.year, cur!.run.month)} only` });
    } else if (p) {
      oneOffs.push({ label: p.name, amount: -Number(p.amount), kind: "ONE_OFF", detail: `Paid in ${period(prev!.run.year, prev!.run.month)}, not this month` });
    }
  }
  return { revision: r2(revision), attendance: r2(attendance), oneOffs };
}

/** Why one employee's net pay changed between their last two runs. */
export async function explainEmployeePay(employeeId: string, opts: { runId?: string; releasedOnly?: boolean } = {}): Promise<Explanation | null> {
  // An employee sees only months whose payslip has been released to them;
  // payroll staff can explain a run while it is still open.
  const rows = await prisma.payrollRunEmployee.findMany({
    where: opts.releasedOnly
      ? { employeeId, run: { rolledBackAt: null, status: "FINALIZED", payslips: { some: { employeeId, status: "RELEASED" } } } }
      : { employeeId, run: { rolledBackAt: null, status: { in: ["FINALIZED", "LOCKED", "IN_PROGRESS", "PENDING_APPROVAL"] } } },
    include: { run: { select: { id: true, year: true, month: true } } },
    orderBy: [{ run: { year: "desc" } }, { run: { month: "desc" } }],
  });
  const idx = opts.runId ? rows.findIndex((r) => r.run.id === opts.runId) : 0;
  if (idx < 0 || !rows[idx]) return null;
  const cur = await loadLine(rows[idx].id);
  const prev = rows[idx + 1] ? await loadLine(rows[idx + 1].id) : null;
  const to = { year: cur.run.year, month: cur.run.month, value: Number(cur.netPay) };
  if (!prev) return { from: null, to, change: 0, causes: [], context: ["This is the first month on record — nothing to compare with."] };

  const causes: Cause[] = [];
  const e = earningCauses(prev, cur);
  if (e.revision) causes.push({ label: e.revision > 0 ? "Salary revision" : "Lower fixed pay", amount: e.revision, kind: "REVISION", detail: `Your full-month salary went from ₹${num(sumFull(prev))} to ₹${num(sumFull(cur))}` });
  if (e.attendance) {
    const dl = Number(cur.lopDays) - Number(prev.lopDays);
    causes.push({
      label: dl !== 0 ? "Loss of pay" : "Days paid",
      amount: e.attendance, kind: "ATTENDANCE",
      detail: dl !== 0
        ? `${Number(cur.lopDays)} LOP day(s) in ${period(cur.run.year, cur.run.month)} against ${Number(prev.lopDays)} in ${period(prev.run.year, prev.run.month)}`
        : `Paid for ${Number(cur.payableDays)} day(s) against ${Number(prev.payableDays)}`,
    });
  }
  causes.push(...e.oneOffs);

  // Deductions: an increase reduces net pay.
  const ded = (l: RunLine) => new Map(l.lines.filter((x) => x.type === "DEDUCTION").map((x) => [x.code, x]));
  const DP = ded(prev), DC = ded(cur);
  for (const code of new Set([...DP.keys(), ...DC.keys()])) {
    const p = Number(DP.get(code)?.amount ?? 0), c = Number(DC.get(code)?.amount ?? 0);
    if (r2(c - p) === 0) continue;
    const name = (DC.get(code) ?? DP.get(code))!.name;
    causes.push({ label: `${name} ${c > p ? "up" : "down"}`, amount: r2(p - c), kind: "DEDUCTION", detail: DEDUCTION_REASON[code] ?? (code.includes("LOAN") || name.includes("EMI") ? "loan repayment schedule" : undefined) });
  }

  const change = r2(Number(cur.netPay) - Number(prev.netPay));
  const explained = r2(causes.reduce((s, c) => s + c.amount, 0));
  if (r2(change - explained) !== 0) causes.push({ label: "Rounding and other", amount: r2(change - explained), kind: "OTHER" });

  const context: string[] = [];
  if (Number(cur.payableDays) !== Number(prev.payableDays)) context.push(`Paid days: ${Number(prev.payableDays)} → ${Number(cur.payableDays)}.`);
  return { from: { year: prev.run.year, month: prev.run.month, value: Number(prev.netPay) }, to, change, causes: causes.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)), context };
}

const sumFull = (l: RunLine) => r2(l.lines.filter((x) => x.type === "EARNING").reduce((s, x) => s + Number(x.fullAmount), 0));
const num = (n: number) => n.toLocaleString("en-IN");

/**
 * Why a run's total moved against the previous month of the same pay group.
 * `measure` picks gross earnings or net pay.
 */
export async function explainRun(runId: string, measure: "gross" | "net" = "gross"): Promise<Explanation | null> {
  const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
  if (!run) return null;
  const prevRun = await prisma.payrollRun.findFirst({
    where: {
      payGroupId: run.payGroupId, rolledBackAt: null, type: "REGULAR",
      OR: [{ year: run.year, month: { lt: run.month } }, { year: { lt: run.year } }],
    },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  const load = (id: string) => prisma.payrollRunEmployee.findMany({
    where: { runId: id }, include: { lines: true, run: { select: { year: true, month: true, payGroupId: true } }, employee: { select: { displayName: true, dateOfJoining: true, lastWorkingDay: true } } },
  });
  const cur = await load(runId);
  const value = (rows: typeof cur) => r2(rows.reduce((s, r) => s + Number(measure === "gross" ? r.grossEarnings : r.netPay), 0));
  const to = { year: run.year, month: run.month, value: value(cur) };
  if (!prevRun) return { from: null, to, change: 0, causes: [], context: ["No earlier month to compare with."] };
  const prev = await load(prevRun.id);

  const P = new Map(prev.map((r) => [r.employeeId, r])), C = new Map(cur.map((r) => [r.employeeId, r]));
  const joiners = cur.filter((r) => !P.has(r.employeeId));
  const leavers = prev.filter((r) => !C.has(r.employeeId));
  const pick = (r: (typeof cur)[number]) => Number(measure === "gross" ? r.grossEarnings : r.netPay);

  const causes: Cause[] = [];
  if (joiners.length) causes.push({ label: `${joiners.length} joiner${joiners.length > 1 ? "s" : ""}`, amount: r2(joiners.reduce((s, r) => s + pick(r), 0)), kind: "HEADCOUNT", detail: joiners.map((j) => j.employee.displayName).slice(0, 5).join(", ") });
  if (leavers.length) causes.push({ label: `${leavers.length} not paid this month`, amount: -r2(leavers.reduce((s, r) => s + pick(r), 0)), kind: "HEADCOUNT", detail: leavers.map((j) => j.employee.displayName).slice(0, 5).join(", ") });

  let revision = 0, attendance = 0, partMonth = 0;
  const oneOff = new Map<string, number>();
  const deductions = new Map<string, number>();
  let revisedPeople = 0, lopPeople = 0, partPeople = 0;
  const inMonth = (d: Date | null, y: number, m: number) => !!d && d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m;
  for (const c of cur) {
    const p = P.get(c.employeeId);
    if (!p) continue;
    const e = earningCauses(p as never, c as never);
    revision += e.revision;
    // Joining or leaving part-way through either month is proration, not LOP.
    const partial = inMonth(c.employee.lastWorkingDay, run.year, run.month) || inMonth(c.employee.dateOfJoining, prevRun.year, prevRun.month);
    if (partial) { partMonth += e.attendance; if (e.attendance) partPeople++; }
    else attendance += e.attendance;
    if (e.revision) revisedPeople++;
    if (Number(c.lopDays) !== Number(p.lopDays)) lopPeople++;
    for (const o of e.oneOffs) oneOff.set(o.label, (oneOff.get(o.label) ?? 0) + o.amount);
    if (measure === "net") {
      const dmap = (l: typeof c) => new Map(l.lines.filter((x) => x.type === "DEDUCTION").map((x) => [x.name, Number(x.amount)]));
      const dp = dmap(p), dc = dmap(c);
      for (const k of new Set([...dp.keys(), ...dc.keys()])) deductions.set(k, (deductions.get(k) ?? 0) + (dp.get(k) ?? 0) - (dc.get(k) ?? 0));
    }
  }
  if (r2(revision)) causes.push({ label: "Salary revisions", amount: r2(revision), kind: "REVISION", detail: `${revisedPeople} employee(s) on a new full-month salary` });
  if (r2(attendance)) causes.push({ label: "Loss of pay and paid days", amount: r2(attendance), kind: "ATTENDANCE", detail: `${lopPeople} employee(s) with different LOP from last month` });
  if (r2(partMonth)) causes.push({ label: "Part-month (joining or leaving)", amount: r2(partMonth), kind: "HEADCOUNT", detail: `${partPeople} employee(s) paid for part of a month` });
  for (const [label, amount] of oneOff) if (r2(amount)) causes.push({ label, amount: r2(amount), kind: "ONE_OFF" });
  for (const [label, amount] of deductions) if (r2(amount)) causes.push({ label: `${label} ${amount < 0 ? "up" : "down"}`, amount: r2(amount), kind: "DEDUCTION" });

  const change = r2(to.value - value(prev));
  const explained = r2(causes.reduce((s, c) => s + c.amount, 0));
  if (r2(change - explained) !== 0) causes.push({ label: "Rounding and other", amount: r2(change - explained), kind: "OTHER" });
  return {
    from: { year: prevRun.year, month: prevRun.month, value: value(prev) }, to, change,
    causes: causes.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    context: [`${prev.length} → ${cur.length} employees paid.`],
  };
}
