import { prisma } from "@keka/db";
import type { ResolvedTimePolicy } from "@keka/services";
import { clock12, hm, type ShiftWindow } from "../_lib";
import s from "../attendance.module.css";

const DAY_NAME: Record<string, string> = {
  MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday", SUN: "Sunday",
};
const ORD = ["", "1st", "2nd", "3rd", "4th", "5th"];

/** "Every Sunday · 2nd & 4th Saturday (first half)" */
export function describeWeeklyOff(config: ResolvedTimePolicy["calendar"]["weeklyOff"]): string {
  const parts = (["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const).flatMap((d) => {
    const rule = config[d];
    if (!rule) return [];
    const which = rule.instances === "ALL" ? `Every ${DAY_NAME[d]}` : `${rule.instances.map((i) => ORD[i] ?? `${i}th`).join(" & ")} ${DAY_NAME[d]}`;
    const portion = rule.portion === "FIRST_HALF" ? " (first half)" : rule.portion === "SECOND_HALF" ? " (second half)" : "";
    return [`${which}${portion}`];
  });
  return parts.join(" · ") || "None";
}

const yes = (b: boolean) => (b ? "Yes" : "No");
const days = (v: unknown) => `${Number(v)} day${Number(v) === 1 ? "" : "s"}`;

function Group({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className={s.policyGroup}>
      <h3>{title}</h3>
      <dl>
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </div>
  );
}

/** Everything the employee's attendance is judged against, in plain words. */
export async function PolicyDetails({
  tenantId, employeeId, policy, shift, year,
}: {
  tenantId: string; employeeId: string; policy: ResolvedTimePolicy; shift: ShiftWindow; year: number;
}) {
  const now = new Date();
  const [row, assignment] = await Promise.all([
    policy.attendancePolicyId
      ? prisma.attendancePolicy.findFirst({ where: { id: policy.attendancePolicyId, tenantId } })
      : null,
    prisma.employeeTimePolicy.findFirst({
      where: { employeeId, employee: { tenantId }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
      orderBy: { effectiveFrom: "desc" },
      select: { weeklyOffPolicyId: true, holidayCalendarId: true, effectiveFrom: true },
    }),
  ]);
  const [weeklyOff, calendar] = await Promise.all([
    assignment?.weeklyOffPolicyId
      ? prisma.weeklyOffPolicy.findFirst({ where: { id: assignment.weeklyOffPolicyId, tenantId }, select: { name: true } })
      : prisma.weeklyOffPolicy.findFirst({ where: { tenantId, isDefault: true, isActive: true }, select: { name: true } }),
    assignment?.holidayCalendarId
      ? prisma.holidayCalendar.findFirst({ where: { id: assignment.holidayCalendarId, tenantId }, select: { name: true } })
      : prisma.holidayCalendar.findFirst({ where: { tenantId, isDefault: true, year }, select: { name: true } }),
  ]);
  const r = policy.rules;
  const holidaysThisYear = [...policy.calendar.holidays].filter((k) => k.startsWith(`${year}-`)).length;

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div className="strong">{row?.name ?? "Default attendance rules"}</div>
        {row?.description ? <div className="muted text-sm">{row.description}</div> : null}
        {!policy.trackAttendance ? (
          <div className="callout info" style={{ marginTop: 10 }}>Attendance is not tracked for you — missing punches never become loss of pay.</div>
        ) : null}
      </div>
      <div className={s.policyGrid}>
        <Group title="Shift" rows={[
          ["Shift", shift.name],
          ["Timings", shift.flexible ? `Flexible · ${hm(shift.required)} a day` : `${clock12(shift.start)} – ${clock12(shift.end)}`],
          ["Break", `${shift.breakMinutes} min`],
          ["Hours required", hm(shift.required)],
        ]} />
        <Group title="Weekly offs & holidays" rows={[
          ["Pattern", weeklyOff?.name ?? "Saturday & Sunday"],
          ["Days off", describeWeeklyOff(policy.calendar.weeklyOff)],
          ["Holiday calendar", calendar?.name ?? "—"],
          [`Holidays in ${year}`, String(holidaysThisYear)],
        ]} />
        <Group title="Capture" rows={[
          ["Web clock-in", yes(policy.allowWebClockIn)],
          ["Comment required", yes(policy.requireClockInComment)],
          ["Office network only", policy.ipAllowList.length > 0 ? `Yes (${policy.ipAllowList.length} address${policy.ipAllowList.length === 1 ? "" : "es"})` : "No"],
        ]} />
        <Group title="Day classification" rows={[
          ["Full day at", `${r.fullDayThresholdPct}% of required hours`],
          ["Half day at", `${r.halfDayThresholdPct}% of required hours`],
          ["No punches, no leave", r.noAttendanceIsLop ? "Loss of pay" : "Not loss of pay"],
        ]} />
        <Group title="Late arrival" rows={[
          ["Grace period", `${r.graceMinutes} min`],
          ["Forgiven each month", String(r.lateExemptPerMonth)],
          ["Penalty after that", `${days(r.latePenaltyDays)} LOP each`],
        ]} />
        <Group title="Missing punch" rows={[
          ["Forgiven each month", String(r.missingPunchExemptPerMonth)],
          ["Penalty after that", `${days(r.missingPunchPenaltyDays)} LOP each`],
        ]} />
        <Group title="Overtime" rows={[
          ["Tracked", yes(r.overtimeEnabled)],
          ...(r.overtimeEnabled ? [["Counts after", `${r.overtimeMinMinutes} min past the shift`] as [string, string]] : []),
        ]} />
        <Group title="Requests" rows={[
          ["Adjust or regularise up to", `${policy.regularisationWindowDays} days back`],
          ["Work from home / on duty", "Any date, needs approval"],
        ]} />
      </div>
    </>
  );
}
