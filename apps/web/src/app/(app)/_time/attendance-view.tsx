/**
 * Shared, render-only pieces for attendance screens. No client state.
 */

const CODES: Record<string, { code: string; label: string }> = {
  PRESENT: { code: "P", label: "Present" },
  ABSENT: { code: "A", label: "Absent" },
  HALF_DAY: { code: "HD", label: "Half day" },
  ON_LEAVE: { code: "L", label: "On leave" },
  WEEKLY_OFF: { code: "WO", label: "Weekly off" },
  HOLIDAY: { code: "HO", label: "Holiday" },
  ON_DUTY: { code: "OD", label: "On duty" },
  WORK_FROM_HOME: { code: "WFH", label: "Work from home" },
  NO_ATTENDANCE: { code: "NA", label: "No attendance" },
};

export function statusLabel(status: string): string {
  return CODES[status]?.label ?? status.toLowerCase();
}

export function AttCode({
  status, penalised, late, title,
}: { status: string; penalised?: boolean; late?: boolean; title?: string }) {
  const c = CODES[status] ?? { code: "?", label: status };
  return (
    <span className={`att-code att-${c.code}${penalised ? " att-pen" : ""}`} title={title ?? c.label}>
      {c.code}{late ? "·" : ""}
    </span>
  );
}

export function AttLegend() {
  return (
    <div className="row gap-3 wrap text-xs muted" style={{ gap: 12 }}>
      {Object.entries(CODES).map(([k, v]) => (
        <span key={k} className="row gap-2"><AttCode status={k} /> {v.label}</span>
      ))}
      <span className="row gap-2"><span className="att-code att-P att-pen">P</span> penalised</span>
      <span className="row gap-2"><span className="att-code att-P">P·</span> late</span>
    </div>
  );
}

/** Minutes worked from a day's punches, counting an open slot up to `now`. */
export function workedMinutes(
  logs: Array<{ timestamp: Date; direction: number }>, now: Date,
): { closed: number; openSince: Date | null } {
  const sorted = [...logs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  let open: Date | null = null;
  let closed = 0;
  for (const l of sorted) {
    if (l.direction === 0) open = l.timestamp;
    else if (open) { closed += (l.timestamp.getTime() - open.getTime()) / 60_000; open = null; }
  }
  // An IN left open from a previous calendar day is not today's slot.
  if (open && now.getTime() - open.getTime() > 20 * 3_600_000) open = null;
  return { closed, openSince: open };
}

export const hours = (v: unknown) => {
  const n = Number(v ?? 0);
  if (n === 0) return "—";
  const h = Math.floor(n);
  const m = Math.round((n - h) * 60);
  return `${h}:${String(m).padStart(2, "0")}`;
};

export const istTime = (d: Date | null | undefined) =>
  d ? d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
