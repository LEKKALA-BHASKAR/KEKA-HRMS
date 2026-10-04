import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import { safeCsv, joinAudit, bgvSlaState, bgvVendorStats, bgvCostFor } from "@keka/services";
import { getViewer, can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";

/**
 * CSV reports for preboarding, onboarding and background verification.
 * Every query is bound to the viewer's tenant and their employee scope for
 * the report's permission; every download is written to the audit log.
 */

type Sheet = { name: string; head: string[]; rows: Array<Array<string | number | null>> };
const P = PERMISSIONS;
const iso = (d: Date | null | undefined) => (d ? d.toISOString().replace("T", " ").slice(0, 19) : "");
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

async function scoped(viewer: Viewer, perm: Permission) {
  const rows = await prisma.employee.findMany({ where: scopedEmployeeWhere(viewer, perm), select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } }, location: { select: { name: true } } } });
  const m = new Map(rows.map((r) => [r.id, r]));
  return { ids: rows.map((r) => r.id), name: (id: string | null | undefined) => (id ? m.get(id)?.displayName ?? "" : ""), number: (id: string | null | undefined) => (id ? m.get(id)?.employeeNumber ?? "" : ""), dept: (id: string | null | undefined) => (id ? m.get(id)?.department?.name ?? "" : ""), loc: (id: string | null | undefined) => (id ? m.get(id)?.location?.name ?? "" : "") };
}

const REPORTS: Record<string, { perm: Permission; build: (v: Viewer) => Promise<Sheet> }> = {
  preboarding: { perm: P.ONBOARDING_MANAGE, build: async (v) => {
    const s = await scoped(v, P.ONBOARDING_MANAGE);
    const rows = await prisma.preboardingTask.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, orderBy: [{ employeeId: "asc" }, { dueDate: "asc" }] });
    return { name: "preboarding-tasks", head: ["Employee #", "Hire", "Department", "Task", "Type", "Due", "Status", "Needs review", "Submitted", "Decided", "Reminders", "Note"],
      rows: rows.map((t) => [s.number(t.employeeId), s.name(t.employeeId), s.dept(t.employeeId), t.title, t.kind, day(t.dueDate), t.status, t.requiresApproval ? "Yes" : "No", iso(t.submittedAt), iso(t.decidedAt), t.remindersSent, t.decisionNote ?? ""]) };
  } },
  forms: { perm: P.ONBOARDING_MANAGE, build: async (v) => {
    const s = await scoped(v, P.ONBOARDING_MANAGE);
    const rows = await prisma.newHireFormSubmission.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, include: { form: { select: { name: true } } }, orderBy: { submittedAt: "desc" } });
    return { name: "new-hire-forms", head: ["Employee #", "Hire", "Form", "Version", "Submitted", "Status", "Decided", "Answers"],
      rows: rows.map((r) => [s.number(r.employeeId), s.name(r.employeeId), r.form.name, r.formVersion, iso(r.submittedAt), r.status, iso(r.decidedAt), Object.entries(r.answers as Record<string, string>).map(([k, x]) => `${k}=${x}`).join("; ")]) };
  } },
  comms: { perm: P.ONBOARDING_MANAGE, build: async (v) => {
    const s = await scoped(v, P.ONBOARDING_MANAGE);
    const rows = await prisma.prejoinMessageLog.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, orderBy: { sentAt: "desc" } });
    return { name: "prejoining-communications", head: ["Sent", "Employee #", "Hire", "Type", "Subject", "To"], rows: rows.map((r) => [iso(r.sentAt), s.number(r.employeeId), s.name(r.employeeId), r.kind, r.subject, r.toAddress ?? "in-app"]) };
  } },
  journeys: { perm: P.ONBOARDING_MANAGE, build: async (v) => {
    const s = await scoped(v, P.ONBOARDING_MANAGE);
    const rows = await prisma.journeyTask.findMany({ where: { journey: { tenantId: v.tenantId, employeeId: { in: s.ids }, trigger: { not: "EXIT" } } }, include: { journey: { select: { title: true, trigger: true, status: true, anchorDate: true, employeeId: true, planStatus: true } } }, orderBy: [{ journeyId: "asc" }, { dueDate: "asc" }] });
    return { name: "onboarding-journeys", head: ["Employee #", "Hire", "Journey", "Trigger", "Journey status", "Plan sign-off", "Task", "Owner", "Assignee", "Due", "Status", "Sign-off", "Escalation", "Completed"],
      rows: rows.map((t) => [s.number(t.journey.employeeId), s.name(t.journey.employeeId), t.journey.title, t.journey.trigger, t.journey.status, t.journey.planStatus ?? "", t.title, t.owner, s.name(t.assigneeEmployeeId), day(t.dueDate), t.status, t.approvalStatus ?? (t.needsApproval ? "required" : ""), t.escalationLevel, iso(t.completedAt)]) };
  } },
  orientation: { perm: P.ONBOARDING_MANAGE, build: async (v) => {
    const s = await scoped(v, P.ONBOARDING_MANAGE);
    const rows = await prisma.orientationSession.findMany({ where: { tenantId: v.tenantId }, include: { attendees: true }, orderBy: { startsAt: "desc" } });
    return { name: "orientation-sessions", head: ["Session", "Type", "Starts", "Ends", "Location", "Status", "Attendee", "Attendance"],
      rows: rows.flatMap((r) => (r.attendees.length ? r.attendees.filter((a) => s.ids.includes(a.employeeId)) : [null]).map((a) => [r.title, r.kind, iso(r.startsAt), iso(r.endsAt), r.location ?? "", r.status, a ? s.name(a.employeeId) : "", a?.status ?? ""])) };
  } },
  buddies: { perm: P.ONBOARDING_MANAGE, build: async (v) => {
    const s = await scoped(v, P.ONBOARDING_MANAGE);
    const rows = await prisma.onboardingBuddy.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, include: { _count: { select: { checkins: true } } } });
    const all = await scoped(v, P.ONBOARDING_VIEW);
    return { name: "buddy-assignments", head: ["Hire", "Buddy", "From", "Until", "Status", "Check-ins", "Rating", "Feedback"], rows: rows.map((b) => [s.name(b.employeeId), all.name(b.buddyEmployeeId) || b.buddyEmployeeId, day(b.startsOn), day(b.endsOn), b.status, b._count.checkins, b.feedbackRating ?? "", b.feedbackNote ?? ""]) };
  } },
  milestones: { perm: P.ONBOARDING_MANAGE, build: async (v) => {
    const s = await scoped(v, P.ONBOARDING_MANAGE);
    const rows = await prisma.onboardingMilestone.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, orderBy: [{ employeeId: "asc" }, { dueDate: "asc" }] });
    return { name: "onboarding-milestones", head: ["Employee #", "Hire", "Milestone", "Due", "Status", "Manager rating", "Manager note", "Hire rating", "Hire comment"], rows: rows.map((m) => [s.number(m.employeeId), s.name(m.employeeId), m.kind, day(m.dueDate), m.status, m.managerRating ?? "", m.managerNote ?? "", m.hireRating ?? "", m.hireComment ?? ""]) };
  } },
  audit: { perm: P.ONBOARDING_MANAGE, build: async (v) => {
    const types = ["Journey", "JourneyTask", "JourneyTemplate", "JourneyTaskTemplate", "PreboardingTask", "PreboardingTemplate", "PreboardingTemplateItem", "NewHireForm", "NewHireFormSubmission", "PrejoinMessage", "PrejoinMessageLog", "PreboardingProvision", "OnboardingBuddy", "OnboardingBuddyCheckin", "OrientationSession", "OnboardingMilestone", "Employee"];
    const rows = await prisma.auditLog.findMany({ where: { tenantId: v.tenantId, module: "LIFECYCLE", entityType: { in: types } }, orderBy: { createdAt: "desc" }, take: 5000 });
    return { name: "onboarding-audit-package", head: ["When", "Actor", "Action", "Record", "Record id", "Summary"], rows: rows.map((r) => [iso(r.createdAt), r.actorLabel ?? "", r.action, r.entityType, r.entityId ?? "", r.summary ?? ""]) };
  } },
  bgv: { perm: P.BGV_MANAGE, build: async (v) => {
    const s = await scoped(v, P.BGV_MANAGE);
    const now = new Date();
    const rows = await prisma.bgvCheck.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, include: { items: true }, orderBy: { initiatedAt: "desc" } });
    return { name: "verification-cases", head: ["Employee #", "Employee", "Vendor", "Priority", "Checks", "Status", "Proposed", "Started", "SLA due", "SLA", "Completed", "Escalation", "Consent given", "Consent expires", "Cost", "Findings"],
      rows: rows.map((c) => [s.number(c.employeeId), s.name(c.employeeId), c.vendor ?? "", c.priority, c.items.map((i) => i.checkType).join(" "), c.status, c.proposedStatus ?? "", iso(c.initiatedAt), iso(c.slaDueAt), bgvSlaState(c.slaDueAt, c.completedAt, now), iso(c.completedAt), c.escalationLevel, iso(c.consentGivenAt), iso(c.consentExpiresAt), c.items.reduce((x, i) => x + Number(i.cost ?? 0), 0), c.findings ?? ""]) };
  } },
  "bgv-checks": { perm: P.BGV_MANAGE, build: async (v) => {
    const s = await scoped(v, P.BGV_MANAGE);
    const rows = await prisma.bgvCheckItem.findMany({ where: { tenantId: v.tenantId, bgvCheck: { employeeId: { in: s.ids } } }, include: { bgvCheck: { select: { employeeId: true, vendor: true } } }, orderBy: [{ bgvCheckId: "asc" }, { createdAt: "asc" }] });
    return { name: "verification-checks", head: ["Employee", "Check", "Status", "Reason code", "Severity", "Vendor stage", "SLA due", "Completed", "Recheck", "Cost", "Findings"],
      rows: rows.map((i) => [s.name(i.bgvCheck.employeeId), i.checkType, i.status, i.reasonCode ?? "", i.severity ?? "", i.vendorStage ?? "", iso(i.slaDueAt), iso(i.completedAt), i.recheckOfId ? "Yes" : "", Number(i.cost ?? 0), i.findings ?? ""]) };
  } },
  "bgv-vendors": { perm: P.BGV_MANAGE, build: async (v) => {
    const s = await scoped(v, P.BGV_MANAGE);
    const vendors = await prisma.bgvVendor.findMany({ where: { tenantId: v.tenantId } });
    const rates = new Map(vendors.map((x) => [x.id, x.costPerCheck]));
    const cases = await prisma.bgvCheck.findMany({ where: { tenantId: v.tenantId, employeeId: { in: s.ids } }, include: { items: { select: { checkType: true, cost: true } } } });
    const stats = bgvVendorStats(cases.map((c) => ({ vendor: c.vendor ?? "", initiatedAt: c.initiatedAt, completedAt: c.completedAt, slaDueAt: c.slaDueAt, status: c.status, cost: c.items.some((i) => i.cost !== null) ? c.items.reduce((x, i) => x + Number(i.cost ?? 0), 0) : bgvCostFor(c.vendorId ? rates.get(c.vendorId) : null, c.items.map((i) => i.checkType)) })));
    return { name: "verification-vendors", head: ["Vendor", "Cases", "Completed", "Avg turnaround (days)", "SLA met %", "Adverse %", "Total cost", "Cost per case"], rows: stats.map((x) => [x.vendor, x.cases, x.completed, x.avgTatDays ?? "", x.slaMetPct ?? "", x.adversePct, x.totalCost, x.costPerCase]) };
  } },
};

export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const key = req.nextUrl.searchParams.get("kind") ?? "";
  const report = REPORTS[key];
  if (!report) return new NextResponse("Unknown report.", { status: 404 });
  if (!can(viewer, report.perm)) return new NextResponse("Forbidden.", { status: 403 });
  const sheet = await report.build(viewer);
  await joinAudit(viewer.tenantId, viewer.user.id, { module: "LIFECYCLE", action: "EXPORT", entityType: "Report", entityId: key, summary: `Exported ${sheet.rows.length} row(s) of ${sheet.name}` });
  const csv = safeCsv(sheet.head, sheet.rows.map((r) => r.map((c) => (c === null ? "" : c))));
  return new NextResponse("﻿" + csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${sheet.name}-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
  });
}
