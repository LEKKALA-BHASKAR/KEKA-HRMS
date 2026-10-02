import { prisma } from "@keka/db";
import { renderTableReport } from "@keka/documents";
import {
  fyMonths, esiHalfMonths, buildForm3A, buildForm6A, buildEsiHalfYearly, buildPtReturn, buildLwfReturn, returnToCsv,
  type ContributionRow, type StatutoryReturn, type Registration,
} from "./statutory-returns-math";

/**
 * Periodic statutory returns read from FINALISED payroll only (regular and
 * off-cycle runs that are not rolled back). The layouts live in
 * statutory-returns-math; this file loads the rows, works out which state
 * registration covers each employee, and renders CSV or PDF.
 */

export type StatutoryForm = "PF_3A" | "PF_6A" | "ESI_HALF" | "PT_MONTHLY" | "PT_ANNUAL" | "LWF";
export const STATUTORY_FORMS: Array<{ form: StatutoryForm; label: string; period: "year" | "half" | "month" }> = [
  { form: "PF_3A", label: "PF Form 3A (member cards)", period: "year" },
  { form: "PF_6A", label: "PF Form 6A (annual return)", period: "year" },
  { form: "ESI_HALF", label: "ESI half-yearly summary", period: "half" },
  { form: "PT_MONTHLY", label: "Professional Tax — monthly", period: "month" },
  { form: "PT_ANNUAL", label: "Professional Tax — annual", period: "year" },
  { form: "LWF", label: "Labour Welfare Fund", period: "year" },
];

export const PORTAL_CHECK_BANNER = "Structured return with the standard columns. Government formats vary by portal and state and change over time: check against the current portal format before filing.";

const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

/** One row per employee per finalised run in the given months. */
export async function loadContributionRows(tenantId: string, months: Array<{ year: number; month: number }>, opts: { payGroupId?: string } = {}): Promise<{ rows: ContributionRow[]; payGroupIds: string[]; missing: Array<{ year: number; month: number }> }> {
  const runs = await prisma.payrollRun.findMany({
    where: { tenantId, status: "FINALIZED", rolledBackAt: null, ...(opts.payGroupId ? { payGroupId: opts.payGroupId } : {}), OR: months.map((m) => ({ year: m.year, month: m.month })) },
    select: { id: true, year: true, month: true, payGroupId: true, type: true },
  });
  const lines = await prisma.payrollRunEmployee.findMany({
    where: { runId: { in: runs.map((r) => r.id) }, payAction: { notIn: ["HOLD_SALARY_PROCESSING", "VOID_SALARY_PROCESSING"] } },
    include: { employee: { select: { employeeNumber: true, firstName: true, lastName: true, displayName: true, locationId: true, lastWorkingDay: true, statutoryProfile: { select: { uan: true, esicNumber: true } } } } },
  });
  const payGroupIds = [...new Set(runs.map((r) => r.payGroupId))];
  const [pt, lwf] = await Promise.all([
    prisma.ptStateRegistrationLocation.findMany({ where: { registration: { payGroupId: { in: payGroupIds }, isActive: true } }, select: { locationId: true, registrationId: true, registration: { select: { payGroupId: true } } } }),
    prisma.lwfStateRegistrationLocation.findMany({ where: { registration: { payGroupId: { in: payGroupIds }, isActive: true } }, select: { locationId: true, registrationId: true, registration: { select: { payGroupId: true } } } }),
  ]);
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const rows: ContributionRow[] = lines.map((l) => {
    const run = runOf.get(l.runId)!;
    const e = l.employee;
    const lwd = e.lastWorkingDay && e.lastWorkingDay.getUTCFullYear() === run.year && e.lastWorkingDay.getUTCMonth() + 1 === run.month ? ddmmyyyy(e.lastWorkingDay) : null;
    return {
      year: run.year, month: run.month, employeeId: l.employeeId, employeeNumber: e.employeeNumber,
      name: e.displayName ?? `${e.firstName} ${e.lastName}`, uan: e.statutoryProfile?.uan ?? null, esicNumber: e.statutoryProfile?.esicNumber ?? null,
      grossWages: Number(l.grossEarnings), pfWage: Number(l.pfWage), pfEmployee: Number(l.pfEmployee), vpf: Number(l.vpf),
      pfEmployer: Number(l.pfEmployer), epsEmployer: Number(l.epsEmployer),
      // An off-cycle run pays extra money, not extra days.
      ncpDays: run.type === "OFF_CYCLE" ? 0 : Number(l.lopDays), payableDays: run.type === "OFF_CYCLE" ? 0 : Number(l.payableDays),
      esiGross: Number(l.esiGross), esiEmployee: Number(l.esiEmployee), esiEmployer: Number(l.esiEmployer),
      professionalTax: Number(l.professionalTax), lwfEmployee: Number(l.lwfEmployee), lwfEmployer: Number(l.lwfEmployer),
      ptRegistrationId: pt.find((p) => p.locationId === e.locationId && p.registration.payGroupId === run.payGroupId)?.registrationId ?? null,
      lwfRegistrationId: lwf.find((p) => p.locationId === e.locationId && p.registration.payGroupId === run.payGroupId)?.registrationId ?? null,
      lastWorkingDay: lwd,
    };
  });
  const missing = months.filter((m) => !runs.some((r) => r.year === m.year && r.month === m.month && r.type === "REGULAR"));
  return { rows, payGroupIds, missing };
}

async function establishment(tenantId: string, payGroupIds: string[]) {
  const groups = await prisma.payGroup.findMany({
    where: { tenantId, ...(payGroupIds.length ? { id: { in: payGroupIds } } : {}) },
    include: { filingDetail: true, legalEntity: true }, orderBy: { name: "asc" },
  });
  const g = groups.find((x) => x.filingDetail) ?? groups[0];
  const name = g?.legalEntity?.legalName ?? g?.legalEntity?.name ?? g?.name ?? "Employer";
  return {
    name, pf: g?.filingDetail?.pfRegistrationNumber ?? null, esi: g?.filingDetail?.esiRegistrationNumber ?? null,
    note: groups.length > 1 ? `Covers ${groups.length} pay groups; registration numbers shown are ${g?.name}'s.` : null,
  };
}

/** The return for one form and period, from finalised payroll. */
export async function buildStatutoryReturn(tenantId: string, input: { form: StatutoryForm; fy: number; half?: 1 | 2; month?: number; payGroupId?: string }): Promise<StatutoryReturn> {
  const { form, fy } = input;
  const months = form === "ESI_HALF" ? esiHalfMonths(fy, input.half ?? 1)
    : form === "PT_MONTHLY" ? fyMonths(fy).filter((m) => m.month === (input.month ?? 4))
    : fyMonths(fy);
  const { rows, payGroupIds, missing } = await loadContributionRows(tenantId, months, { payGroupId: input.payGroupId });
  if (rows.length === 0) throw new Error("No finalised payroll in that period.");
  const est = await establishment(tenantId, payGroupIds);
  const regs = async (kind: "pt" | "lwf"): Promise<Registration[]> => {
    const list = kind === "pt"
      ? await prisma.ptStateRegistration.findMany({ where: { payGroupId: { in: payGroupIds }, isActive: true }, orderBy: { stateName: "asc" } })
      : await prisma.lwfStateRegistration.findMany({ where: { payGroupId: { in: payGroupIds }, isActive: true }, orderBy: { stateName: "asc" } });
    return list.map((r) => ({ id: r.id, stateCode: r.stateCode, stateName: r.stateName, establishmentId: r.establishmentId, frequency: "frequency" in r ? String(r.frequency) : undefined }));
  };
  const r = form === "PF_3A" ? buildForm3A({ fy, rows, establishment: { name: est.name, code: est.pf } })
    : form === "PF_6A" ? buildForm6A({ fy, rows, establishment: { name: est.name, code: est.pf } })
    : form === "ESI_HALF" ? buildEsiHalfYearly({ fy, half: input.half ?? 1, rows, employer: { name: est.name, code: est.esi } })
    : form === "PT_MONTHLY" ? buildPtReturn({ fy, month: months[0], rows, registrations: await regs("pt") })
    : form === "PT_ANNUAL" ? buildPtReturn({ fy, rows, registrations: await regs("pt") })
    : buildLwfReturn({ fy, rows, registrations: await regs("lwf") });
  const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (missing.length) r.issues.push(`Not finalised, so not included: ${missing.map((m) => `${MON[m.month]} ${m.year}`).join(", ")}`);
  if (est.note) r.notes.push(est.note);
  if (form.startsWith("PT") || form === "LWF") r.notes.push("Employees are placed under the registration covering their current work location.");
  return r;
}

export function statutoryReturnFile(r: StatutoryReturn, format: "csv" | "pdf", base: string, company: string): { filename: string; mimeType: string; content: Buffer } {
  if (format === "pdf") {
    return { filename: `${base}.pdf`, mimeType: "application/pdf", content: renderTableReport({ title: r.title, subtitle: r.subtitle, company, banner: PORTAL_CHECK_BANNER, sections: r.sections, notes: r.notes, issues: r.issues }) };
  }
  return { filename: `${base}.csv`, mimeType: "text/csv", content: Buffer.from(returnToCsv(r)) };
}

/** A file name that says what and when, e.g. PF-Form6A-FY2026. */
export function statutoryReturnBase(input: { form: StatutoryForm; fy: number; half?: number; month?: number }): string {
  const fy = `FY${input.fy}`;
  switch (input.form) {
    case "PF_3A": return `PF-Form3A-${fy}`;
    case "PF_6A": return `PF-Form6A-${fy}`;
    case "ESI_HALF": return `ESI-HalfYearly-${fy}-H${input.half ?? 1}`;
    case "PT_MONTHLY": return `PT-Monthly-${fy}-${String(input.month ?? 4).padStart(2, "0")}`;
    case "PT_ANNUAL": return `PT-Annual-${fy}`;
    case "LWF": return `LWF-Returns-${fy}`;
  }
}
