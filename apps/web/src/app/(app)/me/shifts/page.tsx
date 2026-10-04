import { prisma } from "@keka/db";
import { rosterGrid, joinSettings, shiftWindow } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Empty, Badge } from "@/components/ui";
import { Tabs, Table, Pill } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { fmtDay, pretty } from "@/lib/engage-depth";
import { peopleIndex } from "@/lib/join-depth";
import {
  requestShiftSwapAction, respondShiftSwapAction, claimShiftSwapAction, cancelShiftSwapAction, saveShiftPreferenceAction, bidOpenShiftAction,
} from "@/app/actions/join-roster";
import { raiseShiftRequestAction, raiseOvertimeAction } from "@/app/actions/time-requests";

const TABS = { roster: "My roster", swaps: "Swaps", marketplace: "Marketplace", open: "Open shifts", requests: "Shift & overtime requests", preferences: "Preferences" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** My shifts: the roster for the next weeks, swaps and the swap marketplace, open shifts to bid for, shift / weekly-off / overtime requests, and shift preferences. */
export default async function MyShiftsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireViewer();
  const me = viewer.employee;
  if (!me) return <><PageHead title="My shifts" /><Card><Empty title="No employee record is linked to this login" /></Card></>;
  const { tab: raw } = await searchParams;
  const tab = raw && raw in TABS ? raw : "roster";
  const t = viewer.tenantId;
  const today = new Date(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) + "T00:00:00Z");
  const [shifts, self, settings] = await Promise.all([
    prisma.shift.findMany({ where: { tenantId: t, isActive: true }, orderBy: { startTime: "asc" } }),
    prisma.employee.findFirst({ where: { id: me.id }, select: { departmentId: true, locationId: true } }),
    joinSettings(t),
  ]);
  const shiftName = new Map(shifts.map((s) => [s.id, `${s.name} (${s.startTime}–${s.endTime})`]));
  const peers = await prisma.employee.findMany({ where: { tenantId: t, id: { not: me.id }, status: { notIn: ["EXITED", "PREBOARDING", "INACTIVE"] }, ...(settings.swapSameDepartmentOnly ? { departmentId: self?.departmentId ?? "-" } : {}) }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { displayName: "asc" } });
  const peerOpts = peers.map((p) => ({ value: p.id, label: `${p.displayName} (${p.employeeNumber})` }));
  return (
    <>
      <PageHead title="My shifts" subtitle={`Swaps need ${settings.swapMinNoticeHours} h notice, up to ${settings.swapMaxPerMonth} a month${settings.swapSameDepartmentOnly ? ", within your department" : ""}${settings.swapRequiresApproval ? "; your manager approves them" : ""}.`} />
      <Tabs base="/me/shifts" tabs={TABS} active={tab} />
      {tab === "roster" ? await (async () => {
        const grid = (await rosterGrid([me.id], today, 21)).get(me.id) ?? [];
        const pubs = await prisma.rosterPublication.findMany({ where: { tenantId: t, status: "PUBLISHED", toDate: { gte: today } }, orderBy: { publishedAt: "desc" }, take: 3 });
        return (
          <Card tight title="Next three weeks" description={pubs.length ? `Published: ${pubs.map((p) => p.title).join(", ")}` : "Roster as planned"}>
            <Table head={["Date", "Day", "Shift", "Hours"]}>
              {grid.map((c) => {
                const s = c.shiftId ? shifts.find((x) => x.id === c.shiftId) : null;
                const w = s ? shiftWindow(s) : null;
                return (
                  <tr key={c.date}>
                    <td className="text-sm">{c.date}</td>
                    <td className="text-sm">{DAYS[new Date(`${c.date}T00:00:00Z`).getUTCDay()]}</td>
                    <td>{c.off ? <Badge>weekly off</Badge> : s ? <span className="text-sm">{s.name}{c.explicit ? "" : <span className="subtle"> (default)</span>}</span> : <span className="subtle">—</span>}</td>
                    <td className="text-xs">{!c.off && s ? `${s.startTime}–${s.endTime}${w && Array.isArray(s.segments) && s.segments.length ? " + split" : ""}` : ""}</td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "swaps" ? await (async () => {
        const rows = await prisma.shiftSwapRequest.findMany({ where: { tenantId: t, OR: [{ requesterId: me.id }, { counterpartId: me.id }] }, orderBy: { createdAt: "desc" }, take: 100 });
        const ppl = await peopleIndex(t, rows.flatMap((r) => [r.requesterId, r.counterpartId]));
        return (
          <div className="stack gap-4">
            <Card title="Ask to swap" description="Pick the day you are rostered, then a colleague (and their day, for a day-for-day swap) — or post it to the marketplace for anyone eligible to pick up.">
              <SpecForm action={requestShiftSwapAction} submitLabel="Send" fields={[
                { name: "date", label: "My shift on", type: "date", required: true },
                { name: "counterpartId", label: "Swap with", type: "select", options: peerOpts, placeholder: "—" },
                { name: "counterpartDate", label: "Their day (optional)", type: "date", hint: "Leave blank to swap shifts on the same day" },
                { name: "marketplace", label: "Marketplace", type: "checkbox", placeholder: "Post to the marketplace instead" },
                { name: "reason", label: "Reason", type: "textarea", wide: true },
              ]} />
            </Card>
            <Card tight title="My swaps">
              <Table head={["Date", "With", "Their day", "Reason", "Status", ""]} empty={!rows.length}>
                {rows.map((r) => {
                  const mine = r.requesterId === me.id;
                  return (
                    <tr key={r.id}>
                      <td className="text-sm">{fmtDay(r.requesterDate)}<div className="text-xs subtle">{r.requesterShiftId ? shiftName.get(r.requesterShiftId) : ""}</div></td>
                      <td className="text-sm">{mine ? (r.counterpartId ? ppl.name(r.counterpartId) : "marketplace") : `${ppl.name(r.requesterId)} (asked you)`}</td>
                      <td className="text-sm">{r.counterpartDate && r.counterpartDate.getTime() !== r.requesterDate.getTime() ? fmtDay(r.counterpartDate) : "same day"}</td>
                      <td className="text-xs">{r.reason ?? ""}</td>
                      <td><Pill s={r.status} /></td>
                      <td className="right">
                        {!mine && r.status === "PENDING_PEER" ? <div className="row gap-2"><ActButton action={respondShiftSwapAction} hidden={{ id: r.id, response: "accept" }} label="Accept" variant="primary" /><ActButton action={respondShiftSwapAction} hidden={{ id: r.id, response: "decline" }} label="Decline" variant="ghost" /></div> : null}
                        {mine && ["OPEN", "PENDING_PEER"].includes(r.status) ? <ActButton action={cancelShiftSwapAction} hidden={{ id: r.id }} label="Cancel" variant="ghost" /> : null}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "marketplace" ? await (async () => {
        const rows = await prisma.shiftSwapRequest.findMany({ where: { tenantId: t, isMarketplace: true, status: "OPEN", requesterId: { not: me.id }, requesterDate: { gte: today } }, orderBy: { requesterDate: "asc" } });
        const ppl = await peopleIndex(t, rows.map((r) => r.requesterId));
        const visible = rows.filter((r) => !settings.swapSameDepartmentOnly || ppl.get(r.requesterId)?.departmentId === self?.departmentId);
        return (
          <Card tight title="Shifts up for grabs" description="Pick one up; it goes to the poster's manager for approval.">
            <Table head={["Date", "Shift", "Posted by", "Reason", ""]} empty={!visible.length}>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td className="text-sm">{fmtDay(r.requesterDate)}</td>
                  <td className="text-sm">{r.requesterShiftId ? shiftName.get(r.requesterShiftId) : "—"}</td>
                  <td className="text-sm">{ppl.name(r.requesterId)}</td>
                  <td className="text-xs">{r.reason ?? ""}</td>
                  <td className="right"><ActButton action={claimShiftSwapAction} hidden={{ id: r.id }} label="Pick up" variant="primary" /></td>
                </tr>
              ))}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "open" ? await (async () => {
        const rows = await prisma.openShift.findMany({ where: { tenantId: t, status: "OPEN", date: { gte: today }, AND: [{ OR: [{ departmentId: null }, { departmentId: self?.departmentId ?? "-" }] }, { OR: [{ locationId: null }, { locationId: self?.locationId ?? "-" }] }] }, include: { bids: true }, orderBy: { date: "asc" } });
        return (
          <Card tight title="Open shifts" description="Bid for extra shifts; the roster planner awards them.">
            <Table head={["Date", "Shift", "Slots", "Bids", "Note", ""]} empty={!rows.length}>
              {rows.map((o) => {
                const mine = o.bids.find((b) => b.employeeId === me.id);
                return (
                  <tr key={o.id}>
                    <td className="text-sm">{fmtDay(o.date)}</td>
                    <td className="text-sm">{shiftName.get(o.shiftId)}</td>
                    <td className="num">{o.slots}</td>
                    <td className="num">{o.bids.filter((b) => b.status === "BID").length}</td>
                    <td className="text-xs">{o.note ?? ""}</td>
                    <td className="right">{mine ? <div className="row gap-2"><Pill s={mine.status} />{mine.status === "BID" ? <ActButton action={bidOpenShiftAction} hidden={{ id: o.id, withdraw: "true" }} label="Withdraw" variant="ghost" /> : null}</div> : <ActButton action={bidOpenShiftAction} hidden={{ id: o.id }} label="Bid" variant="primary" input={{ name: "note", placeholder: "Note (optional)" }} />}</td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "requests" ? await (async () => {
        const [srs, ots] = await Promise.all([
          prisma.shiftRequest.findMany({ where: { employeeId: me.id }, orderBy: { createdAt: "desc" }, take: 30 }),
          prisma.overtimeRequest.findMany({ where: { employeeId: me.id }, orderBy: { createdAt: "desc" }, take: 30 }),
        ]);
        return (
          <div className="stack gap-4">
            <div className="grid grid-2">
              <Card title="Change my shift or weekly off" description="Goes to your manager; once approved your roster changes.">
                <SpecForm action={raiseShiftRequestAction} fields={[
                  { name: "kind", label: "Change", type: "select", required: true, options: [{ value: "SHIFT_CHANGE", label: "Shift" }, { value: "WEEKLY_OFF", label: "Weekly off" }] },
                  { name: "shiftId", label: "New shift", type: "select", options: shifts.map((s) => ({ value: s.id, label: shiftName.get(s.id)! })), placeholder: "—" },
                  { name: "fromDate", label: "From", type: "date", required: true },
                  { name: "toDate", label: "To", type: "date" },
                  { name: "reason", label: "Reason", type: "textarea", required: true, wide: true },
                ]} submitLabel="Request" />
              </Card>
              <Card title="Request overtime" description="Your overtime rule decides whether it must be approved before the day or can be claimed after.">
                <SpecForm action={raiseOvertimeAction} fields={[
                  { name: "fromDate", label: "Date", type: "date", required: true },
                  { name: "toDate", label: "To (optional)", type: "date" },
                  { name: "hours", label: "Hours (hh:mm)", required: true, placeholder: "02:00" },
                  { name: "note", label: "What for", type: "textarea", wide: true },
                ]} submitLabel="Request" />
              </Card>
            </div>
            <Card tight title="My requests">
              <Table head={["Raised", "Request", "Dates", "Status"]} empty={!srs.length && !ots.length}>
                {srs.map((r) => <tr key={r.id}><td className="text-xs">{fmtDay(r.createdAt)}</td><td className="text-sm">{pretty(r.kind)}{r.shiftId ? ` → ${shiftName.get(r.shiftId) ?? ""}` : ""}{r.reason ? <div className="text-xs subtle">{r.reason}</div> : null}</td><td className="text-sm">{fmtDay(r.fromDate)} – {fmtDay(r.toDate)}</td><td><Pill s={r.status} /></td></tr>)}
                {ots.map((r) => <tr key={r.id}><td className="text-xs">{fmtDay(r.createdAt)}</td><td className="text-sm">Overtime {Math.floor(r.requestedMinutes / 60)}:{String(r.requestedMinutes % 60).padStart(2, "0")} h{r.note ? <div className="text-xs subtle">{r.note}</div> : null}</td><td className="text-sm">{fmtDay(r.fromDate)} – {fmtDay(r.toDate)}</td><td><Pill s={r.status} /></td></tr>)}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "preferences" ? await (async () => {
        const pref = await prisma.shiftPreference.findUnique({ where: { employeeId: me.id } });
        return (
          <Card title="Shift preferences" description="Roster planners see these, and the roster flags days that go against them.">
            <SpecForm action={saveShiftPreferenceAction} fields={[
              { name: "preferredShiftIds", label: "Shifts I prefer", type: "multiselect", options: shifts.map((s) => ({ value: s.id, label: shiftName.get(s.id)! })), defaultValue: pref?.preferredShiftIds ?? [] },
              { name: "avoidWeekdays", label: "Days I'd rather not work", type: "multiselect", options: DAYS.map((d, i) => ({ value: String(i), label: d })), defaultValue: (pref?.avoidWeekdays ?? []).map(String) },
              { name: "maxNightsPerWeek", label: "At most night shifts a week", type: "number", defaultValue: pref?.maxNightsPerWeek },
              { name: "note", label: "Anything else", type: "textarea", defaultValue: pref?.note },
            ]} />
          </Card>
        );
      })() : null}
    </>
  );
}
