import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { rosterGrid, patternSteps, rosterDate } from "@keka/services";
import { dayKey } from "@keka/time";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Empty } from "@/components/ui";
import { RosterGrid, ApplyPatternForm, PatternForm, DeletePattern } from "./forms";

const P = PERMISSIONS;
const DAY = 86_400_000;
const PAGE = 40;

/** Monday of the week containing d. */
function mondayOf(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(x.getTime() - ((x.getUTCDay() + 6) % 7) * DAY);
}

/**
 * Shift roster: a week at a time, per department. Blank cells follow each
 * employee's time policy; picking a shift or a weekly off overrides that
 * day. Rotating patterns lay a cycle over a team for a date range.
 */
export default async function RosterPage({ searchParams }: { searchParams: Promise<{ week?: string; dept?: string; edit?: string }> }) {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const sp = await searchParams;
  const week = mondayOf(rosterDate(sp.week ?? "") ?? new Date());
  const days = Array.from({ length: 7 }, (_, i) => dayKey(new Date(week.getTime() + i * DAY)));
  const scope = scopedEmployeeWhere(viewer, P.SHIFT_MANAGE);

  const [departments, shifts, patterns] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: viewer.tenantId, employees: { some: scope } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.shift.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true, code: true, color: true }, orderBy: { name: "asc" } }),
    prisma.rosterPattern.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  const dept = departments.find((d) => d.id === sp.dept)?.id;
  const employees = await prisma.employee.findMany({
    where: { AND: [scope, { status: { notIn: ["EXITED", "PREBOARDING"] } }, dept ? { departmentId: dept } : {}] },
    select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" }, take: PAGE,
  });
  const grid = await rosterGrid(employees.map((e) => e.id), week, 7);
  const rows = employees.map((e) => ({ id: e.id, name: e.displayName ?? e.employeeNumber, number: e.employeeNumber, cells: grid.get(e.id) ?? [] }));
  const editing = patterns.find((p) => p.id === sp.edit);
  const qs = (w: Date) => `/attendance/roster?week=${dayKey(w)}${dept ? `&dept=${dept}` : ""}`;
  const shiftCode = new Map(shifts.map((s) => [s.id, s.code]));

  return (
    <>
      <PageHead title="Shift roster" subtitle="Who works which shift each day. Blank days follow the employee's shift and weekly-off policy." />
      <div className="tabs">
        <Link className="tab" href="/attendance?tab=shifts">Shifts</Link>
        <Link className="tab active" href="/attendance/roster">Roster</Link>
        <Link className="tab" href="/attendance?tab=assign">Assignments</Link>
      </div>
      <Card tight title={`Week of ${new Date(week).toUTCString().slice(5, 16)}`} action={
        <div className="row gap-2">
          <form className="row gap-2">
            <input type="hidden" name="week" value={dayKey(week)} />
            <select className="input sm" name="dept" defaultValue={dept ?? ""}>
              <option value="">All departments</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button className="btn sm">Filter</button>
          </form>
          <Link className="btn sm" href={qs(new Date(week.getTime() - 7 * DAY))}>‹ Prev</Link>
          <Link className="btn sm" href={qs(mondayOf(new Date()))}>This week</Link>
          <Link className="btn sm" href={qs(new Date(week.getTime() + 7 * DAY))}>Next ›</Link>
        </div>
      }>
        {shifts.length === 0 ? <Empty title="No shifts yet"><Link href="/attendance?tab=shifts">Create a shift</Link> first.</Empty>
          : rows.length === 0 ? <Empty title="Nobody to roster here" />
          : <RosterGrid rows={rows} days={days} shifts={shifts} week={dayKey(week)} />}
        {employees.length === PAGE ? <p className="text-xs subtle">Showing the first {PAGE}; filter by department to see the rest.</p> : null}
      </Card>

      <div className="grid grid-2">
        <Card title="Apply a rotating pattern">
          {patterns.length === 0 ? <Empty title="No patterns yet">Create one alongside.</Empty> : (
            <ApplyPatternForm patterns={patterns} employees={employees.map((e) => ({ id: e.id, label: `${e.employeeNumber} · ${e.displayName}` }))}
              defaultFrom={dayKey(week)} defaultTo={dayKey(new Date(week.getTime() + 27 * DAY))} />
          )}
        </Card>
        <Card title={editing ? `Edit ${editing.name}` : "New pattern"} action={editing ? <Link className="btn sm" href="/attendance/roster">Close</Link> : null}>
          <PatternForm key={editing?.id ?? "new"} shifts={shifts} pattern={editing ? { id: editing.id, name: editing.name, steps: patternSteps(editing.steps) } : undefined} />
        </Card>
      </div>
      {patterns.length ? (
        <Card tight title="Patterns">
          <table className="data">
            <thead><tr><th>Name</th><th>Cycle</th><th /></tr></thead>
            <tbody>
              {patterns.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td className="text-sm mono">{patternSteps(p.steps).map((s) => (s.off ? "OFF" : shiftCode.get(s.shiftId!) ?? "?")).join(" · ")}</td>
                  <td className="right row gap-2" style={{ justifyContent: "flex-end" }}>
                    <Link className="btn sm ghost" href={`/attendance/roster?edit=${p.id}`}>Edit</Link>
                    <DeletePattern id={p.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}
