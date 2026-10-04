import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  rosterGrid, rosterViolations, rosterCoverage, coverageLevel, rosterSnapshotDiff, shiftCostForecast, shiftAdherence, shiftWindow, shiftPlannedMinutes,
  joinSettings, monthlyWages, SHIFT_TEMPLATE_LIBRARY, parseShiftSegments, patternSteps, type SnapshotRow,
} from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Stat, Badge } from "@/components/ui";
import { Tabs, Table, Pill } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { fmtDay, fmtTime, pretty } from "@/lib/engage-depth";
import { peopleIndex } from "@/lib/join-depth";
import {
  saveOpenShiftAction, openShiftOpAction, saveStaffingRuleAction, submitRosterPublicationAction, addShiftFromLibraryAction, saveSplitShiftAction, proposeTimeConfigChangeAction,
} from "@/app/actions/join-roster";
import { saveJoinSettingsAction } from "@/app/actions/join-preboarding";

const P = PERMISSIONS;
const DAY = 86_400_000;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TABS = { swaps: "Swaps", open: "Open shifts", rules: "Staffing & conflicts", coverage: "Coverage", publish: "Publish & history", cost: "Cost forecast", adherence: "Adherence", library: "Shift library", changes: "Workweek & cycle changes", settings: "Rules & settings", reports: "Reports" };
const HEAT = ["#f3f4f6", "#fecaca", "#fde68a", "#bbf7d0", "#93c5fd"];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Roster operations: swaps, open shifts, staffing rules and conflict detection, coverage, publication, cost, adherence, the shift library, and approval-gated workweek / cycle changes. */
export default async function RosterOpsPage({ searchParams }: { searchParams: Promise<{ tab?: string; from?: string; dept?: string }> }) {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const sp = await searchParams;
  const tab = sp.tab && sp.tab in TABS ? sp.tab : "swaps";
  const t = viewer.tenantId;
  const today = new Date(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) + "T00:00:00Z");
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? new Date(`${sp.from}T00:00:00Z`) : today;
  const [emps, shifts, depts, locs] = await Promise.all([
    prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, P.SHIFT_MANAGE), { status: { notIn: ["EXITED", "PREBOARDING", "INACTIVE"] } }, sp.dept ? { departmentId: sp.dept } : {}] }, select: { id: true, displayName: true, employeeNumber: true, departmentId: true, locationId: true, userId: true }, orderBy: { employeeNumber: "asc" }, take: 300 }),
    prisma.shift.findMany({ where: { tenantId: t }, orderBy: { startTime: "asc" } }),
    prisma.department.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const ids = emps.map((e) => e.id);
  const sName = new Map(shifts.map((s) => [s.id, s.name]));
  const empMap = new Map(emps.map((e) => [e.id, { departmentId: e.departmentId, locationId: e.locationId, name: e.displayName ?? "" }]));
  const shiftOpts = shifts.filter((s) => s.isActive).map((s) => ({ value: s.id, label: `${s.name} (${s.startTime}–${s.endTime})` }));
  const deptOpts = depts.map((d) => ({ value: d.id, label: d.name })), locOpts = locs.map((l) => ({ value: l.id, label: l.name }));
  const range = async (days: number) => {
    const grid = await rosterGrid(ids, from, days);
    return [...grid.entries()].flatMap(([employeeId, cells]) => cells.map((c) => ({ employeeId, date: new Date(`${c.date}T00:00:00Z`), shiftId: c.shiftId, off: c.off })));
  };
  const filter = (
    <form method="get" action="/attendance/roster/ops" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
      <input type="hidden" name="tab" value={tab} />
      <input className="input" type="date" name="from" defaultValue={iso(from)} />
      <select className="select" name="dept" defaultValue={sp.dept ?? ""} style={{ width: 200 }}><option value="">All departments</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      <button className="btn sm" type="submit">Show</button>
    </form>
  );
  return (
    <>
      <PageHead title="Roster operations" actions={<Link className="btn" href="/attendance/roster">Roster grid</Link>} />
      <Tabs base="/attendance/roster/ops" tabs={TABS} active={tab} />
      {tab === "swaps" ? await (async () => {
        const rows = await prisma.shiftSwapRequest.findMany({ where: { tenantId: t, OR: [{ requesterId: { in: ids } }, { counterpartId: { in: ids } }] }, orderBy: { createdAt: "desc" }, take: 200 });
        const ppl = await peopleIndex(t, rows.flatMap((r) => [r.requesterId, r.counterpartId]));
        return (
          <Card tight title="Shift swap requests" description="Approvals arrive in the managers' inbox; approved swaps rewrite the roster.">
            <Table head={["Requested", "Shift date", "By", "With", "Type", "Status"]} empty={!rows.length}>
              {rows.map((r) => <tr key={r.id}><td className="text-xs">{fmtTime(r.createdAt)}</td><td className="text-sm">{fmtDay(r.requesterDate)}{r.requesterShiftId ? <div className="text-xs subtle">{sName.get(r.requesterShiftId)}</div> : null}</td><td className="text-sm">{ppl.name(r.requesterId)}</td><td className="text-sm">{r.counterpartId ? ppl.name(r.counterpartId) : "—"}{r.counterpartDate && r.counterpartDate.getTime() !== r.requesterDate.getTime() ? <div className="text-xs subtle">their {fmtDay(r.counterpartDate)}</div> : null}</td><td className="text-xs">{r.isMarketplace ? "marketplace" : "direct"}</td><td><Pill s={r.status} /></td></tr>)}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "open" ? await (async () => {
        const rows = await prisma.openShift.findMany({ where: { tenantId: t }, include: { bids: true }, orderBy: { date: "desc" }, take: 100 });
        const ppl = await peopleIndex(t, rows.flatMap((r) => r.bids.map((b) => b.employeeId)));
        return (
          <div className="stack gap-4">
            <Card title="Post an open shift" description="Eligible employees get a vacancy alert and can bid from My Shifts.">
              <SpecForm action={saveOpenShiftAction} submitLabel="Post" columns={3} fields={[
                { name: "shiftId", label: "Shift", type: "select", required: true, options: shiftOpts },
                { name: "date", label: "Date", type: "date", required: true },
                { name: "slots", label: "Slots", type: "number", defaultValue: 1 },
                { name: "departmentId", label: "Department", type: "select", options: deptOpts, placeholder: "Anyone" },
                { name: "locationId", label: "Location", type: "select", options: locOpts, placeholder: "Anywhere" },
                { name: "note", label: "Note" },
              ]} />
            </Card>
            <Card tight title="Open shifts and bids">
              <Table head={["Date", "Shift", "Slots", "Bids", "Status", ""]} empty={!rows.length}>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td className="text-sm">{fmtDay(o.date)}</td><td className="text-sm">{sName.get(o.shiftId)}</td><td className="num">{o.slots}</td>
                    <td className="text-xs">{o.bids.map((b) => <div key={b.id} className="row gap-2">{ppl.name(b.employeeId)} · {pretty(b.status)}{o.status === "OPEN" && b.status === "BID" ? <ActButton action={openShiftOpAction} hidden={{ id: o.id, op: "award", bidId: b.id }} label="Award" /> : null}</div>)}</td>
                    <td><Pill s={o.status} /></td>
                    <td className="right">{o.status === "OPEN" ? <ActButton action={openShiftOpAction} hidden={{ id: o.id, op: "cancel" }} label="Cancel" variant="ghost" /> : null}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "rules" ? await (async () => {
        const [rules, s, rows, leaves, prefs] = await Promise.all([
          prisma.staffingRule.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
          joinSettings(t), range(14),
          prisma.leaveRequest.findMany({ where: { employeeId: { in: ids }, status: "APPROVED", fromDate: { lte: new Date(from.getTime() + 13 * DAY) }, toDate: { gte: from } }, select: { employeeId: true, fromDate: true, toDate: true } }),
          prisma.shiftPreference.findMany({ where: { tenantId: t, employeeId: { in: ids } } }),
        ]);
        const leave = new Set<string>();
        for (const l of leaves) for (let d = l.fromDate.getTime(); d <= l.toDate.getTime(); d += DAY) leave.add(`${l.employeeId}:${iso(new Date(d))}`);
        const v = rosterViolations({ assignments: rows, shifts, rules: rules.filter((r) => r.isActive), minRestHours: s.minRestHours, employees: empMap, leave, avoid: new Map(prefs.map((p) => [p.employeeId, p.avoidWeekdays])) });
        return (
          <div className="stack gap-4">
            {filter}
            <div className="grid grid-4">
              {(["REST", "UNDERSTAFFED", "OVERSTAFFED", "ON_LEAVE"] as const).map((k) => <Stat key={k} label={pretty(k)} value={v.filter((x) => x.kind === k).length} tone={v.some((x) => x.kind === k) ? "neg" : undefined} />)}
            </div>
            <Card tight title={`Conflicts in the next 14 days (${v.length})`} description={`Rest-period checks use a ${s.minRestHours}-hour minimum; preference clashes come from employees' own preferences.`}>
              <Table head={["Date", "Type", "Detail"]} empty={!v.length}>
                {v.map((x) => <tr key={x.key}><td className="text-sm">{x.date}</td><td><Badge tone={x.kind === "PREFERENCE" ? "neutral" : "danger"}>{pretty(x.kind)}</Badge></td><td className="text-sm">{x.message}</td></tr>)}
              </Table>
            </Card>
            <Card tight title="Minimum and maximum staffing rules">
              <Table head={["Rule", "Shift", "Team", "Days", "Min", "Max", ""]} empty={!rules.length}>
                {rules.map((r) => <tr key={r.id}><td className="text-sm strong">{r.name}</td><td className="text-sm">{r.shiftId ? sName.get(r.shiftId) : "Any"}</td><td className="text-xs">{[r.departmentId && depts.find((d) => d.id === r.departmentId)?.name, r.locationId && locs.find((l) => l.id === r.locationId)?.name].filter(Boolean).join(" · ") || "Everyone"}</td><td className="text-xs">{r.weekdays.length ? r.weekdays.map((d) => WD[d]).join(" ") : "Every day"}</td><td className="num">{r.minStaff}</td><td className="num">{r.maxStaff ?? "—"}</td><td className="right"><ActButton action={saveStaffingRuleAction} hidden={{ id: r.id, op: "delete" }} label="Delete" variant="ghost" /></td></tr>)}
              </Table>
              <div style={{ padding: 16 }}>
                <SpecForm action={saveStaffingRuleAction} submitLabel="Add rule" columns={3} fields={[
                  { name: "name", label: "Name", required: true },
                  { name: "shiftId", label: "Shift", type: "select", options: shiftOpts, placeholder: "Any" },
                  { name: "departmentId", label: "Department", type: "select", options: deptOpts, placeholder: "Any" },
                  { name: "locationId", label: "Location", type: "select", options: locOpts, placeholder: "Any" },
                  { name: "minStaff", label: "Minimum", type: "number" },
                  { name: "maxStaff", label: "Maximum", type: "number" },
                  { name: "weekdays", label: "Days", type: "multiselect", options: WD.map((d, i) => ({ value: String(i), label: d })), wide: true },
                ]} />
              </div>
            </Card>
          </div>
        );
      })() : null}
      {tab === "coverage" ? await (async () => {
        const rows = await range(14);
        const dates = [...Array(14)].map((_, i) => iso(new Date(from.getTime() + i * DAY)));
        const active = shifts.filter((s) => s.isActive);
        const cov = rosterCoverage(rows, dates, active.map((s) => s.id));
        const rules = await prisma.staffingRule.findMany({ where: { tenantId: t, isActive: true, departmentId: sp.dept || undefined } });
        return (
          <>
            {filter}
            <Card tight title="Coverage heat map" description="Headcount per shift per day; colours compare against the minimum staffing rule for that shift.">
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Shift</th>{dates.map((d) => <th key={d} className="text-xs">{d.slice(5)}<div className="subtle">{WD[new Date(`${d}T00:00:00Z`).getUTCDay()]}</div></th>)}</tr></thead>
                  <tbody>
                    {active.map((s) => (
                      <tr key={s.id}>
                        <td className="text-sm nowrap">{s.name}</td>
                        {dates.map((d) => {
                          const n = cov[s.id]?.[d] ?? 0;
                          const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
                          const rule = rules.find((r) => r.shiftId === s.id && (!r.weekdays.length || r.weekdays.includes(wd)));
                          return <td key={d} className="num" style={{ background: HEAT[coverageLevel(n, rule?.minStaff ?? null)] }}>{n}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        );
      })() : null}
      {tab === "publish" ? await (async () => {
        const pubs = await prisma.rosterPublication.findMany({ where: { tenantId: t }, orderBy: { createdAt: "desc" }, take: 30 });
        const ppl = await peopleIndex(t, pubs.flatMap((p) => (Array.isArray(p.snapshot) ? (p.snapshot as unknown as SnapshotRow[]).map((r) => r.employeeId) : [])));
        const published = pubs.filter((p) => p.status === "PUBLISHED");
        return (
          <div className="stack gap-4">
            <Card title="Publish a roster" description="Takes a snapshot of the roster for the range and sends it for approval; once approved everyone on it is told.">
              <SpecForm action={submitRosterPublicationAction} submitLabel="Submit for publication" columns={3} fields={[
                { name: "title", label: "Title" },
                { name: "fromDate", label: "From", type: "date", required: true, defaultValue: iso(from) },
                { name: "toDate", label: "To", type: "date", required: true, defaultValue: iso(new Date(from.getTime() + 13 * DAY)) },
                { name: "departmentId", label: "Department", type: "select", options: deptOpts, placeholder: "All in my scope" },
                { name: "locationId", label: "Location", type: "select", options: locOpts, placeholder: "All" },
              ]} />
            </Card>
            <Card tight title="Publications and revision history">
              <Table head={["Submitted", "Roster", "Range", "Version", "Rows", "Status", "Changes from the previous version"]} empty={!pubs.length}>
                {pubs.map((p) => {
                  const prev = published.find((x) => x.id !== p.id && x.fromDate.getTime() === p.fromDate.getTime() && x.toDate.getTime() === p.toDate.getTime() && x.departmentId === p.departmentId && x.locationId === p.locationId && x.createdAt < p.createdAt);
                  const diff = prev ? rosterSnapshotDiff((prev.snapshot ?? []) as unknown as SnapshotRow[], (p.snapshot ?? []) as unknown as SnapshotRow[]) : [];
                  const label = (v: string) => (v === "OFF" ? "off" : sName.get(v) ?? v);
                  return (
                    <tr key={p.id}>
                      <td className="text-xs">{fmtTime(p.createdAt)}</td><td className="text-sm">{p.title}</td><td className="text-xs">{fmtDay(p.fromDate)} – {fmtDay(p.toDate)}</td><td className="num">{p.status === "PUBLISHED" ? `v${p.version}` : "—"}</td><td className="num">{p.assignmentCount}</td><td><Pill s={p.status} /></td>
                      <td className="text-xs">{prev ? (diff.length ? diff.slice(0, 8).map((d) => <div key={`${d.employeeId}${d.date}`}>{d.date} {ppl.name(d.employeeId)}: {label(d.from)} → {label(d.to)}</div>) : "no changes") : "first version"}{diff.length > 8 ? <div>…and {diff.length - 8} more</div> : null}</td>
                    </tr>
                  );
                })}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "cost" ? await (async () => {
        const rows = (await range(14)).filter((r) => !r.off && r.shiftId) as Array<{ employeeId: string; shiftId: string }>;
        const rates = new Map<string, number>();
        for (const e of emps.slice(0, 200)) { const w = await monthlyWages(e.id, from); rates.set(e.id, w ? Math.round((w.basic * 12 / 2920) * 100) / 100 : 0); }
        const cost = shiftCostForecast(rows, new Map(shifts.map((s) => [s.id, { minutes: shiftPlannedMinutes(s), allowancePerDay: Number(s.allowancePerDay ?? 0) }])), rates);
        const total = cost.reduce((s, c) => s + c.total, 0);
        return (
          <>
            {filter}
            <div className="grid grid-3"><Stat label="Rostered shift-days" value={rows.length} /><Stat label="Forecast cost (14 days)" value={`₹${Math.round(total).toLocaleString("en-IN")}`} /><Stat label="Allowances" value={`₹${Math.round(cost.reduce((s, c) => s + c.allowance, 0)).toLocaleString("en-IN")}`} /></div>
            <Card tight title="Shift cost forecast" description="Planned hours × each person's hourly basic rate, plus the shift allowance.">
              <Table head={["Shift", "Days", "Hours", "Wages", "Allowance", "Total"]} empty={!cost.length}>
                {cost.map((c) => <tr key={c.shiftId}><td className="text-sm">{sName.get(c.shiftId)}</td><td className="num">{c.days}</td><td className="num">{c.hours}</td><td className="num">₹{c.wages.toLocaleString("en-IN")}</td><td className="num">₹{c.allowance.toLocaleString("en-IN")}</td><td className="num strong">₹{c.total.toLocaleString("en-IN")}</td></tr>)}
              </Table>
            </Card>
          </>
        );
      })() : null}
      {tab === "adherence" ? await (async () => {
        const start = new Date(today.getTime() - 14 * DAY);
        const grid = await rosterGrid(ids, start, 14);
        const recs = await prisma.attendanceRecord.findMany({ where: { employeeId: { in: ids }, date: { gte: start, lt: today } }, select: { employeeId: true, date: true, status: true, firstIn: true, lastOut: true, shiftId: true } });
        const recMap = new Map(recs.map((r) => [`${r.employeeId}:${iso(r.date)}`, r]));
        const mins = (d: Date | null) => (d ? d.getUTCHours() * 60 + d.getUTCMinutes() + 330 : null);
        const shiftMap = new Map(shifts.map((s) => [s.id, s]));
        const per = emps.map((e) => {
          const cells = (grid.get(e.id) ?? []).filter((c) => !c.off && c.shiftId);
          const results = cells.map((c) => { const r = recMap.get(`${e.id}:${c.date}`); const s = shiftMap.get(c.shiftId!); return { c, r, a: shiftAdherence(s ? shiftWindow(s) : null, { firstIn: mins(r?.firstIn ?? null), lastOut: mins(r?.lastOut ?? null), status: r?.status ?? "ABSENT" }) }; });
          return { e, planned: cells.length, onTime: results.filter((x) => x.a.status === "ON_TIME").length, late: results.filter((x) => x.a.status === "LATE").length, early: results.filter((x) => x.a.status === "EARLY_EXIT").length, absent: results.filter((x) => x.a.status === "ABSENT").length, mismatched: results.filter((x) => x.r?.shiftId && x.r.shiftId !== x.c.shiftId).length, lateMin: results.reduce((s, x) => s + x.a.lateMinutes, 0) };
        }).filter((x) => x.planned);
        return (
          <Card tight title="Roster adherence — last 14 days" description="Rostered shift against actual punches; 'other shift' counts days the attendance record carries a different shift (shift attendance comparison).">
            <Table head={["Employee", "Rostered", "On time", "Late", "Left early", "Absent", "Other shift", "Late minutes", "Adherence"]} empty={!per.length}>
              {per.map((x) => <tr key={x.e.id}><td className="text-sm">{x.e.displayName}</td><td className="num">{x.planned}</td><td className="num">{x.onTime}</td><td className="num">{x.late}</td><td className="num">{x.early}</td><td className="num">{x.absent}</td><td className="num">{x.mismatched}</td><td className="num">{x.lateMin}</td><td className="num strong">{Math.round((x.onTime / x.planned) * 100)}%</td></tr>)}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "library" ? (
        <div className="stack gap-4">
          <Card tight title="Shift template library" description="Add a ready-made shift in one click; edit it afterwards under Shifts.">
            <Table head={["Template", "Times", "Break", ""]}>
              {SHIFT_TEMPLATE_LIBRARY.map((x) => <tr key={x.code}><td className="text-sm strong">{x.name}</td><td className="text-sm">{x.startTime}–{x.endTime}{x.segments ? ` + ${x.segments.map((g) => `${g.start}–${g.end}`).join(", ")}` : ""}</td><td className="num">{x.breakMinutes} min</td><td className="right"><ActButton action={addShiftFromLibraryAction} hidden={{ code: x.code }} label={shifts.some((s) => s.code === x.code) ? "Add again" : "Add"} input={shifts.some((s) => s.code === x.code) ? { name: "newCode", placeholder: "New code", required: true } : undefined} /></td></tr>)}
            </Table>
          </Card>
          <Card tight title="Split shifts" description="Add later segments to a shift, e.g. 16:00-20:00 after a 08:00–12:00 morning.">
            <Table head={["Shift", "Main", "Segments", ""]}>
              {shifts.filter((s) => s.isActive).map((s) => <tr key={s.id}><td className="text-sm">{s.name}</td><td className="text-sm">{s.startTime}–{s.endTime}</td><td className="text-sm">{parseShiftSegments(s.segments).map((g) => `${g.start}–${g.end}`).join(", ") || "—"}</td><td className="right"><ActButton action={saveSplitShiftAction} hidden={{ shiftId: s.id }} label="Set segments" input={{ name: "segments", placeholder: "16:00-20:00" }} /></td></tr>)}
            </Table>
          </Card>
        </div>
      ) : null}
      {tab === "changes" ? await (async () => {
        const [changes, weeks, cycles] = await Promise.all([
          prisma.timeConfigChange.findMany({ where: { tenantId: t }, orderBy: { createdAt: "desc" }, take: 50 }),
          prisma.weeklyOffPolicy.findMany({ where: { tenantId: t, isActive: true }, select: { id: true, name: true } }),
          prisma.rosterPattern.findMany({ where: { tenantId: t, isActive: true }, select: { id: true, name: true, steps: true } }),
        ]);
        const rule = [{ value: "WORKING", label: "Working" }, { value: "ALL", label: "Off" }, { value: "ALT_2_4", label: "2nd & 4th off" }, { value: "ALT_1_3_5", label: "1st, 3rd & 5th off" }];
        const codeOf = new Map(shifts.map((s) => [s.id, s.code]));
        return (
          <div className="stack gap-4">
            <div className="grid grid-2">
              <Card title="Propose a workweek" description="Applied once a time administrator approves it.">
                <SpecForm action={proposeTimeConfigChangeAction} hidden={{ kind: "WORKWEEK" }} submitLabel="Send for approval" fields={[
                  { name: "targetId", label: "Change", type: "select", options: weeks.map((w) => ({ value: w.id, label: w.name })), placeholder: "A new workweek" },
                  { name: "name", label: "Name (new)" },
                  ...(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const).map((d) => ({ name: `rule_${d}`, label: d, type: "select" as const, options: rule, defaultValue: d === "SAT" || d === "SUN" ? "ALL" : "WORKING" })),
                  { name: "reason", label: "Reason", wide: true },
                ]} />
              </Card>
              <Card title="Propose a shift cycle" description={`Shift codes or OFF in order, e.g. "GEN GEN GEN GEN GEN OFF OFF". Codes: ${shifts.filter((s) => s.isActive).map((s) => s.code).join(", ")}`}>
                <SpecForm action={proposeTimeConfigChangeAction} hidden={{ kind: "SHIFT_CYCLE" }} submitLabel="Send for approval" columns={1} fields={[
                  { name: "targetId", label: "Change", type: "select", options: cycles.map((c) => ({ value: c.id, label: `${c.name} (${patternSteps(c.steps).map((s) => (s.off ? "OFF" : codeOf.get(s.shiftId ?? "") ?? "?")).join(" ")})` })), placeholder: "A new cycle" },
                  { name: "name", label: "Name (new)" },
                  { name: "steps", label: "Days", required: true },
                  { name: "reason", label: "Reason" },
                ]} />
              </Card>
            </div>
            <Card tight title="Change requests">
              <Table head={["Raised", "Type", "Change", "Status", "Applied"]} empty={!changes.length}>
                {changes.map((c) => <tr key={c.id}><td className="text-xs">{fmtTime(c.createdAt)}</td><td><Badge>{pretty(c.kind)}</Badge></td><td className="text-sm">{c.summary}</td><td><Pill s={c.status} /></td><td className="text-xs">{fmtDay(c.appliedAt)}</td></tr>)}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "settings" ? await (async () => {
        const s = await joinSettings(t);
        return (
          <Card title="Swap approval rules, trade eligibility and rest periods">
            <SpecForm action={saveJoinSettingsAction} hidden={{ scope: "roster" }} fields={[
              { name: "swapRequiresApproval", label: "Approval", type: "checkbox", defaultValue: s.swapRequiresApproval, placeholder: "Swaps need the manager's approval" },
              { name: "swapSameDepartmentOnly", label: "Eligibility", type: "checkbox", defaultValue: s.swapSameDepartmentOnly, placeholder: "Only within the same department" },
              { name: "swapMinNoticeHours", label: "Minimum notice (hours)", type: "number", defaultValue: s.swapMinNoticeHours },
              { name: "swapMaxPerMonth", label: "Swaps per person per month", type: "number", defaultValue: s.swapMaxPerMonth },
              { name: "minRestHours", label: "Minimum rest between shifts (hours)", type: "number", defaultValue: s.minRestHours },
            ]} />
          </Card>
        );
      })() : null}
      {tab === "reports" ? (
        <Card title="Reports and exports" description="CSV downloads; each export is recorded in the audit log.">
          <div className="stack gap-2">
            {locs.map((l) => <div key={l.id} className="row gap-2"><a className="btn sm" href={`/time/ops-export?kind=roster&locationId=${l.id}&from=${iso(from)}`}>Download</a><span className="text-sm">Roster — {l.name} (14 days from {iso(from)})</span></div>)}
            {[["roster", "Roster — everyone (14 days)"], ["shifts", "Shift definitions"], ["swaps", "Shift swap requests"], ["shift-requests", "Shift and weekly-off change requests"], ["cycles", "Shift cycles (patterns)"], ["workweeks", "Workweeks (weekly-off patterns)"], ["time-changes", "Workweek, cycle and calendar change requests"], ["roster-audit", "Roster and shift change log"]].map(([k, label]) => <div key={k} className="row gap-2"><a className="btn sm" href={`/time/ops-export?kind=${k}&from=${iso(from)}`}>Download</a><span className="text-sm">{label}</span></div>)}
          </div>
        </Card>
      ) : null}
    </>
  );
}
