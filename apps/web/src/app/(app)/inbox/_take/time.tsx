import "server-only";
import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import type { Viewer } from "@/lib/context";
import { IconCalendar, IconClock, IconWallet, IconTimer } from "@/components/icons";
import {
  TIME_CATEGORIES, listApprovals, countApprovals, type ApprovalRow, type TimeCat,
} from "@/lib/time-approvals";
import { DetailPane, Facts, Message, type ActivityEntry } from "../_ui/panes";
import { DecisionBar } from "../_ui/bulk";
import { formatDateTime } from "../_ui/format";
import type { TakeSource } from "./types";
import s from "../inbox.module.css";

/**
 * The time categories of Take Action — leave, comp off, encashment, WFH / on
 * duty, regularization, remote clock-in, overtime, shift & weekly off — read
 * from the same approvals registry as Time Attend › Approvals, so the inbox
 * and the admin screens can never disagree about what is waiting.
 */

const ICON: Record<TimeCat, React.ReactNode> = {
  leave: <IconCalendar />, compoff: <IconCalendar />, encashment: <IconWallet />, "wfh-od": <IconClock />,
  regularization: <IconClock />, remote: <PinIcon />, overtime: <IconTimer />, shift: <IconClock />,
};
const LABEL: Record<TimeCat, string> = {
  leave: "Leave", compoff: "Comp Off", encashment: "Leave Encashment", "wfh-od": "WFH / On Duty",
  regularization: "Regularization", remote: "Remote Clock In", overtime: "Overtime", shift: "Shift & Weekly Off",
};
/** The bulk card's noun: "1 Remote ClockIn", "Take action on 3 selected leave requests". */
const NOUN: Record<TimeCat, string> = {
  leave: "Leave", compoff: "Comp Off", encashment: "Encashment", "wfh-od": "WFH / OD",
  regularization: "Regularization", remote: "Remote ClockIn", overtime: "Overtime", shift: "Shift",
};

function PinIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z" /><circle cx="12" cy="9.8" r="2.3" />
    </svg>
  );
}

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
function DateTile({ date }: { date: Date }) {
  return (
    <span className={s.dateTile} aria-label={formatDate(date)}>
      <b>{date.getUTCDate()}</b><span>{DOW[date.getUTCDay()]}</span>
    </span>
  );
}

/** The request's first date, from its row (calendar dates are stored as UTC midnights). */
async function firstDate(row: ApprovalRow): Promise<{ from: Date; to: Date } | null> {
  const where = { id: row.id };
  switch (row.cat) {
    case "leave": return prisma.leaveRequest.findFirst({ where, select: { fromDate: true, toDate: true } }).then((r) => r && { from: r.fromDate, to: r.toDate });
    case "compoff": return prisma.compOffRequest.findFirst({ where, select: { fromDate: true, toDate: true } }).then((r) => r && { from: r.fromDate, to: r.toDate });
    case "overtime": return prisma.overtimeRequest.findFirst({ where, select: { fromDate: true, toDate: true } }).then((r) => r && { from: r.fromDate, to: r.toDate });
    case "shift": return prisma.shiftRequest.findFirst({ where, select: { fromDate: true, toDate: true } }).then((r) => r && { from: r.fromDate, to: r.toDate });
    case "encashment": return null;
    default: return prisma.attendanceRequest.findFirst({ where, select: { fromDate: true, toDate: true } }).then((r) => r && { from: r.fromDate, to: r.toDate });
  }
}

const IST = 330 * 60_000;
const clock = (d: Date) => {
  const l = new Date(d.getTime() + IST);
  const h = l.getUTCHours(), m = l.getUTCMinutes();
  return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};

async function detailFor(viewer: Viewer, row: ApprovalRow) {
  const dates = await firstDate(row);
  const person = { id: row.employee.id, name: row.employee.name, photoUrl: row.employee.photoUrl };
  const comments = await prisma.requestComment.findMany({
    where: { tenantId: viewer.tenantId, entityType: row.entity, entityId: row.id }, orderBy: { createdAt: "asc" },
  });
  const authors = comments.length
    ? await prisma.employee.findMany({
        where: { tenantId: viewer.tenantId, id: { in: comments.map((c) => c.authorEmployeeId).filter((x): x is string => !!x) } },
        select: { id: true, displayName: true, firstName: true, lastName: true, photoUrl: true },
      })
    : [];
  const author = new Map(authors.map((a) => [a.id, { id: a.id, name: a.displayName ?? `${a.firstName} ${a.lastName}`, photoUrl: a.photoUrl }]));
  const activity: ActivityEntry[] = [
    { who: person, text: row.summary, at: row.requestedOn },
    ...comments.map((c) => ({ who: (c.authorEmployeeId && author.get(c.authorEmployeeId)) || null, text: "Commented", note: c.body, at: c.createdAt })),
  ];

  let body: React.ReactNode = null;
  if (row.cat === "remote") {
    const logs = await prisma.attendanceLog.findMany({
      where: { tenantId: viewer.tenantId, attendanceRequestId: row.id }, orderBy: { timestamp: "asc" },
      select: { direction: true, timestamp: true, comment: true },
    });
    body = (
      <>
        <div className={s.reqHead}>
          {dates ? <DateTile date={dates.from} /> : null}
          <div>
            <div className={s.reqTitle}>Remote Clock In</div>
            <div className={s.reqSub}>{logs.length} time entr{logs.length === 1 ? "y" : "ies"}</div>
            {row.mapUrl ? (
              <a href={row.mapUrl} target="_blank" rel="noopener noreferrer" className={s.mapLink}>
                View map <PinIcon />
              </a>
            ) : <span className={s.reqSub}>Location not shared</span>}
          </div>
        </div>
        <table className={s.entries}>
          <thead><tr><th>Clock in type</th><th>Time entry</th><th>Comment</th></tr></thead>
          <tbody>
            {logs.map((l, i) => (
              <tr key={i}>
                <td>{l.direction === 1 ? <><span className={s.dirOut} aria-hidden="true">↗</span>OUT</> : <><span className={s.dirIn} aria-hidden="true">↙</span>IN</>}</td>
                <td>{clock(l.timestamp)}</td>
                <td>{l.comment ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  } else {
    const title = row.cat === "leave" ? row.cells.type
      : row.cat === "wfh-od" || row.cat === "regularization" ? row.cells.type
      : row.cat === "overtime" ? "Overtime"
      : row.cat === "shift" ? row.cells.type
      : row.cat === "compoff" ? "Compensatory off credit"
      : `${row.cells.type} encashment`;
    const facts: Array<[string, React.ReactNode] | null> = [];
    if (row.cat === "leave") {
      const r = await prisma.leaveRequest.findFirst({ where: { id: row.id }, select: { leaveTypeId: true, employeeId: true, sandwichDays: true, leaveType: { select: { isPaid: true } } } });
      const bal = r ? await prisma.leaveBalance.findFirst({ where: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId }, orderBy: { yearStart: "desc" }, select: { available: true } }) : null;
      facts.push(["Leave dates", row.cells.dates], ["Days", row.cells.days],
        ["Pay impact", r?.leaveType.isPaid === false ? <span className="neg strong">Creates loss of pay</span> : "Paid"],
        bal ? ["Balance available", `${Number(bal.available)} days`] : null,
        r && Number(r.sandwichDays) > 0 ? ["Sandwich days", `${Number(r.sandwichDays)}`] : null);
    } else if (row.cat === "wfh-od") {
      facts.push(["Date", row.cells.dates], ["Duration", row.cells.portion]);
    } else if (row.cat === "regularization") {
      const r = await prisma.attendanceRequest.findFirst({ where: { id: row.id }, select: { employeeId: true, fromDate: true } });
      const day = r ? await prisma.attendanceRecord.findFirst({ where: { tenantId: viewer.tenantId, employeeId: r.employeeId, date: r.fromDate }, select: { status: true, firstIn: true, lastOut: true, penaltyReason: true } }) : null;
      facts.push(["Date", row.cells.dates], ["Proposed", row.cells.detail],
        day ? ["Recorded that day", [day.status.replace(/_/g, " ").toLowerCase(), day.firstIn ? `in ${clock(day.firstIn)}` : null, day.lastOut ? `out ${clock(day.lastOut)}` : null].filter(Boolean).join(" · ")] : null,
        day?.penaltyReason ? ["Penalty", day.penaltyReason] : null);
    } else if (row.cat === "overtime") {
      facts.push(["Overtime date", row.cells.dates], ["Total overtime", row.cells.total], ["From attendance logs", row.cells.logged]);
    } else if (row.cat === "shift") {
      facts.push(["Dates", row.cells.dates], row.cells.shift !== "—" ? ["New shift (requested)", row.cells.shift] : null);
    } else if (row.cat === "compoff") {
      const r = await prisma.compOffRequest.findFirst({ where: { id: row.id }, select: { employeeId: true, fromDate: true } });
      const day = r ? await prisma.attendanceRecord.findFirst({ where: { tenantId: viewer.tenantId, employeeId: r.employeeId, date: r.fromDate }, select: { status: true, effectiveHours: true, firstIn: true, lastOut: true } }) : null;
      facts.push(["Worked on", row.cells.dates], ["Credit", row.cells.days],
        day ? ["Hours recorded", `${Number(day.effectiveHours)} h${day.firstIn ? ` · ${clock(day.firstIn)} – ${day.lastOut ? clock(day.lastOut) : "?"}` : ""} on a ${day.status === "HOLIDAY" ? "holiday" : "weekly off"}`] : null);
    } else {
      facts.push(["Leave type", row.cells.type], ["No of leave", row.cells.days], ["Estimated amount", row.cells.amount],
        ["On approval", "The days leave the balance and the amount is paid as a taxable payment in the next payroll"]);
    }
    body = (
      <>
        <div className={s.reqHead}>
          {dates ? <DateTile date={dates.from} /> : null}
          <div>
            <div className={s.reqTitle}>{title}</div>
            <div className={s.reqSub}>{row.summary}</div>
          </div>
        </div>
        <Facts items={facts} />
        {row.cells.note ? <Message label="Note">{row.cells.note}</Message> : null}
      </>
    );
  }

  return (
    <DetailPane
      title={row.employee.name}
      avatar={person}
      sub={`Requested on ${formatDateTime(row.requestedOn)}`}
      status={{ label: "Pending", tone: "pending" }}
      activity={activity}
      footer={<DecisionBar entity={row.entity} requestId={row.id} canDecide={row.canDecide} />}
    >
      {body}
      <div className="text-sm muted">
        {row.employee.number}{row.employee.department ? ` · ${row.employee.department}` : ""} · Next approver: {row.nextApprover ?? "—"}
        {" · "}<Link href={`/directory/${row.employee.id}`} className="link">View profile</Link>
      </div>
    </DetailPane>
  );
}

export async function timeSources(viewer: Viewer): Promise<TakeSource[]> {
  return TIME_CATEGORIES.map((cat) => {
    let rows: Promise<ApprovalRow[]> | null = null;
    const load = () => (rows ??= listApprovals(viewer, cat.key, { scope: "admin", status: "PENDING" }));
    return {
      key: cat.key, label: LABEL[cat.key], icon: ICON[cat.key], always: false,
      bulk: { entity: cat.entity, noun: NOUN[cat.key] },
      count: () => countApprovals(viewer, cat.key, "admin"),
      list: async () => (await load()).map((r) => ({
        id: r.id,
        person: { id: r.employee.id, name: r.employee.name, photoUrl: r.employee.photoUrl },
        title: r.summary,
        at: r.requestedOn,
      })),
      detail: async (id: string) => {
        const row = (await load()).find((r) => r.id === id);
        return row ? detailFor(viewer, row) : null;
      },
    };
  });
}
