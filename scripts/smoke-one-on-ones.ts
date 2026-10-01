/**
 * 1:1 meetings: a manager schedules a repeating 1:1 with a report (but not
 * with someone outside their line); both participants share the agenda,
 * talking points, notes and action items, while outsiders get nothing and a
 * private note stays its author's; an action item can only be owned by
 * someone in the meeting; a 1:1 is completed once started; only the
 * organiser cancels, optionally the rest of the series. Meetings are titled
 * "Smoke 1:1" and removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const a = await import("../apps/web/src/app/actions/performance-one-on-ones");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: `${n}@acme.test` } } });
  const [meera, ananya] = await Promise.all([emp("meera.krishnan"), emp("ananya.ghosh")]);
  // Someone neither in Ananya's reporting line nor her manager.
  const inLine = async (id: string) => { for (let cur: string | null = id, n = 0; cur && n < 10; n++) { const e: { reportingManagerId: string | null } = await prisma.employee.findUniqueOrThrow({ where: { id: cur }, select: { reportingManagerId: true } }); if (e.reportingManagerId === ananya.id) return true; cur = e.reportingManagerId; } return false; };
  let outsider = await emp("aditya.verma");
  for (const n of ["aditya.verma", "rahul.kapoor", "manish.tiwari", "priya.sharma", "varun.rathore"]) {
    const e = await emp(n);
    if (e.id !== ananya.reportingManagerId && !(await inLine(e.id))) { outsider = e; break; }
  }
  const outsiderEmail = (await prisma.user.findUniqueOrThrow({ where: { id: outsider.userId! } })).email;
  const started = new Date();
  const cleanup = async () => {
    await prisma.meeting.deleteMany({ where: { tenantId: tenant.id, title: "Smoke 1:1" } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, kind: "PERFORMANCE", createdAt: { gte: started } } });
  };
  await cleanup();
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const form = (employeeId: string) => fd({ employeeId, title: "Smoke 1:1", date: day, startTime: "09:00", endTime: "09:30", recurrence: "WEEKLY", location: "VIRTUAL", meetingUrl: "https://meet.example.test/smoke", purpose: "Weekly check-in", agenda: "Wins\nBlockers" });
  try {
    section("Scheduling");
    await signInAs("ananya.ghosh@acme.test");
    const outside = await a.scheduleOneOnOneAction({}, form(outsider.id));
    check("A manager cannot schedule a 1:1 outside their line", outside.ok === false, outside.message);
    const noLink = await a.scheduleOneOnOneAction({}, fd({ employeeId: meera.id, title: "Smoke 1:1", date: day, startTime: "09:00", endTime: "09:30", location: "VIRTUAL" }));
    check("A video 1:1 needs an https link", noLink.ok === false);
    const made = await a.scheduleOneOnOneAction({}, form(meera.id));
    const series = await prisma.meeting.findMany({ where: { tenantId: tenant.id, title: "Smoke 1:1" }, orderBy: { startsAt: "asc" }, include: { attendees: true } });
    check("A weekly 1:1 creates a series with both people", made.ok && series.length > 1 && series.every((m) => m.seriesId && m.attendees.some((x) => x.employeeId === meera.id)), made.message);
    const first = series[0]!;

    section("Shared workspace");
    await signInAs("meera.krishnan@acme.test");
    const tp = await a.addTalkingPointAction({}, fd({ meetingId: first.id, text: "Promotion timeline" }));
    check("The report adds a talking point", tp.ok, tp.message);
    const priv = await a.savePrivateNoteAction({}, fd({ meetingId: first.id, body: "Ask about the Bangalore move" }));
    check("…and keeps a private note", priv.ok && (await prisma.meetingPrivateNote.count({ where: { meetingId: first.id, authorId: meera.id } })) === 1);
    await signInAs(outsiderEmail);
    const intruder = await a.addTalkingPointAction({}, fd({ meetingId: first.id, text: "Hello" }));
    const peek = await a.saveSharedNotesAction({}, fd({ meetingId: first.id, minutes: "x" }));
    check("Someone outside the 1:1 can do nothing in it", intruder.ok === false && peek.ok === false);
    await signInAs("ananya.ghosh@acme.test");
    const notes = await a.saveSharedNotesAction({}, fd({ meetingId: first.id, minutes: "Agreed to revisit in Q3" }));
    check("The manager saves shared notes", notes.ok && (await prisma.meeting.findUniqueOrThrow({ where: { id: first.id } })).minutes === "Agreed to revisit in Q3");
    const badOwner = await a.addOneOnOneActionItemAction({}, fd({ meetingId: first.id, description: "Draft plan", ownerId: outsider.id }));
    check("An action item's owner must be in the 1:1", badOwner.ok === false, badOwner.message);
    const item = await a.addOneOnOneActionItemAction({}, fd({ meetingId: first.id, description: "Draft growth plan", ownerId: meera.id }));
    const told = await prisma.notification.findFirst({ where: { userId: meera.userId!, title: { contains: "action item" }, createdAt: { gte: started } } });
    check("Assigning an action item tells its owner", item.ok && !!told, item.message);
    const tpRow = await prisma.meetingTalkingPoint.findFirstOrThrow({ where: { meetingId: first.id } });
    const del = await a.toggleTalkingPointAction({}, fd({ id: tpRow.id, op: "delete" }));
    check("Only the author can remove a talking point", del.ok === false);
    const tick = await a.toggleTalkingPointAction({}, fd({ id: tpRow.id, op: "toggle" }));
    check("Either person can mark it discussed", tick.ok && (await prisma.meetingTalkingPoint.findUniqueOrThrow({ where: { id: tpRow.id } })).isDone);

    section("Completing and cancelling");
    const early = await a.completeOneOnOneAction({}, fd({ meetingId: first.id }));
    check("A 1:1 cannot be completed before it starts", early.ok === false, early.message);
    await prisma.meeting.update({ where: { id: first.id }, data: { startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() - 1_800_000) } });
    const done = await a.completeOneOnOneAction({}, fd({ meetingId: first.id }));
    check("Once started it can be completed", done.ok && (await prisma.meeting.findUniqueOrThrow({ where: { id: first.id } })).status === "COMPLETED", done.message);
    const second = series[1]!;
    await signInAs("meera.krishnan@acme.test");
    const notOrganiser = await a.cancelOneOnOneAction({}, fd({ meetingId: second.id, scope: "series" }));
    check("Only the organiser can cancel", notOrganiser.ok === false);
    const itemRow = await prisma.meetingActionItem.findFirstOrThrow({ where: { meetingId: first.id } });
    const finished = await a.toggleOneOnOneActionItemAction({}, fd({ id: itemRow.id }));
    check("The owner ticks off their action item", finished.ok && (await prisma.meetingActionItem.findUniqueOrThrow({ where: { id: itemRow.id } })).status === "DONE");
    await signInAs("ananya.ghosh@acme.test");
    const cancelled = await a.cancelOneOnOneAction({}, fd({ meetingId: second.id, scope: "series" }));
    const left = await prisma.meeting.count({ where: { tenantId: tenant.id, title: "Smoke 1:1", status: "SCHEDULED" } });
    check("Cancelling the series cancels every later meeting", cancelled.ok && left === 0 && /5 meetings/.test(cancelled.message ?? ""), cancelled.message);
  } finally {
    await cleanup();
  }
}

main().then(() => report("1:1 meetings")).catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
