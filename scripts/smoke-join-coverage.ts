/**
 * Coverage for the time and onboarding flows that predate the join-depth work
 * and had no test, through their actions and pages:
 *   1. Shift change and weekly-off requests: raise, approve (roster updated),
 *      reject with a note, withdraw.
 *   2. Overtime requests: raise, view, approve into payroll, withdraw, export.
 *   3. Holidays: add / remove a holiday and create a calendar (each audited),
 *      the upcoming-holiday dashboard.
 *   4. Holiday calendar on the time-policy assignment: set, keep, clear.
 *   5. Shifts: saving a shift is audited and exported.
 *   6. Onboarding templates scoped by department and location, journeys
 *      started from them (audited), the onboarding and preboarding pages.
 *
 * Everything it creates is tagged "Smoke JC" or restored at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const TAG = "Smoke JC";
type AS = { ok?: boolean; message?: string };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utcToday = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

async function main() {
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  async function resolve(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) return Promise.all(node.map(resolve));
    if (node instanceof Promise) return resolve(await node);
    if (!React.isValidElement(node)) return node;
    const el = node as React.ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolve(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    const props: Record<string, unknown> = {};
    let children: unknown = undefined;
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k === "children") children = await resolve(v);
      else props[k] = React.isValidElement(v) ? await resolve(v) : v;
    }
    if (children === undefined) return React.cloneElement(el, props as never);
    return Array.isArray(children) ? React.cloneElement(el, props as never, ...(children as React.ReactNode[])) : React.cloneElement(el, props as never, children as React.ReactNode);
  }
  const html = async (page: unknown) => renderToStaticMarkup((await resolve(await page)) as Parameters<typeof renderToStaticMarkup>[0]);
  const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

  const tr = await import("../apps/web/src/app/actions/time-requests");
  const time = await import("../apps/web/src/app/actions/time");
  const lc = await import("../apps/web/src/app/actions/lifecycle");
  const svc = await import("@keka/services");
  const { NextRequest } = await import("next/server");
  const opsExport = await import("../apps/web/src/app/(app)/time/ops-export/route");
  const MyShifts = (await import("../apps/web/src/app/(app)/me/shifts/page")).default;
  const Holidays = (await import("../apps/web/src/app/(app)/time/holidays/page")).default;
  const Onboarding = (await import("../apps/web/src/app/(app)/onboarding/page")).default;
  const Preboarding = (await import("../apps/web/src/app/(app)/onboarding/preboarding/page")).default;
  const JourneyPage = (await import("../apps/web/src/app/(app)/onboarding/[id]/page")).default;

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const emp = (who: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: t, user: { email: `${who}@acme.test` } } });
  const as = (who: string) => signInAs(`${who}@acme.test`);
  const ok = (label: string, r: AS) => { check(label, !!r.ok, r.message ?? ""); return !!r.ok; };
  const refused = (label: string, r: AS, needle?: RegExp) => check(label, !r.ok && (!needle || needle.test(r.message ?? "")), r.message ?? "");
  const csvOps = async (q: string) => { const r = await opsExport.GET(new NextRequest(`http://acme.localhost/time/ops-export?${q}`)); return { status: r.status, body: await r.text() }; };
  async function render(label: string, page: unknown, needle?: string | RegExp): Promise<string> {
    try {
      const out = await html(page);
      check(label, needle === undefined || (typeof needle === "string" ? out.includes(needle) : needle.test(out)), needle ? `looking for ${needle}` : "");
      return out;
    } catch (e) { check(label, false, (e as Error).message.slice(0, 200)); return ""; }
  }
  const audited = async (entityType: string, since: Date, like?: string) => (await prisma.auditLog.count({ where: { tenantId: t, entityType, createdAt: { gte: since }, ...(like ? { summary: { contains: like } } : {}) } })) > 0;

  const divya = await emp("divya.pillai"), sanjay = await emp("sanjay.gupta"), nikhil = await emp("nikhil.joshi");
  const startedAt = new Date();
  const shifts = new Map((await prisma.shift.findMany({ where: { tenantId: t } })).map((s) => [s.code, s]));
  const NIGHT = shifts.get("NIGHT")!;
  const winFrom = new Date(utcToday().getTime() + 55 * DAY), winTo = new Date(utcToday().getTime() + 60 * DAY);
  const rosterBefore = await prisma.shiftAssignment.findMany({ where: { employeeId: { in: [divya.id, sanjay.id] }, date: { gte: winFrom, lte: winTo } } });
  const otBefore = await prisma.overtimeEntry.findMany({ where: { tenantId: t, employeeId: divya.id } });
  const balBefore = await prisma.leaveBalance.findMany({ where: { employeeId: divya.id } });
  const policyBefore = await prisma.employeeTimePolicy.findMany({ where: { employeeId: sanjay.id } });
  const createdJourneys: string[] = [];

  try {
    section("1. Shift change and weekly-off requests");
    await as("divya.pillai");
    ok("an employee asks for a different shift", await tr.raiseShiftRequestAction({}, fd({ kind: "SHIFT_CHANGE", fromDate: iso(winFrom), shiftId: NIGHT.id, reason: `${TAG} night cover` })));
    const sr = await prisma.shiftRequest.findFirstOrThrow({ where: { tenantId: t, employeeId: divya.id, reason: `${TAG} night cover` } });
    refused("a second request over the same dates is refused", await tr.raiseShiftRequestAction({}, fd({ kind: "SHIFT_CHANGE", fromDate: iso(winFrom), shiftId: NIGHT.id, reason: `${TAG} again` })), /already/);
    await render("the request appears under My Shifts", MyShifts({ searchParams: sp({ tab: "requests" }) }), `${TAG} night cover`);
    await as("sanjay.gupta");
    refused("a colleague cannot approve it", await tr.decideTimeRequestAction({}, fd({ entity: "ShiftRequest", requestId: sr.id, decision: "approve" })));
    await as("sneha.reddy");
    ok("the manager approves", await tr.decideTimeRequestAction({}, fd({ entity: "ShiftRequest", requestId: sr.id, decision: "approve" })));
    check("the roster carries the new shift", (await svc.rosterGrid([divya.id], winFrom, 1)).get(divya.id)?.[0]?.shiftId === NIGHT.id);
    await as("divya.pillai");
    ok("asks for a weekly off", await tr.raiseShiftRequestAction({}, fd({ kind: "WEEKLY_OFF", fromDate: iso(new Date(winFrom.getTime() + 2 * DAY)), reason: `${TAG} weekly off` })));
    const wo = await prisma.shiftRequest.findFirstOrThrow({ where: { tenantId: t, employeeId: divya.id, reason: `${TAG} weekly off` } });
    await as("sneha.reddy");
    refused("rejecting needs a note", await tr.decideTimeRequestAction({}, fd({ entity: "ShiftRequest", requestId: wo.id, decision: "reject" })));
    ok("the manager rejects with a note", await tr.decideTimeRequestAction({}, fd({ entity: "ShiftRequest", requestId: wo.id, decision: "reject", note: "Short-staffed" })));
    check("the request is rejected", (await prisma.shiftRequest.findUniqueOrThrow({ where: { id: wo.id } })).status === "REJECTED");
    await as("divya.pillai");
    ok("raises another", await tr.raiseShiftRequestAction({}, fd({ kind: "WEEKLY_OFF", fromDate: iso(new Date(winFrom.getTime() + 4 * DAY)), reason: `${TAG} withdraw me` })));
    const wd = await prisma.shiftRequest.findFirstOrThrow({ where: { tenantId: t, employeeId: divya.id, reason: `${TAG} withdraw me` } });
    ok("and withdraws it", await tr.withdrawTimeRequestAction({}, fd({ entity: "ShiftRequest", requestId: wd.id })));
    check("the request is withdrawn", ["WITHDRAWN", "CANCELLED"].includes((await prisma.shiftRequest.findUniqueOrThrow({ where: { id: wd.id } })).status));
    check("each step is in the audit log", await audited("ShiftRequest", startedAt));
    await as("priya.sharma");
    const sx = await csvOps("kind=shift-requests");
    check("shift requests export with their outcome", sx.status === 200 && sx.body.includes(`${TAG} night cover`) && sx.body.includes("APPROVED"));

    section("2. Overtime requests");
    await as("divya.pillai");
    refused("hours must be hh:mm", await tr.raiseOvertimeAction({}, fd({ fromDate: iso(new Date(utcToday().getTime() - DAY)), hours: "abc", note: TAG })));
    ok("an employee claims overtime for yesterday", await tr.raiseOvertimeAction({}, fd({ fromDate: iso(new Date(utcToday().getTime() - DAY)), hours: "01:30", note: TAG })));
    const otr = await prisma.overtimeRequest.findFirstOrThrow({ where: { tenantId: t, employeeId: divya.id, note: TAG }, orderBy: { createdAt: "desc" } });
    check("it is pending for 90 minutes", otr.status === "PENDING" && otr.requestedMinutes === 90);
    await render("it appears under My Shifts", MyShifts({ searchParams: sp({ tab: "requests" }) }), /1:30|01:30|90/);
    await as("sneha.reddy");
    ok("the manager approves it", await tr.decideTimeRequestAction({}, fd({ entity: "OvertimeRequest", requestId: otr.id, decision: "approve" })));
    const otAfter = await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: otr.id } });
    check("the request is approved (paid or converted)", otAfter.status === "APPROVED");
    await as("divya.pillai");
    ok("claims another", await tr.raiseOvertimeAction({}, fd({ fromDate: iso(new Date(utcToday().getTime() - 2 * DAY)), hours: "00:45", note: TAG })));
    const ot2 = await prisma.overtimeRequest.findFirstOrThrow({ where: { tenantId: t, employeeId: divya.id, note: TAG, status: "PENDING" } });
    ok("and withdraws it", await tr.withdrawTimeRequestAction({}, fd({ entity: "OvertimeRequest", requestId: ot2.id })));
    check("overtime requests are audited", await audited("OvertimeRequest", startedAt));
    await as("priya.sharma");
    const ox = await csvOps("kind=overtime-requests");
    check("overtime requests export", ox.status === 200 && ox.body.includes(divya.displayName ?? "~"));
    await as("divya.pillai");
    check("an employee cannot export overtime", (await csvOps("kind=overtime-requests")).status === 403);

    section("3. Holidays and calendars (existing admin)");
    await as("priya.sharma");
    const year = new Date().getUTCFullYear() + 4;
    const live = await prisma.holidayCalendar.findFirstOrThrow({ where: { tenantId: t, isDefault: true } });
    ok("HR creates a calendar copying the default", await time.addHolidayCalendar({}, fd({ name: `${TAG} calendar`, year, copyFromId: live.id })));
    const cal = await prisma.holidayCalendar.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} calendar` } });
    check("creating a calendar is audited", await audited("HolidayCalendar", startedAt, TAG));
    ok("adds a holiday", await time.addHoliday({}, fd({ calendarId: cal.id, name: `${TAG} founders day`, date: `${year}-08-01`, description: "Company day" })));
    const h = await prisma.holiday.findFirstOrThrow({ where: { calendarId: cal.id, name: `${TAG} founders day` } });
    check("adding a holiday is audited", await audited("Holiday", startedAt, "founders day"));
    ok("removes it", await time.deleteHoliday({}, fd({ id: h.id })));
    check("removing a holiday is audited", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "Holiday", action: "DELETE", entityId: h.id } })) === 1);
    const nextLive = await prisma.holiday.findFirst({ where: { calendar: { tenantId: t }, date: { gte: utcToday(), lte: new Date(Date.now() + 90 * DAY) } }, orderBy: { date: "asc" } });
    await render("the upcoming-holiday dashboard renders", Holidays({ searchParams: sp({ tab: "upcoming" }) }), nextLive ? nextLive.name : "Upcoming holidays");
    await as("divya.pillai");
    const denied = await time.addHoliday({}, fd({ calendarId: cal.id, name: "x", date: `${year}-08-02` })).catch((e: Error) => ({ ok: false, message: e.message }));
    refused("an employee cannot add holidays", denied);

    section("4. Holiday calendar on a time-policy assignment");
    await as("priya.sharma");
    ok("assigns a policy with a holiday calendar", await time.assignTimePolicy({}, fd({ employeeIds: sanjay.id, holidayCalendarId: cal.id, trackAttendance: true, effectiveFrom: iso(new Date(utcToday().getTime() + DAY)) })));
    const p1 = await prisma.employeeTimePolicy.findFirstOrThrow({ where: { employeeId: sanjay.id, effectiveTo: null }, orderBy: { createdAt: "desc" } });
    check("the calendar is on the policy", p1.holidayCalendarId === cal.id);
    ok("re-assigns without choosing a calendar", await time.assignTimePolicy({}, fd({ employeeIds: sanjay.id, trackAttendance: true, effectiveFrom: iso(new Date(utcToday().getTime() + 2 * DAY)) })));
    check("the calendar is kept", (await prisma.employeeTimePolicy.findFirstOrThrow({ where: { employeeId: sanjay.id, effectiveTo: null }, orderBy: { createdAt: "desc" } })).holidayCalendarId === cal.id);
    ok("clears it", await time.assignTimePolicy({}, fd({ employeeIds: sanjay.id, holidayCalendarId: "NONE", trackAttendance: true, effectiveFrom: iso(new Date(utcToday().getTime() + 3 * DAY)) })));
    check("the calendar is cleared", (await prisma.employeeTimePolicy.findFirstOrThrow({ where: { employeeId: sanjay.id, effectiveTo: null }, orderBy: { createdAt: "desc" } })).holidayCalendarId === null);
    refused("an unknown calendar is refused", await time.assignTimePolicy({}, fd({ employeeIds: sanjay.id, holidayCalendarId: "nope" })), /not found/);
    check("the assignment is audited", await audited("EmployeeTimePolicy", startedAt, "holiday calendar"));

    section("5. Shifts");
    ok("HR saves a shift", await time.saveShift({}, fd({ name: `${TAG} late`, code: "SMKJC", startTime: "12:00", endTime: "21:00", breakMinutes: 60 })));
    check("saving a shift is audited", await audited("Shift", startedAt, TAG));
    const shx = await csvOps("kind=shifts");
    check("shift definitions export", shx.status === 200 && shx.body.includes("SMKJC"));

    section("6. Onboarding templates by department and location");
    ok("HR creates a department + location template", await lc.saveTemplateAction({}, fd({ name: `${TAG} dept path`, trigger: "PROMOTION", departmentId: nikhil.departmentId ?? "", locationId: nikhil.locationId ?? "", isActive: true })));
    ok("and a company-wide one", await lc.saveTemplateAction({}, fd({ name: `${TAG} generic path`, trigger: "PROMOTION", isActive: true })));
    const dept = await prisma.journeyTemplate.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} dept path` } });
    const gen = await prisma.journeyTemplate.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} generic path` } });
    for (const tp of [dept, gen]) ok(`adds a task to ${tp.name}`, await lc.addTemplateTaskAction({}, fd({ templateId: tp.id, title: `${TAG} task for ${tp.name}`, owner: "HR", offsetDays: 0, category: "OTHER", isRequired: true })));
    ok("starts a journey for someone in that department and location", await lc.startJourneyAction({}, fd({ employeeId: nikhil.id, trigger: "PROMOTION", anchorDate: iso(utcToday()) })));
    const jn = await prisma.journey.findFirstOrThrow({ where: { tenantId: t, employeeId: nikhil.id, trigger: "PROMOTION" }, orderBy: { createdAt: "desc" } });
    createdJourneys.push(jn.id);
    check("the most specific template is used", jn.templateId === dept.id);
    ok("and for someone elsewhere", await lc.startJourneyAction({}, fd({ employeeId: divya.id, trigger: "PROMOTION", anchorDate: iso(utcToday()) })));
    const jd = await prisma.journey.findFirstOrThrow({ where: { tenantId: t, employeeId: divya.id, trigger: "PROMOTION" }, orderBy: { createdAt: "desc" } });
    createdJourneys.push(jd.id);
    check("a department template is not used outside its department", jd.templateId !== dept.id && !!jd.templateId);
    check("starting a journey is audited", await audited("Journey", startedAt));
    await render("the journey page renders", JourneyPage({ params: Promise.resolve({ id: jn.id }) }), `${TAG} task for`);
    await render("the onboarding page lists the templates", Onboarding({ searchParams: sp({ tab: "templates" }) }), `${TAG} dept path`);
    await render("the preboarding overview renders with its navigation", Preboarding(), "Preboarding desk");
  } finally {
    section("Cleanup");
    const since = { gte: startedAt };
    await prisma.shiftAssignment.deleteMany({ where: { employeeId: { in: [divya.id, sanjay.id] }, date: { gte: winFrom, lte: winTo } } });
    if (rosterBefore.length) await prisma.shiftAssignment.createMany({ data: rosterBefore });
    await prisma.shiftRequest.deleteMany({ where: { tenantId: t, reason: { startsWith: TAG } } });
    const reqs = await prisma.overtimeRequest.findMany({ where: { tenantId: t, note: TAG }, select: { id: true } });
    await prisma.leaveLedgerEntry.deleteMany({ where: { tenantId: t, requestId: { in: reqs.map((r) => r.id) } } });
    for (const b of balBefore) { const { id, updatedAt: _u, ...rest } = b; await prisma.leaveBalance.update({ where: { id }, data: rest }); }
    await prisma.overtimeRequest.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } });
    const keepOt = new Set(otBefore.map((o) => o.id));
    await prisma.overtimeEntry.deleteMany({ where: { tenantId: t, employeeId: divya.id, id: { notIn: [...keepOt] } } });
    for (const o of otBefore) await prisma.overtimeEntry.update({ where: { id: o.id }, data: { hours: o.hours, amount: o.amount, rate: o.rate } });
    const keepPol = new Set(policyBefore.map((p) => p.id));
    await prisma.employeeTimePolicy.deleteMany({ where: { employeeId: sanjay.id, id: { notIn: [...keepPol] } } });
    for (const p of policyBefore) await prisma.employeeTimePolicy.update({ where: { id: p.id }, data: { effectiveTo: p.effectiveTo, holidayCalendarId: p.holidayCalendarId } });
    await prisma.holidayCalendar.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.shift.deleteMany({ where: { tenantId: t, code: "SMKJC" } });
    await prisma.journey.deleteMany({ where: { id: { in: createdJourneys } } });
    const tpls = await prisma.journeyTemplate.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
    await prisma.journeyTemplateRevision.deleteMany({ where: { tenantId: t, templateId: { in: tpls.map((x) => x.id) } } });
    await prisma.journeyTemplate.deleteMany({ where: { id: { in: tpls.map((x) => x.id) } } });
    await prisma.notification.deleteMany({ where: { tenantId: t, createdAt: since } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: t, createdAt: since } }).catch(() => undefined);
    check("cleanup finished", true);
    await prisma.$disconnect();
  }
  report("smoke-join-coverage");
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
