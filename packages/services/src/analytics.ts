import { prisma, type Prisma } from "@keka/db";
import {
  DAY, leavingDate, utcDay, riskEligible, riskFeaturesAt, scoreRisk, RISK_MODEL_VERSION,
  type PopMember, type RiskInputs, type RiskResult,
} from "./analytics-math";

/**
 * Org analytics, loaded: the population behind every chart, and the
 * attrition-risk model run over the database. All definitions live in
 * analytics-math; this file only reads.
 */

export interface PopEmployee extends PopMember {
  employeeNumber: string;
  name: string;
  jobTitle: string | null;
  gender: string | null;
  dateOfBirth: Date | null;
  reportingManagerId: string | null;
  /** The reporting manager's name, "No manager" when there is none. */
  manager: string;
  departmentId: string | null; department: string;
  locationId: string | null; location: string;
  businessUnitId: string | null; businessUnit: string;
  legalEntityId: string | null; legalEntity: string;
  costCenterId: string | null; costCenter: string;
  workerTypeId: string | null; workerType: string;
  band: string;
  exitType: string | null;
  exitReasonId: string | null;
  exitReason: string | null;
  exitReasonKind: string | null;
  noticeDate: Date | null;
  /** Effective dates of raises (revisions that increased pay over a previous CTC). */
  raiseDates: Date[];
  /** Final ratings and when they became known. */
  ratings: Array<{ at: Date; rating: number }>;
}

const UNASSIGNED = "Unassigned";

/** Everyone matching `where` (already tenant- and scope-bound by the caller). */
export async function loadPopulation(where: Prisma.EmployeeWhereInput): Promise<PopEmployee[]> {
  const rows = await prisma.employee.findMany({
    where: { ...where, status: { not: "PREBOARDING" } },
    select: {
      id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true, jobTitleName: true,
      gender: true, dateOfBirth: true, dateOfJoining: true, status: true, lastWorkingDay: true, reportingManagerId: true,
      reportingManager: { select: { displayName: true, firstName: true, lastName: true } },
      departmentId: true, department: { select: { name: true } },
      locationId: true, location: { select: { name: true } },
      businessUnitId: true, businessUnit: { select: { name: true } },
      legalEntityId: true, legalEntity: { select: { name: true } },
      costCenterId: true, costCenter: { select: { name: true } },
      workerTypeId: true, workerType: { select: { name: true } },
      band: { select: { name: true } },
      exitRecord: { select: { status: true, type: true, lastWorkingDay: true, noticeDate: true, reasonId: true, exitReason: { select: { name: true, kind: true } } } },
      salaryRevisions: { where: { status: "APPLIED", previousCtc: { not: null } }, select: { effectiveFrom: true, annualCtc: true, previousCtc: true } },
      reviewsAboutMe: { where: { finalRating: { not: null } }, select: { finalRating: true, sharedAt: true, cycle: { select: { periodEnd: true, status: true } } } },
    },
    orderBy: { employeeNumber: "asc" },
  });
  return rows.map((e) => {
    const exitLive = e.exitRecord && !["CANCELLED", "RETAINED", "REJECTED"].includes(e.exitRecord.status) ? e.exitRecord : null;
    return {
      id: e.id, employeeNumber: e.employeeNumber, name: e.displayName ?? `${e.firstName} ${e.lastName}`, jobTitle: e.jobTitleName,
      gender: e.gender, dateOfBirth: e.dateOfBirth, dateOfJoining: e.dateOfJoining, status: e.status,
      leftOn: leavingDate({ status: e.status, lastWorkingDay: e.lastWorkingDay, exitRecord: e.exitRecord }),
      reportingManagerId: e.reportingManagerId,
      manager: e.reportingManager ? e.reportingManager.displayName ?? `${e.reportingManager.firstName} ${e.reportingManager.lastName}` : "No manager",
      departmentId: e.departmentId, department: e.department?.name ?? UNASSIGNED,
      locationId: e.locationId, location: e.location?.name ?? UNASSIGNED,
      businessUnitId: e.businessUnitId, businessUnit: e.businessUnit?.name ?? UNASSIGNED,
      legalEntityId: e.legalEntityId, legalEntity: e.legalEntity?.name ?? UNASSIGNED,
      costCenterId: e.costCenterId, costCenter: e.costCenter?.name ?? UNASSIGNED,
      workerTypeId: e.workerTypeId, workerType: e.workerType?.name ?? "None",
      band: e.band?.name ?? UNASSIGNED,
      exitType: exitLive?.type ?? null,
      exitReasonId: exitLive?.reasonId ?? null,
      exitReason: exitLive?.exitReason?.name ?? null,
      exitReasonKind: exitLive?.exitReason?.kind ?? null,
      noticeDate: exitLive?.noticeDate ?? null,
      raiseDates: e.salaryRevisions.filter((r) => Number(r.annualCtc) > Number(r.previousCtc)).map((r) => r.effectiveFrom).sort((a, b) => a.getTime() - b.getTime()),
      ratings: e.reviewsAboutMe
        .filter((r) => r.sharedAt || r.cycle.status === "COMPLETED")
        .map((r) => ({ at: r.sharedAt ?? r.cycle.periodEnd, rating: Number(r.finalRating) }))
        .sort((a, b) => a.at.getTime() - b.at.getTime()),
    };
  });
}

/** Latest final rating known on a date. */
export function ratingAt(e: PopEmployee, d: Date): number | null {
  let r: number | null = null;
  for (const x of e.ratings) if (x.at.getTime() <= d.getTime()) r = x.rating;
  return r;
}

/** Whole months from the last raise (on or before d) to d; null if never raised. */
export function monthsSinceRaiseAt(e: PopEmployee, d: Date): number | null {
  let last: Date | null = null;
  for (const x of e.raiseDates) if (x.getTime() <= d.getTime()) last = x;
  if (!last) return null;
  const m = (d.getUTCFullYear() - last.getUTCFullYear()) * 12 + (d.getUTCMonth() - last.getUTCMonth()) - (d.getUTCDate() < last.getUTCDate() ? 1 : 0);
  return Math.max(0, m);
}

// ---------------------------------------------------------------------------
//  Attrition risk
// ---------------------------------------------------------------------------

/** Everything risk-v1 reads, for a whole tenant, in a handful of queries. */
export async function loadRiskInputs(tenantId: string): Promise<RiskInputs> {
  const emps = await prisma.employee.findMany({
    where: { tenantId },
    select: {
      id: true, status: true, dateOfJoining: true, reportingManagerId: true, lastWorkingDay: true,
      payGrade: { select: { midAnnual: true } },
      exitRecord: { select: { status: true, noticeDate: true, lastWorkingDay: true, type: true } },
    },
  });
  const ids = emps.map((e) => e.id);
  const since = new Date(Date.now() - 2 * 365 * DAY);
  const [revisions, reviews, pips, jobRecords, leaves, attendance, praise] = await Promise.all([
    prisma.salaryRevision.findMany({ where: { employeeId: { in: ids }, status: "APPLIED" }, select: { employeeId: true, effectiveFrom: true, annualCtc: true, previousCtc: true } }),
    prisma.employeeReview.findMany({ where: { employeeId: { in: ids }, finalRating: { not: null } }, select: { employeeId: true, finalRating: true, sharedAt: true, cycle: { select: { periodEnd: true, status: true } } } }),
    prisma.improvementPlan.findMany({ where: { tenantId }, select: { employeeId: true, startDate: true, endDate: true, status: true, decidedAt: true } }),
    prisma.employeeJobRecord.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, effectiveFrom: true, reportingManagerId: true, reason: true } }),
    prisma.leaveRequest.findMany({ where: { tenantId, fromDate: { gte: since } }, select: { employeeId: true, fromDate: true, createdAt: true, totalDays: true, status: true } }),
    prisma.attendanceRecord.findMany({ where: { tenantId, date: { gte: new Date(Date.now() - 400 * DAY) } }, select: { employeeId: true, date: true, status: true, effectiveHours: true } }),
    prisma.praise.findMany({ where: { tenantId }, select: { toEmployeeId: true, createdAt: true } }),
  ]);
  return {
    employees: emps.map((e) => ({
      id: e.id, status: e.status, dateOfJoining: e.dateOfJoining, reportingManagerId: e.reportingManagerId,
      gradeMid: e.payGrade?.midAnnual ? Number(e.payGrade.midAnnual) : null,
      exit: e.exitRecord, lastWorkingDay: e.lastWorkingDay,
    })),
    revisions: revisions.map((r) => ({ employeeId: r.employeeId, effectiveFrom: r.effectiveFrom, annualCtc: Number(r.annualCtc), previousCtc: r.previousCtc === null ? null : Number(r.previousCtc) })),
    ratings: reviews
      .filter((r) => r.sharedAt || r.cycle.status === "COMPLETED")
      .map((r) => ({ employeeId: r.employeeId, at: r.sharedAt ?? r.cycle.periodEnd, rating: Number(r.finalRating) })),
    pips: pips.map((p) => ({ employeeId: p.employeeId, startDate: p.startDate, endDate: p.endDate, status: p.status, decidedAt: p.decidedAt })),
    jobRecords: jobRecords.map((j) => ({ employeeId: j.employeeId, effectiveFrom: j.effectiveFrom, reportingManagerId: j.reportingManagerId, reason: j.reason })),
    leaves: leaves.map((l) => ({ employeeId: l.employeeId, fromDate: l.fromDate, createdAt: l.createdAt, totalDays: Number(l.totalDays), status: l.status })),
    attendance: attendance.map((a) => ({ employeeId: a.employeeId, date: a.date, status: a.status, effectiveHours: Number(a.effectiveHours) })),
    praise: praise.map((p) => ({ toEmployeeId: p.toEmployeeId, createdAt: p.createdAt })),
  };
}

export interface ScoredEmployee extends RiskResult { employeeId: string }

/** Score everyone eligible on `asOf` (optionally only these ids). */
export function scoreAll(input: RiskInputs, asOf: Date, onlyIds?: Set<string>): ScoredEmployee[] {
  const d = utcDay(asOf);
  return input.employees
    .filter((e) => (!onlyIds || onlyIds.has(e.id)) && riskEligible(e, d))
    .map((e) => ({ employeeId: e.id, ...scoreRisk(riskFeaturesAt(input, e.id, d)) }));
}

/** Write (or overwrite) the snapshot for `asOf`. Returns how many were scored. */
export async function snapshotRisk(tenantId: string, asOf: Date, input?: RiskInputs): Promise<number> {
  const d = utcDay(asOf);
  const data = input ?? await loadRiskInputs(tenantId);
  const scored = scoreAll(data, d);
  await prisma.$transaction([
    prisma.attritionRiskScore.deleteMany({ where: { tenantId, asOf: d, modelVersion: RISK_MODEL_VERSION } }),
    prisma.attritionRiskScore.createMany({
      data: scored.map((s) => ({
        tenantId, employeeId: s.employeeId, asOf: d, score: s.score, band: s.band, coverage: s.coverage, modelVersion: RISK_MODEL_VERSION,
        factors: s.factors.map((f) => ({ key: f.key, label: f.label, points: f.points, max: f.max, detail: f.detail, hasData: f.hasData })),
      })),
    }),
  ]);
  return scored.length;
}

export interface Backtest {
  leavers: number; leaversFlagged: number; leaverShare: number;
  stayers: number; stayersFlagged: number; stayerShare: number;
  lift: number | null; thin: boolean;
}

/**
 * How well would risk-v1 have warned us? Every resignation whose notice fell
 * in the last 12 months is scored as it looked 90 days before the notice;
 * people still here are scored as they looked 90 days ago.
 */
export function backtestRisk(input: RiskInputs, today: Date, onlyIds?: Set<string>): Backtest {
  const t = utcDay(today);
  const resigned = input.employees.filter((e) => (!onlyIds || onlyIds.has(e.id)) && e.exit && e.exit.type === "RESIGNATION"
    && !["CANCELLED", "RETAINED", "REJECTED"].includes(e.exit.status)
    && e.exit.noticeDate.getTime() <= t.getTime() && e.exit.noticeDate.getTime() > t.getTime() - 365 * DAY);
  let leaversScored = 0, leaversFlagged = 0;
  for (const e of resigned) {
    const at = new Date(utcDay(e.exit!.noticeDate).getTime() - 90 * DAY);
    if (!riskEligible(e, at)) continue;
    leaversScored++;
    if (scoreRisk(riskFeaturesAt(input, e.id, at)).score >= 30) leaversFlagged++;
  }
  const back = new Date(t.getTime() - 90 * DAY);
  const stayers = input.employees.filter((e) => (!onlyIds || onlyIds.has(e.id)) && riskEligible(e, t) && riskEligible(e, back));
  const stayersFlagged = stayers.filter((e) => scoreRisk(riskFeaturesAt(input, e.id, back)).score >= 30).length;
  const leaverShare = leaversScored ? leaversFlagged / leaversScored : 0;
  const stayerShare = stayers.length ? stayersFlagged / stayers.length : 0;
  return {
    leavers: leaversScored, leaversFlagged, leaverShare,
    stayers: stayers.length, stayersFlagged, stayerShare,
    lift: stayerShare > 0 ? leaverShare / stayerShare : null,
    thin: leaversScored < 10,
  };
}
