import type { PrismaClient } from "@prisma/client";
import { SYSTEM_ROLES } from "../../../rbac/src/roles";
import { PERMISSIONS } from "../../../rbac/src/permissions";

/**
 * Org analytics seed: the history the charts and the attrition-risk model
 * need, consistent with the Acme tenant on 1 Oct 2026.
 *
 *  - The exit-reason master, and reasons on the three live exits.
 *  - 24 people who left between Oct 2024 and Aug 2026 (ACM0101–ACM0124), with
 *    salaries, raises, job history and ratings, so "why people leave" has a
 *    story: Sales and Customer Success lose people at 1–3 years' tenure who
 *    went 18+ months without a raise.
 *  - Raise history for the current team, without changing what payroll pays.
 *  - A few deliberate warning signs (manager churn, short-notice leave, a
 *    falling rating) so Flight risk shows High, Medium and Low.
 *  - Monthly risk snapshots, two widget comments and one shared storyboard.
 *
 * Idempotent: it removes everything it made (tagged `seed:analytics`, or the
 * ACM01xx numbers) before making it again, and restores the joining salaries
 * it adjusted. It runs as part of the main seed, or alone by calling
 * `seedAnalytics(prisma, { tenantId })` for an existing tenant.
 */

const TAG = "seed:analytics";
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (s: string) => new Date(`${s}T00:00:00Z`);
const DAY = 86_400_000;

type ExitType = "RESIGNATION" | "TERMINATION" | "RETIREMENT" | "ABSCONDING" | "END_OF_CONTRACT";
type Gender = "MALE" | "FEMALE" | "UNDISCLOSED";

const REASONS: Array<{ name: string; kind: "VOLUNTARY" | "INVOLUNTARY" | "OTHER" }> = [
  { name: "Career growth", kind: "VOLUNTARY" }, { name: "Compensation", kind: "VOLUNTARY" },
  { name: "Higher studies", kind: "VOLUNTARY" }, { name: "Relocation", kind: "VOLUNTARY" },
  { name: "Personal/family", kind: "VOLUNTARY" }, { name: "Health", kind: "VOLUNTARY" },
  { name: "Work-life balance", kind: "VOLUNTARY" }, { name: "Manager/team", kind: "VOLUNTARY" },
  { name: "Role mismatch", kind: "VOLUNTARY" },
  { name: "Performance", kind: "INVOLUNTARY" }, { name: "Misconduct", kind: "INVOLUNTARY" }, { name: "Restructuring", kind: "INVOLUNTARY" },
  { name: "Contract ended", kind: "OTHER" }, { name: "Retirement", kind: "OTHER" }, { name: "Other", kind: "OTHER" },
];

/** [first, last, gender, dept, title, manager, joined, born, lastDay, type, reason, CTC, raise?, rating 24-25, rating 25-26, worker, city, note] */
type Leaver = [string, string, Gender, string, string, string, string, string, string, ExitType, string, number, [string, number] | null, number | null, number | null, "Permanent" | "Contract" | "Intern", string, string];
const LEAVERS: Leaver[] = [
  ["Arvind", "Rao", "MALE", "SALES", "Account Executive", "ACM0015", "2022-06-13", "1996-03-11", "2024-10-31", "RESIGNATION", "Compensation", 1150000, ["2023-04-01", 0.06], null, null, "Permanent", "Mumbai", "Offered 30% more at a fintech."],
  ["Sakshi", "Jain", "FEMALE", "CS", "Customer Success Associate", "ACM0017", "2024-02-05", "2000-08-19", "2024-11-29", "RESIGNATION", "Higher studies", 600000, null, null, null, "Permanent", "Chennai", "MBA admit, starting in January."],
  ["Mohit", "Bansal", "MALE", "PROD", "Software Engineer", "ACM0007", "2021-07-12", "1995-01-23", "2024-12-31", "RESIGNATION", "Career growth", 1300000, ["2023-04-01", 0.08], null, null, "Permanent", "Bengaluru", "Wanted a senior role sooner than our cycle allowed."],
  ["Farhan", "Qureshi", "MALE", "SALES", "Sales Development Representative", "ACM0015", "2024-05-20", "2001-11-02", "2025-01-17", "TERMINATION", "Performance", 550000, null, null, null, "Permanent", "Mumbai", "Missed pipeline targets three quarters running."],
  ["Ishita", "Menon", "FEMALE", "QA", "QA Engineer", "ACM0005", "2023-01-09", "1997-05-30", "2025-03-28", "RESIGNATION", "Compensation", 750000, null, null, null, "Permanent", "Hyderabad", "Market correction elsewhere was larger than our offer."],
  ["Vivek", "Anand", "MALE", "PLAT", "Senior Software Engineer", "ACM0006", "2018-08-06", "1989-09-14", "2025-04-30", "RESIGNATION", "Career growth", 2100000, ["2024-04-01", 0.10], null, null, "Permanent", "Bengaluru", "Moving to a staff role at a product company."],
  ["Nandini", "Iyer", "FEMALE", "SALES", "Account Executive", "ACM0015", "2023-03-06", "1998-07-07", "2025-05-30", "RESIGNATION", "Compensation", 900000, null, 4.2, null, "Permanent", "Mumbai", "Top closer; no revision since joining."],
  ["Rakesh", "Yadav", "MALE", "SD", "Delivery Analyst", "ACM0023", "2023-09-11", "1999-12-01", "2025-06-20", "ABSCONDING", "Other", 480000, null, 2.6, null, "Contract", "Chennai", "Stopped reporting; unreachable after 10 days."],
  ["Pallavi", "Deshpande", "FEMALE", "PROD", "Software Engineer", "ACM0007", "2022-09-05", "1998-02-17", "2025-07-31", "RESIGNATION", "Manager/team", 1150000, ["2023-10-01", 0.07], 4.0, null, "Permanent", "Bengaluru", "Two manager changes in a year; felt unsupported."],
  ["Kiran", "Kumar", "MALE", "CS", "Customer Success Manager", "ACM0017", "2021-03-15", "1992-04-25", "2025-09-30", "RESIGNATION", "Career growth", 1200000, ["2023-04-01", 0.06], 4.4, null, "Permanent", "Chennai", "Head of CS role at a Series B startup."],
  ["Sunita", "Rawat", "FEMALE", "FIN", "Accounts Executive", "ACM0002", "2015-02-02", "1966-06-20", "2025-10-31", "RETIREMENT", "Retirement", 1400000, ["2025-04-01", 0.06], 3.4, null, "Permanent", "Bengaluru", "Retired after ten years with us."],
  ["Abhishek", "Sinha", "MALE", "SALES", "Account Executive", "ACM0015", "2024-08-19", "2000-10-10", "2025-11-28", "RESIGNATION", "Career growth", 800000, null, 3.4, null, "Permanent", "Mumbai", "Moved into enterprise sales elsewhere."],
  ["Tanya", "Kohli", "FEMALE", "MKTG", "Content Marketer", "ACM0018", "2023-01-09", "1997-09-29", "2025-12-31", "RESIGNATION", "Work-life balance", 850000, ["2024-04-01", 0.04], 3.8, null, "Permanent", "Bengaluru", "Launch calendar left little room; going freelance."],
  ["Gautam", "Shetty", "MALE", "PROD", "Software Engineer", "ACM0007", "2025-06-02", "2001-05-05", "2026-02-27", "TERMINATION", "Misconduct", 900000, null, null, null, "Permanent", "Bengaluru", "Policy breach confirmed by the disciplinary panel."],
  ["Riya", "Sen", "FEMALE", "CS", "Customer Success Associate", "ACM0017", "2023-07-03", "1999-01-15", "2026-03-31", "RESIGNATION", "Compensation", 650000, null, 4.0, null, "Permanent", "Chennai", "No revision in nearly three years."],
  ["Amit", "Chawla", "MALE", "SALES", "Account Executive", "ACM0015", "2022-11-14", "1995-06-08", "2026-04-30", "RESIGNATION", "Career growth", 1050000, ["2024-04-01", 0.05], 4.2, null, "Permanent", "Mumbai", "Regional sales lead role at a competitor."],
  ["Deepika", "Nair", "FEMALE", "PROD", "Software Engineer", "ACM0007", "2024-10-07", "2002-02-14", "2026-05-29", "RESIGNATION", "Higher studies", 700000, null, 3.6, 3.4, "Permanent", "Bengaluru", "MS in Computer Science, Fall 2026."],
  ["Harsh", "Vardhan", "MALE", "PLAT", "Software Engineering Intern", "ACM0006", "2025-08-04", "2003-03-21", "2026-05-15", "END_OF_CONTRACT", "Contract ended", 300000, null, null, null, "Intern", "Bengaluru", "Internship completed."],
  ["Shalini", "Gupta", "FEMALE", "CS", "Customer Success Manager", "ACM0017", "2022-01-17", "1990-08-08", "2026-06-30", "RESIGNATION", "Relocation", 1300000, ["2025-04-01", 0.08], 4.0, 3.8, "Permanent", "Mumbai", "Spouse transferred to Pune."],
  ["Rohan", "Mehta", "MALE", "SALES", "Account Executive", "ACM0015", "2023-09-04", "1996-12-12", "2026-07-31", "RESIGNATION", "Compensation", 1000000, null, 4.2, 4.4, "Permanent", "Mumbai", "Counter-offer declined; gap was too wide."],
  ["Neeraj", "Pandey", "MALE", "SD", "Delivery Analyst", "ACM0023", "2025-11-03", "1992-06-30", "2026-07-24", "TERMINATION", "Performance", 520000, null, null, 2.2, "Contract", "Chennai", "Did not clear the improvement plan."],
  ["Aishwarya", "Reddy", "FEMALE", "PROD", "Senior Software Engineer", "ACM0007", "2022-04-11", "1993-10-03", "2026-08-14", "RESIGNATION", "Career growth", 1750000, ["2024-04-01", 0.09], 4.4, 4.6, "Permanent", "Hyderabad", "Tech lead role; our promotion window was a year away."],
  ["Kunal", "Joshi", "UNDISCLOSED", "QA", "QA Engineer", "ACM0005", "2024-03-04", "1999-07-19", "2026-08-21", "RESIGNATION", "Relocation", 680000, ["2025-04-01", 0.06], 3.6, 3.4, "Permanent", "Hyderabad", "Moving back to Jaipur."],
  ["Swapnil", "Kale", "MALE", "CS", "Customer Success Associate", "ACM0017", "2024-01-08", "1983-11-21", "2026-08-31", "RESIGNATION", "Manager/team", 700000, null, 3.6, 3.2, "Permanent", "Chennai", "Unhappy with the account reshuffle."],
];

/** Current staff whose raise history the risk story depends on. */
const NO_RAISE = new Set(["ACM0016", "ACM0017", "ACM0029", "ACM0027", "ACM0028"]);
const SPECIAL_RAISE: Record<string, [string, number]> = { ACM0011: ["2025-02-01", 0.03], ACM0012: ["2025-04-01", 0.04] };
/** 2024-25 ratings that differ from the person's 2025-26 rating on purpose. */
const RATING_2425: Record<string, number> = { ACM0016: 3.8, ACM0011: 4.8, ACM0012: 4.0 };
/** Manager history: [employee, effective, manager] — all within the last year. */
const MANAGER_MOVES: Array<[string, string, string]> = [
  ["ACM0016", "2025-10-06", "ACM0001"], ["ACM0016", "2026-01-05", "ACM0018"], ["ACM0016", "2026-04-06", "ACM0015"],
  ["ACM0017", "2025-10-06", "ACM0015"], ["ACM0017", "2025-12-01", "ACM0023"], ["ACM0017", "2026-06-01", "ACM0015"],
  ["ACM0011", "2025-10-06", "ACM0005"], ["ACM0011", "2026-01-05", "ACM0006"], ["ACM0011", "2026-04-06", "ACM0005"],
];
/** One-day leaves applied the evening before: [employee, date, reason]. */
const SHORT_LEAVES: Array<[string, string, string]> = [
  ["ACM0016", "2026-09-07", "Personal errand"], ["ACM0016", "2026-09-18", "Not feeling well"], ["ACM0016", "2026-09-28", "Family function"],
  ["ACM0012", "2026-09-04", "Personal work"], ["ACM0012", "2026-09-25", "Not feeling well"],
  ["ACM0011", "2026-09-11", "Bank work"], ["ACM0011", "2026-09-29", "Personal errand"],
];

export async function seedAnalytics(prisma: PrismaClient, ctx: { tenantId: string; today?: Date }) {
  const t = ctx.tenantId;
  const today = ctx.today ?? utc(2026, 10, 1);
  const svc = await import("@keka/services");

  // ---- Permissions on the system roles (the DB predates them) ----------------
  const analyticsPerms = [PERMISSIONS.ANALYTICS_VIEW, PERMISSIONS.ATTRITION_RISK_VIEW] as string[];
  // An earlier draft used "analytics.org.view" for ANALYTICS_VIEW; drop any rows it left behind.
  await prisma.rolePermission.deleteMany({ where: { permission: "analytics.org.view", role: { tenantId: t } } });
  const roles = await prisma.role.findMany({ where: { tenantId: t, isSystem: true }, select: { id: true, key: true } });
  let granted = 0;
  for (const def of SYSTEM_ROLES) {
    const role = roles.find((r) => r.key === def.key);
    if (!role) continue;
    for (const p of def.permissions.filter((x) => analyticsPerms.includes(x))) {
      await prisma.rolePermission.upsert({ where: { roleId_permission: { roleId: role.id, permission: p } }, create: { roleId: role.id, permission: p }, update: {} });
      granted++;
    }
  }

  // ---- Clear what this module made before ------------------------------------
  const leaverNumbers = LEAVERS.map((_, i) => `ACM${String(101 + i).padStart(4, "0")}`);
  await prisma.storyboardShare.deleteMany({ where: { tenantId: t } });
  await prisma.analyticsComment.deleteMany({ where: { tenantId: t } });
  await prisma.attritionRiskScore.deleteMany({ where: { tenantId: t } });
  const mine = await prisma.salaryRevision.findMany({ where: { createdBy: TAG, employee: { tenantId: t } }, select: { id: true, employeeId: true, annualCtc: true } });
  for (const r of mine) {
    const joining = await prisma.salaryRevision.findFirst({ where: { employeeId: r.employeeId, previousCtc: null }, orderBy: { effectiveFrom: "asc" } });
    if (joining) await prisma.salaryRevision.update({ where: { id: joining.id }, data: { annualCtc: r.annualCtc } });
  }
  await prisma.salaryRevision.deleteMany({ where: { id: { in: mine.map((r) => r.id) } } });
  await prisma.employeeJobRecord.deleteMany({ where: { createdBy: TAG, employee: { tenantId: t } } });
  await prisma.employee.deleteMany({ where: { tenantId: t, employeeNumber: { in: leaverNumbers } } });
  await prisma.reviewCycle.deleteMany({ where: { tenantId: t, name: "Annual review 2024-25" } });
  await prisma.exitRecord.updateMany({ where: { employee: { tenantId: t } }, data: { reasonId: null } });
  await prisma.exitReason.deleteMany({ where: { tenantId: t } });

  // ---- Exit reasons ---------------------------------------------------------------
  await prisma.exitReason.createMany({ data: REASONS.map((r, i) => ({ tenantId: t, name: r.name, kind: r.kind, displayOrder: i })) });
  const reasonId = new Map((await prisma.exitReason.findMany({ where: { tenantId: t } })).map((r) => [r.name, r.id]));
  const byNumber = async (n: string) => prisma.employee.findFirst({ where: { tenantId: t, employeeNumber: n } });
  for (const [n, reason] of [["ACM0027", "Higher studies"], ["ACM0028", "Relocation"], ["ACM0029", "Career growth"]] as const) {
    const e = await byNumber(n);
    if (e) await prisma.exitRecord.updateMany({ where: { employeeId: e.id }, data: { reasonId: reasonId.get(reason)! } });
  }

  // ---- Reference lookups --------------------------------------------------------
  const emps = await prisma.employee.findMany({ where: { tenantId: t }, select: { id: true, employeeNumber: true, departmentId: true, businessUnitId: true, legalEntityId: true, costCenterId: true, status: true, dateOfJoining: true, reportingManagerId: true, locationId: true, payGradeId: true, bandId: true, workerTypeId: true, userId: true } });
  const num = new Map(emps.map((e) => [e.employeeNumber, e]));
  const depts = await prisma.department.findMany({ where: { tenantId: t }, select: { id: true, code: true } });
  const deptId = (code: string) => depts.find((d) => d.code === code)?.id ?? null;
  const locs = await prisma.location.findMany({ where: { tenantId: t }, select: { id: true, city: true } });
  const grades = await prisma.payGrade.findMany({ where: { tenantId: t }, select: { id: true, name: true } });
  const bands = await prisma.band.findMany({ where: { tenantId: t }, select: { id: true, name: true } });
  const workers = await prisma.workerType.findMany({ where: { tenantId: t }, select: { id: true, name: true } });
  const gradeFor = (ctc: number) => grades.find((g) => g.name === (ctc < 650000 ? "G1" : ctc < 1250000 ? "G2" : ctc < 2200000 ? "G3" : ctc < 3700000 ? "G4" : "G5"))?.id ?? null;
  const bandFor = (title: string, ctc: number) => bands.find((b) => b.name.startsWith(/Intern/.test(title) ? "B1" : /Associate|Analyst|Representative/.test(title) ? "B1" : ctc < 1250000 ? "B2" : ctc < 2200000 ? "B3" : "B4"))?.id ?? null;

  // ---- 2024-25 review cycle -------------------------------------------------------
  const lastYear = await prisma.reviewCycle.findFirst({ where: { tenantId: t, name: "Annual review 2025-26" } });
  const cycle2425 = await prisma.reviewCycle.create({
    data: {
      tenantId: t, name: "Annual review 2024-25", status: "COMPLETED", timing: "SYNCHRONOUS",
      periodStart: utc(2024, 4, 1), periodEnd: utc(2025, 3, 31), reviewOpensAt: utc(2025, 3, 15), reviewClosesAt: utc(2025, 4, 30),
      reviewerTypes: [{ type: "SELF", weight: 20 }, { type: "MANAGER", weight: 80 }], ratingScale: { min: 1, max: 5 }, launchedAt: utc(2025, 3, 15),
    },
  });
  const shared2425 = utc(2025, 5, 10), shared2526 = utc(2026, 5, 10);
  // Current staff who were here for 2024-25: their 2025-26 rating, nudged deterministically.
  const lastRatings = lastYear ? await prisma.employeeReview.findMany({ where: { cycleId: lastYear.id, finalRating: { not: null } }, select: { employeeId: true, finalRating: true } }) : [];
  for (const e of emps) {
    if (e.dateOfJoining.getTime() > utc(2025, 3, 31).getTime() || e.status === "PREBOARDING") continue;
    const last = lastRatings.find((r) => r.employeeId === e.id);
    const nudge = [0, 0.2, -0.2, 0, 0.4, -0.2][Number(e.employeeNumber.slice(3)) % 6];
    const r = RATING_2425[e.employeeNumber] ?? Math.max(2, Math.min(5, Math.round(((last ? Number(last.finalRating) : 3.4) + nudge) * 10) / 10));
    await prisma.employeeReview.create({ data: { cycleId: cycle2425.id, employeeId: e.id, status: "SHARED", rawRating: r, finalRating: r, sharedAt: shared2425, acknowledgedAt: new Date(shared2425.getTime() + 3 * DAY) } });
  }

  // ---- Raise history for the current team ------------------------------------------
  const nonInitial = new Set((await prisma.salaryRevision.findMany({ where: { employee: { tenantId: t }, previousCtc: { not: null } }, select: { employeeId: true } })).map((r) => r.employeeId));
  let raises = 0;
  for (const e of emps) {
    if (NO_RAISE.has(e.employeeNumber) || nonInitial.has(e.id) || e.status === "EXITED" || e.status === "PREBOARDING") continue;
    const special = SPECIAL_RAISE[e.employeeNumber];
    if (!special && e.dateOfJoining.getTime() >= utc(2025, 4, 1).getTime()) continue;
    const joining = await prisma.salaryRevision.findFirst({ where: { employeeId: e.id, previousCtc: null, status: "APPLIED" }, orderBy: { effectiveFrom: "asc" } });
    if (!joining) continue;
    const ctc = Number(joining.annualCtc);
    const pct = special ? special[1] : [0.06, 0.08, 0.1, 0.12, 0.07, 0.09][Number(e.employeeNumber.slice(3)) % 6];
    const previous = Math.round(ctc / (1 + pct) / 100) * 100;
    await prisma.salaryRevision.update({ where: { id: joining.id }, data: { annualCtc: previous } });
    await prisma.salaryRevision.create({
      data: {
        employeeId: e.id, structureId: joining.structureId, effectiveFrom: special ? iso(special[0]) : utc(2026, 4, 1),
        annualCtc: ctc, previousCtc: previous, remunerationType: joining.remunerationType, status: "APPLIED",
        reason: special ? "Annual appraisal 2025" : "Annual appraisal 2026", arrearsProcessed: true,
        approvedAt: special ? iso(special[0]) : utc(2026, 3, 25), createdBy: TAG,
      },
    });
    raises++;
  }

  // ---- People who have left ---------------------------------------------------------
  for (const [i, L] of LEAVERS.entries()) {
    const [first, last, gender, dept, title, mgr, joined, born, lwdS, type, reason, ctc, raise, r2425, r2526, worker, city, note] = L;
    const peer = emps.find((e) => e.departmentId === deptId(dept) && e.status !== "EXITED");
    const lwd = iso(lwdS);
    const noticeDays = type === "RESIGNATION" ? 60 : type === "TERMINATION" ? 30 : type === "ABSCONDING" ? 0 : 90;
    const notice = new Date(lwd.getTime() - noticeDays * DAY);
    const employeeNumber = leaverNumbers[i];
    const managerId = num.get(mgr)?.id ?? null;
    const doj = iso(joined);
    const raiseRow = raise ? { at: iso(raise[0]), before: Math.round(ctc / (1 + raise[1]) / 100) * 100 } : null;
    const e = await prisma.employee.create({
      data: {
        tenantId: t, employeeNumber, firstName: first, lastName: last, displayName: `${first} ${last}`,
        workEmail: `${first.toLowerCase()}.${last.toLowerCase()}@acme.test`, gender, dateOfBirth: iso(born), dateOfJoining: doj,
        confirmationDate: new Date(doj.getTime() + 180 * DAY) < lwd ? new Date(doj.getTime() + 180 * DAY) : null,
        status: "EXITED", jobTitleName: title,
        departmentId: deptId(dept), businessUnitId: peer?.businessUnitId ?? null, legalEntityId: peer?.legalEntityId ?? null, costCenterId: peer?.costCenterId ?? null,
        locationId: locs.find((l) => l.city === city)?.id ?? peer?.locationId ?? null,
        payGradeId: gradeFor(ctc), bandId: bandFor(title, ctc), workerTypeId: workers.find((w) => w.name === worker)?.id ?? null,
        reportingManagerId: managerId, exitInitiatedAt: notice, lastWorkingDay: lwd,
        isRehireEligible: !["TERMINATION", "ABSCONDING"].includes(type),
      },
    });
    await prisma.exitRecord.create({
      data: {
        employeeId: e.id, type, reasonId: reasonId.get(reason) ?? null, reason: note, status: "COMPLETED",
        noticeDate: notice, lastWorkingDay: lwd, hadDiscussion: type === "RESIGNATION", isRehireEligible: !["TERMINATION", "ABSCONDING"].includes(type),
        approvedAt: new Date(notice.getTime() + 2 * DAY), discussionNote: type === "RESIGNATION" ? "Exit interview held with HR." : null,
      },
    });
    await prisma.salaryRevision.create({ data: { employeeId: e.id, effectiveFrom: doj, annualCtc: raiseRow ? raiseRow.before : ctc, status: "APPLIED", reason: "Initial compensation on joining", createdBy: TAG } });
    if (raiseRow) await prisma.salaryRevision.create({ data: { employeeId: e.id, effectiveFrom: raiseRow.at, annualCtc: ctc, previousCtc: raiseRow.before, status: "APPLIED", reason: `Annual appraisal ${raiseRow.at.getUTCFullYear()}`, arrearsProcessed: true, createdBy: TAG } });
    await prisma.employeeJobRecord.create({ data: { employeeId: e.id, effectiveFrom: doj, reason: "NEW_HIRE", departmentId: deptId(dept), reportingManagerId: managerId, createdBy: TAG } });
    if (["Pallavi", "Swapnil", "Kiran", "Mohit"].includes(first)) {
      const moved = new Date(Math.max(doj.getTime() + 120 * DAY, lwd.getTime() - 240 * DAY));
      await prisma.employeeJobRecord.create({ data: { employeeId: e.id, effectiveFrom: moved, reason: "MANAGER_CHANGE", departmentId: deptId(dept), reportingManagerId: num.get("ACM0004")?.id ?? managerId, createdBy: TAG } });
      await prisma.employeeJobRecord.create({ data: { employeeId: e.id, effectiveFrom: new Date(moved.getTime() + 90 * DAY), reason: "MANAGER_CHANGE", departmentId: deptId(dept), reportingManagerId: managerId, createdBy: TAG } });
    }
    if (r2425 !== null) await prisma.employeeReview.create({ data: { cycleId: cycle2425.id, employeeId: e.id, status: "SHARED", rawRating: r2425, finalRating: r2425, sharedAt: shared2425 } });
    if (r2526 !== null && lastYear) await prisma.employeeReview.create({ data: { cycleId: lastYear.id, employeeId: e.id, status: "SHARED", rawRating: r2526, finalRating: r2526, sharedAt: shared2526 } });
  }

  // ---- Warning signs on the current team --------------------------------------------
  for (const [n, at, mgr] of MANAGER_MOVES) {
    const e = num.get(n), m = num.get(mgr);
    if (!e || !m) continue;
    await prisma.employeeJobRecord.create({ data: { employeeId: e.id, effectiveFrom: iso(at), reason: "MANAGER_CHANGE", departmentId: e.departmentId, reportingManagerId: m.id, note: "Team restructure", createdBy: TAG } });
  }
  const cl = await prisma.leaveType.findFirst({ where: { tenantId: t, code: "CL" } });
  let shortLeaves = 0;
  for (const [n, day, why] of SHORT_LEAVES) {
    const e = num.get(n);
    if (!e || !cl) continue;
    const date = iso(day);
    const exists = await prisma.leaveRequest.findFirst({ where: { employeeId: e.id, fromDate: date, status: { in: ["PENDING", "APPROVED"] } } });
    if (exists) { shortLeaves++; continue; }
    const res = await svc.applyLeave({ employeeId: e.id, leaveTypeId: cl.id, from: date, to: date, reason: why, onBehalf: true, today: new Date(date.getTime() - DAY) });
    if (!res.ok || !res.requestId) { console.warn(`  analytics seed: leave for ${n} on ${day} refused: ${res.issues.map((x) => x.message).join("; ")}`); continue; }
    const mgrId = (await prisma.employee.findUnique({ where: { id: e.id }, select: { reportingManagerId: true } }))?.reportingManagerId;
    await svc.decideLeave({ requestId: res.requestId, decision: "APPROVE", approverEmployeeId: mgrId });
    // Applied the evening before.
    await prisma.leaveRequest.update({ where: { id: res.requestId }, data: { createdAt: new Date(date.getTime() - 5.5 * 3_600_000) } });
    shortLeaves++;
  }

  // ---- Risk snapshots, Apr–Oct 2026 ---------------------------------------------------
  const inputs = await svc.loadRiskInputs(t);
  let snapshots = 0;
  for (let m = 4; m <= today.getUTCMonth() + 1; m++) snapshots += await svc.snapshotRisk(t, utc(2026, m, 1), inputs);
  const now = svc.scoreAll(inputs, today);
  const bandsNow = { HIGH: now.filter((s) => s.band === "HIGH").length, MEDIUM: now.filter((s) => s.band === "MEDIUM").length, LOW: now.filter((s) => s.band === "LOW").length };

  // ---- A shared storyboard and widget comments ----------------------------------------
  const user = async (email: string) => prisma.user.findFirst({ where: { tenantId: t, email } });
  const [priya, vikram, arjun] = await Promise.all([user("priya.sharma@acme.test"), user("vikram.menon@acme.test"), user("arjun.nair@acme.test")]);
  if (priya && vikram) {
    await prisma.analyticsComment.createMany({
      data: [
        { tenantId: t, board: "attrition", widget: "department", authorId: priya.id, body: "Sales and Customer Success account for half of this year's exits — mostly people with 1–3 years' tenure. Taking this to the GTM leadership review.", createdAt: utc(2026, 9, 22) },
        { tenantId: t, board: "attrition", widget: "since-raise", authorId: vikram.id, body: "Let's bring the off-cycle correction for long-unrevised high performers to the October board meeting.", createdAt: utc(2026, 9, 24) },
      ],
    });
  }
  if (priya && arjun) await prisma.storyboardShare.create({ data: { tenantId: t, board: "attrition", ownerId: priya.id, userId: arjun.id, filters: {} } });

  return { reasons: REASONS.length, leavers: LEAVERS.length, raises, shortLeaves, snapshots, granted, risk: bandsNow };
}
