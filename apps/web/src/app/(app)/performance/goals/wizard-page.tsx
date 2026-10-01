import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { timeframeOptions } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { aiEnabled, AI_UNAVAILABLE } from "@/lib/ai";
import { nameOf } from "@/lib/directory";
import { GoalWizard } from "./wizard";

const P = PERMISSIONS;
const BACKS = ["/me/performance", "/performance/goals"];

/**
 * Data for the goal wizard: who the goals can be for, the departments and
 * roles to suggest for, goals they can align to, and the timeframes of this
 * financial year and the next. The browser gets names and ids, nothing else.
 */
export async function WizardPage({ mode, sp }: { mode: "ai" | "custom"; sp: { back?: string; for?: string } }) {
  const viewer = await requireViewer();
  const me = viewer.employee;
  const back = BACKS.some((b) => (sp.back ?? "").startsWith(b)) && !(sp.back ?? "").includes("//") ? sp.back! : me ? "/me/performance" : "/performance/goals";
  const canOrg = can(viewer, P.GOALS_MANAGE);
  const ownerWhere = canOrg
    ? { ...scopedEmployeeWhere(viewer, P.GOALS_MANAGE), status: { notIn: ["EXITED" as const] } }
    : { tenantId: viewer.tenantId, id: { in: [...(me ? [me.id] : []), ...viewer.allReportIds] }, status: { notIn: ["EXITED" as const] } };
  const [owners, departments, titles, parents, mine] = await Promise.all([
    prisma.employee.findMany({ where: ownerWhere, select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true }, orderBy: [{ firstName: "asc" }], take: 500 }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.jobTitle.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { name: true }, orderBy: { name: "asc" } }),
    prisma.goal.findMany({ where: { tenantId: viewer.tenantId, level: { in: ["COMPANY", "DEPARTMENT", "TEAM"] }, status: { notIn: ["CANCELLED", "DRAFT", "COMPLETED", "MISSED"] } }, select: { id: true, title: true, level: true }, orderBy: [{ level: "asc" }, { title: "asc" }] }),
    me ? prisma.employee.findUnique({ where: { id: me.id }, select: { departmentId: true, jobTitleName: true } }) : null,
  ]);
  const jobTitles = [...new Set([mine?.jobTitleName, ...titles.map((t) => t.name), ...owners.map((o) => o.jobTitleName)].filter((x): x is string => !!x))].sort();
  const today = new Date();
  const forId = sp.for && owners.some((o) => o.id === sp.for) ? sp.for : me?.id ?? owners[0]?.id ?? "";
  const ownerOptions = owners.map((o) => ({ value: o.id, label: o.id === me?.id ? `${nameOf(o)} (you)` : nameOf(o) }));
  if (me && !ownerOptions.some((o) => o.value === me.id)) ownerOptions.unshift({ value: me.id, label: `${me.displayName} (you)` });
  return (
    <GoalWizard
      mode={mode} ai={aiEnabled()} aiReason={AI_UNAVAILABLE} canOrg={canOrg} back={back}
      jobTitles={jobTitles.length ? jobTitles : ["Software Engineer"]}
      departments={departments.map((d) => ({ value: d.id, label: d.name }))}
      owners={ownerOptions}
      parents={parents.map((g) => ({ value: g.id, label: `${g.level.charAt(0)}${g.level.slice(1).toLowerCase()}: ${g.title}` }))}
      timeframes={timeframeOptions(today, viewer.tenant.fyStartMonth).map((t) => ({ label: t.label, kind: t.kind, start: t.start.toISOString().slice(0, 10), end: t.end.toISOString().slice(0, 10) }))}
      defaults={{ jobTitle: mine?.jobTitleName ?? "", departmentId: mine?.departmentId ?? "", employeeId: forId, today: today.toISOString().slice(0, 10) }}
    />
  );
}
