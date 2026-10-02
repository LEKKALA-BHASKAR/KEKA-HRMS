/**
 * Multi-level payroll approvals, through the actions: locking a run sends it
 * up the LOCK_PAYROLL chain (Payroll Admin, then Global Admin), skipping the
 * level the requester holds; the requester and the wrong role cannot decide;
 * a rejection needs a reason and reopens the run; the requester can withdraw;
 * the last approval locks. A salary change climbs the COMPENSATION_CHANGE
 * chain, stays pending (and blocks a second change) until decided, and a
 * rejection leaves the old CTC in force.
 *
 * Uses payroll period February 2027 (refusing to run if a run already exists
 * for it) and Meera's salary; everything it creates is removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const Y = 2027;
const M = 2;

async function main() {
  const payroll = await import("../apps/web/src/app/actions/payroll");
  const approvals = await import("../apps/web/src/app/actions/payroll-approvals");
  const employee = await import("../apps/web/src/app/actions/employee");
  const { createRun, calculateRun, approvalsWaitingOn } = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "meera.krishnan@acme.test" } } });
  const users = Object.fromEntries(await Promise.all(["ramesh.iyer", "vikram.menon", "priya.sharma"].map(async (n) =>
    [n, (await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: `${n}@acme.test` } })).id] as const)));
  const payGroupId = meera.payGroupId!;
  const since = new Date();
  const runWhere = { tenantId: tenant.id, payGroupId, year: Y, month: M };
  if (await prisma.payrollRun.count({ where: runWhere })) throw new Error(`A payroll run already exists for ${M}-${Y}; this test needs that month free.`);

  let runId = "";
  const ctcBefore = await prisma.salaryRevision.findFirstOrThrow({ where: { employeeId: meera.id, status: "APPLIED" }, orderBy: { effectiveFrom: "desc" } });
  const requestFor = (where: object) => prisma.payrollApprovalRequest.findFirstOrThrow({ where: { status: "PENDING", ...where }, orderBy: { requestedAt: "desc" } });
  const decide = (requestId: string, decision: "approve" | "reject", comment = "") =>
    approvals.decideApprovalAction({}, fd({ requestId, decision, comment }));
  const runStatus = async () => (await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).status;

  try {
    runId = await createRun(runWhere);
    await calculateRun(runId);

    // -----------------------------------------------------------------
    section("Locking a run climbs the approval chain");
    await signInAs("ramesh.iyer@acme.test");
    await payroll.lockRun(fd({ runId }));
    check("The run waits for approval instead of locking", (await runStatus()) === "PENDING_APPROVAL");
    let req = await requestFor({ runId });
    check("The Payroll Admin level was skipped, since the requester holds it", req.currentLevel === 1, `level ${req.currentLevel}`);
    const vikramQueue = await approvalsWaitingOn(tenant.id, users["vikram.menon"]);
    check("It shows in the Global Admin's queue as theirs", vikramQueue.some((r) => r.id === req.id && r.mine));
    const priyaQueue = await approvalsWaitingOn(tenant.id, users["priya.sharma"]);
    check("It is not the HR Manager's to decide", !priyaQueue.some((r) => r.id === req.id && r.mine));

    const own = await decide(req.id, "approve");
    check("The requester cannot approve their own lock", own.ok !== true, own.message);
    await signInAs("priya.sharma@acme.test");
    const wrong = await decide(req.id, "approve");
    check("Someone without the level's role cannot approve", wrong.ok !== true && /waiting on someone/i.test(wrong.message ?? ""), wrong.message);

    await signInAs("vikram.menon@acme.test");
    const bare = await decide(req.id, "reject");
    check("A rejection needs a reason", bare.ok !== true && /reason/i.test(bare.message ?? ""), bare.message);
    const rejected = await decide(req.id, "reject", "Overtime not loaded yet");
    check("Rejected with a reason", rejected.ok === true, rejected.message);
    check("The run reopened for changes", (await runStatus()) === "IN_PROGRESS");
    const log = (await prisma.payrollApprovalRequest.findUniqueOrThrow({ where: { id: req.id } })).comments as { decision: string; comment?: string }[];
    check("The reason is kept on the request", log.some((c) => c.decision === "REJECT" && c.comment === "Overtime not loaded yet"));

    // -----------------------------------------------------------------
    section("Withdrawing, then approving");
    await signInAs("ramesh.iyer@acme.test");
    await payroll.lockRun(fd({ runId }));
    req = await requestFor({ runId });
    await signInAs("vikram.menon@acme.test");
    const notTheirs = await approvals.withdrawApprovalAction({}, fd({ requestId: req.id }));
    check("Only the requester can withdraw", notTheirs.ok !== true, notTheirs.message);
    await signInAs("ramesh.iyer@acme.test");
    const withdrawn = await approvals.withdrawApprovalAction({}, fd({ requestId: req.id }));
    check("The requester withdrew it", withdrawn.ok === true, withdrawn.message);
    check("The run is back in progress", (await runStatus()) === "IN_PROGRESS");

    await payroll.lockRun(fd({ runId }));
    req = await requestFor({ runId });
    await signInAs("vikram.menon@acme.test");
    const approved = await decide(req.id, "approve", "Looks right");
    check("The last level approved it", approved.ok === true && /locked/i.test(approved.message ?? ""), approved.message);
    check("The run is locked", (await runStatus()) === "LOCKED");
    const ramesh = await prisma.notification.findFirst({ where: { userId: users["ramesh.iyer"], createdAt: { gte: since }, title: { startsWith: "Approved" } } });
    check("The requester was told", !!ramesh, ramesh?.title);

    // -----------------------------------------------------------------
    section("A salary change waits for its chain");
    await signInAs("vikram.menon@acme.test");
    const newCtc = Number(ctcBefore.annualCtc) + 60000;
    const revised = await employee.reviseSalary({}, fd({ employeeId: meera.id, effectiveFrom: "2027-01-01", annualCtc: String(newCtc), reason: "Smoke approval test" }));
    check("The change was sent for approval", revised.ok === true && /approval/i.test(revised.message ?? ""), revised.message);
    const pending = await prisma.salaryRevision.findFirst({ where: { employeeId: meera.id, status: "PENDING_APPROVAL" } });
    check("It is pending, not applied", !!pending && Number(pending.annualCtc) === newCtc);
    const second = await employee.reviseSalary({}, fd({ employeeId: meera.id, effectiveFrom: "2027-02-01", annualCtc: String(newCtc + 1000), reason: "Another" }));
    check("A second change is refused while one is pending", second.ok !== true, second.message);

    const compReq = await requestFor({ action: "COMPENSATION_CHANGE", payload: { path: ["revisionId"], equals: pending?.id } });
    check("It waits on the HR Manager first", compReq.currentLevel === 0);
    await signInAs("priya.sharma@acme.test");
    const no = await decide(compReq.id, "reject", "Outside the review cycle");
    check("The HR Manager rejected it", no.ok === true, no.message);
    const after = await prisma.salaryRevision.findUniqueOrThrow({ where: { id: pending!.id } });
    check("The revision is marked rejected", after.status === "REJECTED");
    const live = await prisma.salaryRevision.findFirstOrThrow({ where: { employeeId: meera.id, status: "APPLIED" }, orderBy: { effectiveFrom: "desc" } });
    check("The old CTC is still in force", live.id === ctcBefore.id, String(live.annualCtc));
  } finally {
    await prisma.payrollApprovalRequest.deleteMany({ where: { OR: [{ runId: runId || undefined }, { action: "COMPENSATION_CHANGE", requestedAt: { gte: since }, payload: { path: ["employeeId"], equals: meera.id } }] } });
    await prisma.salaryRevision.deleteMany({ where: { employeeId: meera.id, createdAt: { gte: since } } });
    await prisma.payrollRun.deleteMany({ where: runWhere });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since }, kind: "PAYROLL" } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since } } });
  }
  report("Payroll approvals");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
