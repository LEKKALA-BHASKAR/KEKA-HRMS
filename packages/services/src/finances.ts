import { prisma } from "@keka/db";
import { calculatePayroll, type StructureComponentSpec, type TaxConfig } from "@keka/payroll";
import { daysInMonth, fyMonths, fyRange, fyStartYear } from "@keka/shared";
import { renderPayslips, renderForm12BB } from "@keka/documents";
import { notify, usersWithPermission } from "./lifecycle";
import { loadStatutoryTables } from "./payroll-run";
import { payslipData, type BuiltFile } from "./filings";
import { SECTION_BY_KEY, sectionName } from "./declarations";
import { claimEntitlement, claimRemaining, bonusStatus, interestLabel, loanEligibilityLines, scheduleTotals } from "./finances-math";

export * from "./finances-math";

/**
 * My Finances, the database side: flexible-benefit claims, the salary
 * timeline and breakup, payslip bundles, Form 12BB and the loan views.
 * Every function takes the employee id it acts for; callers pass the
 * signed-in viewer's own id, never one from a form.
 */

const n = (v: unknown) => Number(v ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ---------------------------------------------------------------------------
//  Component claims
// ---------------------------------------------------------------------------

export interface ClaimSummaryRow {
  componentId: string; code: string; name: string; typeLabel: string;
  monthly: number; annual: number; accrued: number; claimed: number; pending: number; remaining: number;
}

/**
 * The claimable flexible-benefit reimbursements for one employee and year:
 * the REIMBURSEMENT components in their pay group that are part of the
 * flexible benefits plan and carry an annual limit. Entitlement accrues a
 * twelfth of the limit for every month employed.
 */
export async function componentClaimSummary(employeeId: string, fy: number, today = new Date()) {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { tenantId: true, dateOfJoining: true, lastWorkingDay: true, payGroupId: true, tenant: { select: { fyStartMonth: true } } },
  });
  const fyStartMonth = emp.tenant.fyStartMonth;
  const [components, claims] = await Promise.all([
    emp.payGroupId
      ? prisma.salaryComponent.findMany({
          where: {
            tenantId: emp.tenantId, type: "REIMBURSEMENT", isPartOfFbp: true, isActive: true,
            annualExemptLimit: { gt: 0 }, payGroupLinks: { some: { payGroupId: emp.payGroupId } },
          },
          orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
          select: { id: true, code: true, name: true, annualExemptLimit: true },
        })
      : Promise.resolve([]),
    prisma.componentClaim.findMany({
      where: { employeeId, fyStartYear: fy },
      include: { component: { select: { name: true, code: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const rows: ClaimSummaryRow[] = components.map((c) => {
    const ent = claimEntitlement({ annualLimit: n(c.annualExemptLimit), joinedOn: emp.dateOfJoining, lastWorkingDay: emp.lastWorkingDay, fy, fyStartMonth, today });
    const mine = claims.filter((x) => x.componentId === c.id);
    const claimed = r2(mine.filter((x) => x.status === "APPROVED" || x.status === "PAID").reduce((s, x) => s + n(x.payableAmount ?? x.claimedAmount), 0));
    const pending = r2(mine.filter((x) => x.status === "SUBMITTED").reduce((s, x) => s + n(x.claimedAmount), 0));
    return {
      componentId: c.id, code: c.code, name: c.name, typeLabel: "Reimbursement",
      monthly: ent.monthly, annual: ent.annual, accrued: ent.accrued, claimed, pending,
      remaining: claimRemaining(ent.accrued, claimed, pending),
    };
  });
  return {
    fyStartMonth,
    rows,
    pending: claims.filter((c) => c.status === "SUBMITTED"),
    processed: claims.filter((c) => c.status === "APPROVED" || c.status === "PAID" || c.status === "REJECTED"),
  };
}

/** Raise a claim against a component, within what has accrued and not yet been claimed. */
export async function submitComponentClaim(input: {
  employeeId: string; componentId: string; amount: number; billDate: Date;
  billNumber?: string | null; note?: string | null; attachmentUrl: string | null; today?: Date;
}): Promise<{ ok: boolean; message: string; claimId?: string; field?: string }> {
  const today = input.today ?? new Date();
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: input.employeeId },
    select: { tenantId: true, displayName: true, lastWorkingDay: true, status: true, tenant: { select: { fyStartMonth: true } } },
  });
  if (emp.status === "EXITED" || (emp.lastWorkingDay && emp.lastWorkingDay < today)) {
    return { ok: false, message: "Claims close after your last working day." };
  }
  const fy = fyStartYear(today, emp.tenant.fyStartMonth);
  const summary = await componentClaimSummary(input.employeeId, fy, today);
  const row = summary.rows.find((r) => r.componentId === input.componentId);
  if (!row) return { ok: false, message: "This component cannot be claimed.", field: "componentId" };
  if (!(input.amount > 0)) return { ok: false, message: "Enter the amount you are claiming.", field: "amount" };
  if (r2(input.amount) > row.remaining) {
    return { ok: false, message: `You can claim up to INR ${row.remaining.toLocaleString("en-IN")} for ${row.name} right now.`, field: "amount" };
  }
  const { start } = fyRange(fy, emp.tenant.fyStartMonth);
  if (input.billDate < start || input.billDate > today) {
    return { ok: false, message: "The bill date must fall in this financial year and not be in the future.", field: "billDate" };
  }
  if (!input.attachmentUrl) return { ok: false, message: "Attach the bill.", field: "file" };
  const claim = await prisma.componentClaim.create({
    data: {
      employeeId: input.employeeId, componentId: input.componentId, fyStartYear: fy,
      claimedAmount: r2(input.amount), status: "SUBMITTED", billDate: input.billDate,
      billNumber: input.billNumber ?? null, comment: input.note ?? null, attachmentUrl: input.attachmentUrl,
    },
  });
  await notify({
    tenantId: emp.tenantId, userIds: await usersWithPermission(emp.tenantId, "payroll.run.execute"), kind: "PAYROLL",
    title: `${emp.displayName} claimed ${row.name}`,
    body: `INR ${r2(input.amount).toLocaleString("en-IN")} — review it in step 4 of the payroll run.`,
    link: "/payroll/runs",
  });
  return { ok: true, message: `Claimed INR ${r2(input.amount).toLocaleString("en-IN")} against ${row.name}. Your payroll team will review it.`, claimId: claim.id };
}

/** Take back a claim the payroll team has not acted on. */
export async function withdrawComponentClaim(claimId: string, employeeId: string): Promise<{ ok: boolean; message: string; summary?: string }> {
  const claim = await prisma.componentClaim.findFirst({ where: { id: claimId, employeeId }, include: { component: { select: { name: true } } } });
  if (!claim) return { ok: false, message: "Claim not found." };
  if (claim.status !== "SUBMITTED") return { ok: false, message: "Only a pending claim can be withdrawn." };
  await prisma.componentClaim.delete({ where: { id: claim.id } });
  const summary = `Withdrew a ${claim.component.name} claim of INR ${n(claim.claimedAmount).toLocaleString("en-IN")}`;
  return { ok: true, message: "Claim withdrawn.", summary };
}

// ---------------------------------------------------------------------------
//  Salary timeline and breakup
// ---------------------------------------------------------------------------

export interface BreakupLine { code: string; name: string; monthly: number; annual: number; varies: boolean }
export interface SalaryBreakup {
  earnings: BreakupLine[];
  deductions: BreakupLine[];
  /** Employer contributions inside the CTC. */
  employer: BreakupLine[];
  /** Employer costs over and above the CTC: Keka's "Other". */
  other: BreakupLine[];
  totals: { earnings: [number, number]; deductions: [number, number]; employer: [number, number]; other: [number, number]; net: [number, number] };
}

const DUMMY_TAX: TaxConfig = { standardDeduction: 0, rebateLimit: 0, rebateMaxAmount: 0, cessPercent: 4, surchargeBands: [], marginalReliefEnabled: false };

const EMP_SELECT = {
  id: true, tenantId: true, payGroupId: true, locationId: true, gender: true,
  statutoryProfile: true,
  tenant: { select: { fyStartMonth: true } },
  payGroup: { select: { pfEnabled: true, esiEnabled: true, ptEnabled: true, lwfEnabled: true, filingDetail: true } },
} as const;

type RevisionWithStructure = Awaited<ReturnType<typeof loadRevisions>>[number];
async function loadRevisions(employeeId: string) {
  return prisma.salaryRevision.findMany({
    where: { employeeId, status: { in: ["APPLIED", "APPROVED"] } },
    orderBy: { effectiveFrom: "desc" },
    include: { structure: { include: { components: { where: { isActive: true }, include: { component: true } } } } },
  });
}

function specsOf(rev: RevisionWithStructure): StructureComponentSpec[] {
  return (rev.structure?.components ?? []).map((sc) => ({
    code: sc.component.code, name: sc.component.name, type: sc.component.type, calculationType: sc.calculationType,
    formula: sc.formula, fixedAmount: sc.fixedAmount === null ? null : n(sc.fixedAmount),
    percentage: sc.percentage === null ? null : n(sc.percentage), percentageOf: sc.percentageOf, sequence: sc.sequence,
    minAmount: sc.minAmount === null ? null : n(sc.minAmount), maxAmount: sc.maxAmount === null ? null : n(sc.maxAmount),
    isOutsideCtc: sc.component.isOutsideCtc, isLopApplicable: sc.component.isLopApplicable,
    affectsPfWage: sc.component.affectsPfWage, affectsEsiGross: sc.component.affectsEsiGross,
    showOnPayslip: sc.component.showOnPayslip, isPartOfFbp: sc.component.isPartOfFbp,
  }));
}

/**
 * A year of full months at this revision's salary, run through the payroll
 * engine with no loss of pay and no income tax: what the structure pays,
 * what statutory contributions take from it and what the employer adds.
 * Professional tax and LWF vary by month, so the annual figure is the sum
 * of the twelve months, not twelve times one.
 */
function breakupFor(
  emp: Awaited<ReturnType<typeof loadEmp>>, rev: RevisionWithStructure,
  tables: Awaited<ReturnType<typeof loadStatutoryTables>> | null, fy: number,
): SalaryBreakup | null {
  const specs = specsOf(rev);
  if (specs.length === 0) return null;
  const sp = emp.statutoryProfile, pg = emp.payGroup, filing = pg?.filingDetail ?? null;
  const ptEntry = emp.locationId ? tables?.ptByState.get(emp.locationId) : undefined;
  const lwfRule = emp.locationId ? tables?.lwfByState.get(emp.locationId) ?? null : null;
  const byCode = new Map<string, { name: string; type: string; months: number[] }>();
  let ptYtd = 0;
  for (const { year, month } of fyMonths(fy, emp.tenant.fyStartMonth)) {
    const res = calculatePayroll({
      employeeId: emp.id, year, month, fyStartMonth: emp.tenant.fyStartMonth,
      annualCtc: n(rev.annualCtc), structureComponents: specs, roundComponents: rev.structure?.roundComponents ?? true,
      attendance: { totalDays: daysInMonth(year, month), lopDays: 0, lopAdjustment: 0, lopReversalDays: 0 },
      statutory: {
        pfEnabled: !!pg?.pfEnabled && (sp?.pfEnabled ?? true),
        pfCapAtCeiling: sp?.pfCapAtCeiling ?? filing?.pfCapAtCeiling ?? true,
        epsApplicable: sp?.epsApplicable ?? true,
        vpfAmount: sp?.vpfAmount ? n(sp.vpfAmount) : undefined,
        vpfPercent: sp?.vpfPercent ? n(sp.vpfPercent) : undefined,
        pfConfig: filing ? {
          wageCeiling: n(filing.pfWageCeiling), capAtCeiling: filing.pfCapAtCeiling, employeeRate: n(filing.pfEmployeeRate),
          employerRate: n(filing.pfEmployerRate), epsRate: n(filing.epsRate), epsWageCeiling: n(filing.epsWageCeiling),
          edliRate: n(filing.edliRate), adminRate: n(filing.pfAdminRate),
        } : undefined,
        esiEnabled: !!pg?.esiEnabled && (sp?.esiEnabled ?? true),
        esiConfig: filing ? { wageLimit: n(filing.esiWageLimit), employeeRate: n(filing.esiEmployeeRate), employerRate: n(filing.esiEmployerRate), capAtLimit: true } : undefined,
        ptEnabled: !!pg?.ptEnabled && (sp?.ptEnabled ?? true) && !!ptEntry,
        ptSlabs: ptEntry?.slabs ?? [], ptFrequency: ptEntry?.frequency, ptCollectionMonths: ptEntry?.collectionMonths, ptYtdDeducted: ptYtd,
        gender: emp.gender === "MALE" || emp.gender === "FEMALE" ? emp.gender : null,
        lwfEnabled: !!pg?.lwfEnabled && (sp?.lwfEnabled ?? true), lwfRule,
      },
      tax: { enabled: false, regime: "NEW", slabs: [], config: DUMMY_TAX },
    });
    for (const l of res.lines) {
      const row = byCode.get(l.code) ?? { name: l.name, type: l.type, months: [] };
      row.months.push(n(l.amount));
      byCode.set(l.code, row);
    }
    ptYtd += n(res.pt.amount);
  }
  const line = (code: string, r: { name: string; months: number[] }): BreakupLine => {
    const annual = r2(r.months.reduce((s, x) => s + x, 0));
    const varies = r.months.length !== 12 || r.months.some((x) => x !== r.months[0]);
    return { code, name: r.name, monthly: varies ? r2(annual / 12) : r.months[0], annual, varies };
  };
  const insideCtc = new Set(specs.filter((c) => !c.isOutsideCtc).map((c) => c.code));
  if (insideCtc.has("PF_EMPLOYER")) insideCtc.add("EPS");
  if (filing?.esiEmployerInsideCtc) insideCtc.add("ESI_EMPLOYER");
  const out: SalaryBreakup = { earnings: [], deductions: [], employer: [], other: [], totals: { earnings: [0, 0], deductions: [0, 0], employer: [0, 0], other: [0, 0], net: [0, 0] } };
  for (const [code, r] of byCode) {
    const l = line(code, r);
    if (r.type === "EARNING" || r.type === "REIMBURSEMENT") (insideCtc.has(code) ? out.earnings : out.other).push(l);
    else if (r.type === "DEDUCTION") out.deductions.push(l);
    else if (r.type === "EMPLOYER_CONTRIBUTION") (insideCtc.has(code) ? out.employer : out.other).push(l);
  }
  const tot = (xs: BreakupLine[]): [number, number] => [r2(xs.reduce((s, x) => s + x.monthly, 0)), r2(xs.reduce((s, x) => s + x.annual, 0))];
  out.totals.earnings = tot(out.earnings);
  out.totals.deductions = tot(out.deductions);
  out.totals.employer = tot(out.employer);
  out.totals.other = tot(out.other);
  out.totals.net = [r2(out.totals.earnings[0] - out.totals.deductions[0]), r2(out.totals.earnings[1] - out.totals.deductions[1])];
  return out;
}

async function loadEmp(employeeId: string) {
  return prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: EMP_SELECT });
}

export interface TimelineBonus {
  id: string; name: string; type: "Fixed"; status: ReturnType<typeof bonusStatus>; amount: number; due: Date; note: string | null;
}
export interface TimelineEntry {
  revisionId: string; effectiveFrom: Date; annualCtc: number; previousCtc: number | null; reason: string | null;
  structureId: string | null; structureName: string | null;
  isCurrent: boolean; isUpcoming: boolean; isJoining: boolean;
  regular: number; other: number; bonus: number; total: number;
  otherItems: BreakupLine[];
  bonuses: TimelineBonus[];
  /** The breakup drawer's tables, and its version history (newest first). */
  breakup: SalaryBreakup | null;
  versions: Array<{ id: string; date: Date; lines: string[]; current: boolean }>;
}

/**
 * Every revision with Keka's sum: Regular salary + Other (employer costs
 * over the CTC) + Bonus (paid or due while the revision was in force) = Total.
 */
export async function salaryTimeline(employeeId: string, today = new Date()): Promise<TimelineEntry[]> {
  const [emp, revisions, bonuses] = await Promise.all([
    loadEmp(employeeId),
    loadRevisions(employeeId),
    prisma.employeeBonus.findMany({ where: { employeeId }, include: { bonusType: { select: { name: true } } }, orderBy: [{ payoutYear: "asc" }, { payoutMonth: "asc" }] }),
  ]);
  const fy = fyStartYear(today, emp.tenant.fyStartMonth);
  const tables = emp.payGroupId ? await loadStatutoryTables(emp.payGroupId, fy, today) : null;
  const current = revisions.find((r) => r.effectiveFrom <= today) ?? null;
  const idx = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  const structureIds = [...new Set(revisions.map((r) => r.structureId).filter((x): x is string => !!x))];
  const audit = revisions.length ? await prisma.auditLog.findMany({
    where: {
      tenantId: emp.tenantId,
      OR: [{ entityType: "SalaryStructure", entityId: { in: structureIds } }, { entityType: "SalaryRevision", entityId: { in: revisions.map((r) => r.id) } }],
    },
    orderBy: { createdAt: "desc" }, take: 60, select: { id: true, entityType: true, entityId: true, summary: true, createdAt: true },
  }) : [];
  return revisions.map((r, i) => {
    const from = idx(r.effectiveFrom);
    const until = i === 0 ? Number.POSITIVE_INFINITY : idx(revisions[i - 1].effectiveFrom);
    const mine = bonuses.filter((b) => {
      const k = b.payoutYear * 12 + (b.payoutMonth - 1);
      return (i === revisions.length - 1 ? true : k >= from) && k < until;
    });
    const breakup = breakupFor(emp, r, tables, fy);
    const otherItems = breakup?.other ?? [];
    const other = breakup?.totals.other[1] ?? 0;
    const tl: TimelineBonus[] = mine.map((b) => ({
      id: b.id, name: b.bonusType.name, type: "Fixed", status: bonusStatus(b),
      amount: n(b.paidAmount ?? b.amount), due: new Date(Date.UTC(b.payoutYear, b.payoutMonth - 1, 1)), note: b.note,
    }));
    const bonus = r2(tl.filter((b) => b.status !== "Void").reduce((s, b) => s + b.amount, 0));
    return {
      revisionId: r.id, effectiveFrom: r.effectiveFrom, annualCtc: n(r.annualCtc), previousCtc: r.previousCtc === null ? null : n(r.previousCtc),
      reason: r.reason, structureId: r.structureId, structureName: r.structure?.name ?? null,
      isCurrent: r.id === current?.id, isUpcoming: r.effectiveFrom > today, isJoining: i === revisions.length - 1 && !r.previousCtc,
      regular: n(r.annualCtc), other, bonus, total: r2(n(r.annualCtc) + other + bonus), otherItems, bonuses: tl,
      breakup,
      versions: [
        ...audit
          .filter((a) => (a.entityType === "SalaryRevision" ? a.entityId === r.id : a.entityId === r.structureId) && a.createdAt >= r.createdAt)
          .map((a) => ({ id: a.id, date: a.createdAt, lines: [a.summary ?? "Salary structure updated"], current: false })),
        { id: r.id, date: r.effectiveFrom, lines: ["Original salary structure"], current: true },
      ],
    };
  });
}

/** The breakup drawer: the component tables for one revision, and its version history. */
export async function salaryBreakup(employeeId: string, revisionId: string, today = new Date()) {
  const [emp, revisions] = await Promise.all([loadEmp(employeeId), loadRevisions(employeeId)]);
  const rev = revisions.find((r) => r.id === revisionId);
  if (!rev) return null;
  const fy = fyStartYear(today, emp.tenant.fyStartMonth);
  const tables = emp.payGroupId ? await loadStatutoryTables(emp.payGroupId, fy, today) : null;
  const breakup = breakupFor(emp, rev, tables, fy);
  const history = await prisma.auditLog.findMany({
    where: {
      tenantId: emp.tenantId,
      OR: [
        ...(rev.structureId ? [{ entityType: "SalaryStructure", entityId: rev.structureId }] : []),
        { entityType: "SalaryRevision", entityId: rev.id },
      ],
      createdAt: { gte: rev.createdAt },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, summary: true, createdAt: true },
  });
  return {
    annualCtc: n(rev.annualCtc), effectiveFrom: rev.effectiveFrom, structureName: rev.structure?.name ?? null, breakup,
    versions: [
      ...history.map((h) => ({ id: h.id, date: h.createdAt, lines: [h.summary ?? "Salary structure updated"], current: false })),
      { id: rev.id, date: rev.effectiveFrom, lines: ["Original salary structure"], current: true },
    ],
  };
}

// ---------------------------------------------------------------------------
//  Payslip bundle and Form 12BB
// ---------------------------------------------------------------------------

/** The latest N released payslips in one PDF, oldest first, protected by the PAN. */
export async function payslipBundlePdf(employeeId: string, last: 3 | 6 | 12): Promise<BuiltFile & { count: number }> {
  const slips = await prisma.payslip.findMany({
    where: { employeeId, status: "RELEASED", isSegregated: false },
    orderBy: [{ year: "desc" }, { month: "desc" }], take: last, select: { id: true },
  });
  if (slips.length === 0) throw new Error("No released payslips to download.");
  const pages = [];
  for (const s of slips.reverse()) pages.push(await payslipData(s.id));
  const first = pages[0], latest = pages[pages.length - 1];
  const password = latest.password;
  return {
    filename: `Payslips-${latest.employeeNumber}-last-${last}-months.pdf`, mimeType: "application/pdf",
    content: renderPayslips(pages.map((p) => p.data), { title: `Payslips ${first.data.period} to ${latest.data.period}`, password: password ?? undefined }),
    issues: password ? [] : ["No PAN on record — the file is not password protected"],
    summary: `${pages.length} payslip(s), ${first.data.period} to ${latest.data.period}`,
    count: pages.length,
  };
}

const EIGHTY_C_FAMILY = /^80CC?C|^80C$|^80CCD/;

/** Form 12BB for a financial year, from the employee's investment declaration. */
export async function form12bbPdf(employeeId: string, fy: number, today = new Date()): Promise<BuiltFile> {
  const [emp, decl] = await Promise.all([
    prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: {
        employeeNumber: true, firstName: true, middleName: true, lastName: true, jobTitleName: true,
        location: { select: { city: true } },
        addresses: { select: { type: true, line1: true, line2: true, city: true, state: true, postalCode: true } },
        identityDocs: { where: { type: "PAN" }, select: { number: true }, take: 1 },
      },
    }),
    prisma.investmentDeclaration.findUnique({ where: { employeeId_fyStartYear: { employeeId, fyStartYear: fy } }, include: { items: true, hraDetail: true } }),
  ]);
  if (!decl) throw new Error("No investment declaration for this financial year.");
  const name = [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ");
  const addr = emp.addresses.find((a) => a.type === "CURRENT") ?? emp.addresses.find((a) => a.type === "PERMANENT") ?? null;
  const pan = emp.identityDocs[0]?.number.toUpperCase() ?? null;
  const h = decl.hraDetail;
  const rent = h ? (h.annualRent !== null ? n(h.annualRent) : Object.values((h.monthlyRent ?? {}) as Record<string, unknown>).reduce<number>((s, v) => s + n(v), 0)) : 0;
  const claims = decl.items.filter((i) => n(i.declaredAmount) > 0 && SECTION_BY_KEY.get(i.section)?.kind === "deduction");
  const label = (i: { section: string; category: string }) => i.category || SECTION_BY_KEY.get(i.section)?.label || sectionName(i.section);
  const fyLabel = `${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;
  const d = today;
  const content = renderForm12BB({
    employee: { name, address: addr ? [addr.line1, addr.line2, addr.city, addr.state, addr.postalCode].filter(Boolean).join(", ") : null, pan, designation: emp.jobTitleName },
    fy: fyLabel,
    hra: rent > 0 ? { rent, landlordName: h?.landlordName ?? null, landlordAddress: h?.rentAddress ?? null, landlordPan: h?.landlordPan ?? null } : null,
    lta: 0,
    homeLoanInterest: r2(decl.items.filter((i) => i.section.startsWith("24B")).reduce((s, i) => s + n(i.declaredAmount), 0)),
    eightyC: claims.filter((i) => EIGHTY_C_FAMILY.test(i.section)).map((i) => ({ section: sectionName(i.section), label: label(i), amount: n(i.declaredAmount) })),
    otherSections: claims.filter((i) => !EIGHTY_C_FAMILY.test(i.section)).map((i) => ({ section: sectionName(i.section), label: label(i), amount: n(i.declaredAmount) })),
    place: emp.location?.city ?? null,
    date: `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`,
  }, { password: pan ?? undefined });
  return {
    filename: `Form12BB-${emp.employeeNumber}-FY${fyLabel}.pdf`, mimeType: "application/pdf", content,
    issues: pan ? [] : ["No PAN on record — the file is not password protected"],
    summary: `Form 12BB for FY ${fyLabel}`,
  };
}

// ---------------------------------------------------------------------------
//  Loans
// ---------------------------------------------------------------------------

/** The four cards on Loan Summary. */
export async function loanSummaryFor(employeeId: string) {
  const loans = await prisma.loan.findMany({
    where: { employeeId, status: { in: ["DISBURSED", "ACTIVE", "CLOSED", "FORECLOSED"] } },
    select: { status: true, principal: true, outstanding: true, emiAmount: true },
  });
  const ongoing = loans.filter((l) => l.status === "ACTIVE" || l.status === "DISBURSED");
  return {
    outstandingPrincipal: r2(ongoing.reduce((s, l) => s + n(l.outstanding), 0)),
    ongoingEmi: r2(ongoing.reduce((s, l) => s + n(l.emiAmount), 0)),
    ongoingCount: ongoing.length,
    issuedCount: loans.length,
    totalIssued: r2(loans.reduce((s, l) => s + n(l.principal), 0)),
  };
}

/** Loan Policy Explanation: the policy's eligibility rules and its categories. */
export async function loanPolicyView(tenantId: string, fmt: (n: number) => string) {
  const policy = await prisma.loanPolicy.findFirst({
    where: { tenantId, isActive: true },
    include: { rules: { include: { category: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!policy) return null;
  const approvers = Array.isArray(policy.approverRoleIds) ? policy.approverRoleIds.length : 0;
  return {
    name: policy.name,
    description: policy.description,
    eligibility: loanEligibilityLines({
      minDaysFromJoining: policy.minDaysFromJoining, minAnnualSalary: policy.minAnnualSalary === null ? null : n(policy.minAnnualSalary),
      maxAnnualSalary: policy.maxAnnualSalary === null ? null : n(policy.maxAnnualSalary),
      blockOnNoticePeriod: policy.blockOnNoticePeriod, requireProbationComplete: policy.requireProbationComplete, approvalRequired: approvers > 0,
    }, fmt),
    categories: policy.rules
      .filter((r) => r.category.isActive)
      .sort((a, b) => a.category.name.localeCompare(b.category.name))
      .map((r) => {
        const amount = r.maxAmount === null ? null : n(r.maxAmount);
        const pct = r.maxPercentOfSalary === null ? null : n(r.maxPercentOfSalary);
        return {
          id: r.category.id, name: r.category.name, code: r.category.code, description: r.category.description, icon: r.category.icon,
          limit: amount === null && pct === null ? "No Limit" : amount !== null ? fmt(amount) : null,
          limitNote: pct !== null ? `${pct} % of annual salary` : null,
          interest: interestLabel(r.interestType, n(r.interestRate)),
          maxInstallments: r.maxInstallments,
        };
      }),
  };
}

/** One disbursed loan with its schedule totals, for the detail pane. */
export async function loanDetailFor(employeeId: string, loanId: string) {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, employeeId },
    include: { category: true, schedule: { orderBy: { sequence: "asc" } } },
  });
  if (!loan) return null;
  const totals = scheduleTotals(loan.schedule.map((i) => ({ principalPart: n(i.principalPart), interestPart: n(i.interestPart), totalAmount: n(i.totalAmount), status: i.status })));
  const approver = loan.approvedBy ? await prisma.user.findUnique({ where: { id: loan.approvedBy }, select: { email: true, employee: { select: { displayName: true } } } }) : null;
  return { loan, totals, approvedBy: approver?.employee?.displayName ?? approver?.email ?? null, monthLabel: (y: number, m: number) => `${MONTHS[m]} ${y}` };
}
