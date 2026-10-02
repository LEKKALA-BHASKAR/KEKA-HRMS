import "server-only";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatINR } from "@keka/shared";
import {
  requisitionStatus, requisitionsToDecideWhere, decisionBlocker, isSuperApprover, salaryFrequencyLabel, type ApproverActor, type RequisitionTone,
} from "@keka/services";
import { can, canAny, type Viewer } from "@/lib/context";

/**
 * Server-side reads for the Hire screens: who may see which requisitions,
 * the list rows as Keka shows them, and the names behind user ids.
 */

const P = PERMISSIONS;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 11, 2025" — Keka's date style. */
export const kDate = (d: Date | null | undefined) => (d ? `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}, ${d.getUTCFullYear()}` : "—");
/** "Apr 17, 2025 - 2:45 pm" in IST, for activity entries. */
export function kDateTime(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes();
  return `${MONTHS[ist.getUTCMonth()]} ${String(ist.getUTCDate()).padStart(2, "0")}, ${ist.getUTCFullYear()} - ${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

export const rupees = (n: unknown) => formatINR(Number(n)).replace(/\.00$/, "");

/** "₹14,00,000 - ₹22,00,000 / Annual", or "Not Available". */
export function salaryRange(r: { currency: string; salaryMin: unknown; salaryMax: unknown; salaryFrequency: string | null; minAnnualCtc?: unknown; maxAnnualCtc?: unknown }): string {
  const min = r.salaryMin ?? null, max = r.salaryMax ?? null;
  const fmt = (v: unknown) => (r.currency === "INR" ? rupees(v) : `${r.currency} ${Number(v).toLocaleString("en-IN")}`);
  if (min === null && max === null) {
    // Requisitions from before Keka parity kept only the annual CTC band.
    if (r.minAnnualCtc || r.maxAnnualCtc) return `${rupees(r.minAnnualCtc ?? 0)} - ${rupees(r.maxAnnualCtc ?? 0)} / Annual`;
    return "Not Available";
  }
  const range = min !== null && max !== null ? `${fmt(min)} - ${fmt(max)}` : min !== null ? `From ${fmt(min)}` : `Up to ${fmt(max)}`;
  return r.salaryFrequency ? `${range} / ${salaryFrequencyLabel(r.salaryFrequency)}` : range;
}

/** Names for user ids (raisers, approvers): the employee's display name, else "Administrator". */
export async function userNames(tenantId: string, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const users = await prisma.user.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true, employee: { select: { displayName: true, firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.employee ? u.employee.displayName ?? `${u.employee.firstName} ${u.employee.lastName}` : "Administrator"]));
}

export async function approverActor(viewer: Viewer): Promise<ApproverActor> {
  return { userId: viewer.user.id, canApprove: can(viewer, P.REQUISITION_APPROVE), superApprover: can(viewer, P.REQUISITION_APPROVE) && await isSuperApprover(viewer.tenantId, viewer.user.id) };
}

/** The department ids this person heads, directly or as head of their business unit. */
export async function headedDepartments(viewer: Viewer): Promise<string[]> {
  if (!viewer.employee) return [];
  const rows = await prisma.department.findMany({
    where: { tenantId: viewer.tenantId, OR: [{ headId: viewer.employee.id }, { businessUnit: { headId: viewer.employee.id } }] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Which requisitions a viewer may see. Managers and approvers see the whole
 * tenant; someone with view rights only (a department or business head)
 * sees their own departments' requisitions, ones they raised and ones
 * pending on them.
 */
export async function visibleRequisitions(viewer: Viewer): Promise<Prisma.RequisitionWhereInput> {
  if (canAny(viewer, [P.REQUISITION_MANAGE, P.REQUISITION_APPROVE])) return { tenantId: viewer.tenantId };
  const depts = await headedDepartments(viewer);
  return {
    tenantId: viewer.tenantId,
    OR: [{ raisedBy: viewer.user.id }, { approverUserId: viewer.user.id }, ...(depts.length ? [{ departmentId: { in: depts } }] : [])],
  };
}

export type View = "all" | "pending" | "archived";

export interface Filters { department: string; location: string; status: string; priority: string; q: string; page: number }

export function readFilters(sp: Record<string, string | string[] | undefined>): Filters {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) ?? "";
  return { department: one("department"), location: one("location"), status: one("status"), priority: one("priority"), q: one("q").trim().slice(0, 80), page: Math.max(1, Number(one("page")) || 1) };
}

export interface ReqRow {
  id: string; code: string | null; title: string; department: string; requestedBy: string; requestedOn: string; location: string;
  priority: boolean; positions: number; openPositions: number; salary: string;
  status: string; tone: RequisitionTone; statusSub: string | null; jobId: string | null;
  canDecide: boolean; blocker: string | null; canEdit: boolean; canArchive: boolean; canOpenJob: boolean; archived: boolean;
}

export const PAGE_SIZE = 25;

/** The list for one view, filtered and paged, with every name resolved. */
export async function requisitionRows(viewer: Viewer, view: View, f: Filters, opts: { all?: boolean } = {}): Promise<{ rows: ReqRow[]; total: number; pendingCount: number }> {
  const actor = await approverActor(viewer);
  const scope = await visibleRequisitions(viewer);
  const pendingWhere = requisitionsToDecideWhere(viewer.tenantId, actor);
  const filters: Prisma.RequisitionWhereInput[] = [];
  if (f.department) filters.push({ departmentId: f.department });
  if (f.location) filters.push({ locationId: f.location });
  if (f.priority) filters.push({ isPriority: f.priority === "yes" });
  if (f.q) filters.push({ OR: [{ title: { contains: f.q, mode: "insensitive" } }, { code: { contains: f.q, mode: "insensitive" } }] });
  if (view === "all" && f.status) {
    const st: Record<string, Prisma.RequisitionWhereInput> = {
      pending: { status: "PENDING_APPROVAL" }, approved: { status: "APPROVED", jobs: { none: {} } }, progress: { status: "APPROVED", jobs: { some: {} } },
      rejected: { status: "REJECTED" }, fulfilled: { status: "FULFILLED" },
    };
    if (st[f.status]) filters.push(st[f.status]);
  }
  const where: Prisma.RequisitionWhereInput = view === "pending"
    ? { AND: [pendingWhere, scope, ...filters] }
    : { AND: [scope, { archivedAt: view === "archived" ? { not: null } : null }, ...filters] };
  const [total, pendingCount, list] = await Promise.all([
    prisma.requisition.count({ where }),
    prisma.requisition.count({ where: { AND: [pendingWhere, scope] } }),
    prisma.requisition.findMany({
      where, orderBy: [{ createdAt: "desc" }], skip: opts.all ? 0 : (f.page - 1) * PAGE_SIZE, take: opts.all ? 5000 : PAGE_SIZE,
      include: { jobs: { select: { id: true, openings: true, status: true }, orderBy: { createdAt: "asc" } } },
    }),
  ]);
  const [depts, locs, names] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: viewer.tenantId, id: { in: list.map((r) => r.departmentId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId, id: { in: list.map((r) => r.locationId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    userNames(viewer.tenantId, list.flatMap((r) => [r.raisedBy, r.approverUserId, r.approvedBy])),
  ]);
  const dn = new Map(depts.map((d) => [d.id, d.name])), ln = new Map(locs.map((l) => [l.id, l.name]));
  const manage = can(viewer, P.REQUISITION_MANAGE), approve = can(viewer, P.REQUISITION_APPROVE), jobs = can(viewer, P.JOB_MANAGE);
  const rows = list.map((r): ReqRow => {
    const st = requisitionStatus({ status: r.status, archivedAt: r.archivedAt, jobCount: r.jobs.length });
    const opened = r.jobs.reduce((n, j) => n + j.openings, 0);
    const statusSub = st.tone === "pending" && r.status === "PENDING_APPROVAL"
      ? (r.approverUserId ? `on ${names.get(r.approverUserId) ?? "an approver"}` : "on any approver")
      : st.tone === "approved" && r.approvedBy ? `by ${names.get(r.approvedBy) ?? "an approver"}` : null;
    const blocker = decisionBlocker(r, actor);
    const editable = !r.archivedAt && !["FULFILLED", "CANCELLED"].includes(r.status)
      && (r.status === "APPROVED" ? approve : manage || r.raisedBy === viewer.user.id);
    return {
      id: r.id, code: r.code, title: r.title, department: r.departmentId ? dn.get(r.departmentId) ?? "—" : "Not Available",
      requestedBy: r.raisedBy ? names.get(r.raisedBy) ?? "—" : "—", requestedOn: kDate(r.createdAt),
      location: r.locationId ? ln.get(r.locationId) ?? "—" : "Not Available", priority: r.isPriority,
      positions: r.positions, openPositions: Math.max(0, r.positions - opened), salary: salaryRange(r),
      status: st.label, tone: st.tone, statusSub, jobId: r.jobs[0]?.id ?? null,
      canDecide: blocker === null, blocker, canEdit: editable,
      canArchive: manage && !r.jobs.some((j) => ["OPEN", "ON_HOLD", "DRAFT"].includes(j.status)),
      canOpenJob: jobs && r.status === "APPROVED" && !r.archivedAt && opened < r.positions, archived: !!r.archivedAt,
    };
  });
  return { rows, total, pendingCount };
}

/** Pending requisitions this viewer can decide — the nav badge and Inbox count. */
export async function requisitionsToDecideCount(viewer: Viewer): Promise<number> {
  if (!canAny(viewer, [P.REQUISITION_APPROVE, P.REQUISITION_VIEW, P.REQUISITION_MANAGE])) {
    // Someone may be the named approver without holding the permission (a default approver).
    return prisma.requisition.count({ where: requisitionsToDecideWhere(viewer.tenantId, { userId: viewer.user.id, canApprove: false, superApprover: false }) });
  }
  return prisma.requisition.count({ where: requisitionsToDecideWhere(viewer.tenantId, await approverActor(viewer)) });
}

export interface Option { value: string; label: string }

export async function requisitionOptions(viewer: Viewer) {
  const [departments, locations, jobTitles, employees, recruiters, templates] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.jobTitle.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" }, select: { name: true } }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, orderBy: { displayName: "asc" }, select: { id: true, displayName: true, employeeNumber: true, jobTitleName: true } }),
    prisma.user.findMany({
      where: { tenantId: viewer.tenantId, loginDisabled: false, isDeactivated: false, roleAssignments: { some: { role: { permissions: { some: { permission: P.CANDIDATE_MANAGE } } } } } },
      select: { id: true, email: true, employee: { select: { displayName: true } } },
    }),
    prisma.jobDescriptionTemplate.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { title: "asc" }, select: { id: true, title: true, body: true } }),
  ]);
  return {
    departments: departments.map((d) => ({ value: d.id, label: d.name })),
    locations: locations.map((l) => ({ value: l.id, label: l.name })),
    jobTitles: jobTitles.map((j) => j.name),
    employees: employees.map((e) => ({ id: e.id, name: e.displayName ?? "", number: e.employeeNumber, title: e.jobTitleName })),
    recruiters: recruiters.map((u) => ({ value: u.id, label: u.employee?.displayName ?? u.email })),
    templates,
  };
}
