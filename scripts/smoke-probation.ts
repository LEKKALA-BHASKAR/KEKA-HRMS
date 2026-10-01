/**
 * Probation and confirmation through the actions and the nightly job: who may
 * manage probation and within what scope; policies; the review opening on
 * the right day; manager and self reviews and who may submit them;
 * extensions within the policy's limit; confirmation writing the job record,
 * the status and the date; not confirming; and auto-confirmation.
 *
 * Snapshots the seeded probations first and restores them exactly, so the
 * suite can run again.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date | null | undefined) => d?.toISOString().slice(0, 10);

async function main() {
  const act = await import("../apps/web/src/app/actions/probation");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n } });
  const swati = await emp("ACM0024"), harish = await emp("ACM0025"), sneha = await emp("ACM0005");
  const started = new Date();

  // ---- Snapshot what the suite will change ----
  const people = [swati.id, harish.id];
  const snapEmployees = await prisma.employee.findMany({ where: { id: { in: people } }, select: { id: true, status: true, confirmationDate: true } });
  const snapProbations = await prisma.employeeProbation.findMany({ where: { employeeId: { in: people } } });
  const snapEvaluations = await prisma.probationEvaluation.findMany({ where: { probationId: { in: snapProbations.map((p) => p.id) } } });
  const snapJobs = await prisma.employeeJobRecord.findMany({ where: { employeeId: { in: people } }, select: { id: true, effectiveTo: true } });
  const policiesBefore = new Set((await prisma.probationPolicy.findMany({ where: { tenantId: tenant.id }, select: { id: true } })).map((p) => p.id));
  const sales = await prisma.department.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Sales" } });
  let tempId: string | null = null;

  console.log("\nProbation and confirmation\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------------
    section("Access");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot manage probation", await denied(() => act.saveProbationPolicyAction({}, fd({ name: "x", durationDays: 90, maxExtensions: 1, extensionDays: 30, completion: "EVALUATION" }))));
    check("…or decide one", await denied(() => act.decideProbationAction({}, fd({ probationId: "x", decision: "CONFIRM" }))));
    await signInAs("sneha.reddy@acme.test");
    check("A reporting manager cannot decide either; they review", await denied(() => act.decideProbationAction({}, fd({ probationId: "x", decision: "CONFIRM" }))));

    const temp = await prisma.employee.create({
      data: {
        tenantId: tenant.id, employeeNumber: "SMOKE-PRB", firstName: "Smoke", lastName: "Probationer", displayName: "Smoke Probationer",
        dateOfJoining: utc(2026, 9, 1), status: "PROBATION", departmentId: sales.id, reportingManagerId: sneha.id,
      },
    });
    tempId = temp.id;
    await signInAs("deepak.chauhan@acme.test");
    const outOfScope = await act.startProbationAction({}, fd({ employeeId: temp.id }));
    check("A scoped HR executive cannot reach someone outside their departments", outOfScope.ok === false && /outside/.test(outOfScope.message ?? ""), outOfScope.message);

    // -----------------------------------------------------------------------
    section("Policies");
    await signInAs("priya.sharma@acme.test");
    const lead = await act.saveProbationPolicyAction({}, fd({ name: "Smoke short", durationDays: 10, maxExtensions: 1, extensionDays: 5, completion: "EVALUATION", reviewLeadDays: 10 }));
    check("A review cannot open before probation starts", lead.ok === false && !!lead.errors?.reviewLeadDays, lead.message);
    const made = await act.saveProbationPolicyAction({}, fd({ name: "Smoke short", durationDays: 30, maxExtensions: 0, extensionDays: 5, completion: "EVALUATION", reviewLeadDays: 7, selfReview: "on" }));
    check("HR creates a policy", made.ok === true, made.message);
    const dup = await act.saveProbationPolicyAction({}, fd({ name: "Smoke short", durationDays: 30, maxExtensions: 0, extensionDays: 5, completion: "EVALUATION" }));
    check("…but not two with the same name", dup.ok === false && !!dup.errors?.name, dup.message);
    const short = await prisma.probationPolicy.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke short" } });
    const standard = await prisma.probationPolicy.findFirstOrThrow({ where: { tenantId: tenant.id, isDefault: true } });

    // -----------------------------------------------------------------------
    section("Starting probation");
    const start = await act.startProbationAction({}, fd({ employeeId: temp.id }));
    const tempP = await prisma.employeeProbation.findUniqueOrThrow({ where: { employeeId: temp.id } });
    check("HR starts it under the default policy from the date of joining", start.ok === true && tempP.policyId === standard.id && iso(tempP.startDate) === "2026-09-01" && iso(tempP.endDate) === "2026-11-29", `${start.message} ${iso(tempP.endDate)}`);
    const again = await svc.startProbation({ employeeId: temp.id });
    check("Starting it again changes nothing", again.ok && again.created === false && (await prisma.employeeProbation.count({ where: { employeeId: temp.id } })) === 1);
    const moved = await act.changeProbationPolicyAction({}, fd({ probationId: tempP.id, policyId: short.id }));
    check("Moving to a 30-day policy recomputes the end", moved.ok === true && iso((await prisma.employeeProbation.findUniqueOrThrow({ where: { id: tempP.id } })).endDate) === "2026-09-30", moved.message);
    const confirmed = await emp("ACM0001");
    const notOnProbation = await act.startProbationAction({}, fd({ employeeId: confirmed.id }));
    check("Someone already confirmed cannot be put on probation", notOnProbation.ok === false, notOnProbation.message);

    // -----------------------------------------------------------------------
    section("The review opens on time");
    const hP = await prisma.employeeProbation.findUniqueOrThrow({ where: { employeeId: harish.id } });
    check("Harish's 90 days run 1 Aug – 29 Oct", iso(hP.endDate) === "2026-10-29" && hP.status === "ACTIVE");
    await svc.runProbationJob(tenant.id, utc(2026, 10, 13));
    check("The job leaves it alone the day before the window", (await prisma.employeeProbation.findUniqueOrThrow({ where: { id: hP.id } })).status === "ACTIVE");
    const notesBefore = await prisma.notification.count({ where: { tenantId: tenant.id, kind: "PROBATION" } });
    await svc.runProbationJob(tenant.id, utc(2026, 10, 14));
    const opened = await prisma.employeeProbation.findUniqueOrThrow({ where: { id: hP.id }, include: { evaluations: true } });
    check("…and opens the review 15 days before the end", opened.status === "IN_REVIEW" && opened.evaluations.length === 2);
    check("The manager and Harish are both asked, due on the last day",
      opened.evaluations.some((e) => e.role === "MANAGER" && e.evaluatorId === harish.reportingManagerId) &&
      opened.evaluations.some((e) => e.role === "SELF" && e.evaluatorId === harish.id) &&
      opened.evaluations.every((e) => iso(e.dueDate) === "2026-10-29"));
    check("…and notified", (await prisma.notification.count({ where: { tenantId: tenant.id, kind: "PROBATION" } })) - notesBefore === 2);
    const reopen = await act.openProbationReviewAction({}, fd({ probationId: hP.id }));
    check("Opening it again asks nobody twice", reopen.ok === true && (await prisma.probationEvaluation.count({ where: { probationId: hP.id } })) === 2, reopen.message);

    // -----------------------------------------------------------------------
    section("Reviews");
    const mgrEval = opened.evaluations.find((e) => e.role === "MANAGER")!;
    const selfEval = opened.evaluations.find((e) => e.role === "SELF")!;
    await signInAs("karthik.subramanian@acme.test");
    const wrong = await act.submitProbationEvaluationAction({}, fd({ evaluationId: mgrEval.id, rating: 5, recommendation: "CONFIRM" }));
    check("Another manager cannot submit Harish's review", wrong.ok === false && /not found/.test(wrong.message ?? ""), wrong.message);
    await signInAs("harish.prasad@acme.test");
    const asMgr = await act.submitProbationEvaluationAction({}, fd({ evaluationId: mgrEval.id, rating: 5, recommendation: "CONFIRM" }));
    check("…nor can Harish submit his manager's", asMgr.ok === false, asMgr.message);
    const selfOk = await act.submitProbationEvaluationAction({}, fd({ evaluationId: selfEval.id, rating: 3, strengths: "Smoke self review" }));
    check("Harish submits his own review", selfOk.ok === true, selfOk.message);
    const selfTwice = await act.submitProbationEvaluationAction({}, fd({ evaluationId: selfEval.id, rating: 5 }));
    check("…once", selfTwice.ok === false, selfTwice.message);
    await signInAs("ananya.ghosh@acme.test");
    const noRec = await act.submitProbationEvaluationAction({}, fd({ evaluationId: mgrEval.id, rating: 3 }));
    check("A manager must recommend", noRec.ok === false && !!noRec.errors?.recommendation, noRec.message);
    const noWhy = await act.submitProbationEvaluationAction({}, fd({ evaluationId: mgrEval.id, rating: 2, recommendation: "EXTEND" }));
    check("…and explain an extension", noWhy.ok === false && !!noWhy.errors?.comments, noWhy.message);
    const mgrOk = await act.submitProbationEvaluationAction({}, fd({ evaluationId: mgrEval.id, rating: 2, recommendation: "EXTEND", comments: "Smoke: needs another month on releases" }));
    check("The manager recommends an extension", mgrOk.ok === true, mgrOk.message);
    check("HR is told the feedback is in", (await prisma.notification.count({ where: { tenantId: tenant.id, kind: "PROBATION", link: `/probation/${hP.id}` } })) >= 1);

    // -----------------------------------------------------------------------
    section("Extension");
    await signInAs("priya.sharma@acme.test");
    const ext = await act.decideProbationAction({}, fd({ probationId: hP.id, decision: "EXTEND", extendDays: 30, note: "Smoke extension" }));
    const afterExt = await prisma.employeeProbation.findUniqueOrThrow({ where: { id: hP.id } });
    check("HR extends by 30 days from the current end", ext.ok === true && iso(afterExt.endDate) === "2026-11-28" && iso(afterExt.originalEndDate) === "2026-10-29", ext.message);
    check("…which starts a new round with no review open", afterExt.status === "ACTIVE" && afterExt.round === 2 && afterExt.extensions === 1);
    const ext2 = await act.decideProbationAction({}, fd({ probationId: hP.id, decision: "EXTEND", extendDays: 30 }));
    check("A second extension is refused under a one-extension policy", ext2.ok === false && /already been extended/.test(ext2.message ?? ""), ext2.message);
    check("Harish stays on probation", (await emp("ACM0025")).status === "PROBATION");

    // -----------------------------------------------------------------------
    section("Auto-confirmation");
    const interns = await prisma.probationPolicy.findFirstOrThrow({ where: { tenantId: tenant.id, completion: "AUTO_CONFIRM" } });
    await act.changeProbationPolicyAction({}, fd({ probationId: hP.id, policyId: interns.id }));
    const onInterns = await prisma.employeeProbation.findUniqueOrThrow({ where: { id: hP.id } });
    check("A policy move keeps the 30 extension days already granted", iso(onInterns.endDate) === "2026-10-29", iso(onInterns.endDate));
    await svc.runProbationJob(tenant.id, utc(2026, 10, 29));
    check("Auto-confirm waits through the last day", (await prisma.employeeProbation.findUniqueOrThrow({ where: { id: hP.id } })).status === "ACTIVE");
    const run = await svc.runProbationJob(tenant.id, utc(2026, 10, 30));
    const autoP = await prisma.employeeProbation.findUniqueOrThrow({ where: { id: hP.id } });
    const harishNow = await emp("ACM0025");
    check("…and confirms the day after", run.autoConfirmed >= 1 && autoP.status === "CONFIRMED" && autoP.decidedBy === null && iso(autoP.confirmedOn) === "2026-10-30");
    check("Harish is confirmed from 30 Oct", harishNow.status === "CONFIRMED" && iso(harishNow.confirmationDate) === "2026-10-30");
    check("Running the job again does nothing more", (await svc.runProbationJob(tenant.id, utc(2026, 10, 31))).autoConfirmed === 0);

    // -----------------------------------------------------------------------
    section("Confirmation");
    const sP = await prisma.employeeProbation.findUniqueOrThrow({ where: { employeeId: swati.id } });
    check("Swati's review is in and her manager recommends confirmation",
      sP.status === "IN_REVIEW" && (await prisma.probationEvaluation.count({ where: { probationId: sP.id, status: "SUBMITTED", recommendation: "CONFIRM" } })) === 1);
    const notWhy = await act.decideProbationAction({}, fd({ probationId: sP.id, decision: "NOT_CONFIRM" }));
    check("Not confirming needs a reason", notWhy.ok === false && !!notWhy.errors?.note, notWhy.message);
    const conf = await act.decideProbationAction({}, fd({ probationId: sP.id, decision: "CONFIRM", note: "Smoke confirm" }));
    const swatiNow = await emp("ACM0024");
    check("HR confirms Swati", conf.ok === true && swatiNow.status === "CONFIRMED", conf.message);
    check("…backdated to the day after probation ended (13 Sep)", iso(swatiNow.confirmationDate) === "2026-09-13");
    const job = await prisma.employeeJobRecord.findFirst({ where: { employeeId: swati.id, reason: "CONFIRMATION", effectiveTo: null } });
    check("A CONFIRMATION job record takes over from 13 Sep", iso(job?.effectiveFrom) === "2026-09-13" &&
      (await prisma.employeeJobRecord.count({ where: { employeeId: swati.id, effectiveTo: null } })) === 1);
    const twice = await act.decideProbationAction({}, fd({ probationId: sP.id, decision: "EXTEND", extendDays: 10 }));
    check("A decided probation cannot be decided again", twice.ok === false && /already decided/.test(twice.message ?? ""), twice.message);

    // -----------------------------------------------------------------------
    section("Not confirmed");
    const notConf = await act.decideProbationAction({}, fd({ probationId: tempP.id, decision: "NOT_CONFIRM", note: "Smoke: did not meet the role's bar" }));
    const tempNow = await prisma.employee.findUniqueOrThrow({ where: { id: temp.id } });
    check("HR records that the employee is not confirmed", notConf.ok === true && (await prisma.employeeProbation.findUniqueOrThrow({ where: { id: tempP.id } })).status === "NOT_CONFIRMED", notConf.message);
    check("…which leaves them on probation for Exits to take forward", tempNow.status === "PROBATION" && tempNow.confirmationDate === null);
  } finally {
    // ---- Restore the seeded state exactly ----
    if (tempId) await prisma.employee.delete({ where: { id: tempId } });
    await prisma.employeeProbation.deleteMany({ where: { employeeId: { in: people } } });
    await prisma.employeeProbation.createMany({ data: snapProbations });
    await prisma.probationEvaluation.createMany({ data: snapEvaluations });
    for (const e of snapEmployees) await prisma.employee.update({ where: { id: e.id }, data: { status: e.status, confirmationDate: e.confirmationDate } });
    await prisma.employeeJobRecord.deleteMany({ where: { employeeId: { in: people }, id: { notIn: snapJobs.map((j) => j.id) } } });
    for (const j of snapJobs) await prisma.employeeJobRecord.update({ where: { id: j.id }, data: { effectiveTo: j.effectiveTo } });
    await prisma.journey.deleteMany({ where: { employeeId: { in: people }, trigger: "CONFIRMATION", createdAt: { gte: started } } });
    await prisma.probationPolicy.deleteMany({ where: { tenantId: tenant.id, id: { notIn: [...policiesBefore] } } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, kind: "PROBATION", createdAt: { gte: started } } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, OR: [{ relatedType: "EmployeeProbation" }, { subject: { contains: "robation" } }, { subject: { contains: "confirmed" } }] } });
  }
  report("Probation and confirmation");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
