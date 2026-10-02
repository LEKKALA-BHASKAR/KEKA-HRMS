import { ticketSlaLabel } from "@keka/services";
import { dayTime } from "./format";
import s from "./hd.module.css";

/** The SLA hint in a ticket's header: the clock that is running, or how the closed ticket did. */
export function SlaHint({ t, now = new Date() }: {
  t: { status: string; closed: boolean; dueAt: Date; firstResponseDueAt: Date | null; firstResponseAt: Date | null; missedFirstResponse: boolean; missedResolution: boolean };
  now?: Date;
}) {
  if (t.closed) {
    return t.missedResolution
      ? <span className={`${s.sla} ${s.slaLate}`} title={`Resolution was due ${dayTime(t.dueAt)}`}>Missed resolution time</span>
      : <span className={`${s.sla} ${s.notEscalated}`} title={`Resolution was due ${dayTime(t.dueAt)}`}>Closed within SLA</span>;
  }
  if (t.status === "ON_HOLD") return <span className={`${s.sla} ${s.notEscalated}`} title="The SLA clocks pause while a ticket is on hold">On hold · SLA paused</span>;
  const firstPending = !t.firstResponseAt && t.firstResponseDueAt;
  const due = firstPending ? t.firstResponseDueAt! : t.dueAt;
  const l = ticketSlaLabel(due, now);
  return (
    <span className={`${s.sla} ${l.overdue ? s.slaLate : s.slaOk}`} title={`${firstPending ? "First response" : "Resolution"} due ${dayTime(due)}`}>
      {firstPending ? "First response" : "Resolution"}: {l.text}
    </span>
  );
}
