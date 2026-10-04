import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  revisionHolidays, calendarDiff, holidayImpact, holidayCountCheck, defaultWeeklyOff, calendarResolution, joinSettings, type CalHoliday,
} from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Stat, Badge, Empty } from "@/components/ui";
import { Tabs, Table, Pill, SearchBar } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { fmtDay, fmtTime, pretty, matches } from "@/lib/engage-depth";
import {
  createCalendarRevisionAction, editCalendarRevisionAction, submitCalendarRevisionAction, withdrawCalendarRevisionAction, saveHolidayRuleAction, holidayRuleOpAction,
  saveDayTypeAction, saveShutdownAction, shutdownOpAction, syncCalendarExceptionsAction, calendarExceptionOpAction, proposeCalendarAssignmentAction,
} from "@/app/actions/join-holidays";
import { saveJoinSettingsAction } from "@/app/actions/join-preboarding";

const P = PERMISSIONS;
const TABS = { upcoming: "Upcoming", calendars: "Calendars & versions", rules: "Rules", daytypes: "Day types", shutdowns: "Shutdowns", exceptions: "Exception queue", assignment: "Assignment", history: "Change history", settings: "Settings", reports: "Reports" };
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Holidays & calendars: regional calendars with versioned, approved publishing, rules, day types, shutdowns, the exception queue, assignment and history. */
export default async function HolidaysPage({ searchParams }: { searchParams: Promise<{ tab?: string; rev?: string; q?: string }> }) {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const sp = await searchParams;
  const tab = sp.tab && sp.tab in TABS ? sp.tab : "upcoming";
  const t = viewer.tenantId;
  const [cals, locs, dayTypes] = await Promise.all([
    prisma.holidayCalendar.findMany({ where: { tenantId: t }, include: { holidays: { orderBy: { date: "asc" } } }, orderBy: [{ year: "desc" }, { name: "asc" }] }),
    prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.holidayDayType.findMany({ where: { tenantId: t }, orderBy: { code: "asc" } }),
  ]);
  const locName = new Map(locs.map((l) => [l.id, l.name]));
  const calOpts = cals.map((c) => ({ value: c.id, label: `${c.name} (${c.year})` }));
  const locOpts = locs.map((l) => ({ value: l.id, label: l.name }));
  const typeOpts = dayTypes.filter((d) => d.isActive).map((d) => ({ value: d.code, label: d.name }));
  const live = (c: (typeof cals)[number]): CalHoliday[] => c.holidays.map((h) => ({ name: h.name, date: iso(h.date), isOptional: h.isOptional, dayType: h.dayType }));
  const locsOf = (c: { locationIds: unknown }) => (Array.isArray(c.locationIds) ? (c.locationIds as string[]) : []);
  const today = new Date();
  return (
    <>
      <PageHead title="Holidays & calendars" subtitle="Calendars change through versions that are approved before they publish." />
      <Tabs base="/time/holidays" tabs={TABS} active={tab} />
      {tab === "upcoming" ? (() => {
        const soon = cals.flatMap((c) => c.holidays.filter((h) => h.date >= new Date(iso(today) + "T00:00:00Z") && h.date.getTime() <= today.getTime() + 90 * 86_400_000).map((h) => ({ c, h }))).sort((a, b) => a.h.date.getTime() - b.h.date.getTime());
        return (
          <div className="stack gap-4">
            <div className="grid grid-4">
              <Stat label="Calendars" value={cals.length} />
              <Stat label="Holidays in the next 90 days" value={soon.length} />
              <Stat label="Next holiday" value={soon[0] ? fmtDay(soon[0].h.date) : "—"} meta={soon[0]?.h.name} />
              <Stat label="Regional calendars" value={cals.filter((c) => c.country || c.state || locsOf(c).length).length} />
            </div>
            <Card tight title="Upcoming holidays">
              <Table head={["Date", "Holiday", "Calendar", "Region", "Type"]} empty={!soon.length}>
                {soon.map(({ c, h }) => <tr key={h.id}><td className="text-sm">{fmtDay(h.date)}</td><td className="text-sm strong">{h.name}</td><td className="text-sm">{c.name}</td><td className="text-xs">{[c.country, c.state].filter(Boolean).join(" / ") || (locsOf(c).length ? locsOf(c).map((x) => locName.get(x)).join(", ") : "all")}</td><td>{h.isOptional ? <Badge>optional</Badge> : <Badge tone="info">public</Badge>}{h.dayType ? <Badge>{dayTypes.find((d) => d.code === h.dayType)?.name ?? h.dayType}</Badge> : null}</td></tr>)}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "calendars" ? await (async () => {
        const revs = await prisma.holidayCalendarRevision.findMany({ where: { tenantId: t }, orderBy: { createdAt: "desc" }, take: 60 });
        const sel = revs.find((r) => r.id === sp.rev) ?? revs.find((r) => ["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(r.status));
        const s = await joinSettings(t);
        const wo = await defaultWeeklyOff(t);
        return (
          <div className="stack gap-4">
            <Card tight title="Live calendars">
              <Table head={["Calendar", "Year", "Country / state", "Locations", "Holidays", "Default", ""]} empty={!cals.length}>
                {cals.map((c) => <tr key={c.id}><td className="text-sm strong">{c.name}</td><td className="num">{c.year}</td><td className="text-sm">{[c.country, c.state].filter(Boolean).join(" / ") || "—"}</td><td className="text-xs">{locsOf(c).map((x) => locName.get(x)).join(", ") || "all"}</td><td className="num">{c.holidays.length}</td><td>{c.isDefault ? <Badge tone="success">default</Badge> : null}</td><td className="right"><ActButton action={createCalendarRevisionAction} hidden={{ calendarId: c.id }} label="Start a revision" /></td></tr>)}
              </Table>
            </Card>
            <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 380px", alignItems: "start" }}>
              <div className="stack gap-4">
                {sel ? (() => {
                  const hs = revisionHolidays(sel.holidays);
                  const cal = cals.find((c) => c.id === sel.calendarId);
                  const base = cal ? live(cal) : [];
                  const diff = calendarDiff(base, hs);
                  const a = holidayImpact(base, sel.year, wo), b = holidayImpact(hs, sel.year, wo);
                  const problems = holidayCountCheck(hs, { min: s.holidayMinCount, max: s.holidayMaxCount });
                  const editable = ["DRAFT", "REJECTED"].includes(sel.status);
                  return (
                    <Card title={`${sel.name} ${sel.year} — v${sel.version}`} description={`${[sel.country, sel.state].filter(Boolean).join(" / ") || "no region"} · ${sel.locationIds.length ? sel.locationIds.map((x) => locName.get(x)).join(", ") : "all locations"}${sel.effectiveFrom ? ` · effective ${fmtDay(sel.effectiveFrom)}` : ""}`} action={<Pill s={sel.status} />}>
                      <div className="grid grid-3">
                        <Stat label="Public holidays" value={`${a.publicHolidays} → ${b.publicHolidays}`} />
                        <Stat label="Working days" value={`${a.workingDays} → ${b.workingDays}`} meta="Entitlement impact" />
                        <Stat label="On weekly offs" value={b.onWeeklyOffs} />
                      </div>
                      {problems.length ? <div className="callout warning" style={{ margin: "10px 0" }}><div>{problems.join(" ")}</div></div> : null}
                      <div className="strong text-sm" style={{ margin: "12px 0 4px" }}>Compared with the live calendar</div>
                      <Table head={["Change", "Holiday", "From", "To"]} empty={!diff.length}>
                        {diff.map((d, i) => <tr key={i}><td><Badge tone={d.change === "REMOVED" ? "danger" : d.change === "ADDED" ? "success" : "warning"}>{pretty(d.change)}</Badge></td><td className="text-sm">{d.name}</td><td className="text-xs">{d.from ?? ""}</td><td className="text-xs">{d.to ?? ""}</td></tr>)}
                      </Table>
                      <div className="strong text-sm" style={{ margin: "12px 0 4px" }}>Holidays in this version ({hs.length})</div>
                      <Table head={["Date", "Holiday", "Type", ""]} empty={!hs.length}>
                        {hs.map((h) => <tr key={`${h.date}|${h.name}`}><td className="text-sm">{h.date}</td><td className="text-sm">{h.name}</td><td className="text-xs">{h.isOptional ? "optional" : "public"}{h.dayType ? ` · ${h.dayType}` : ""}</td><td className="right">{editable ? <ActButton action={editCalendarRevisionAction} hidden={{ id: sel.id, op: "remove", key: `${h.date}|${h.name}` }} label="Remove" variant="ghost" /> : null}</td></tr>)}
                      </Table>
                      {editable ? (
                        <div className="stack gap-3" style={{ marginTop: 12 }}>
                          <SpecForm action={editCalendarRevisionAction} hidden={{ id: sel.id, op: "add" }} submitLabel="Add holiday" columns={3} fields={[
                            { name: "name", label: "Holiday", required: true }, { name: "date", label: "Date", type: "date", required: true },
                            { name: "dayType", label: "Day type", type: "select", options: typeOpts, placeholder: "None" }, { name: "isOptional", label: "Optional", type: "checkbox", placeholder: "Optional holiday" },
                          ]} />
                          <SpecForm action={editCalendarRevisionAction} hidden={{ id: sel.id, op: "import" }} submitLabel="Import CSV" columns={1} fields={[{ name: "csv", label: "Import CSV (Name,Date,Optional,DayType)", type: "textarea", required: true, placeholder: "Name,Date,Optional,DayType\nRepublic Day,2026-01-26,No," }]} />
                          <SpecForm action={editCalendarRevisionAction} hidden={{ id: sel.id, op: "meta" }} submitLabel="Save region & dating" fields={[
                            { name: "country", label: "Country", defaultValue: sel.country }, { name: "state", label: "State", defaultValue: sel.state },
                            { name: "effectiveFrom", label: "Effective from", type: "date", defaultValue: sel.effectiveFrom ? iso(sel.effectiveFrom) : null, hint: "Holidays before this date stay as they are" },
                            { name: "note", label: "Note", defaultValue: sel.note },
                            { name: "locationIds", label: "Locations (overlay)", type: "multiselect", options: locOpts, defaultValue: sel.locationIds, wide: true },
                          ]} />
                          <div className="row gap-2">
                            <ActButton action={submitCalendarRevisionAction} hidden={{ id: sel.id }} label="Submit for approval" variant="primary" />
                            <ActButton action={withdrawCalendarRevisionAction} hidden={{ id: sel.id }} label="Discard draft" variant="ghost" confirmText="Discard this draft?" />
                          </div>
                        </div>
                      ) : null}
                    </Card>
                  );
                })() : <Card><Empty title="No revision selected">Start a revision of a live calendar, or create a new regional calendar.</Empty></Card>}
              </div>
              <div className="stack gap-4">
                <Card title="New regional calendar" description="Country, state and the locations it overlays. Published once approved.">
                  <SpecForm action={createCalendarRevisionAction} columns={1} submitLabel="Start draft" fields={[
                    { name: "name", label: "Name", required: true }, { name: "year", label: "Year", type: "number", required: true, defaultValue: today.getUTCFullYear() + 1 },
                    { name: "country", label: "Country", placeholder: "IN" }, { name: "state", label: "State", placeholder: "Karnataka" },
                    { name: "locationIds", label: "Locations", type: "multiselect", options: locOpts },
                  ]} />
                </Card>
                <Card tight title="Versions">
                  <Table head={["Calendar", "v", "Status", "When"]} empty={!revs.length}>
                    {revs.map((r) => <tr key={r.id}><td className="text-sm"><Link href={`/time/holidays?tab=calendars&rev=${r.id}`}>{r.name} {r.year}</Link></td><td className="num">{r.version}</td><td><Pill s={r.status} /></td><td className="text-xs">{fmtDay(r.publishedAt ?? r.submittedAt ?? r.createdAt)}</td></tr>)}
                  </Table>
                </Card>
              </div>
            </div>
          </div>
        );
      })() : null}
      {tab === "rules" ? await (async () => {
        const rules = await prisma.holidayRule.findMany({ where: { tenantId: t }, orderBy: { createdAt: "desc" } });
        return (
          <div className="stack gap-4">
            <Card tight title="Holiday rules" description="Rules are approved before they take effect.">
              <Table head={["Rule", "Type", "Calendar", "Settings", "Status", ""]} empty={!rules.length}>
                {rules.map((r) => <tr key={r.id}><td className="text-sm strong">{r.name}</td><td className="text-xs">{pretty(r.kind)}</td><td className="text-sm">{r.calendarId ? calOpts.find((c) => c.value === r.calendarId)?.label : "All"}</td><td className="text-xs">{Object.entries((r.config ?? {}) as Record<string, unknown>).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join(", ")}</td><td><Pill s={r.status} /></td><td className="right"><div className="row gap-2">{r.status === "ACTIVE" && r.kind === "SUBSTITUTE_WEEKEND" ? <ActButton action={holidayRuleOpAction} hidden={{ id: r.id, op: "apply" }} label="Apply now" /> : null}{r.status === "ACTIVE" ? <ActButton action={holidayRuleOpAction} hidden={{ id: r.id, op: "retire" }} label="Retire" variant="ghost" /> : null}</div></td></tr>)}
              </Table>
            </Card>
            <div className="grid grid-2">
              <Card title="Weekend substitution" description="A public holiday on a weekly off gets a substitute working day off.">
                <SpecForm action={saveHolidayRuleAction} hidden={{ kind: "SUBSTITUTE_WEEKEND" }} columns={1} submitLabel="Send for approval" fields={[
                  { name: "name", label: "Name", required: true }, { name: "calendarId", label: "Calendar", type: "select", required: true, options: calOpts },
                  { name: "direction", label: "Substitute", type: "select", options: [{ value: "NEXT", label: "The next working day" }, { value: "PREVIOUS", label: "The previous working day" }] },
                ]} />
              </Card>
              <Card title="Holiday count limits" description="Checked when a calendar version is submitted.">
                <SpecForm action={saveHolidayRuleAction} hidden={{ kind: "COUNT_LIMIT" }} columns={1} submitLabel="Send for approval" fields={[
                  { name: "name", label: "Name", required: true }, { name: "calendarId", label: "Calendar", type: "select", options: calOpts, placeholder: "All calendars" },
                  { name: "min", label: "At least (public)", type: "number" }, { name: "max", label: "At most (public)", type: "number" }, { name: "maxOptional", label: "At most (optional)", type: "number" },
                ]} />
              </Card>
            </div>
          </div>
        );
      })() : null}
      {tab === "daytypes" ? (
        <div className="grid grid-2">
          <Card tight title="Custom event day types">
            <Table head={["Code", "Name", "Colour", "Status", ""]} empty={!dayTypes.length}>
              {dayTypes.map((d) => <tr key={d.id}><td className="text-sm strong">{d.code}</td><td className="text-sm">{d.name}{d.description ? <div className="text-xs subtle">{d.description}</div> : null}</td><td>{d.color ? <span style={{ display: "inline-block", width: 16, height: 16, borderRadius: 4, background: d.color }} /> : null}</td><td>{d.isActive ? <Badge tone="success">active</Badge> : <Badge>retired</Badge>}</td><td className="right"><ActButton action={saveDayTypeAction} hidden={{ code: d.code, op: "toggle" }} label={d.isActive ? "Retire" : "Restore"} variant="ghost" /></td></tr>)}
            </Table>
          </Card>
          <Card title="Add or edit a day type" description="e.g. FESTIVAL, NATIONAL, COMPANY_EVENT. Shutdown and substitute days use SHUTDOWN and SUBSTITUTE.">
            <SpecForm action={saveDayTypeAction} columns={1} fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "color", label: "Colour", placeholder: "#1f6feb" }, { name: "description", label: "Description" }]} />
          </Card>
        </div>
      ) : null}
      {tab === "shutdowns" ? await (async () => {
        const rows = await prisma.shutdownPeriod.findMany({ where: { tenantId: t }, orderBy: { fromDate: "desc" } });
        return (
          <div className="stack gap-4">
            <Card title="Plan a company shutdown" description="Applying it adds its working days to the calendar as SHUTDOWN holidays.">
              <SpecForm action={saveShutdownAction} submitLabel="Save" fields={[{ name: "name", label: "Name", required: true }, { name: "calendarId", label: "Calendar", type: "select", required: true, options: calOpts }, { name: "fromDate", label: "From", type: "date", required: true }, { name: "toDate", label: "To", type: "date", required: true }, { name: "reason", label: "Reason", wide: true }]} />
            </Card>
            <Card tight title="Shutdowns">
              <Table head={["Shutdown", "Calendar", "Dates", "Days added", "Status", ""]} empty={!rows.length}>
                {rows.map((r) => <tr key={r.id}><td className="text-sm strong">{r.name}</td><td className="text-sm">{calOpts.find((c) => c.value === r.calendarId)?.label}</td><td className="text-sm">{fmtDay(r.fromDate)} – {fmtDay(r.toDate)}</td><td className="num">{r.holidaysAdded}</td><td><Pill s={r.status} /></td><td className="right"><div className="row gap-2">{r.status === "DRAFT" ? <ActButton action={shutdownOpAction} hidden={{ id: r.id, op: "apply" }} label="Apply" variant="primary" /> : null}{r.status !== "CANCELLED" ? <ActButton action={shutdownOpAction} hidden={{ id: r.id, op: "cancel" }} label="Cancel" variant="ghost" /> : null}</div></td></tr>)}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "exceptions" ? await (async () => {
        const rows = await prisma.calendarException.findMany({ where: { tenantId: t }, orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }] });
        return (
          <Card tight title="Calendar exception queue" description="Holidays on weekly offs, duplicate dates, overlapping regions, missing defaults and people with no calendar. Refreshed nightly."
            action={<ActButton action={syncCalendarExceptionsAction} hidden={{}} label="Run checks now" />}>
            <Table head={["Found", "Type", "Detail", "Status", ""]} empty={!rows.length}>
              {rows.map((x) => <tr key={x.id}><td className="text-xs">{fmtDay(x.firstSeenAt)}</td><td><Badge>{pretty(x.kind)}</Badge></td><td className="text-sm">{x.summary}{x.note ? <div className="text-xs subtle">{x.note}</div> : null}</td><td><Pill s={x.status} /></td><td className="right">{x.status === "OPEN" ? <div className="row gap-2"><ActButton action={calendarExceptionOpAction} hidden={{ id: x.id, op: "resolve" }} label="Resolved" /><ActButton action={calendarExceptionOpAction} hidden={{ id: x.id, op: "dismiss" }} label="Ignore" variant="ghost" input={{ name: "note", placeholder: "Why", required: true }} /></div> : <ActButton action={calendarExceptionOpAction} hidden={{ id: x.id, op: "reopen" }} label="Reopen" variant="ghost" />}</td></tr>)}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "assignment" ? await (async () => {
        const res = (await calendarResolution(t)).filter((r) => matches(sp.q, r.name, r.number, r.location, r.how));
        const emps = await prisma.employee.findMany({ where: { tenantId: t, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" } });
        return (
          <div className="stack gap-4">
            <Card title="Assign a calendar" description="Assignment rules: an assigned calendar wins, then a calendar covering the employee's location, then the default. Assignments are approved before they apply.">
              <SpecForm action={proposeCalendarAssignmentAction} submitLabel="Send for approval" fields={[
                { name: "calendarId", label: "Calendar", type: "select", required: true, options: calOpts },
                { name: "effectiveFrom", label: "From", type: "date", defaultValue: iso(today) },
                { name: "locationId", label: "Everyone at", type: "select", options: locOpts, placeholder: "Pick people instead" },
                { name: "reason", label: "Reason" },
                { name: "employeeIds", label: "Or these people", type: "multiselect", options: emps.map((e) => ({ value: e.id, label: `${e.employeeNumber} · ${e.displayName}` })), wide: true },
              ]} />
            </Card>
            <Card tight title="Who gets which calendar">
              <div style={{ padding: "12px 16px 0" }}><SearchBar action="/time/holidays" tab="assignment" q={sp.q} /></div>
              <Table head={["Employee", "Location", "Resolved by", "Calendars"]} empty={!res.length}>
                {res.map((r) => <tr key={r.employeeId}><td className="text-sm">{r.number} · {r.name}</td><td className="text-sm">{r.location}</td><td><Badge tone={r.how === "NONE" ? "danger" : r.how === "ASSIGNED" ? "info" : "neutral"}>{pretty(r.how)}</Badge></td><td className="text-xs">{r.calendars.join(", ") || "—"}</td></tr>)}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "history" ? await (async () => {
        const rows = await prisma.auditLog.findMany({ where: { tenantId: t, entityType: { in: ["Holiday", "HolidayCalendar", "HolidayCalendarRevision", "HolidayRule", "HolidayDayType", "ShutdownPeriod", "CalendarException", "TimeConfigChange", "OptionalHolidayQuota"] } }, orderBy: { createdAt: "desc" }, take: 300 });
        return (
          <Card tight title="Calendar change history" description="Every holiday, calendar, rule and assignment change">
            <Table head={["When", "By", "Action", "Record", "Change"]} empty={!rows.length}>
              {rows.map((r) => <tr key={r.id}><td className="text-xs nowrap">{fmtTime(r.createdAt)}</td><td className="text-xs">{r.actorLabel}</td><td><Badge>{r.action.toLowerCase()}</Badge></td><td className="text-xs">{r.entityType}</td><td className="text-sm">{r.summary}</td></tr>)}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "settings" ? await (async () => {
        const s = await joinSettings(t);
        return (
          <Card title="Holiday count validation" description="0 means no limit. A COUNT_LIMIT rule overrides these for its calendar.">
            <SpecForm action={saveJoinSettingsAction} hidden={{ scope: "holiday" }} fields={[{ name: "holidayMinCount", label: "At least (public holidays)", type: "number", defaultValue: s.holidayMinCount }, { name: "holidayMaxCount", label: "At most (public holidays)", type: "number", defaultValue: s.holidayMaxCount }]} />
          </Card>
        );
      })() : null}
      {tab === "reports" ? (
        <Card title="Reports and exports" description="CSV downloads; each export is recorded in the audit log.">
          <div className="stack gap-2">
            {cals.map((c) => <div key={c.id} className="row gap-2"><a className="btn sm" href={`/time/ops-export?kind=holidays&calendarId=${c.id}`}>Download</a><span className="text-sm">Holidays — {c.name} ({c.year})</span></div>)}
            {[["holidays", "Holidays — every calendar"], ["calendars", "Calendars and their regions"], ["holiday-rules", "Holiday rules"], ["calendar-assignments", "Calendar assignment by employee"], ["calendar-history", "Calendar change history"]].map(([k, label]) => <div key={k} className="row gap-2"><a className="btn sm" href={`/time/ops-export?kind=${k}`}>Download</a><span className="text-sm">{label}</span></div>)}
          </div>
        </Card>
      ) : null}
    </>
  );
}
