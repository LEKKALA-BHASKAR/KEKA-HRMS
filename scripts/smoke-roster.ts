/**
 * Shift rostering through the actions: create a rotating pattern, apply it to
 * two employees with a stagger, override single days on the week grid, roster
 * a working day onto a pattern weekly-off, copy a week forward, and the scope
 * and validation guards. Attendance for a past rostered day is reprocessed
 * against the rostered shift.
 *
 * Uses a night shift "SMKN" and a pattern "Smoke rotation", and roster days in
 * December 2026 plus one past day; everything is removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function main() {
  const act = await import("../apps/web/src/app/actions/roster");
  const { rosterGrid, processAttendance } = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email } } });
  const meera = await emp("meera.krishnan@acme.test");
  const priya = await emp("priya.sharma@acme.test");
  const ids = [meera.id, priya.id];
  const since = new Date();
  const general = await prisma.shift.findFirstOrThrow({ where: { tenantId: tenant.id, isActive: true }, orderBy: { createdAt: "asc" } });
  // A past Sunday inside the attendance window, for the reprocess check.
  const past = new Date(Date.now() - 14 * 86_400_000);
  past.setUTCDate(past.getUTCDate() - past.getUTCDay());
  const pastKey = past.toISOString().slice(0, 10);
  const pastDate = d(pastKey);
  const cleanup = async () => {
    await prisma.shiftAssignment.deleteMany({ where: { employeeId: { in: ids }, OR: [{ date: { gte: d("2026-11-30"), lte: d("2027-01-10") } }, { date: pastDate }] } });
    await prisma.rosterPattern.deleteMany({ where: { tenantId: tenant.id, name: "Smoke rotation" } });
    await prisma.shift.deleteMany({ where: { tenantId: tenant.id, code: "SMKN" } });
  };
  await cleanup();
  const night = await prisma.shift.create({ data: { tenantId: tenant.id, name: "Smoke night", code: "SMKN", startTime: "22:00", endTime: "06:00", crossesMidnight: true, breakMinutes: 30 } });

  try {
    await signInAs("vikram.menon@acme.test");

    // -----------------------------------------------------------------
    section("Rotating patterns");
    const empty = await act.savePatternAction({}, fd({ name: "Smoke rotation" }));
    check("A pattern needs at least one day", empty.ok !== true, empty.message);
    const gap = await act.savePatternAction({}, fd({ name: "Smoke rotation", step0: general.id, step1: "", step2: "OFF" }));
    check("Gaps in the cycle are refused", gap.ok !== true, gap.message);
    const saved = await act.savePatternAction({}, fd({ name: "Smoke rotation", step0: general.id, step1: general.id, step2: night.id, step3: night.id, step4: "OFF", step5: "", step6: "" }));
    check("A 5-day cycle is saved, trailing blanks dropped", saved.ok === true && /5-day/.test(saved.message ?? ""), saved.message);
    const pattern = await prisma.rosterPattern.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke rotation" } });

    const tooLong = await act.applyPatternAction({}, fd({ patternId: pattern.id, employeeIds: meera.id, from: "2026-12-01", to: "2027-06-01" }));
    check("More than three months at once is refused", tooLong.ok !== true, tooLong.message);
    const f = fd({ patternId: pattern.id, from: "2026-12-01", to: "2026-12-10", staggerBy: "2" });
    ids.forEach((id) => f.append("employeeIds", id));
    const applied = await act.applyPatternAction({}, f);
    check("Applied to two employees", applied.ok === true, applied.message);
    const grid = await rosterGrid(ids, d("2026-12-01"), 10);
    const m = grid.get(meera.id)!, p = grid.get(priya.id)!;
    check("Meera starts the cycle on day 1", m[0].shiftId === general.id && m[2].shiftId === night.id && m[4].off, m.map((c) => (c.off ? "OFF" : c.shiftId === night.id ? "N" : "G")).join(""));
    check("Priya is staggered two days on", p[0].shiftId === night.id && p[2].off && p[3].shiftId === general.id, p.map((c) => (c.off ? "OFF" : c.shiftId === night.id ? "N" : "G")).join(""));
    check("The cycle repeats", m[5].shiftId === general.id && m[9].off);
    check("Every day is explicit", m.every((c) => c.explicit));

    // -----------------------------------------------------------------
    section("The week grid");
    // 2026-12-06 is a Sunday: a pattern weekly-off by default.
    const g = await act.saveRosterAction({}, fd({ [`cell:${meera.id}:2026-12-06`]: night.id, [`cell:${meera.id}:2026-12-07`]: "OFF", [`cell:${meera.id}:2026-12-08`]: "" }));
    check("Saved three cells", g.ok === true && /3 days/.test(g.message ?? ""), g.message);
    const sun = await prisma.shiftAssignment.findUnique({ where: { employeeId_date: { employeeId: meera.id, date: d("2026-12-06") } } });
    check("A shift on a pattern weekly-off is marked as a working day", sun?.weeklyOffCode === "ON" && sun.shiftId === night.id, sun?.weeklyOffCode ?? "none");
    const cleared = await prisma.shiftAssignment.findUnique({ where: { employeeId_date: { employeeId: meera.id, date: d("2026-12-08") } } });
    check("A blank cell goes back to the policy", !cleared);
    const same = await act.saveRosterAction({}, fd({ [`cell:${meera.id}:2026-12-06`]: night.id }));
    check("Saving an unchanged cell changes nothing", same.ok === true && /Nothing/.test(same.message ?? ""), same.message);
    const bad = await act.saveRosterAction({}, fd({ [`cell:${meera.id}:2026-12-06`]: "not-a-shift" }));
    check("An unknown shift is refused", bad.ok !== true, bad.message);
    const badDate = await act.saveRosterAction({}, fd({ [`cell:${meera.id}:2026-13-40`]: night.id }));
    check("A malformed date is refused", badDate.ok !== true, badDate.message);

    const cf = fd({ week: "2026-11-30" });
    ids.forEach((id) => cf.append("employeeIds", id));
    const copied = await act.copyWeekAction({}, cf);
    check("Copied a week forward", copied.ok === true, copied.message);
    const next = await prisma.shiftAssignment.findUnique({ where: { employeeId_date: { employeeId: meera.id, date: d("2026-12-13") } } });
    check("The rostered Sunday shift carried to the next Sunday", next?.shiftId === night.id && next.weeklyOffCode === "ON", next?.weeklyOffCode ?? "none");

    // -----------------------------------------------------------------
    section("Past days are reprocessed");
    const r = await act.saveRosterAction({}, fd({ [`cell:${meera.id}:${pastKey}`]: general.id }));
    check("Rostered a past Sunday as a working day", r.ok === true, r.message);
    await processAttendance({ employeeIds: [meera.id], from: pastDate, to: pastDate });
    const rec = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: meera.id, date: pastDate } } });
    check("Attendance no longer counts it as a weekly off", !!rec && rec.status !== "WEEKLY_OFF", rec?.status ?? "no record");

    // -----------------------------------------------------------------
    section("Scope");
    await signInAs("meera.krishnan@acme.test");
    let denied = false;
    try { await act.saveRosterAction({}, fd({ [`cell:${priya.id}:2026-12-09`]: night.id })); } catch (e) { denied = /403/.test((e as { digest?: string }).digest ?? ""); }
    check("An employee cannot edit the roster", denied);
  } finally {
    await cleanup();
    const pastStart = new Date(Date.UTC(past.getUTCFullYear(), past.getUTCMonth(), 1));
    await processAttendance({ employeeIds: [meera.id], from: pastStart, to: new Date(Math.min(Date.now(), Date.UTC(past.getUTCFullYear(), past.getUTCMonth() + 1, 0))) });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since }, entityType: { in: ["ShiftAssignment", "RosterPattern"] } } });
  }
  report("Shift roster");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
