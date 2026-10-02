/**
 * Periodic statutory returns built from finalised payroll lines: PF Form 3A
 * (the member's annual contribution card) and Form 6A (the establishment's
 * annual consolidated return), the ESI half-yearly contribution summary, and
 * the state Professional Tax and Labour Welfare Fund returns.
 *
 * Every builder here is pure: it takes one row per employee per wage month,
 * already read from finalised runs, and lays it out with the columns the
 * standard forms carry. The exact layout of each government portal differs
 * and changes, so the output is a structured return to check against the
 * portal before filing, not a file to upload blind.
 */

export const MONTH_SHORT = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const r2 = (n: number) => Math.round(n * 100) / 100;
const fyText = (fy: number) => `${fy}-${String(fy + 1).slice(2)}`;

/** One employee's statutory figures for one finalised wage month. */
export interface ContributionRow {
  year: number;
  month: number;
  employeeId: string;
  employeeNumber: string;
  name: string;
  uan: string | null;
  esicNumber: string | null;
  grossWages: number;
  pfWage: number;
  /** Employee EPF share, excluding VPF. */
  pfEmployee: number;
  vpf: number;
  /** Employer EPF share (account 1, the difference after EPS). */
  pfEmployer: number;
  epsEmployer: number;
  ncpDays: number;
  payableDays: number;
  esiGross: number;
  esiEmployee: number;
  esiEmployer: number;
  professionalTax: number;
  lwfEmployee: number;
  lwfEmployer: number;
  /** The PT / LWF registration covering the employee's location, if any. */
  ptRegistrationId?: string | null;
  lwfRegistrationId?: string | null;
  lastWorkingDay?: string | null;
}

export interface Registration {
  id: string;
  stateCode: string;
  stateName: string;
  establishmentId: string | null;
  frequency?: string;
}

export type Cell = string | number;
export interface ReturnSection {
  heading: string;
  /** Label/value pairs printed above the table. */
  meta?: Array<[string, string]>;
  columns: Array<{ label: string; numeric?: boolean }>;
  rows: Cell[][];
  totals?: Cell[];
}
export interface StatutoryReturn {
  title: string;
  subtitle: string;
  sections: ReturnSection[];
  notes: string[];
  issues: string[];
  /** A short line for the screen, e.g. "12 members, ₹1,23,456". */
  summary: string;
}

/** The twelve wage months of a financial year, April to March. */
export function fyMonths(fy: number): Array<{ year: number; month: number }> {
  return Array.from({ length: 12 }, (_, i) => {
    const m = 4 + i;
    return m > 12 ? { year: fy + 1, month: m - 12 } : { year: fy, month: m };
  });
}

/**
 * ESI contribution periods: April–September (half 1) and October–March
 * (half 2) of the financial year.
 */
export function esiHalfMonths(fy: number, half: 1 | 2): Array<{ year: number; month: number }> {
  return fyMonths(fy).slice(half === 1 ? 0 : 6, half === 1 ? 6 : 12);
}

const key = (y: number, m: number) => y * 100 + m;
const sum = <T>(xs: T[], f: (x: T) => number) => r2(xs.reduce((s, x) => s + f(x), 0));
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function byEmployee(rows: ContributionRow[]): Map<string, ContributionRow[]> {
  const m = new Map<string, ContributionRow[]>();
  for (const r of [...rows].sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber) || key(a.year, a.month) - key(b.year, b.month))) {
    const list = m.get(r.employeeId) ?? [];
    list.push(r);
    m.set(r.employeeId, list);
  }
  return m;
}

/** Add rows that are the same month and employee — a regular and an off-cycle run. */
export function mergeMonths(rows: ContributionRow[]): ContributionRow[] {
  const m = new Map<string, ContributionRow>();
  const numeric: Array<keyof ContributionRow> = ["grossWages", "pfWage", "pfEmployee", "vpf", "pfEmployer", "epsEmployer", "ncpDays", "payableDays", "esiGross", "esiEmployee", "esiEmployer", "professionalTax", "lwfEmployee", "lwfEmployer"];
  for (const r of rows) {
    const k = `${r.employeeId}:${key(r.year, r.month)}`;
    const cur = m.get(k);
    if (!cur) { m.set(k, { ...r }); continue; }
    for (const f of numeric) (cur as unknown as Record<string, number>)[f] = r2(Number(cur[f]) + Number(r[f]));
  }
  return [...m.values()];
}

/** Worker share as the forms show it: statutory EPF plus any voluntary PF. */
const workerShare = (r: ContributionRow) => r2(r.pfEmployee + r.vpf);

// ---------------------------------------------------------------------------
//  PF Form 3A — member's annual contribution card
// ---------------------------------------------------------------------------

export function buildForm3A(input: { fy: number; rows: ContributionRow[]; establishment: { name: string; code: string | null } }): StatutoryReturn {
  const months = fyMonths(input.fy);
  const pf = mergeMonths(input.rows).filter((r) => r.pfWage > 0 || r.pfEmployee > 0);
  const issues: string[] = [];
  const sections: ReturnSection[] = [];
  for (const list of byEmployee(pf).values()) {
    const first = list[0];
    if (!first.uan) issues.push(`${first.name} (${first.employeeNumber}): no UAN on record`);
    const rows: Cell[][] = months.map(({ year, month }) => {
      const r = list.find((x) => x.year === year && x.month === month);
      return [`${MONTH_SHORT[month]} ${year}`, r?.pfWage ?? 0, r ? workerShare(r) : 0, r?.pfEmployer ?? 0, r?.epsEmployer ?? 0, 0, r ? Math.round(r.ncpDays) : 0, r?.lastWorkingDay ? `Left ${r.lastWorkingDay}` : r ? "" : "No contribution"];
    });
    sections.push({
      heading: `${first.name} — ${first.employeeNumber}`,
      meta: [["UAN / account no.", first.uan ?? "—"], ["Establishment", `${input.establishment.name}${input.establishment.code ? ` (${input.establishment.code})` : ""}`], ["Contribution period", `April ${input.fy} – March ${input.fy + 1}`]],
      columns: [{ label: "Wage month" }, { label: "EPF wages", numeric: true }, { label: "Worker share EPF", numeric: true }, { label: "Employer share EPF (A/c 1)", numeric: true }, { label: "Employer share EPS (A/c 10)", numeric: true }, { label: "Refund of advances", numeric: true }, { label: "NCP days", numeric: true }, { label: "Remarks" }],
      rows,
      totals: ["Total", sum(list, (r) => r.pfWage), sum(list, workerShare), sum(list, (r) => r.pfEmployer), sum(list, (r) => r.epsEmployer), 0, Math.round(sum(list, (r) => r.ncpDays)), ""],
    });
  }
  const total = sum(pf, (r) => workerShare(r) + r.pfEmployer + r.epsEmployer);
  return {
    title: "Form 3A — member's annual contribution card", subtitle: `Employees' Provident Fund · FY ${fyText(input.fy)}`,
    sections, issues,
    notes: ["One card per member, April to March. Refund of advances is not tracked in payroll and is shown as zero."],
    summary: `${sections.length} member card(s), ${inr(total)} contributions`,
  };
}

// ---------------------------------------------------------------------------
//  PF Form 6A — annual consolidated return
// ---------------------------------------------------------------------------

export function buildForm6A(input: { fy: number; rows: ContributionRow[]; establishment: { name: string; code: string | null } }): StatutoryReturn {
  const pf = mergeMonths(input.rows).filter((r) => r.pfWage > 0 || r.pfEmployee > 0);
  const issues: string[] = [];
  const members: Cell[][] = [];
  let i = 0;
  for (const list of byEmployee(pf).values()) {
    const first = list[0];
    if (!first.uan) issues.push(`${first.name} (${first.employeeNumber}): no UAN on record`);
    const vpf = sum(list, (r) => r.vpf);
    members.push([++i, first.uan ?? "", first.name, sum(list, (r) => r.pfWage), sum(list, workerShare), sum(list, (r) => r.pfEmployer), sum(list, (r) => r.epsEmployer), 0, vpf > 0 ? vpf : 0, list.some((r) => r.lastWorkingDay) ? `Left ${list.find((r) => r.lastWorkingDay)!.lastWorkingDay}` : ""]);
  }
  const monthly: Cell[][] = fyMonths(input.fy).map(({ year, month }) => {
    const ms = pf.filter((r) => r.year === year && r.month === month);
    return [`${MONTH_SHORT[month]} ${year}`, ms.length, sum(ms, (r) => r.pfWage), sum(ms, workerShare), sum(ms, (r) => r.pfEmployer), sum(ms, (r) => r.epsEmployer), sum(ms, (r) => workerShare(r) + r.pfEmployer + r.epsEmployer)];
  });
  const T = (f: (r: ContributionRow) => number) => sum(pf, f);
  return {
    title: "Form 6A — annual consolidated contribution return", subtitle: `Employees' Provident Fund · FY ${fyText(input.fy)}`,
    sections: [
      {
        heading: "Members",
        meta: [["Establishment", input.establishment.name], ["Code no.", input.establishment.code ?? "—"], ["Currency period", `April ${input.fy} – March ${input.fy + 1}`]],
        columns: [{ label: "Sl." }, { label: "UAN / account no." }, { label: "Member name" }, { label: "Wages (EPF)", numeric: true }, { label: "Worker contribution", numeric: true }, { label: "Employer EPF (A/c 1)", numeric: true }, { label: "Employer EPS (A/c 10)", numeric: true }, { label: "Refund of advances", numeric: true }, { label: "Of which VPF", numeric: true }, { label: "Remarks" }],
        rows: members,
        totals: ["", "", `${members.length} member(s)`, T((r) => r.pfWage), T(workerShare), T((r) => r.pfEmployer), T((r) => r.epsEmployer), 0, T((r) => r.vpf), ""],
      },
      {
        heading: "Month-wise remittance",
        columns: [{ label: "Wage month" }, { label: "Members", numeric: true }, { label: "Wages", numeric: true }, { label: "Worker share", numeric: true }, { label: "Employer EPF", numeric: true }, { label: "Employer EPS", numeric: true }, { label: "Total remitted", numeric: true }],
        rows: monthly,
        totals: ["Total", "", T((r) => r.pfWage), T(workerShare), T((r) => r.pfEmployer), T((r) => r.epsEmployer), T((r) => workerShare(r) + r.pfEmployer + r.epsEmployer)],
      },
    ],
    issues,
    notes: ["Administrative and EDLI charges are paid by the employer on the challan and are not part of this return.", "Remittance dates come from your challans; record them on the portal."],
    summary: `${members.length} member(s), ${inr(T((r) => workerShare(r) + r.pfEmployer + r.epsEmployer))} contributed`,
  };
}

// ---------------------------------------------------------------------------
//  ESI half-yearly contribution summary
// ---------------------------------------------------------------------------

export function buildEsiHalfYearly(input: { fy: number; half: 1 | 2; rows: ContributionRow[]; employer: { name: string; code: string | null } }): StatutoryReturn {
  const months = esiHalfMonths(input.fy, input.half);
  const inPeriod = mergeMonths(input.rows).filter((r) => r.esiGross > 0 && months.some((m) => m.year === r.year && m.month === r.month));
  const issues: string[] = [];
  const rows: Cell[][] = [];
  for (const list of byEmployee(inPeriod).values()) {
    const first = list[0];
    if (!first.esicNumber) issues.push(`${first.name} (${first.employeeNumber}): no ESI IP number on record`);
    const days = months.map(({ year, month }) => Math.round(list.find((r) => r.year === year && r.month === month)?.payableDays ?? 0));
    const totalDays = days.reduce((s, d) => s + d, 0);
    const wages = sum(list, (r) => r.esiGross);
    rows.push([first.esicNumber ?? "", first.name, ...days, totalDays, wages, sum(list, (r) => r.esiEmployee), sum(list, (r) => r.esiEmployer), sum(list, (r) => r.esiEmployee + r.esiEmployer), totalDays > 0 ? r2(wages / totalDays) : 0]);
  }
  const periodText = input.half === 1 ? `April – September ${input.fy}` : `October ${input.fy} – March ${input.fy + 1}`;
  const T = (f: (r: ContributionRow) => number) => sum(inPeriod, f);
  return {
    title: "ESI half-yearly contribution summary", subtitle: `Contribution period ${periodText}`,
    sections: [
      {
        heading: "Insured persons",
        meta: [["Employer", input.employer.name], ["Employer code", input.employer.code ?? "—"], ["Contribution period", periodText]],
        columns: [{ label: "IP number" }, { label: "IP name" }, ...months.map((m) => ({ label: `${MONTH_SHORT[m.month]} days`, numeric: true })), { label: "Total days", numeric: true }, { label: "Total wages", numeric: true }, { label: "IP contribution", numeric: true }, { label: "Employer contribution", numeric: true }, { label: "Total contribution", numeric: true }, { label: "Avg daily wage", numeric: true }],
        rows,
        totals: ["", `${rows.length} IP(s)`, ...months.map(() => ""), "", T((r) => r.esiGross), T((r) => r.esiEmployee), T((r) => r.esiEmployer), T((r) => r.esiEmployee + r.esiEmployer), ""],
      },
      {
        heading: "Month-wise",
        columns: [{ label: "Wage month" }, { label: "IPs", numeric: true }, { label: "Wages", numeric: true }, { label: "IP contribution", numeric: true }, { label: "Employer contribution", numeric: true }, { label: "Total", numeric: true }],
        rows: months.map(({ year, month }) => {
          const ms = inPeriod.filter((r) => r.year === year && r.month === month);
          return [`${MONTH_SHORT[month]} ${year}`, ms.length, sum(ms, (r) => r.esiGross), sum(ms, (r) => r.esiEmployee), sum(ms, (r) => r.esiEmployer), sum(ms, (r) => r.esiEmployee + r.esiEmployer)];
        }),
        totals: ["Total", "", T((r) => r.esiGross), T((r) => r.esiEmployee), T((r) => r.esiEmployer), T((r) => r.esiEmployee + r.esiEmployer)],
      },
    ],
    issues,
    notes: ["Monthly contributions are filed on the ESIC portal each month; this summary reconciles the period and supports the register of contributions."],
    summary: rows.length ? `${rows.length} insured person(s), ${inr(T((r) => r.esiEmployee + r.esiEmployer))} contributed` : "No employee was within the ESI wage limit in this period",
  };
}

// ---------------------------------------------------------------------------
//  Professional Tax — per state registration
// ---------------------------------------------------------------------------

function unmapped(rows: ContributionRow[], field: "ptRegistrationId" | "lwfRegistrationId", amount: (r: ContributionRow) => number, label: string): string[] {
  const names = new Set(rows.filter((r) => !r[field] && amount(r) > 0).map((r) => `${r.name} (${r.employeeNumber})`));
  return [...names].map((n) => `${n}: ${label} was deducted but no registration covers their location`);
}

/**
 * A PT return for one wage month (slab-wise, with the employee detail) or
 * for the whole year (month-wise), one section per state registration.
 */
export function buildPtReturn(input: { fy: number; month?: { year: number; month: number } | null; rows: ContributionRow[]; registrations: Registration[] }): StatutoryReturn {
  const months = input.month ? [input.month] : fyMonths(input.fy);
  const rows = mergeMonths(input.rows).filter((r) => months.some((m) => m.year === r.year && m.month === r.month));
  const sections: ReturnSection[] = [];
  let total = 0;
  for (const reg of input.registrations) {
    const mine = rows.filter((r) => r.ptRegistrationId === reg.id);
    const meta: Array<[string, string]> = [["State", `${reg.stateName} (${reg.stateCode})`], ["Registration / enrolment no.", reg.establishmentId ?? "—"], ["Frequency", (reg.frequency ?? "MONTHLY").toLowerCase().replace(/_/g, "-")]];
    total += sum(mine, (r) => r.professionalTax);
    if (input.month) {
      // Slab-wise: how many employees paid each amount, as the state forms tabulate it.
      const slabs = new Map<number, ContributionRow[]>();
      for (const r of mine) slabs.set(r.professionalTax, [...(slabs.get(r.professionalTax) ?? []), r]);
      const slabRows = [...slabs.entries()].sort((a, b) => a[0] - b[0]).map(([amt, list]): Cell[] => [amt === 0 ? "Nil (below threshold)" : `₹${amt} per employee`, list.length, sum(list, (r) => r.grossWages), sum(list, (r) => r.professionalTax)]);
      sections.push({
        heading: `${reg.stateName} — ${MONTH_SHORT[input.month.month]} ${input.month.year}`, meta,
        columns: [{ label: "Rate" }, { label: "Employees", numeric: true }, { label: "Gross salary", numeric: true }, { label: "Tax deducted", numeric: true }],
        rows: slabRows, totals: ["Total", mine.length, sum(mine, (r) => r.grossWages), sum(mine, (r) => r.professionalTax)],
      });
      sections.push({
        heading: `${reg.stateName} — employee detail`,
        columns: [{ label: "Employee no." }, { label: "Name" }, { label: "Gross salary", numeric: true }, { label: "PT", numeric: true }],
        rows: [...mine].sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber)).map((r) => [r.employeeNumber, r.name, r.grossWages, r.professionalTax]),
        totals: ["", `${mine.length} employee(s)`, sum(mine, (r) => r.grossWages), sum(mine, (r) => r.professionalTax)],
      });
    } else {
      sections.push({
        heading: `${reg.stateName} — annual summary`, meta,
        columns: [{ label: "Wage month" }, { label: "Employees", numeric: true }, { label: "Liable", numeric: true }, { label: "Gross salary", numeric: true }, { label: "Tax deducted", numeric: true }],
        rows: months.map(({ year, month }) => {
          const ms = mine.filter((r) => r.year === year && r.month === month);
          return [`${MONTH_SHORT[month]} ${year}`, ms.length, ms.filter((r) => r.professionalTax > 0).length, sum(ms, (r) => r.grossWages), sum(ms, (r) => r.professionalTax)];
        }),
        totals: ["Total", "", "", sum(mine, (r) => r.grossWages), sum(mine, (r) => r.professionalTax)],
      });
    }
  }
  const period = input.month ? `${MONTH_SHORT[input.month.month]} ${input.month.year}` : `FY ${fyText(input.fy)}`;
  return {
    title: input.month ? "Professional Tax — monthly return" : "Professional Tax — annual return",
    subtitle: `${period} · per state registration`, sections,
    issues: unmapped(rows, "ptRegistrationId", (r) => r.professionalTax, "professional tax"),
    notes: ["Each state has its own form (Form 5 in Karnataka, Form III-B in Maharashtra, and so on); copy these figures into it."],
    summary: `${input.registrations.length} registration(s), ${inr(total)} deducted`,
  };
}

// ---------------------------------------------------------------------------
//  Labour Welfare Fund — per state registration
// ---------------------------------------------------------------------------

/** One section per state and contribution month in the year, employee by employee. */
export function buildLwfReturn(input: { fy: number; rows: ContributionRow[]; registrations: Registration[] }): StatutoryReturn {
  const months = fyMonths(input.fy);
  const rows = mergeMonths(input.rows).filter((r) => months.some((m) => m.year === r.year && m.month === r.month));
  const sections: ReturnSection[] = [];
  let total = 0;
  for (const reg of input.registrations) {
    const mine = rows.filter((r) => r.lwfRegistrationId === reg.id && (r.lwfEmployee > 0 || r.lwfEmployer > 0));
    const meta: Array<[string, string]> = [["State", `${reg.stateName} (${reg.stateCode})`], ["Registration no.", reg.establishmentId ?? "—"]];
    const contributed = months.filter(({ year, month }) => mine.some((r) => r.year === year && r.month === month));
    total += sum(mine, (r) => r.lwfEmployee + r.lwfEmployer);
    if (contributed.length === 0) {
      sections.push({ heading: `${reg.stateName} — no contribution in FY ${fyText(input.fy)}`, meta, columns: [{ label: "Note" }], rows: [["No LWF was deducted under this registration in the year."]] });
      continue;
    }
    for (const { year, month } of contributed) {
      const ms = mine.filter((r) => r.year === year && r.month === month).sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber));
      sections.push({
        heading: `${reg.stateName} — ${MONTH_SHORT[month]} ${year}`, meta,
        columns: [{ label: "Employee no." }, { label: "Name" }, { label: "Gross salary", numeric: true }, { label: "Employee contribution", numeric: true }, { label: "Employer contribution", numeric: true }, { label: "Total", numeric: true }],
        rows: ms.map((r) => [r.employeeNumber, r.name, r.grossWages, r.lwfEmployee, r.lwfEmployer, r2(r.lwfEmployee + r.lwfEmployer)]),
        totals: ["", `${ms.length} employee(s)`, sum(ms, (r) => r.grossWages), sum(ms, (r) => r.lwfEmployee), sum(ms, (r) => r.lwfEmployer), sum(ms, (r) => r.lwfEmployee + r.lwfEmployer)],
      });
    }
  }
  return {
    title: "Labour Welfare Fund — returns", subtitle: `FY ${fyText(input.fy)} · per state registration and contribution month`,
    sections, issues: unmapped(rows, "lwfRegistrationId", (r) => r.lwfEmployee, "LWF"),
    notes: ["Most states collect LWF in June and December or once in December; the welfare board's form is filed with the challan for that period."],
    summary: `${input.registrations.length} registration(s), ${inr(total)} contributed`,
  };
}

// ---------------------------------------------------------------------------
//  CSV
// ---------------------------------------------------------------------------

const csvCell = (v: Cell) => {
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v.replace(/₹/g, "Rs. ");
  // Leading = + - @ would be run as a formula by spreadsheet apps.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The whole return as one CSV: a title block, then each section's table. */
export function returnToCsv(r: StatutoryReturn): string {
  const out: Cell[][] = [[r.title], [r.subtitle], ["Check every figure against the current portal format before filing."], []];
  for (const s of r.sections) {
    out.push([s.heading]);
    for (const [k, v] of s.meta ?? []) out.push([k, v]);
    out.push(s.columns.map((c) => c.label));
    out.push(...s.rows);
    if (s.totals) out.push(s.totals);
    out.push([]);
  }
  if (r.issues.length) { out.push(["Issues"]); for (const i of r.issues) out.push([i]); }
  return "﻿" + out.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
