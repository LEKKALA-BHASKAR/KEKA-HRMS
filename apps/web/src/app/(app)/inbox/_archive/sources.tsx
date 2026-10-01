import "server-only";
import type { ReactNode } from "react";
import { prisma, type Prisma } from "@keka/db";
import { formatDate, formatINR } from "@keka/shared";
import { canAny, type Viewer } from "@/lib/context";
import { PERMISSIONS } from "@keka/rbac";
import { IconFile, IconCheck } from "@/components/icons";
import { IconSend, IconClipboardCheck, IconFeedback } from "../_ui/icons";
import { DetailPane, Facts, Message, PersonStrip, type ActivityEntry, type ListItem, type Tone } from "../_ui/panes";
import { formatInstantDate, formatTime, humanise } from "../_ui/format";
import { resolvePeople, who, type PersonRef } from "../_ui/people";
import s from "../inbox.module.css";

/**
 * Inbox → Archive: the last three months of what has already happened to
 * the viewer's work. Every query is pinned to the viewer — tasks assigned to
 * them, their own documents and requests, decisions they made — and to the
 * tenant. A detail is looked up through the same `where` plus its id.
 */

export interface ArchiveSource {
  key: string;
  label: string;
  icon: ReactNode;
  list: () => Promise<ListItem[]>;
  detail: (id: string) => Promise<ReactNode | null>;
}

const EMP = { id: true, displayName: true, firstName: true, lastName: true, photoUrl: true } as const;
const EMP_CARD = { ...EMP, employeeNumber: true, jobTitleName: true, department: { select: { name: true } } } as const;
type Emp = { id: string; displayName: string | null; firstName: string; lastName: string; photoUrl: string | null };
type EmpCard = Emp & { employeeNumber: string; jobTitleName: string | null; department: { name: string } | null };
const person = (e: Emp): PersonRef => ({ id: e.id, name: e.displayName ?? `${e.firstName} ${e.lastName}`, photoUrl: e.photoUrl });
const cardMeta = (e: EmpCard) => [e.jobTitleName, e.department?.name, e.employeeNumber].filter(Boolean).join(" · ");
const range = (from: Date, to: Date) => (from.getTime() === to.getTime() ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`);
const days = (n: unknown) => {
  const v = Number(n);
  return `${Number.isInteger(v) ? v : v.toFixed(1)} day${v === 1 ? "" : "s"}`;
};
const initiated = (d: Date) => `Initiated on ${formatInstantDate(d)}`;

const STATUS: Record<string, { label: string; tone: Tone }> = {
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
  PAYMENT_PENDING: { label: "Approved · payment pending", tone: "success" },
  PAID: { label: "Paid", tone: "success" },
  DISBURSED: { label: "Disbursed", tone: "success" },
  ACTIVE: { label: "Active", tone: "success" },
  CLOSED: { label: "Closed", tone: "neutral" },
  FORECLOSED: { label: "Foreclosed", tone: "neutral" },
  DONE: { label: "Done", tone: "success" },
  SKIPPED: { label: "Skipped", tone: "neutral" },
  VERIFIED: { label: "Verified", tone: "success" },
};
const statusOf = (s: string) => STATUS[s] ?? { label: humanise(s), tone: "neutral" as Tone };
const tagTone = (t: Tone) => (t === "success" ? "success" as const : t === "danger" ? "danger" as const : undefined);

/** "✓ The document has been verified" — the outcome line Keka shows. */
function Outcome({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className={s.done}>
      <span className={`${s.doneIcon}${ok ? "" : ` ${s.rejected}`}`} aria-hidden="true">{ok ? <IconCheck width={15} height={15} /> : "✕"}</span>
      <span>{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Record kinds that appear under "Approvals I decided" and "My requests"
// ---------------------------------------------------------------------------

interface Kind<W> {
  prefix: string;
  label: string;
  list: (where: W, mine: boolean) => Promise<ListItem[]>;
  detail: (where: W, id: string) => Promise<ReactNode | null>;
}

function leaveKind(tenantId: string): Kind<Prisma.LeaveRequestWhereInput> {
  const employees = async (ids: string[]) => new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: ids } }, select: EMP_CARD })).map((e) => [e.id, e]));
  return {
    prefix: "lv", label: "Leave",
    list: async (where) => {
      const rows = await prisma.leaveRequest.findMany({ where, include: { leaveType: { select: { name: true } } }, orderBy: { updatedAt: "desc" }, take: 200 });
      const emps = await employees([...new Set(rows.map((r) => r.employeeId))]);
      return rows.flatMap((r) => {
        const e = emps.get(r.employeeId);
        const st = statusOf(r.status);
        return e ? [{ id: `lv.${r.id}`, person: person(e), title: `${r.leaveType.name} · ${days(r.totalDays)} · ${range(r.fromDate, r.toDate)}`, at: r.approvedAt ?? r.updatedAt, tag: `Leave · ${st.label}`, tagTone: tagTone(st.tone) }] : [];
      });
    },
    detail: async (where, id) => {
      const r = await prisma.leaveRequest.findFirst({ where: { ...where, id }, include: { leaveType: { select: { name: true, isPaid: true } } } });
      if (!r) return null;
      const emps = await employees([r.employeeId]);
      const e = emps.get(r.employeeId);
      if (!e) return null;
      const people = await resolvePeople(tenantId, [r.approvedBy]);
      const p = person(e);
      const st = statusOf(r.status);
      const activity: ActivityEntry[] = [{ who: p, text: `Applied for ${days(r.totalDays)} of ${r.leaveType.name}`, at: r.createdAt }];
      if (r.approvedAt && r.approvedBy) activity.push({ who: who(people, r.approvedBy), text: r.status === "REJECTED" ? "Rejected the request" : "Approved the request", at: r.approvedAt, note: r.rejectReason });
      if (r.status === "CANCELLED" || r.status === "WITHDRAWN") activity.push({ who: p, text: `${st.label} the request`, at: r.updatedAt });
      return (
        <DetailPane title={`${r.leaveType.name} request`} sub={initiated(r.createdAt)} status={st} activity={activity}>
          <PersonStrip person={p} meta={cardMeta(e)} />
          <Facts items={[
            ["Dates", range(r.fromDate, r.toDate)],
            ["Days", days(r.totalDays)],
            ["Pay impact", r.leaveType.isPaid ? "Paid" : "Loss of pay"],
          ]} />
          {r.reason ? <Message label="Reason">{r.reason}</Message> : null}
          {r.rejectReason ? <Message label="Why it was rejected">{r.rejectReason}</Message> : null}
        </DetailPane>
      );
    },
  };
}

function attendanceKind(tenantId: string): Kind<Prisma.AttendanceRequestWhereInput> {
  return {
    prefix: "at", label: "Attendance",
    list: async (where) => (await prisma.attendanceRequest.findMany({ where, include: { employee: { select: EMP } }, orderBy: { updatedAt: "desc" }, take: 200 }))
      .map((r) => {
        const st = statusOf(r.status);
        return { id: `at.${r.id}`, person: person(r.employee), title: `${humanise(r.type)} · ${range(r.fromDate, r.toDate)}`, at: r.decidedAt ?? r.updatedAt, tag: `Attendance · ${st.label}`, tagTone: tagTone(st.tone) };
      }),
    detail: async (where, id) => {
      const r = await prisma.attendanceRequest.findFirst({ where: { ...where, id }, include: { employee: { select: EMP_CARD } } });
      if (!r) return null;
      const people = await resolvePeople(tenantId, [r.decidedBy]);
      const p = person(r.employee);
      const activity: ActivityEntry[] = [{ who: p, text: `Requested ${humanise(r.type).toLowerCase()} for ${range(r.fromDate, r.toDate)}`, at: r.createdAt }];
      if (r.decidedAt) activity.push({ who: who(people, r.decidedBy), text: r.status === "REJECTED" ? "Rejected the request" : r.status === "CANCELLED" ? "Cancelled the request" : "Approved the request", at: r.decidedAt, note: r.decisionNote });
      return (
        <DetailPane title={`${humanise(r.type)} request`} sub={initiated(r.createdAt)} status={statusOf(r.status)} activity={activity}>
          <PersonStrip person={p} meta={cardMeta(r.employee)} />
          <Facts items={[
            ["Request", humanise(r.type)],
            ["Dates", range(r.fromDate, r.toDate)],
            r.proposedIn ? ["Proposed in", formatTime(r.proposedIn)] : null,
            r.proposedOut ? ["Proposed out", formatTime(r.proposedOut)] : null,
          ]} />
          <Message label="Reason">{r.reason}</Message>
        </DetailPane>
      );
    },
  };
}

function expenseKind(tenantId: string): Kind<Prisma.ExpenseClaimWhereInput> {
  return {
    prefix: "ex", label: "Expenses",
    list: async (where) => (await prisma.expenseClaim.findMany({ where, include: { employee: { select: EMP } }, orderBy: { updatedAt: "desc" }, take: 200 }))
      .map((c) => {
        const st = statusOf(c.stage);
        return { id: `ex.${c.id}`, person: person(c.employee), title: `${c.claimNumber} · ${c.title} · ${formatINR(Number(c.claimedTotal))}`, at: c.approvedAt ?? c.updatedAt, tag: `Expense · ${st.label}`, tagTone: tagTone(st.tone) };
      }),
    detail: async (where, id) => {
      const c = await prisma.expenseClaim.findFirst({ where: { ...where, id }, include: { employee: { select: EMP_CARD }, lines: { include: { category: { select: { name: true } } }, orderBy: { expenseDate: "asc" } } } });
      if (!c) return null;
      const people = await resolvePeople(tenantId, [c.approvedBy]);
      const p = person(c.employee);
      const at = c.submittedAt ?? c.createdAt;
      const activity: ActivityEntry[] = [{ who: p, text: `Submitted ${formatINR(Number(c.claimedTotal))}`, at }];
      if (c.approvedAt) activity.push({ who: who(people, c.approvedBy), text: c.stage === "REJECTED" ? "Rejected the claim" : `Approved ${formatINR(Number(c.approvedTotal))}`, at: c.approvedAt, note: c.rejectReason });
      if (c.paidAt) activity.push({ who: null, text: "Paid out", at: c.paidAt });
      return (
        <DetailPane title={`${c.claimNumber} · ${c.title}`} sub={initiated(at)} status={statusOf(c.stage)} activity={activity}>
          <PersonStrip person={p} meta={cardMeta(c.employee)} />
          <table className={s.lines}>
            <thead><tr><th>Date</th><th>Category</th><th className={s.num}>Claimed</th><th className={s.num}>Approved</th></tr></thead>
            <tbody>
              {c.lines.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{formatDate(l.expenseDate)}</td>
                  <td>{l.category.name}{l.merchant ? <span className="muted"> · {l.merchant}</span> : null}</td>
                  <td className={s.num}>{formatINR(Number(l.amount))}</td>
                  <td className={s.num}>{l.approvedAmount !== null ? formatINR(Number(l.approvedAmount)) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.rejectReason ? <Message label="Why it was rejected">{c.rejectReason}</Message> : null}
        </DetailPane>
      );
    },
  };
}

function timesheetKind(tenantId: string): Kind<Prisma.TimesheetWhereInput> {
  return {
    prefix: "ts", label: "Timesheets",
    list: async (where) => (await prisma.timesheet.findMany({ where, include: { employee: { select: EMP } }, orderBy: { updatedAt: "desc" }, take: 200 }))
      .map((t) => {
        const st = statusOf(t.status);
        return { id: `ts.${t.id}`, person: person(t.employee), title: `Week of ${formatDate(t.periodStart)} · ${Number(t.totalHours)} h`, at: t.approvedAt ?? t.updatedAt, tag: `Timesheet · ${st.label}`, tagTone: tagTone(st.tone) };
      }),
    detail: async (where, id) => {
      const t = await prisma.timesheet.findFirst({ where: { ...where, id }, include: { employee: { select: EMP_CARD } } });
      if (!t) return null;
      const people = await resolvePeople(tenantId, [t.approvedBy]);
      const p = person(t.employee);
      const at = t.submittedAt ?? t.createdAt;
      const activity: ActivityEntry[] = [{ who: p, text: `Submitted ${Number(t.totalHours)} h`, at }];
      if (t.status === "APPROVED") activity.push({ who: who(people, t.approvedBy), text: "Approved the timesheet", at: t.approvedAt });
      if (t.status === "REJECTED") activity.push({ who: null, text: "Sent back for changes", at: t.updatedAt, note: t.rejectReason });
      return (
        <DetailPane title={`Timesheet · week of ${formatDate(t.periodStart)}`} sub={initiated(at)} status={statusOf(t.status)} activity={activity}>
          <PersonStrip person={p} meta={cardMeta(t.employee)} />
          <Facts items={[
            ["Week", range(t.periodStart, t.periodEnd)],
            ["Total hours", `${Number(t.totalHours)} h`],
            ["Billable", `${Number(t.billableHours)} h`],
          ]} />
          {t.rejectReason ? <Message label="What needs fixing">{t.rejectReason}</Message> : null}
        </DetailPane>
      );
    },
  };
}

function loanKind(tenantId: string): Kind<Prisma.LoanWhereInput> {
  return {
    prefix: "ln", label: "Loans",
    list: async (where) => (await prisma.loan.findMany({ where, include: { employee: { select: EMP }, category: { select: { name: true } } }, orderBy: { approvedAt: "desc" }, take: 200 }))
      .map((l) => {
        const st = statusOf(l.status);
        return { id: `ln.${l.id}`, person: person(l.employee), title: `${l.category.name} · ${formatINR(Number(l.principal))}`, at: l.approvedAt ?? l.requestedAt, tag: `Loan · ${st.label}`, tagTone: tagTone(st.tone) };
      }),
    detail: async (where, id) => {
      const l = await prisma.loan.findFirst({ where: { ...where, id }, include: { employee: { select: EMP_CARD }, category: { select: { name: true } } } });
      if (!l) return null;
      const people = await resolvePeople(tenantId, [l.approvedBy]);
      const p = person(l.employee);
      const activity: ActivityEntry[] = [{ who: p, text: `Requested ${formatINR(Number(l.principal))} over ${l.installments} months`, at: l.requestedAt }];
      if (l.approvedAt) activity.push({ who: who(people, l.approvedBy), text: l.status === "REJECTED" ? "Declined the loan" : "Approved the loan", at: l.approvedAt, note: l.decisionNote });
      if (l.disbursedAt) activity.push({ who: null, text: l.disbursedOutside ? "Disbursed outside payroll" : "Disbursed", at: l.disbursedAt });
      return (
        <DetailPane title={`${l.category.name} request`} sub={initiated(l.requestedAt)} status={statusOf(l.status)} activity={activity}>
          <PersonStrip person={p} meta={cardMeta(l.employee)} />
          <Facts items={[
            ["Principal", formatINR(Number(l.principal))],
            ["EMI", formatINR(Number(l.emiAmount))],
            ["Instalments", `${l.installments} months`],
          ]} />
          {l.purpose ? <Message label="Purpose">{l.purpose}</Message> : null}
        </DetailPane>
      );
    },
  };
}

/** A category drawing on several record kinds, ids prefixed by kind. */
function composite(parts: Array<{ kind: Kind<never>; where: unknown }>): Pick<ArchiveSource, "list" | "detail"> {
  return {
    list: async () => (await Promise.all(parts.map((p) => p.kind.list(p.where as never, false)))).flat(),
    detail: async (id) => {
      const dot = id.indexOf(".");
      const part = parts.find((p) => p.kind.prefix === id.slice(0, dot));
      return part ? part.kind.detail(part.where as never, id.slice(dot + 1)) : null;
    },
  };
}

// ---------------------------------------------------------------------------
//  Journey tasks and documents
// ---------------------------------------------------------------------------

function journeyTasks(viewer: Viewer, where: Prisma.JourneyTaskWhereInput): Pick<ArchiveSource, "list" | "detail"> {
  const include = { journey: { select: { id: true, title: true, trigger: true, createdAt: true, createdBy: true, employee: { select: EMP_CARD } } } } as const;
  const triggerLabel = (t: string) => (t === "JOINING" ? "Onboarding" : t === "CONFIRMATION" ? "Probation" : humanise(t));
  return {
    list: async () => (await prisma.journeyTask.findMany({ where, include, orderBy: { completedAt: "desc" }, take: 200 }))
      .map((t) => {
        const st = statusOf(t.status);
        return { id: t.id, person: person(t.journey.employee), title: t.title, at: t.completedAt ?? t.journey.createdAt, tag: `${triggerLabel(t.journey.trigger)} · ${st.label}`, tagTone: tagTone(st.tone) };
      }),
    detail: async (id) => {
      const t = await prisma.journeyTask.findFirst({ where: { ...where, id }, include });
      if (!t) return null;
      const people = await resolvePeople(viewer.tenantId, [t.completedBy, t.journey.createdBy]);
      const subject = person(t.journey.employee);
      const done = t.status === "DONE";
      return (
        <DetailPane title={t.title} sub={initiated(t.journey.createdAt)} status={statusOf(t.status)}
          activity={[
            { who: t.journey.createdBy ? who(people, t.journey.createdBy) : null, text: `Started “${t.journey.title}”`, at: t.journey.createdAt },
            { who: who(people, t.completedBy), text: `Status updated from Not started to ${done ? "Done" : "Skipped"}`, at: t.completedAt, note: t.note },
          ]}>
          <p>Hello {viewer.employee?.displayName ?? "there"},<br />{t.description ?? `“${t.title}” was part of ${t.journey.title}.`}</p>
          <Outcome ok={done}>{done ? "This task has been completed" : "This task was skipped"}</Outcome>
          {t.journey.employee.id !== viewer.employee?.id ? <PersonStrip person={subject} meta={cardMeta(t.journey.employee)} /> : null}
          <Facts items={[
            ["Journey", t.journey.title],
            ["Due", formatDate(t.dueDate)],
            ["Category", humanise(t.category)],
          ]} />
        </DetailPane>
      );
    },
  };
}

function myDocuments(viewer: Viewer, where: Prisma.EmployeeDocumentWhereInput): Pick<ArchiveSource, "list" | "detail"> {
  const decidedAt = (d: { status: string; verifiedAt: Date | null; updatedAt: Date }) => (d.status === "VERIFIED" ? d.verifiedAt ?? d.updatedAt : d.updatedAt);
  return {
    list: async () => (await prisma.employeeDocument.findMany({ where, include: { employee: { select: EMP } }, orderBy: { updatedAt: "desc" }, take: 200 }))
      .map((d) => {
        const st = statusOf(d.status);
        return { id: d.id, person: person(d.employee), title: d.name, at: decidedAt(d), tag: st.label, tagTone: tagTone(st.tone) };
      }),
    detail: async (id) => {
      const d = await prisma.employeeDocument.findFirst({
        where: { ...where, id },
        include: { employee: { select: EMP }, documentType: { select: { name: true } }, folder: { select: { name: true } } },
      });
      if (!d) return null;
      const people = await resolvePeople(viewer.tenantId, [d.uploadedBy, d.verifiedBy]);
      const ok = d.status === "VERIFIED";
      const activity: ActivityEntry[] = [];
      if (d.uploadedAt) activity.push({ who: d.uploadedBy ? who(people, d.uploadedBy) : person(d.employee), text: "Uploaded the document", at: d.uploadedAt });
      activity.push(ok
        ? { who: d.verifiedBy ? who(people, d.verifiedBy) : null, text: "Status updated to Verified", at: decidedAt(d) }
        : { who: null, text: "Status updated to Rejected", at: d.updatedAt, note: d.rejectReason });
      return (
        <DetailPane title={d.name} sub={initiated(d.uploadedAt ?? d.createdAt)} status={statusOf(d.status)} activity={activity}>
          <Outcome ok={ok}>{ok ? "The document has been verified" : "The document was rejected"}</Outcome>
          <Facts items={[
            ["Document type", d.documentType?.name ?? null],
            ["Folder", d.folder?.name ?? null],
            d.issuedOn ? ["Issued on", formatDate(d.issuedOn)] : null,
            d.expiresOn ? ["Expires on", formatDate(d.expiresOn)] : null,
          ]} />
          {d.rejectReason ? <Message label="Why it was rejected">{d.rejectReason}</Message> : null}
          {d.fileUrl?.startsWith("/files/") ? <div><a className="btn sm" href={d.fileUrl} target="_blank" rel="noreferrer">View the file</a></div> : null}
        </DetailPane>
      );
    },
  };
}

// ---------------------------------------------------------------------------
//  The categories
// ---------------------------------------------------------------------------

export async function archiveSources(viewer: Viewer, since: Date): Promise<ArchiveSource[]> {
  const tenantId = viewer.tenantId;
  const me = viewer.employee?.id ?? null;
  const userId = viewer.user.id;
  const out: ArchiveSource[] = [];
  const recent = { gte: since };

  if (me) {
    const taskBase: Prisma.JourneyTaskWhereInput = {
      assigneeEmployeeId: me, status: { in: ["DONE", "SKIPPED"] }, completedAt: recent, journey: { tenantId },
    };
    const onboarding: Prisma.JourneyTaskWhereInput = { ...taskBase, journey: { tenantId, trigger: { not: "CONFIRMATION" } } };
    const probation: Prisma.JourneyTaskWhereInput = { ...taskBase, journey: { tenantId, trigger: "CONFIRMATION" } };
    const probationCount = await prisma.journeyTask.count({ where: probation });

    out.push({ key: "onboarding", label: "Onboarding", icon: <IconClipboardCheck />, ...journeyTasks(viewer, onboarding) });
    if (probationCount > 0) out.push({ key: "probation", label: "Probation Feedbacks", icon: <IconFeedback />, ...journeyTasks(viewer, probation) });

    out.push({
      key: "documents", label: "Documents", icon: <IconFile />,
      ...myDocuments(viewer, {
        tenantId, employeeId: me,
        OR: [
          { status: "VERIFIED", OR: [{ verifiedAt: recent }, { verifiedAt: null, updatedAt: recent }] },
          { status: "REJECTED", updatedAt: recent },
        ],
      }),
    });
  }

  // Decisions the viewer made. Leave and attendance record the deciding
  // employee; expenses and timesheets record the deciding user.
  const decided: Array<{ kind: Kind<never>; where: unknown }> = [
    ...(me ? [
      { kind: leaveKind(tenantId) as Kind<never>, where: { tenantId, approvedBy: me, approvedAt: recent, NOT: { employeeId: me } } satisfies Prisma.LeaveRequestWhereInput },
      { kind: attendanceKind(tenantId) as Kind<never>, where: { tenantId, decidedBy: me, decidedAt: recent, NOT: { employeeId: me } } satisfies Prisma.AttendanceRequestWhereInput },
    ] : []),
    { kind: expenseKind(tenantId) as Kind<never>, where: { tenantId, approvedBy: userId, approvedAt: recent, ...(me ? { NOT: { employeeId: me } } : {}) } satisfies Prisma.ExpenseClaimWhereInput },
    { kind: timesheetKind(tenantId) as Kind<never>, where: { tenantId, approvedBy: userId, approvedAt: recent, ...(me ? { NOT: { employeeId: me } } : {}) } satisfies Prisma.TimesheetWhereInput },
  ];
  const P = PERMISSIONS;
  const approver = viewer.allReportIds.size > 0
    || canAny(viewer, [P.LEAVE_APPROVE, P.ATTENDANCE_APPROVE, P.EXPENSE_APPROVE, P.EXPENSE_MANAGE, P.TIMESHEET_APPROVE]);
  if (approver) out.push({ key: "approvals", label: "Approvals I decided", icon: <IconCheck />, ...composite(decided) });

  if (me) {
    const mine: Array<{ kind: Kind<never>; where: unknown }> = [
      { kind: leaveKind(tenantId) as Kind<never>, where: { tenantId, employeeId: me, status: { in: ["APPROVED", "REJECTED"] }, OR: [{ approvedAt: recent }, { approvedAt: null, updatedAt: recent }] } satisfies Prisma.LeaveRequestWhereInput },
      { kind: attendanceKind(tenantId) as Kind<never>, where: { tenantId, employeeId: me, status: { in: ["APPROVED", "REJECTED"] }, OR: [{ decidedAt: recent }, { decidedAt: null, updatedAt: recent }] } satisfies Prisma.AttendanceRequestWhereInput },
      { kind: expenseKind(tenantId) as Kind<never>, where: { tenantId, employeeId: me, stage: { in: ["APPROVED", "REJECTED", "PAYMENT_PENDING", "PAID"] }, updatedAt: recent } satisfies Prisma.ExpenseClaimWhereInput },
      { kind: timesheetKind(tenantId) as Kind<never>, where: { tenantId, employeeId: me, status: { in: ["APPROVED", "REJECTED"] }, updatedAt: recent } satisfies Prisma.TimesheetWhereInput },
      { kind: loanKind(tenantId) as Kind<never>, where: { employeeId: me, employee: { tenantId }, status: { notIn: ["REQUESTED", "PENDING_APPROVAL"] }, approvedAt: recent } satisfies Prisma.LoanWhereInput },
    ];
    out.push({ key: "requests", label: "My requests", icon: <IconSend />, ...composite(mine) });
  }

  return out;
}
