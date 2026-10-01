import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import { fyStartYear } from "@keka/shared";
import { journeyProgress } from "@keka/services";
import { can, type Viewer } from "./context";
import { scopedEmployeeWhere } from "./scope";

/**
 * Reports are definitions, not pages: each declares its permission, scopes
 * its own rows through that permission, and returns columns and rows. One
 * renderer draws them and one route exports any of them as CSV, so a report
 * on screen and its download can never disagree.
 */

const P = PERMISSIONS;
const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export type Format = "text" | "int" | "inr" | "pct" | "date" | "num";
export interface Column { key: string; label: string; format?: Format }
export interface ReportResult {
  columns: Column[];
  rows: Array<Record<string, unknown> & { _href?: string; _tone?: "danger" | "warning" }>;
  totals?: Record<string, unknown>;
  notes?: string[];
}
export interface ReportParams { fy: number; month?: number }
export interface ReportDef {
  key: string;
  title: string;
  group: "People" | "Payroll" | "Time" | "Operations" | "Compliance";
  description: string;
  permission: Permission;
  run(viewer: Viewer, params: ReportParams): Promise<ReportResult>;
}

const fyMonths = (fy: number) => Array.from({ length: 12 }, (_, i) => ({ year: i < 9 ? fy : fy + 1, month: ((i + 3) % 12) + 1 }));
const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 1));
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0));
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------

const headcount: ReportDef = {
  key: "headcount", title: "Headcount by department", group: "People", permission: P.REPORT_VIEW,
  description: "Who is employed today, by department and status, with gender mix and average tenure.",
  async run(viewer) {
    const emps = await prisma.employee.findMany({
      where: { ...scopedEmployeeWhere(viewer, P.REPORT_VIEW), status: { notIn: ["EXITED", "PREBOARDING"] } },
      select: { status: true, gender: true, dateOfJoining: true, department: { select: { name: true } } },
    });
    const by = new Map<string, typeof emps>();
    for (const e of emps) by.set(e.department?.name ?? "Unassigned", [...(by.get(e.department?.name ?? "Unassigned") ?? []), e]);
    const row = (name: string, list: typeof emps) => ({
      department: name, total: list.length,
      probation: list.filter((e) => e.status === "PROBATION").length,
      notice: list.filter((e) => e.status === "NOTICE_PERIOD").length,
      female: list.length ? list.filter((e) => e.gender === "FEMALE").length / list.length : 0,
      tenure: list.length ? r2(list.reduce((s, e) => s + (Date.now() - e.dateOfJoining.getTime()) / (365.25 * DAY), 0) / list.length) : 0,
    });
    return {
      columns: [
        { key: "department", label: "Department" }, { key: "total", label: "Headcount", format: "int" },
        { key: "probation", label: "On probation", format: "int" }, { key: "notice", label: "Serving notice", format: "int" },
        { key: "female", label: "Women", format: "pct" }, { key: "tenure", label: "Avg tenure (yrs)", format: "num" },
      ],
      rows: [...by.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => row(k, v)),
      totals: row("All", emps),
    };
  },
};

const attrition: ReportDef = {
  key: "attrition", title: "Joiners, leavers and attrition", group: "People", permission: P.REPORT_VIEW,
  description: "Month by month for the financial year: opening headcount, joiners, leavers, and the annualised attrition rate.",
  async run(viewer, { fy }) {
    const scope = scopedEmployeeWhere(viewer, P.REPORT_VIEW);
    const emps = await prisma.employee.findMany({
      where: scope,
      select: { dateOfJoining: true, lastWorkingDay: true, status: true, exitRecord: { select: { type: true, status: true } } },
    });
    const left = (e: (typeof emps)[number]) => e.lastWorkingDay && (e.status === "EXITED" || (e.exitRecord && ["APPROVED", "IN_CLEARANCE", "SETTLED", "COMPLETED"].includes(e.exitRecord.status))) ? e.lastWorkingDay : null;
    const today = new Date();
    const rows = fyMonths(fy).filter((m) => monthStart(m.year, m.month) <= today).map((m) => {
      const s = monthStart(m.year, m.month), e = monthEnd(m.year, m.month);
      const opening = emps.filter((x) => x.dateOfJoining < s && !(left(x) && left(x)! < s)).length;
      const joiners = emps.filter((x) => x.dateOfJoining >= s && x.dateOfJoining <= e).length;
      const leavers = emps.filter((x) => { const l = left(x); return l && l >= s && l <= e; });
      const closing = opening + joiners - leavers.length;
      const avg = (opening + closing) / 2 || 1;
      return {
        month: `${MONTHS[m.month]} ${m.year}`, opening, joiners, leavers: leavers.length,
        voluntary: leavers.filter((x) => x.exitRecord?.type === "RESIGNATION").length,
        closing, rate: (leavers.length / avg) * 12,
      };
    });
    const totalLeavers = rows.reduce((s, r) => s + r.leavers, 0);
    const avgHead = rows.length ? rows.reduce((s, r) => s + (r.opening + r.closing) / 2, 0) / rows.length : 1;
    return {
      columns: [
        { key: "month", label: "Month" }, { key: "opening", label: "Opening", format: "int" }, { key: "joiners", label: "Joiners", format: "int" },
        { key: "leavers", label: "Leavers", format: "int" }, { key: "voluntary", label: "of which resigned", format: "int" },
        { key: "closing", label: "Closing", format: "int" }, { key: "rate", label: "Annualised attrition", format: "pct" },
      ],
      rows,
      totals: { month: "Year to date", joiners: rows.reduce((s, r) => s + r.joiners, 0), leavers: totalLeavers, voluntary: rows.reduce((s, r) => s + r.voluntary, 0), rate: rows.length ? (totalLeavers / avgHead) * (12 / rows.length) : 0 },
      notes: ["Leavers count in the month of their last working day. Attrition is annualised: leavers ÷ average headcount × 12."],
    };
  },
};

const payrollSummary: ReportDef = {
  key: "payroll-summary", title: "Payroll cost by month", group: "Payroll", permission: P.PAYROLL_VIEW,
  description: "Every run in the year: gross, deductions, net and what the company actually spends. Open a month to see why it moved.",
  async run(viewer, { fy }) {
    const runs = await prisma.payrollRun.findMany({
      where: { tenantId: viewer.tenantId, rolledBackAt: null, OR: [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: 3 } }] },
      orderBy: [{ year: "asc" }, { month: "asc" }], include: { payGroup: { select: { name: true } } },
    });
    const rows = runs.map((r) => ({
      month: `${MONTHS[r.month]} ${r.year}`, group: r.payGroup.name, status: r.status.toLowerCase().replace("_", " "),
      employees: r.employeeCount, gross: Number(r.totalGross), deductions: Number(r.totalDeductions),
      net: Number(r.totalNetPay), cost: Number(r.totalEmployerCost), _href: `/payroll/runs/${r.id}`,
    }));
    const sum = (k: "gross" | "deductions" | "net" | "cost") => rows.reduce((s, r) => s + r[k], 0);
    return {
      columns: [
        { key: "month", label: "Month" }, { key: "group", label: "Pay group" }, { key: "status", label: "Status" },
        { key: "employees", label: "Paid", format: "int" }, { key: "gross", label: "Gross", format: "inr" },
        { key: "deductions", label: "Deductions", format: "inr" }, { key: "net", label: "Net", format: "inr" }, { key: "cost", label: "Employer cost", format: "inr" },
      ],
      rows, totals: { month: "Year to date", gross: sum("gross"), deductions: sum("deductions"), net: sum("net"), cost: sum("cost") },
    };
  },
};

const payrollByDept: ReportDef = {
  key: "payroll-by-department", title: "Payroll cost by department", group: "Payroll", permission: P.PAY_REGISTER_VIEW,
  description: "The latest finalised month split by department — who costs what, and the average per head.",
  async run(viewer) {
    const run = await prisma.payrollRun.findFirst({ where: { tenantId: viewer.tenantId, status: "FINALIZED", rolledBackAt: null }, orderBy: [{ year: "desc" }, { month: "desc" }] });
    if (!run) return { columns: [], rows: [], notes: ["No finalised payroll yet."] };
    const lines = await prisma.payrollRunEmployee.findMany({
      where: { runId: run.id, employee: scopedEmployeeWhere(viewer, P.PAY_REGISTER_VIEW) },
      select: { grossEarnings: true, netPay: true, employerCost: true, employee: { select: { department: { select: { name: true } } } } },
    });
    const by = new Map<string, { n: number; gross: number; net: number; cost: number }>();
    for (const l of lines) {
      const k = l.employee.department?.name ?? "Unassigned";
      const c = by.get(k) ?? { n: 0, gross: 0, net: 0, cost: 0 };
      c.n++; c.gross += Number(l.grossEarnings); c.net += Number(l.netPay); c.cost += Number(l.employerCost);
      by.set(k, c);
    }
    const total = [...by.values()].reduce((s, c) => s + c.cost, 0) || 1;
    return {
      columns: [
        { key: "department", label: "Department" }, { key: "n", label: "Paid", format: "int" }, { key: "gross", label: "Gross", format: "inr" },
        { key: "cost", label: "Employer cost", format: "inr" }, { key: "share", label: "Share of cost", format: "pct" }, { key: "avg", label: "Cost per head", format: "inr" },
      ],
      rows: [...by.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([k, c]) => ({ department: k, n: c.n, gross: c.gross, cost: c.cost, share: c.cost / total, avg: c.cost / c.n })),
      notes: [`${MONTHS[run.month]} ${run.year}.`],
    };
  },
};

/** Due dates as the statutes set them. */
function dueDates(y: number, m: number) {
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return {
    pfEsi: new Date(Date.UTC(next.y, next.m - 1, 15)),
    // TDS for March is due 30 April; otherwise the 7th of the next month.
    tds: m === 3 ? new Date(Date.UTC(y, 3, 30)) : new Date(Date.UTC(next.y, next.m - 1, 7)),
  };
}

const statutoryDues: ReportDef = {
  key: "statutory-dues", title: "Statutory dues and deadlines", group: "Compliance", permission: P.STATUTORY_MANAGE,
  description: "PF, ESI, PT, LWF and TDS by month — what is owed, by when, and whether it has been filed.",
  async run(viewer, { fy }) {
    const runs = await prisma.payrollRun.findMany({
      where: { tenantId: viewer.tenantId, rolledBackAt: null, status: { in: ["FINALIZED", "LOCKED"] }, OR: [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: 3 } }] },
      orderBy: [{ year: "asc" }, { month: "asc" }],
    });
    const filings = await prisma.statutoryFiling.findMany({ where: { tenantId: viewer.tenantId, fyStartYear: fy } });
    const filed = (type: string, month: number) => filings.find((f) => f.type === type && f.month === month && (f.status === "FILED" || f.status === "ACKNOWLEDGED"));
    const today = new Date();
    const rows = [];
    for (const r of runs) {
      const agg = await prisma.payrollRunEmployee.aggregate({
        where: { runId: r.id },
        _sum: { pfEmployee: true, pfEmployer: true, epsEmployer: true, vpf: true, esiEmployee: true, esiEmployer: true, professionalTax: true, lwfEmployee: true, lwfEmployer: true, tds: true },
      });
      const s = agg._sum, d = dueDates(r.year, r.month);
      const pf = Number(s.pfEmployee ?? 0) + Number(s.pfEmployer ?? 0) + Number(s.epsEmployer ?? 0) + Number(s.vpf ?? 0);
      const esi = Number(s.esiEmployee ?? 0) + Number(s.esiEmployer ?? 0);
      const pfFiled = !!filed("PF_ECR", r.month), esiFiled = !!filed("ESI_ECR", r.month);
      const late = d.pfEsi < today && ((!pfFiled && pf > 0) || (!esiFiled && esi > 0));
      rows.push({
        month: `${MONTHS[r.month]} ${r.year}`, pf, esi, pt: Number(s.professionalTax ?? 0),
        lwf: Number(s.lwfEmployee ?? 0) + Number(s.lwfEmployer ?? 0), tds: Number(s.tds ?? 0),
        pfDue: d.pfEsi, tdsDue: d.tds,
        status: (pf === 0 || pfFiled) && (esi === 0 || esiFiled) ? "filed" : late ? "overdue" : "due",
        _tone: late ? "danger" as const : undefined,
      });
    }
    return {
      columns: [
        { key: "month", label: "Wage month" }, { key: "pf", label: "PF (all)", format: "inr" }, { key: "esi", label: "ESI", format: "inr" },
        { key: "pt", label: "PT", format: "inr" }, { key: "lwf", label: "LWF", format: "inr" }, { key: "tds", label: "TDS", format: "inr" },
        { key: "pfDue", label: "PF/ESI due", format: "date" }, { key: "tdsDue", label: "TDS due", format: "date" }, { key: "status", label: "Status" },
      ],
      rows,
      notes: ["PF and ESI are due on the 15th of the following month; TDS on the 7th (30 April for March). Generate and file from Payroll → Filings to clear a month."],
    };
  },
};

const leaveUtil: ReportDef = {
  key: "leave-utilisation", title: "Leave utilisation", group: "Time", permission: P.LEAVE_VIEW,
  description: "For each leave type this year: credited, used, still available, and how much of the entitlement is being taken.",
  async run(viewer, { fy }) {
    const ids = (await prisma.employee.findMany({ where: scopedEmployeeWhere(viewer, P.LEAVE_VIEW), select: { id: true } })).map((e) => e.id);
    const yearStart = new Date(Date.UTC(fy, viewer.tenant.fyStartMonth - 1, 1));
    const balances = await prisma.leaveBalance.findMany({ where: { employeeId: { in: ids }, yearStart }, include: { leaveType: { select: { name: true, isPaid: true } } } });
    const by = new Map<string, { people: number; credited: number; used: number; available: number }>();
    for (const b of balances) {
      const c = by.get(b.leaveType.name) ?? { people: 0, credited: 0, used: 0, available: 0 };
      c.people++; c.credited += Number(b.opening) + Number(b.accrued) + Number(b.carriedForward); c.used += Number(b.used); c.available += Number(b.available);
      by.set(b.leaveType.name, c);
    }
    return {
      columns: [
        { key: "type", label: "Leave type" }, { key: "people", label: "Employees", format: "int" }, { key: "credited", label: "Credited", format: "num" },
        { key: "used", label: "Used", format: "num" }, { key: "available", label: "Available", format: "num" }, { key: "rate", label: "Taken", format: "pct" },
      ],
      rows: [...by.entries()].map(([k, c]) => ({ type: k, ...c, credited: r2(c.credited), used: r2(c.used), available: r2(c.available), rate: c.credited ? c.used / c.credited : 0 })),
    };
  },
};

const attendanceSummary: ReportDef = {
  key: "attendance-summary", title: "Attendance and loss of pay", group: "Time", permission: P.ATTENDANCE_VIEW,
  description: "One month per employee: days present, absent, on leave, late arrivals, LOP and average hours.",
  async run(viewer, { fy, month }) {
    const now = new Date();
    const m = month ?? now.getUTCMonth() + 1;
    const y = m >= 4 ? fy : fy + 1;
    const emps = await prisma.employee.findMany({ where: { ...scopedEmployeeWhere(viewer, P.ATTENDANCE_VIEW), status: { notIn: ["PREBOARDING"] } }, select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } }, orderBy: { employeeNumber: "asc" } });
    const recs = await prisma.attendanceRecord.findMany({ where: { employeeId: { in: emps.map((e) => e.id) }, date: { gte: monthStart(y, m), lte: monthEnd(y, m) } } });
    const by = new Map<string, typeof recs>();
    for (const r of recs) by.set(r.employeeId, [...(by.get(r.employeeId) ?? []), r]);
    const rows = emps.filter((e) => by.has(e.id)).map((e) => {
      const rs = by.get(e.id)!;
      const worked = rs.filter((r) => Number(r.effectiveHours) > 0);
      const lop = rs.reduce((s, r) => s + Number(r.lopValue), 0);
      return {
        employee: e.displayName, number: e.employeeNumber, department: e.department?.name ?? "",
        present: rs.filter((r) => ["PRESENT", "WORK_FROM_HOME", "ON_DUTY"].includes(r.status)).length + rs.filter((r) => r.status === "HALF_DAY").length * 0.5,
        leave: rs.filter((r) => r.status === "ON_LEAVE").length,
        absent: rs.filter((r) => ["ABSENT", "NO_ATTENDANCE"].includes(r.status)).length,
        late: rs.filter((r) => r.remark?.includes("Late by")).length,
        lop, hours: worked.length ? r2(worked.reduce((s, r) => s + Number(r.effectiveHours), 0) / worked.length) : 0,
        _tone: lop > 0 ? "warning" as const : undefined,
        _href: `/employees/${e.id}`,
      };
    });
    return {
      columns: [
        { key: "employee", label: "Employee" }, { key: "number", label: "No." }, { key: "department", label: "Department" },
        { key: "present", label: "Present", format: "num" }, { key: "leave", label: "Leave", format: "int" }, { key: "absent", label: "Absent", format: "int" },
        { key: "late", label: "Late", format: "int" }, { key: "lop", label: "LOP days", format: "num" }, { key: "hours", label: "Avg hours", format: "num" },
      ],
      rows, notes: [`${MONTHS[m]} ${y}. Unpaid leave is charged through the leave request, so it shows as leave here, not as LOP.`],
    };
  },
};

const probation: ReportDef = {
  key: "probation-due", title: "Probation reviews due", group: "People", permission: P.REPORT_VIEW,
  description: "Everyone still on probation, when it ends, and whether their onboarding is on track.",
  async run(viewer) {
    const emps = await prisma.employee.findMany({
      where: { ...scopedEmployeeWhere(viewer, P.REPORT_VIEW), status: "PROBATION" },
      select: { id: true, displayName: true, employeeNumber: true, dateOfJoining: true, reportingManager: { select: { displayName: true } }, journeys: { where: { trigger: "JOINING" }, select: { tasks: { select: { status: true, isRequired: true, dueDate: true } } } } },
    });
    const rows = emps.map((e) => {
      const ends = new Date(e.dateOfJoining.getTime() + 180 * DAY);
      const days = Math.ceil((ends.getTime() - Date.now()) / DAY);
      const p = e.journeys[0] ? journeyProgress(e.journeys[0].tasks) : null;
      return {
        employee: e.displayName, number: e.employeeNumber, manager: e.reportingManager?.displayName ?? "—",
        joined: e.dateOfJoining, ends, days, onboarding: p ? p.pct / 100 : null,
        _tone: days < 0 ? "danger" as const : days <= 30 ? "warning" as const : undefined, _href: `/employees/${e.id}`,
      };
    }).sort((a, b) => a.days - b.days);
    return {
      columns: [
        { key: "employee", label: "Employee" }, { key: "manager", label: "Manager" }, { key: "joined", label: "Joined", format: "date" },
        { key: "ends", label: "Probation ends", format: "date" }, { key: "days", label: "Days left", format: "int" }, { key: "onboarding", label: "Onboarding done", format: "pct" },
      ],
      rows, notes: ["Probation is six months from joining. Confirm from the employee's Job tab; that starts the confirmation journey."],
    };
  },
};

const dataQuality: ReportDef = {
  key: "data-quality", title: "Data quality", group: "Compliance", permission: P.EMPLOYEE_VIEW_ALL,
  description: "Gaps that break payroll or compliance before they do: missing PAN, UAN or bank details, no manager, no leave plan, duplicate identifiers.",
  async run(viewer) {
    const emps = await prisma.employee.findMany({
      where: { ...scopedEmployeeWhere(viewer, P.EMPLOYEE_VIEW_ALL), status: { notIn: ["EXITED"] } },
      select: {
        id: true, displayName: true, employeeNumber: true, reportingManagerId: true, payGroupId: true, dateOfBirth: true,
        statutoryProfile: { select: { uan: true } },
        identityDocs: { select: { type: true, number: true } },
        bankAccounts: { select: { ifsc: true, isVerified: true } },
        salaryRevisions: { where: { status: "APPLIED" }, select: { id: true }, take: 1 },
        _count: { select: { journeys: true } },
      },
    });
    const topOfOrg = new Set((await prisma.employee.findMany({
      where: { tenantId: viewer.tenantId, reportingManagerId: null, directReports: { some: {} } }, select: { id: true },
    })).map((e) => e.id));
    const plans = new Set((await prisma.leavePlanAssignment.findMany({ where: { employeeId: { in: emps.map((e) => e.id) } }, select: { employeeId: true } })).map((p) => p.employeeId));
    const pans = new Map<string, string[]>();
    for (const e of emps) for (const d of e.identityDocs.filter((x) => x.type === "PAN")) pans.set(d.number.toUpperCase(), [...(pans.get(d.number.toUpperCase()) ?? []), e.displayName ?? ""]);
    const rows: ReportResult["rows"] = [];
    const add = (e: (typeof emps)[number], issue: string, impact: string, severity: "high" | "medium") =>
      rows.push({ employee: e.displayName, number: e.employeeNumber, issue, impact, severity, _tone: severity === "high" ? "danger" : "warning", _href: `/employees/${e.id}` });
    for (const e of emps) {
      const pan = e.identityDocs.find((d) => d.type === "PAN");
      if (!pan) add(e, "No PAN", "TDS must be deducted at 20% without a PAN (s.206AA)", "high");
      else if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan.number.toUpperCase())) add(e, `PAN ${pan.number} is malformed`, "Form 16 and 24Q will be rejected", "high");
      else if ((pans.get(pan.number.toUpperCase()) ?? []).length > 1) add(e, `PAN shared with ${pans.get(pan.number.toUpperCase())!.filter((n) => n !== e.displayName).join(", ")}`, "One of these records is wrong", "high");
      if (e.payGroupId && !e.statutoryProfile?.uan) add(e, "No UAN", "The PF ECR cannot include them", "medium");
      if (e.payGroupId && e.bankAccounts.length === 0) add(e, "No bank account", "Salary cannot be paid by transfer", "high");
      for (const b of e.bankAccounts) if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(b.ifsc)) add(e, `IFSC ${b.ifsc} is invalid`, "The bank transfer file will bounce", "high");
      if (e.payGroupId && e.salaryRevisions.length === 0) add(e, "No salary assigned", "They will be paid nothing", "high");
      // The top of the org chart has no manager by design.
      if (!e.reportingManagerId && !topOfOrg.has(e.id)) add(e, "No reporting manager", "Their leave and attendance requests have no approver", "medium");
      if (!plans.has(e.id)) add(e, "No leave plan", "They accrue no leave", "medium");
      if (!e.dateOfBirth) add(e, "No date of birth", "Senior-citizen tax slabs cannot be applied", "medium");
    }
    rows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
    return {
      columns: [{ key: "employee", label: "Employee" }, { key: "number", label: "No." }, { key: "issue", label: "Issue" }, { key: "impact", label: "Why it matters" }, { key: "severity", label: "Severity" }],
      rows,
      notes: [rows.length === 0 ? `All ${emps.length} records are complete.` : `${rows.length} issue(s) across ${new Set(rows.map((r) => r.number)).size} of ${emps.length} employees.`],
    };
  },
};

const loansOutstanding: ReportDef = {
  key: "loans-outstanding", title: "Loans outstanding", group: "Payroll", permission: P.LOAN_MANAGE,
  description: "Every open loan with what is left to recover and when it ends.",
  async run(viewer) {
    const loans = await prisma.loan.findMany({
      where: { employee: scopedEmployeeWhere(viewer, P.LOAN_MANAGE), status: { in: ["ACTIVE", "DISBURSED", "APPROVED"] } },
      include: { employee: { select: { displayName: true, employeeNumber: true } }, category: { select: { name: true } }, schedule: { orderBy: { sequence: "desc" }, take: 1 } },
    });
    return {
      columns: [
        { key: "employee", label: "Employee" }, { key: "category", label: "Type" }, { key: "principal", label: "Principal", format: "inr" },
        { key: "repaid", label: "Repaid", format: "inr" }, { key: "outstanding", label: "Outstanding", format: "inr" }, { key: "emi", label: "EMI", format: "inr" }, { key: "ends", label: "Ends" },
      ],
      rows: loans.map((l) => ({ employee: l.employee.displayName, category: l.category.name, principal: Number(l.principal), repaid: Number(l.totalRepaid), outstanding: Number(l.outstanding), emi: Number(l.emiAmount), ends: l.schedule[0] ? `${MONTHS[l.schedule[0].month]} ${l.schedule[0].year}` : "—" })),
      totals: { employee: "All", principal: loans.reduce((s, l) => s + Number(l.principal), 0), repaid: loans.reduce((s, l) => s + Number(l.totalRepaid), 0), outstanding: loans.reduce((s, l) => s + Number(l.outstanding), 0) },
    };
  },
};

const helpdeskSla: ReportDef = {
  key: "helpdesk-sla", title: "Helpdesk performance", group: "Operations", permission: P.HELPDESK_MANAGE,
  description: "Per category: volume, how many are open, the share resolved within target, and satisfaction.",
  async run(viewer) {
    const cats = await prisma.helpdeskCategory.findMany({ where: { tenantId: viewer.tenantId }, include: { tickets: true } });
    return {
      columns: [
        { key: "category", label: "Category" }, { key: "total", label: "Tickets", format: "int" }, { key: "open", label: "Open", format: "int" },
        { key: "sla", label: "Resolved in target", format: "pct" }, { key: "csat", label: "Satisfaction (of 5)", format: "num" },
      ],
      rows: cats.map((c) => {
        const resolved = c.tickets.filter((t) => t.resolvedAt);
        const rated = c.tickets.filter((t) => t.satisfaction);
        return {
          category: c.name, total: c.tickets.length, open: c.tickets.filter((t) => ["OPEN", "IN_PROGRESS", "WAITING_ON_EMPLOYEE"].includes(t.status)).length,
          sla: resolved.length ? resolved.filter((t) => t.resolvedAt! <= t.dueAt).length / resolved.length : null,
          csat: rated.length ? r2(rated.reduce((s, t) => s + (t.satisfaction ?? 0), 0) / rated.length) : null,
        };
      }),
    };
  },
};

// --- Payroll inputs and year-to-date -------------------------------------

const fyRunWhere = (fy: number) => ({ rolledBackAt: null, status: "FINALIZED" as const, OR: [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: 3 } }] });
const label = (s: string) => s.toLowerCase().replace(/_/g, " ");

const payrollYtd: ReportDef = {
  key: "payroll-ytd", title: "Year-to-date salary by employee", group: "Payroll", permission: P.PAY_REGISTER_VIEW,
  description: "Everything paid and deducted in the financial year's finalised runs, regular and off-cycle, one row per employee.",
  async run(viewer, { fy }) {
    const lines = await prisma.payrollRunEmployee.findMany({
      where: { run: { tenantId: viewer.tenantId, ...fyRunWhere(fy) }, employee: scopedEmployeeWhere(viewer, P.PAY_REGISTER_VIEW) },
      select: {
        grossEarnings: true, totalDeductions: true, netPay: true, pfEmployee: true, vpf: true, esiEmployee: true, professionalTax: true, lwfEmployee: true, tds: true,
        run: { select: { year: true, month: true } },
        employee: { select: { id: true, displayName: true, employeeNumber: true } },
      },
    });
    type Row = { employee: string; number: string; months: Set<string>; gross: number; pf: number; esi: number; pt: number; tds: number; other: number; net: number; _href: string };
    const by = new Map<string, Row>();
    for (const l of lines) {
      const r = by.get(l.employee.id) ?? { employee: l.employee.displayName ?? "", number: l.employee.employeeNumber, months: new Set<string>(), gross: 0, pf: 0, esi: 0, pt: 0, tds: 0, other: 0, net: 0, _href: `/employees/${l.employee.id}?tab=finances` };
      const pf = Number(l.pfEmployee) + Number(l.vpf), esi = Number(l.esiEmployee), pt = Number(l.professionalTax), tds = Number(l.tds);
      r.months.add(`${l.run.year}-${l.run.month}`);
      r.gross += Number(l.grossEarnings); r.pf += pf; r.esi += esi; r.pt += pt; r.tds += tds; r.net += Number(l.netPay);
      r.other += Number(l.totalDeductions) - pf - esi - pt - tds;
      by.set(l.employee.id, r);
    }
    const rows = [...by.values()].sort((a, b) => a.number.localeCompare(b.number)).map(({ months, ...r }) => ({ ...r, months: months.size, other: r2(r.other) }));
    const sum = (k: "gross" | "pf" | "esi" | "pt" | "tds" | "other" | "net") => rows.reduce((s, r) => s + r[k], 0);
    return {
      columns: [
        { key: "employee", label: "Employee" }, { key: "number", label: "No." }, { key: "months", label: "Months paid", format: "int" },
        { key: "gross", label: "Gross", format: "inr" }, { key: "pf", label: "PF + VPF", format: "inr" }, { key: "esi", label: "ESI", format: "inr" },
        { key: "pt", label: "PT", format: "inr" }, { key: "tds", label: "TDS", format: "inr" }, { key: "other", label: "Other deductions", format: "inr" }, { key: "net", label: "Net paid", format: "inr" },
      ],
      rows,
      totals: { employee: "All", gross: sum("gross"), pf: sum("pf"), esi: sum("esi"), pt: sum("pt"), tds: sum("tds"), other: sum("other"), net: sum("net") },
      notes: rows.length ? [] : ["No finalised payroll in this financial year yet."],
    };
  },
};

const incomeTax: ReportDef = {
  key: "income-tax", title: "Income tax deducted and projected", group: "Payroll", permission: P.PAY_REGISTER_VIEW,
  description: "TDS deducted so far this year, the latest month's TDS, where the year is heading at that rate, and how far each employee's declaration and proofs have got.",
  async run(viewer, { fy }) {
    const emps = await prisma.employee.findMany({
      where: { ...scopedEmployeeWhere(viewer, P.PAY_REGISTER_VIEW), status: { notIn: ["PREBOARDING"] }, payGroupId: { not: null } },
      select: {
        id: true, displayName: true, employeeNumber: true, status: true,
        statutoryProfile: { select: { taxRegime: true } },
        declarations: { where: { fyStartYear: fy }, select: { status: true, declaredTotal: true, approvedTotal: true, items: { select: { proofStatus: true } } } },
        payrollLines: {
          where: { run: { ...fyRunWhere(fy) } },
          select: { tds: true, grossEarnings: true, run: { select: { year: true, month: true, type: true } } },
        },
      },
      orderBy: { employeeNumber: "asc" },
    });
    const fyIndex = (y: number, m: number) => (y - fy) * 12 + m - 4; // 0 = April
    const rows = emps.map((e) => {
      const regular = e.payrollLines.filter((l) => l.run.type === "REGULAR").sort((a, b) => fyIndex(b.run.year, b.run.month) - fyIndex(a.run.year, a.run.month));
      const deducted = e.payrollLines.reduce((s, l) => s + Number(l.tds), 0);
      const latest = regular[0];
      const monthly = latest ? Number(latest.tds) : 0;
      const left = latest && e.status !== "EXITED" ? 11 - fyIndex(latest.run.year, latest.run.month) : 0;
      const d = e.declarations[0];
      const pendingProofs = d ? d.items.filter((i) => i.proofStatus === "SUBMITTED").length : 0;
      return {
        employee: e.displayName, number: e.employeeNumber, regime: e.statutoryProfile?.taxRegime ?? "NEW",
        gross: e.payrollLines.reduce((s, l) => s + Number(l.grossEarnings), 0), deducted, monthly, projected: deducted + monthly * Math.max(0, left),
        declaration: d ? label(d.status) : "not started", declared: d ? Number(d.declaredTotal) : 0, approved: d ? Number(d.approvedTotal) : 0,
        proofs: pendingProofs, _href: `/employees/${e.id}?tab=finances`, _tone: pendingProofs > 0 ? ("warning" as const) : undefined,
      };
    });
    const sum = (k: "gross" | "deducted" | "projected") => rows.reduce((s, r) => s + r[k], 0);
    return {
      columns: [
        { key: "employee", label: "Employee" }, { key: "number", label: "No." }, { key: "regime", label: "Regime" },
        { key: "gross", label: "Gross YTD", format: "inr" }, { key: "deducted", label: "TDS YTD", format: "inr" }, { key: "monthly", label: "Latest monthly TDS", format: "inr" },
        { key: "projected", label: "Projected year TDS", format: "inr" }, { key: "declaration", label: "Declaration" },
        { key: "declared", label: "Declared", format: "inr" }, { key: "approved", label: "Approved", format: "inr" }, { key: "proofs", label: "Proofs to review", format: "int" },
      ],
      rows,
      totals: { employee: "All", gross: sum("gross"), deducted: sum("deducted"), projected: sum("projected") },
      notes: ["Projected TDS assumes the latest regular month's TDS repeats for the rest of the year; the run recalculates it every month from actual pay and approved proofs."],
    };
  },
};

const componentClaims: ReportDef = {
  key: "component-claims", title: "Reimbursement claims by component", group: "Payroll", permission: P.PAYROLL_VIEW,
  description: "Claims against reimbursement and flexible benefit components for the year: claimed, approved, paid, rejected and still waiting.",
  async run(viewer, { fy }) {
    const claims = await prisma.componentClaim.findMany({
      where: { fyStartYear: fy, employee: scopedEmployeeWhere(viewer, P.PAYROLL_VIEW), status: { not: "DRAFT" } },
      select: { status: true, claimedAmount: true, payableAmount: true, component: { select: { name: true } } },
    });
    const declared = await prisma.fbpDeclarationLine.findMany({
      where: { declaration: { fyStartYear: fy, employee: scopedEmployeeWhere(viewer, P.PAYROLL_VIEW) } },
      select: { annualAmount: true, component: { select: { name: true } } },
    });
    type Row = { component: string; declared: number; count: number; claimed: number; waiting: number; approved: number; paid: number; rejected: number };
    const by = new Map<string, Row>();
    const get = (k: string) => by.get(k) ?? { component: k, declared: 0, count: 0, claimed: 0, waiting: 0, approved: 0, paid: 0, rejected: 0 };
    for (const d of declared) { const r = get(d.component.name); r.declared += Number(d.annualAmount); by.set(r.component, r); }
    for (const c of claims) {
      const r = get(c.component.name);
      const claimed = Number(c.claimedAmount), payable = Number(c.payableAmount ?? c.claimedAmount);
      r.count++; r.claimed += claimed;
      if (c.status === "SUBMITTED") r.waiting += claimed;
      if (c.status === "APPROVED") r.approved += payable;
      if (c.status === "PAID") r.paid += payable;
      if (c.status === "REJECTED") r.rejected += claimed;
      by.set(r.component, r);
    }
    const rows = [...by.values()].sort((a, b) => b.claimed - a.claimed).map((r) => ({ ...r, _tone: r.waiting > 0 ? ("warning" as const) : undefined }));
    const sum = (k: keyof Omit<Row, "component">) => rows.reduce((s, r) => s + r[k], 0);
    return {
      columns: [
        { key: "component", label: "Component" }, { key: "declared", label: "Declared under FBP", format: "inr" }, { key: "count", label: "Claims", format: "int" },
        { key: "claimed", label: "Claimed", format: "inr" }, { key: "waiting", label: "Waiting", format: "inr" }, { key: "approved", label: "Approved, unpaid", format: "inr" },
        { key: "paid", label: "Paid", format: "inr" }, { key: "rejected", label: "Rejected", format: "inr" },
      ],
      rows,
      totals: { component: "All", declared: sum("declared"), count: sum("count"), claimed: sum("claimed"), waiting: sum("waiting"), approved: sum("approved"), paid: sum("paid"), rejected: sum("rejected") },
    };
  },
};

const salaryRevisions: ReportDef = {
  key: "salary-revisions", title: "Salary revisions", group: "Payroll", permission: P.PAY_REGISTER_VIEW,
  description: "Every salary change effective in the year, with the size of the change and whether it is applied, still with approvers, or rejected.",
  async run(viewer, { fy }) {
    const revs = await prisma.salaryRevision.findMany({
      where: { employee: scopedEmployeeWhere(viewer, P.PAY_REGISTER_VIEW), effectiveFrom: { gte: monthStart(fy, 4), lte: monthEnd(fy + 1, 3) } },
      select: { effectiveFrom: true, annualCtc: true, previousCtc: true, reason: true, status: true, employee: { select: { id: true, displayName: true, employeeNumber: true } } },
      orderBy: { effectiveFrom: "asc" },
    });
    const rows = revs.map((r) => {
      const prev = r.previousCtc ? Number(r.previousCtc) : 0;
      return {
        employee: r.employee.displayName, number: r.employee.employeeNumber, effective: r.effectiveFrom,
        previous: prev || null, ctc: Number(r.annualCtc), change: prev ? (Number(r.annualCtc) - prev) / prev : null,
        reason: r.reason ?? "", status: label(r.status), _href: `/employees/${r.employee.id}?tab=finances`,
        _tone: r.status === "PENDING_APPROVAL" ? ("warning" as const) : r.status === "REJECTED" ? ("danger" as const) : undefined,
      };
    });
    const applied = rows.filter((r) => r.status === "applied" && r.previous);
    return {
      columns: [
        { key: "employee", label: "Employee" }, { key: "number", label: "No." }, { key: "effective", label: "Effective", format: "date" },
        { key: "previous", label: "Previous CTC", format: "inr" }, { key: "ctc", label: "New CTC", format: "inr" }, { key: "change", label: "Change", format: "pct" },
        { key: "reason", label: "Reason" }, { key: "status", label: "Status" },
      ],
      rows,
      notes: applied.length ? [`Average applied increase: ${((applied.reduce((s, r) => s + (r.change ?? 0), 0) / applied.length) * 100).toFixed(1)}% across ${applied.length} revisions.`] : [],
    };
  },
};

const bonusRegister: ReportDef = {
  key: "bonuses", title: "Bonuses", group: "Payroll", permission: P.PAYROLL_VIEW,
  description: "Bonuses scheduled for payout in the year by type: paid through payroll, paid outside it, on hold, voided and still to come.",
  async run(viewer, { fy }) {
    const bonuses = await prisma.employeeBonus.findMany({
      where: { employee: scopedEmployeeWhere(viewer, P.PAYROLL_VIEW), OR: [{ payoutYear: fy, payoutMonth: { gte: 4 } }, { payoutYear: fy + 1, payoutMonth: { lte: 3 } }] },
      select: { amount: true, paidAmount: true, payAction: true, isProcessed: true, bonusType: { select: { name: true } } },
    });
    type Row = { type: string; count: number; scheduled: number; paid: number; outside: number; held: number; voided: number; upcoming: number };
    const by = new Map<string, Row>();
    for (const b of bonuses) {
      const r = by.get(b.bonusType.name) ?? { type: b.bonusType.name, count: 0, scheduled: 0, paid: 0, outside: 0, held: 0, voided: 0, upcoming: 0 };
      const amt = Number(b.amount);
      r.count++; r.scheduled += amt;
      if (b.payAction === "VOID") r.voided += amt;
      else if (b.payAction === "ON_HOLD") r.held += amt;
      else if (b.payAction === "PAY_OUTSIDE_PAYROLL") r.outside += amt;
      else if (b.isProcessed) r.paid += b.payAction === "PARTIALLY_PAY" ? Number(b.paidAmount ?? 0) : amt;
      else r.upcoming += b.payAction === "PARTIALLY_PAY" ? Number(b.paidAmount ?? 0) : amt;
      by.set(r.type, r);
    }
    const rows = [...by.values()].sort((a, b) => b.scheduled - a.scheduled);
    const sum = (k: keyof Omit<Row, "type">) => rows.reduce((s, r) => s + r[k], 0);
    return {
      columns: [
        { key: "type", label: "Bonus type" }, { key: "count", label: "Bonuses", format: "int" }, { key: "scheduled", label: "Scheduled", format: "inr" },
        { key: "paid", label: "Paid in payroll", format: "inr" }, { key: "outside", label: "Paid outside", format: "inr" }, { key: "held", label: "On hold", format: "inr" },
        { key: "voided", label: "Voided", format: "inr" }, { key: "upcoming", label: "Still to pay", format: "inr" },
      ],
      rows,
      totals: { type: "All", count: sum("count"), scheduled: sum("scheduled"), paid: sum("paid"), outside: sum("outside"), held: sum("held"), voided: sum("voided"), upcoming: sum("upcoming") },
    };
  },
};


export const REPORTS: ReportDef[] = [headcount, attrition, probation, payrollSummary, payrollByDept, payrollYtd, incomeTax, salaryRevisions, bonusRegister, componentClaims, loansOutstanding, attendanceSummary, leaveUtil, statutoryDues, dataQuality, helpdeskSla];

export function reportsFor(viewer: Viewer): ReportDef[] {
  return REPORTS.filter((r) => can(viewer, r.permission));
}

export function defaultParams(viewer: Viewer, sp: { fy?: string; month?: string }): ReportParams {
  const fy = Number(sp.fy) || fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const month = Number(sp.month) || undefined;
  return { fy, month: month && month >= 1 && month <= 12 ? month : undefined };
}

/** Plain-text rendering of one cell, shared by the table and the CSV. */
export function formatCell(v: unknown, f: Format = "text"): string {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    if (f === "pct") return `${(v * 100).toFixed(1)}%`;
    if (f === "int") return String(Math.round(v));
    if (f === "inr") return v.toFixed(2);
    return String(r2(v));
  }
  return String(v);
}
