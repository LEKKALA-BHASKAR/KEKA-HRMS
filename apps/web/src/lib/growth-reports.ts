import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { certificateStatus, competencyGap, enrolmentStanding, pipRisk, actionsProgress } from "@keka/services";
import type { Viewer } from "./context";
import { scopedEmployeeWhere } from "./scope";

/**
 * The growth reports: one definition per report, shared by the on-screen
 * table and the CSV download so both always show the same rows. Every report
 * is limited to the viewer's tenant and, where it lists people, to the
 * employees the viewer's permission reaches.
 */

const P = PERMISSIONS;
export interface Report { title: string; head: string[]; rows: Array<Array<string | number | null>> }
const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : "");
const lower = (s: string | null | undefined) => (s ? s.replace(/_/g, " ").toLowerCase() : "");

// ---------------------------------------------------------------------------
//  Learning
// ---------------------------------------------------------------------------

export const LEARNING_REPORTS = { records: "Learning records", courses: "Course completion", paths: "Learning paths", sessions: "Session attendance", assessments: "Quiz results", certificates: "Certificates", requests: "Learning approvals" } as const;
export type LearningReportKind = keyof typeof LEARNING_REPORTS;

export async function learningReport(viewer: Viewer, kind: LearningReportKind, q = ""): Promise<Report> {
  const who = { ...scopedEmployeeWhere(viewer, P.COURSE_ASSIGN), ...(q ? { displayName: { contains: q, mode: "insensitive" as const } } : {}) };
  const title = LEARNING_REPORTS[kind];
  const t = viewer.tenantId;
  if (kind === "records") {
    const rows = await prisma.courseEnrolment.findMany({ where: { tenantId: t, employee: who }, include: { course: { select: { title: true, category: true, credits: true } }, employee: { select: { displayName: true, employeeNumber: true, department: { select: { name: true } } } } }, orderBy: [{ employee: { displayName: "asc" } }, { assignedAt: "asc" }], take: 5000 });
    return { title, head: ["Employee", "Number", "Department", "Course", "Category", "Source", "Assigned", "Due", "Standing", "Progress %", "Completed", "Score %", "Credits"], rows: rows.map((r) => [r.employee.displayName, r.employee.employeeNumber, r.employee.department?.name ?? "", r.course.title, r.course.category, lower(r.source), d(r.assignedAt), d(r.dueDate), lower(enrolmentStanding(r)), r.progressPercent, d(r.completedAt), r.score, r.status === "COMPLETED" ? r.course.credits : 0]) };
  }
  if (kind === "courses") {
    const rows = await prisma.course.findMany({ where: { tenantId: t, ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}) }, include: { enrolments: { where: { employee: scopedEmployeeWhere(viewer, P.COURSE_ASSIGN) }, select: { status: true, dueDate: true, completedAt: true, score: true, progressPercent: true } } }, orderBy: { title: "asc" } });
    return { title, head: ["Course", "Category", "Status", "Version", "Enrolled", "Completed", "Completion %", "Overdue", "Average score %"], rows: rows.map((c) => {
      const done = c.enrolments.filter((e) => e.status === "COMPLETED");
      const scores = done.map((e) => e.score).filter((s): s is number => s !== null);
      return [c.title, c.category, lower(c.status), c.version, c.enrolments.length, done.length, c.enrolments.length ? Math.round((done.length / c.enrolments.length) * 100) : 0, c.enrolments.filter((e) => enrolmentStanding(e) === "OVERDUE").length, scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null];
    }) };
  }
  if (kind === "paths") {
    const rows = await prisma.learningPathAssignment.findMany({ where: { tenantId: t, employee: who }, include: { path: { select: { name: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: [{ path: { name: "asc" } }, { assignedAt: "asc" }] });
    return { title, head: ["Path", "Employee", "Number", "Assigned", "Due", "Status", "Progress %", "Completed"], rows: rows.map((r) => [r.path.name, r.employee.displayName, r.employee.employeeNumber, d(r.assignedAt), d(r.dueDate), lower(r.status), r.progressPercent, d(r.completedAt)]) };
  }
  if (kind === "sessions") {
    const rows = await prisma.sessionRegistration.findMany({ where: { session: { tenantId: t }, employee: who }, include: { session: { select: { title: true, startsAt: true, mode: true, status: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: [{ session: { startsAt: "desc" } }] });
    return { title, head: ["Session", "Date", "Mode", "Session status", "Employee", "Number", "Registration", "Attendance"], rows: rows.map((r) => [r.session.title, d(r.session.startsAt), lower(r.session.mode), lower(r.session.status), r.employee.displayName, r.employee.employeeNumber, lower(r.status), lower(r.attendance)]) };
  }
  if (kind === "assessments") {
    const rows = await prisma.lessonProgress.findMany({ where: { lesson: { kind: "QUIZ", course: { tenantId: t } }, enrolment: { employee: who }, attempts: { gt: 0 } }, include: { lesson: { select: { title: true, maxAttempts: true, course: { select: { title: true, passPercent: true } } } }, enrolment: { select: { employee: { select: { displayName: true, employeeNumber: true } } } } } });
    return { title, head: ["Employee", "Number", "Course", "Quiz", "Attempts", "Attempts allowed", "Best score %", "Pass mark %", "Passed"], rows: rows.map((r) => [r.enrolment.employee.displayName, r.enrolment.employee.employeeNumber, r.lesson.course.title, r.lesson.title, r.attempts, r.lesson.maxAttempts ?? "unlimited", r.score, r.lesson.course.passPercent, r.completedAt ? "Yes" : "No"]) };
  }
  if (kind === "certificates") {
    const rows = await prisma.learningCertificate.findMany({ where: { tenantId: t, employee: who }, include: { course: { select: { title: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { issuedAt: "desc" } });
    return { title, head: ["Number", "Employee", "Employee number", "Course", "Issued", "Expires", "Status", "Revoked reason"], rows: rows.map((r) => [r.number, r.employee.displayName, r.employee.employeeNumber, r.course.title, d(r.issuedAt), d(r.expiresAt), lower(certificateStatus(r)), r.revokedReason ?? ""]) };
  }
  const rows = await prisma.learningRequest.findMany({ where: { tenantId: t, employee: who }, include: { course: { select: { title: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" } });
  return { title, head: ["Employee", "Number", "Course", "Request", "Reason", "Asked", "Status", "Decided", "Note"], rows: rows.map((r) => [r.employee.displayName, r.employee.employeeNumber, r.course.title, lower(r.kind), r.reason ?? "", d(r.createdAt), lower(r.status), d(r.decidedAt), r.decisionNote ?? ""]) };
}

// ---------------------------------------------------------------------------
//  Succession and talent
// ---------------------------------------------------------------------------

export const SUCCESSION_REPORTS = { plans: "Succession plans", successors: "Successor pipeline", ninebox: "9-box placements" } as const;
export type SuccessionReportKind = keyof typeof SUCCESSION_REPORTS;

export async function successionReport(viewer: Viewer, kind: SuccessionReportKind): Promise<Report> {
  const t = viewer.tenantId;
  const title = SUCCESSION_REPORTS[kind];
  if (kind === "plans") {
    const plans = await prisma.successionPlan.findMany({ where: { tenantId: t }, include: { incumbent: { select: { displayName: true } }, successors: { include: { readiness: { select: { code: true } } } } }, orderBy: { positionTitle: "asc" } });
    return { title, head: ["Position", "Incumbent", "Criticality", "Risk of loss", "Status", "Approved successors", "Ready now", "Nominations pending", "Decided"], rows: plans.map((p) => {
      const ok = p.successors.filter((s) => s.status === "APPROVED");
      return [p.positionTitle, p.incumbent?.displayName ?? "Vacant", lower(p.criticality), lower(p.riskOfLoss), lower(p.status), ok.length, ok.filter((s) => s.readiness.code === "READY_NOW").length, p.successors.filter((s) => s.status === "NOMINATED").length, d(p.decidedAt)];
    }) };
  }
  if (kind === "successors") {
    const rows = await prisma.successor.findMany({ where: { plan: { tenantId: t } }, include: { plan: { select: { positionTitle: true } }, employee: { select: { displayName: true, employeeNumber: true } }, readiness: { select: { name: true } } }, orderBy: [{ plan: { positionTitle: "asc" } }, { rank: "asc" }] });
    return { title, head: ["Position", "Rank", "Successor", "Number", "Readiness", "Emergency cover", "Status", "Pending readiness change", "Development plan"], rows: rows.map((s) => [s.plan.positionTitle, s.rank, s.employee.displayName, s.employee.employeeNumber, s.readiness.name, s.isEmergency ? "Yes" : "No", lower(s.status), s.pendingReadinessId ? "Yes" : "", s.developmentPlanId ? "Yes" : ""]) };
  }
  const [entries, labels] = await Promise.all([
    prisma.talentReviewEntry.findMany({ where: { review: { tenantId: t } }, include: { review: { select: { name: true, status: true } }, employee: { select: { displayName: true, employeeNumber: true, department: { select: { name: true } } } } }, orderBy: [{ review: { name: "asc" } }, { box: "desc" }] }),
    prisma.talentBoxLabel.findMany({ where: { tenantId: t } }),
  ]);
  const label = new Map(labels.map((l) => [l.box, l.label]));
  return { title, head: ["Review", "Review status", "Employee", "Number", "Department", "Performance (1-3)", "Potential (1-3)", "Box", "Box label", "Flight risk", "Retention action"], rows: entries.map((e) => [e.review.name, lower(e.review.status), e.employee.displayName, e.employee.employeeNumber, e.employee.department?.name ?? "", e.performance, e.potential, e.box, e.box ? (label.get(e.box) ?? "") : "", lower(e.flightRisk), e.retentionAction ?? ""]) };
}

// ---------------------------------------------------------------------------
//  Career and mobility
// ---------------------------------------------------------------------------

export const MOBILITY_REPORTS = { applications: "Internal applications", moves: "Transfer requests", aspirations: "Career aspirations", development: "Development plans" } as const;
export type MobilityReportKind = keyof typeof MOBILITY_REPORTS;

export async function mobilityReport(viewer: Viewer, kind: MobilityReportKind): Promise<Report> {
  const t = viewer.tenantId;
  const title = MOBILITY_REPORTS[kind];
  const who = scopedEmployeeWhere(viewer, kind === "aspirations" || kind === "development" ? P.CAREER_PATH_MANAGE : P.MOBILITY_MANAGE);
  if (kind === "applications") {
    const rows = await prisma.internalApplication.findMany({ where: { tenantId: t, employee: who }, include: { job: { select: { title: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" } });
    return { title, head: ["Job", "Employee", "Number", "Applied", "Status", "Manager note", "HR note", "Decided"], rows: rows.map((r) => [r.job.title, r.employee.displayName, r.employee.employeeNumber, d(r.createdAt), lower(r.status), r.managerNote ?? "", r.hrNote ?? "", d(r.hrDecidedAt ?? r.managerDecidedAt)]) };
  }
  if (kind === "moves") {
    const [rows, depts, locs, titles] = await Promise.all([
      prisma.mobilityRequest.findMany({ where: { tenantId: t, employee: who }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" } }),
      prisma.department.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
      prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
      prisma.jobTitle.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
    ]);
    const n = new Map([...depts, ...locs, ...titles].map((x) => [x.id, x.name]));
    return { title, head: ["Employee", "Number", "Kind", "To department", "To location", "To job title", "Preferred date", "Status", "Raised", "Manager note", "HR note"], rows: rows.map((r) => [r.employee.displayName, r.employee.employeeNumber, lower(r.kind), n.get(r.toDepartmentId ?? "") ?? "", n.get(r.toLocationId ?? "") ?? "", n.get(r.toJobTitleId ?? "") ?? "", d(r.preferredDate), lower(r.status), d(r.createdAt), r.managerNote ?? "", r.hrNote ?? ""]) };
  }
  if (kind === "aspirations") {
    const rows = await prisma.careerAspiration.findMany({ where: { employee: { ...who, tenantId: t } }, include: { employee: { select: { displayName: true, employeeNumber: true } }, step: { select: { title: true, path: { select: { name: true } } } } }, orderBy: { updatedAt: "desc" } });
    return { title, head: ["Employee", "Number", "Path", "Target step", "Target date", "Open to relocate", "Status", "Manager note"], rows: rows.map((r) => [r.employee.displayName, r.employee.employeeNumber, r.step.path.name, r.step.title, d(r.targetDate), r.openToRelocate ? "Yes" : "No", lower(r.status), r.managerNote ?? ""]) };
  }
  const rows = await prisma.developmentPlan.findMany({ where: { tenantId: t, employee: who }, include: { employee: { select: { displayName: true, employeeNumber: true } }, actions: { select: { status: true } } }, orderBy: { createdAt: "desc" } });
  return { title, head: ["Employee", "Number", "Plan", "Start", "End", "Status", "Actions", "Verified %", "Decision note"], rows: rows.map((r) => [r.employee.displayName, r.employee.employeeNumber, r.title, d(r.startDate), d(r.endDate), lower(r.status), r.actions.length, actionsProgress(r.actions), r.decisionNote ?? ""]) };
}

// ---------------------------------------------------------------------------
//  Skills
// ---------------------------------------------------------------------------

export const SKILL_REPORTS = { inventory: "Skill inventory", gaps: "Competency gaps", assessments: "Assessment history", library: "Skill library" } as const;
export type SkillReportKind = keyof typeof SKILL_REPORTS;

export async function skillsReport(viewer: Viewer, kind: SkillReportKind, frameworkId?: string): Promise<Report> {
  const t = viewer.tenantId;
  const title = SKILL_REPORTS[kind];
  const who = scopedEmployeeWhere(viewer, P.SKILL_MANAGE);
  const levelName = (levels: unknown, i: number | null) => (i === null ? "" : Array.isArray(levels) && levels[i] ? String(levels[i]) : String(i));
  if (kind === "library") {
    const rows = await prisma.skill.findMany({ where: { tenantId: t }, include: { _count: { select: { employeeSkills: true, competencyItems: true } } }, orderBy: { name: "asc" } });
    return { title, head: ["Skill", "Category", "Status", "Active", "Critical", "Levels", "Validity (months)", "People", "Frameworks"], rows: rows.map((s) => [s.name, s.category ?? "", lower(s.status), s.isActive ? "Yes" : "No", s.isCritical ? "Yes" : "No", Array.isArray(s.levels) ? (s.levels as string[]).join(" / ") : "", s.validityMonths, s._count.employeeSkills, s._count.competencyItems]) };
  }
  if (kind === "inventory") {
    const rows = await prisma.employeeSkill.findMany({ where: { employee: { ...who, tenantId: t } }, include: { skill: { select: { name: true, levels: true, category: true } }, employee: { select: { displayName: true, employeeNumber: true, department: { select: { name: true } } } } }, orderBy: [{ employee: { displayName: "asc" } }] });
    return { title, head: ["Employee", "Number", "Department", "Skill", "Category", "Level", "Source", "Confirmed", "Confirmed on"], rows: rows.map((r) => [r.employee.displayName, r.employee.employeeNumber, r.employee.department?.name ?? "", r.skill.name, r.skill.category ?? "", levelName(r.skill.levels, r.level), lower(r.source), r.isApproved ? "Yes" : "No", d(r.approvedAt)]) };
  }
  if (kind === "assessments") {
    const rows = await prisma.skillAssessmentLog.findMany({ where: { tenantId: t, employee: who }, include: { skill: { select: { name: true, levels: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" }, take: 5000 });
    return { title, head: ["Date", "Employee", "Number", "Skill", "Kind", "Level", "Evidence"], rows: rows.map((r) => [d(r.createdAt), r.employee.displayName, r.employee.employeeNumber, r.skill.name, lower(r.kind), levelName(r.skill.levels, r.level), r.evidence ?? ""]) };
  }
  // Gaps: everyone whose job title matches an approved framework, against its required levels.
  const frameworks = await prisma.competencyFramework.findMany({ where: { tenantId: t, status: "APPROVED", ...(frameworkId ? { id: frameworkId } : {}) }, include: { items: { include: { skill: { select: { name: true, levels: true } } } } } });
  const out: Report["rows"] = [];
  for (const f of frameworks) {
    if (!f.jobTitle) continue;
    const people = await prisma.employee.findMany({ where: { ...who, tenantId: t, status: { notIn: ["EXITED"] }, jobTitleName: { equals: f.jobTitle, mode: "insensitive" } }, select: { displayName: true, employeeNumber: true, employeeSkills: { select: { skillId: true, level: true, isApproved: true } } } });
    for (const p of people) {
      const g = competencyGap(f.items, p.employeeSkills);
      for (const r of g.rows) {
        const item = f.items.find((i) => i.skillId === r.skillId)!;
        out.push([f.name, `v${f.version}`, p.displayName, p.employeeNumber, item.skill.name, levelName(item.skill.levels, r.required), levelName(item.skill.levels, r.held), r.met ? "Met" : "Gap", r.critical ? "Yes" : "No", g.readiness]);
      }
    }
  }
  return { title, head: ["Framework", "Version", "Employee", "Number", "Skill", "Required", "Held (confirmed)", "Result", "Critical", "Role readiness %"], rows: out };
}

// ---------------------------------------------------------------------------
//  Improvement plans and coaching
// ---------------------------------------------------------------------------

export const PLAN_REPORTS = { pips: "Improvement plans", checkins: "PIP check-ins", coaching: "Coaching plans", actions: "Development actions" } as const;
export type PlanReportKind = keyof typeof PLAN_REPORTS;

export async function plansReport(viewer: Viewer, kind: PlanReportKind): Promise<Report> {
  const t = viewer.tenantId;
  const title = PLAN_REPORTS[kind];
  const who = scopedEmployeeWhere(viewer, P.PIP_MANAGE);
  if (kind === "pips") {
    const rows = await prisma.improvementPlan.findMany({ where: { tenantId: t, employee: who }, include: { employee: { select: { displayName: true, employeeNumber: true } }, milestones: true, checkIns: true }, orderBy: { startDate: "desc" } });
    return { title, head: ["Employee", "Number", "Start", "End", "Status", "Acknowledged", "Milestones met", "Milestones missed", "Check-ins", "Risk", "Outcome", "Outcome awaiting sign-off"], rows: rows.map((r) => [r.employee.displayName, r.employee.employeeNumber, d(r.startDate), d(r.endDate), lower(r.status), d(r.acknowledgedAt), r.milestones.filter((m) => m.status === "MET").length, r.milestones.filter((m) => m.status === "MISSED").length, r.checkIns.length, r.status === "ACTIVE" ? lower(pipRisk(r.checkIns, r.milestones.filter((m) => m.status === "MISSED").length)) : "", lower(r.outcome), lower(r.proposedOutcome)]) };
  }
  if (kind === "checkins") {
    const rows = await prisma.pipCheckIn.findMany({ where: { pip: { tenantId: t, employee: who } }, include: { pip: { select: { employee: { select: { displayName: true, employeeNumber: true } } } } }, orderBy: { heldOn: "desc" } });
    return { title, head: ["Employee", "Number", "Date", "Progress", "Notes", "Acknowledged", "Employee comment"], rows: rows.map((r) => [r.pip.employee.displayName, r.pip.employee.employeeNumber, d(r.heldOn), lower(r.progress), r.notes, d(r.acknowledgedAt), r.employeeComment ?? ""]) };
  }
  if (kind === "coaching") {
    const rows = await prisma.coachingPlan.findMany({ where: { tenantId: t, OR: [{ employee: who }, { coachId: viewer.employee?.id ?? "__none__" }] }, include: { employee: { select: { displayName: true } }, coach: { select: { displayName: true } }, sessions: { select: { id: true } }, actions: { select: { status: true } } }, orderBy: { startDate: "desc" } });
    return { title, head: ["Coachee", "Coach", "Focus", "Start", "End", "Status", "Sessions", "Actions verified %", "Effectiveness (1-5)"], rows: rows.map((r) => [r.employee.displayName, r.coach.displayName, r.focusArea, d(r.startDate), d(r.endDate), lower(r.status), r.sessions.length, actionsProgress(r.actions), r.effectivenessScore]) };
  }
  const rows = await prisma.developmentAction.findMany({ where: { tenantId: t, employee: who }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" } });
  return { title, head: ["Employee", "Number", "Action", "Kind", "From", "Due", "Status", "Evidence", "Verified"], rows: rows.map((r) => [r.employee.displayName, r.employee.employeeNumber, r.title, lower(r.kind), r.pipId ? "Improvement plan" : r.coachingPlanId ? "Coaching" : r.planId ? "Development plan" : "Skill gap", d(r.dueDate), lower(r.status), r.evidence ?? "", d(r.verifiedAt)]) };
}
