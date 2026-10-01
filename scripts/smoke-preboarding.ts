/**
 * Preboarding and background checks: HR marks a hire joined (not before the
 * day, not more than a month back), which starts probation; records a
 * no-show, which exits them, disables their login and cancels open checks;
 * starts a background check (one open at a time), and closes it (a
 * discrepancy needs findings). Scoped HR cannot reach hires outside their
 * departments, and an employee cannot do any of it. Temporary hires are
 * numbered SMOKE-PB* and removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const key = (d: Date) => d.toISOString().slice(0, 10);
const today = new Date(key(new Date()) + "T00:00:00Z");

async function main() {
  const act = await import("../apps/web/src/app/actions/preboarding");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const sales = await prisma.department.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Sales" } });
  const cleanup = async () => {
    const ids = (await prisma.employee.findMany({ where: { tenantId: tenant.id, employeeNumber: { startsWith: "SMOKE-PB" } }, select: { id: true, userId: true } }));
    await prisma.bgvCheck.deleteMany({ where: { employeeId: { in: ids.map((e) => e.id) } } });
    await prisma.employee.deleteMany({ where: { id: { in: ids.map((e) => e.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: ids.map((e) => e.userId).filter((u): u is string => !!u) } } });
  };
  await cleanup();
  const hire = async (n: string, joins: Date, withUser = false) => prisma.employee.create({
    data: {
      ...(withUser ? { userId: (await prisma.user.create({ data: { tenantId: tenant.id, email: `smoke-pb${n.toLowerCase()}@acme.test`, passwordHash: "x" } })).id } : {}),
      tenantId: tenant.id, employeeNumber: `SMOKE-PB${n}`, firstName: "Smoke", lastName: `Hire ${n}`, displayName: `Smoke Hire ${n}`,
      dateOfJoining: joins, status: "PREBOARDING", departmentId: sales.id,
    },
  });
  try {
    const future = await hire("1", new Date(today.getTime() + 5 * DAY));
    const due = await hire("2", new Date(today.getTime() - 2 * DAY));
    const noShow = await hire("3", new Date(today.getTime() + 3 * DAY), true);

    section("Access");
    await signInAs("meera.krishnan@acme.test");
    let threw = false;
    try { await act.markJoinedAction({}, fd({ employeeId: due.id, joinedOn: key(today) })); } catch { threw = true; }
    check("An employee cannot mark anyone joined", threw);
    await signInAs("deepak.chauhan@acme.test");
    const scoped = await act.markJoinedAction({}, fd({ employeeId: due.id, joinedOn: key(today) }));
    check("Scoped HR cannot reach a hire outside their departments", scoped.ok === false && /scope/.test(scoped.message ?? ""), scoped.message);

    section("Mark joined");
    await signInAs("priya.sharma@acme.test");
    const early = await act.markJoinedAction({}, fd({ employeeId: future.id, joinedOn: key(new Date(today.getTime() + 5 * DAY)) }));
    check("A hire cannot be marked joined before the day", early.ok === false, early.message);
    const old = await act.markJoinedAction({}, fd({ employeeId: due.id, joinedOn: key(new Date(today.getTime() - 40 * DAY)) }));
    check("A joining date more than a month back is refused", old.ok === false, old.message);
    const joined = await act.markJoinedAction({}, fd({ employeeId: due.id, joinedOn: key(new Date(today.getTime() - DAY)) }));
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: due.id } });
    check("Marking joined starts probation", joined.ok && after.status === "PROBATION", joined.message);
    check("The actual joining date replaces the planned one", key(after.dateOfJoining) === key(new Date(today.getTime() - DAY)));
    const again = await act.markJoinedAction({}, fd({ employeeId: due.id, joinedOn: key(today) }));
    check("Someone already joined cannot be marked again", again.ok === false);

    section("Background checks");
    const none = await act.initiateBgvAction({}, fd({ employeeId: future.id, vendor: "AuthBridge" }));
    check("A check needs at least one item", none.ok === false, none.message);
    const f1 = fd({ employeeId: future.id, vendor: "AuthBridge" }); f1.append("checks", "IDENTITY"); f1.append("checks", "EDUCATION"); f1.append("checks", "BOGUS");
    const started = await act.initiateBgvAction({}, f1);
    const bgv = await prisma.bgvCheck.findFirstOrThrow({ where: { employeeId: future.id } });
    check("A background check starts with only the known checks", started.ok && JSON.stringify(bgv.checkTypes) === JSON.stringify(["IDENTITY", "EDUCATION"]) && bgv.status === "INITIATED", started.message);
    const f2 = fd({ employeeId: future.id }); f2.append("checks", "ADDRESS");
    const dup = await act.initiateBgvAction({}, f2);
    check("Only one check can be open per person", dup.ok === false, dup.message);
    const vague = await act.updateBgvAction({}, fd({ id: bgv.id, status: "DISCREPANCY", findings: "" }));
    check("A discrepancy needs findings", vague.ok === false, vague.message);
    const prog = await act.updateBgvAction({}, fd({ id: bgv.id, status: "IN_PROGRESS", findings: "" }));
    check("A check can move to in progress", prog.ok && (await prisma.bgvCheck.findUniqueOrThrow({ where: { id: bgv.id } })).status === "IN_PROGRESS", prog.message);
    const disc = await act.updateBgvAction({}, fd({ id: bgv.id, status: "DISCREPANCY", findings: "Degree year differs" }));
    const closed = await prisma.bgvCheck.findUniqueOrThrow({ where: { id: bgv.id } });
    check("A discrepancy closes the check with its findings", disc.ok && closed.status === "DISCREPANCY" && !!closed.completedAt && closed.findings === "Degree year differs", disc.message);
    const reopen = await act.updateBgvAction({}, fd({ id: bgv.id, status: "CLEAR", findings: "" }));
    check("A closed check cannot be changed", reopen.ok === false, reopen.message);

    section("Did not join");
    const f3 = fd({ employeeId: noShow.id, vendor: "" }); f3.append("checks", "CRIMINAL");
    await act.initiateBgvAction({}, f3);
    const noReason = await act.markNoShowAction({}, fd({ employeeId: noShow.id, reason: " " }));
    check("A no-show needs a reason", noReason.ok === false);
    const ns = await act.markNoShowAction({}, fd({ employeeId: noShow.id, reason: "Took another offer" }));
    const gone = await prisma.employee.findUniqueOrThrow({ where: { id: noShow.id }, include: { user: true, bgvChecks: true } });
    check("A no-show is exited with portal access off", ns.ok && gone.status === "EXITED" && gone.user?.loginDisabled === true, ns.message);
    check("A no-show's open background check is cancelled", gone.bgvChecks.every((b) => b.status === "CANCELLED"));
  } finally {
    await cleanup();
  }
}

main().then(() => report("Preboarding")).catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
