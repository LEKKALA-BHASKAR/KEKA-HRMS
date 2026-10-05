import Link from "next/link";
import { prisma } from "@keka/db";
import { rosterGrid, rosterDate, EDITABLE_STATUSES } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { managedTeam } from "@/lib/core-hr";
import { PageHead, Card, Empty } from "@/components/ui";
import { SpecForm } from "@/components/spec-form";
import { GridForm } from "@/components/grid-form";
import { managerSaveRosterAction, managerEditAttendanceAction } from "@/app/actions/core2-people";

export const metadata = { title: "Team roster — BooS-HR" };

const DAY = 86_400_000;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * My Team › Roster: a manager sets the shift or weekly off for each person
 * on their direct (or acting) team, two weeks at a time, and can mark or
 * correct a day's attendance with a reason.
 */
export default async function TeamRosterPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const team = await managedTeam(viewer);
  const ids = [...team].filter(([, l]) => l === "DIRECT" || l === "ACTING").map(([id]) => id);
  if (!ids.length) return <><PageHead title="Team roster" /><Card><Empty title="No team to roster">People who report to you directly, or whose manager you act for, appear here.</Empty></Card></>;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);
  const from = (sp.from && rosterDate(sp.from)) || monday;
  const days = 14;
  const [people, shifts, grid] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: ids } }, select: { id: true, displayName: true, firstName: true }, orderBy: { firstName: "asc" } }),
    prisma.shift.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: "asc" } }),
    rosterGrid(ids, from, days),
  ]);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const dates = Array.from({ length: days }, (_, i) => new Date(from.getTime() + i * DAY));
  const shiftCode = new Map(shifts.map((s) => [s.id, s.code]));
  return (
    <>
      <PageHead title="Team roster" subtitle={`${iso(from)} to ${iso(dates[days - 1]!)}`}
        actions={<><Link className="btn" href={`/team/roster?from=${iso(new Date(from.getTime() - days * DAY))}`}>Earlier</Link><Link className="btn" href={`/team/roster?from=${iso(new Date(from.getTime() + days * DAY))}`}>Later</Link><a className="btn" href={`/exports/core2/roster?from=${iso(from)}`}>Export CSV</a></>} />
      <Card title="Shifts and weekly offs" description="Leave a cell on Default to follow the person's time policy.">
        <GridForm action={managerSaveRosterAction} submitLabel="Save roster">
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Employee</th>{dates.map((d) => <th key={iso(d)} className="text-xs">{WD[d.getUTCDay()]}<br />{d.getUTCDate()}</th>)}</tr></thead>
            <tbody>{people.map((p) => (
              <tr key={p.id}><td>{p.displayName ?? p.firstName}</td>
                {(grid.get(p.id) ?? []).map((c) => (
                  <td key={c.date} title={c.explicit ? "Set on the roster" : `Policy: ${c.off ? "off" : shiftCode.get(c.shiftId ?? "") ?? "default"}`}>
                    <select className="select" name={`cell:${p.id}:${c.date}`} defaultValue={c.explicit ? (c.off ? "OFF" : c.shiftId ?? "") : ""} aria-label={`${p.displayName ?? p.firstName} on ${c.date}`} style={{ minWidth: 70 }}>
                      <option value="">{c.explicit ? "Default" : `(${c.off ? "off" : shiftCode.get(c.shiftId ?? "") ?? "—"})`}</option>
                      <option value="OFF">Off</option>
                      {shifts.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                    </select>
                  </td>
                ))}</tr>
            ))}</tbody>
          </table></div>
        </GridForm>
      </Card>
      <Card title="Mark or correct a day" description="For your team only; the reason is kept with the day and in the audit log.">
        <SpecForm action={managerEditAttendanceAction} submitLabel="Save the day" fields={[
          { name: "employeeId", label: "Employee", kind: "select", required: true, options: people.map((p) => ({ value: p.id, label: p.displayName ?? p.firstName })) },
          { name: "date", label: "Date", kind: "date", required: true, defaultValue: iso(today) },
          { name: "status", label: "Status", kind: "select", options: [{ value: "AUTO", label: "From punches" }, ...EDITABLE_STATUSES.map((s) => ({ value: s, label: s.toLowerCase().replace(/_/g, " ") }))] },
          { name: "firstIn", label: "First in (HH:MM)", placeholder: "09:30" },
          { name: "lastOut", label: "Last out (HH:MM)", placeholder: "18:30" },
          { name: "reason", label: "Reason", required: true, wide: true },
        ]} />
      </Card>
    </>
  );
}
