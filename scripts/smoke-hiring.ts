/**
 * Hiring end to end through the actions: requisition approval, a job, a
 * candidate through the stages, an interview panel, feedback gates, an offer
 * above budget that needs approval, the letter, acceptance — and the hire,
 * which must produce a real employee with onboarding already started.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { unlink } from "node:fs/promises";
import path from "node:path";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

async function main() {
  const a = await import("../apps/web/src/app/actions/hiring");
  const { STORAGE_DIR } = await import("../apps/web/src/lib/storage");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n } });
  const sneha = await emp("ACM0005"), meera = await emp("ACM0009");
  const dept = await prisma.department.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Platform Engineering" } });
  const started = new Date();
  const ids = { req: "", job: "", employee: "" };

  console.log("\nHiring\n" + "=".repeat(72));
  try {
    section("Requisition and job");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot raise a requisition", await denied(() => a.raiseRequisitionAction({}, fd({ title: "x" }))));
    await signInAs("priya.sharma@acme.test");
    const raised = await a.raiseRequisitionAction({}, fd({ title: "Smoke SRE", type: "NEW_HIRE", departmentId: dept.id, positions: 2, minAnnualCtc: 2000000, maxAnnualCtc: 3000000, justification: "Smoke test" }));
    const req = await prisma.requisition.findFirstOrThrow({ where: { tenantId: tenant.id, title: "Smoke SRE" } });
    ids.req = req.id;
    check("HR raises a requisition for approval", raised.ok === true && req.status === "PENDING_APPROVAL", raised.message);
    const self = await a.decideRequisitionAction({}, fd({ id: req.id, decision: "approve" }));
    check("…but cannot approve her own", self.ok === false, self.message);
    await signInAs("vikram.menon@acme.test");
    const ok = await a.decideRequisitionAction({}, fd({ id: req.id, decision: "approve" }));
    check("Leadership approves it", ok.ok === true);
    await signInAs("priya.sharma@acme.test");
    const opened = await a.openJobAction({}, fd({ requisitionId: req.id, hiringManagerId: sneha.id }));
    const job = await prisma.job.findFirstOrThrow({ where: { requisitionId: req.id } });
    ids.job = job.id;
    check("A job opens with the requisition's openings and budget", opened.ok === true && job.openings === 2 && Number(job.maxAnnualCtc) === 3000000, opened.message);

    section("Candidates and stages");
    const add = await a.addCandidateAction({}, fd({ jobId: job.id, firstName: "Smoke", lastName: "Candidate", email: "smoke.candidate@mail.test", currentEmployer: "Acme Rival", expectedAnnualCtc: 3200000, source: "JOB_BOARD" }));
    const app = await prisma.application.findFirstOrThrow({ where: { jobId: job.id, candidate: { email: "smoke.candidate@mail.test" } }, include: { job: { include: { flow: { include: { stages: { orderBy: { sequence: "asc" } } } } } } } });
    const stages = app.job.flow!.stages;
    const st = (n: string) => stages.find((s) => s.name === n)!.id;
    check("The candidate enters the first stage", add.ok === true && app.currentStageId === stages[0].id, add.message);
    const dup = await a.addCandidateAction({}, fd({ jobId: job.id, firstName: "Smoke", lastName: "Candidate", email: "SMOKE.CANDIDATE@mail.test" }));
    check("The same person cannot apply twice (email is case-insensitive)", dup.ok === false, dup.message);
    await signInAs("meera.krishnan@acme.test");
    const ref = await a.referAction({}, fd({ jobId: job.id, firstName: "Smoke", lastName: "Referral", email: "smoke.referral@mail.test" }));
    const refCand = await prisma.candidate.findFirstOrThrow({ where: { email: "smoke.referral@mail.test" } });
    check("Any employee can refer, and is credited", ref.ok === true && refCand.source === "REFERRAL" && refCand.referredById === meera.id, ref.message);

    await signInAs("priya.sharma@acme.test");
    const toTech = await a.moveStageAction({}, fd({ applicationId: app.id, stageId: st("Technical interview") }));
    check("HR moves the candidate to the technical round", toTech.ok === true, toTech.message);
    const skip = await a.moveStageAction({}, fd({ applicationId: app.id, stageId: st("Manager round") }));
    check("…who cannot leave it without interview feedback", skip.ok === false && /feedback/.test(skip.message ?? ""), skip.message);

    section("Interview and feedback");
    const tomorrow = iso(new Date(Date.now() + DAY));
    const f = new FormData();
    for (const [k, v] of Object.entries({ applicationId: app.id, title: "Technical interview", date: tomorrow, time: "11:00", durationMinutes: "60", mode: "VIDEO" })) f.set(k, v);
    f.append("panel", sneha.id); f.append("panel", meera.id);
    const sched = await a.scheduleInterviewAction({}, f);
    const iv = await prisma.interview.findFirstOrThrow({ where: { applicationId: app.id } });
    check("A panel interview is scheduled", sched.ok === true, sched.message);
    const g = new FormData();
    for (const [k, v] of Object.entries({ applicationId: app.id, title: "Clash", date: tomorrow, time: "11:30", durationMinutes: "30", mode: "PHONE" })) g.set(k, v);
    g.append("panel", sneha.id);
    const clash = await a.scheduleInterviewAction({}, g);
    check("A second interview that overlaps a panellist is refused", clash.ok === false && /already interviewing/.test(clash.message ?? ""), clash.message);

    await signInAs("meera.krishnan@acme.test");
    const early = await a.scorecardAction({}, fd({ interviewId: iv.id, overallScore: 4, recommendation: "YES" }));
    check("Feedback cannot be given before the interview", early.ok === false, early.message);
    await prisma.interview.update({ where: { id: iv.id }, data: { scheduledAt: new Date(Date.now() - 2 * 3_600_000) } });
    const sc = await a.scorecardAction({}, fd({ interviewId: iv.id, overallScore: 4, recommendation: "STRONG_YES", strengths: "Solid systems thinking" }));
    check("A panellist gives feedback after it", sc.ok === true, sc.message);
    await signInAs("ramesh.iyer@acme.test");
    const outsider = await a.scorecardAction({}, fd({ interviewId: iv.id, overallScore: 1, recommendation: "STRONG_NO" }));
    check("Someone not on the panel cannot", outsider.ok === false, outsider.message);
    await signInAs("sneha.reddy@acme.test");
    await a.scorecardAction({}, fd({ interviewId: iv.id, overallScore: 5, recommendation: "STRONG_YES", strengths: "Excellent" }));
    const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    check("The average score is 4.5 and the interview is complete",
      Number(after.averageScore) === 4.5 && (await prisma.interview.findUniqueOrThrow({ where: { id: iv.id } })).status === "COMPLETED");
    await signInAs("priya.sharma@acme.test");
    const moved = await a.moveStageAction({}, fd({ applicationId: app.id, stageId: st("Manager round") }));
    check("With feedback in, the candidate moves on", moved.ok === true, moved.message);

    section("Offer");
    const over = await a.draftOfferAction({}, fd({ applicationId: app.id, annualCtc: 3400000, proposedJoiningDate: iso(new Date(Date.now() + 40 * DAY)), expiresOn: iso(new Date(Date.now() + 7 * DAY)), reportingManagerId: sneha.id }));
    check("An offer above the ₹30 lakh budget needs approval", over.ok === true && /approval/.test(over.message ?? ""), over.message);
    const early2 = await a.offerOpAction({}, fd({ applicationId: app.id, op: "extend" }));
    check("…and cannot be sent until approved", early2.ok === false, early2.message);
    await signInAs("vikram.menon@acme.test");
    const appr = await a.offerOpAction({}, fd({ applicationId: app.id, op: "approve" }));
    check("An approver signs off the extra", appr.ok === true, appr.message);
    await signInAs("priya.sharma@acme.test");
    const ext = await a.offerOpAction({}, fd({ applicationId: app.id, op: "extend" }));
    const offer = await prisma.offer.findUniqueOrThrow({ where: { applicationId: app.id } });
    const mail = await prisma.emailOutbox.findFirst({ where: { toAddress: "smoke.candidate@mail.test", relatedType: "Offer" } });
    check("Extending produces the letter and emails the candidate", ext.ok === true && !!offer.letterUrl?.startsWith("/files/") && !!mail, ext.message);
    const letter = await prisma.storedFile.findUniqueOrThrow({ where: { id: offer.letterUrl!.replace("/files/", "") } });
    check("The letter is a real PDF", letter.mimeType === "application/pdf" && letter.sizeBytes > 1000);
    const acc = await a.offerOpAction({}, fd({ applicationId: app.id, op: "accepted" }));
    check("The candidate's acceptance is recorded", acc.ok === true);

    section("Hire");
    const hire = await a.hireAction({}, fd({ applicationId: app.id, workEmail: "smoke.candidate@acme.test" }));
    const employee = await prisma.employee.findFirst({ where: { tenantId: tenant.id, workEmail: "smoke.candidate@acme.test" }, include: { salaryRevisions: true, journeys: true } });
    if (employee) ids.employee = employee.id;
    check("Hiring creates the employee", hire.ok === true && !!employee, hire.message);
    check("…on the offered salary, reporting to the hiring manager", Number(employee?.salaryRevisions[0]?.annualCtc) === 3400000 && employee?.reportingManagerId === sneha.id);
    check("…with onboarding already started", (employee?.journeys.filter((j) => j.trigger === "JOINING").length ?? 0) === 1);
    const appAfter = await prisma.application.findUniqueOrThrow({ where: { id: app.id }, include: { candidate: true } });
    check("The application is closed as hired and linked", appAfter.status === "HIRED" && appAfter.candidate.convertedEmployeeId === employee?.id);
    check("One of two openings filled — the job stays open", (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "OPEN");
    const again = await a.addCandidateAction({}, fd({ jobId: job.id, firstName: "Smoke", lastName: "Candidate", email: "smoke.candidate@mail.test" }));
    check("A hired candidate cannot be put back in a pipeline", again.ok === false, again.message);

    section("Rejection");
    const refApp = await prisma.application.findFirstOrThrow({ where: { candidateId: refCand.id } });
    const noReason = await a.rejectApplicationAction({}, fd({ applicationId: refApp.id, reason: " " }));
    check("Rejecting needs a reason", noReason.ok === false);
    const rej = await a.rejectApplicationAction({}, fd({ applicationId: refApp.id, reason: "Not enough distributed-systems depth" }));
    check("…and the candidate is told", rej.ok === true && !!(await prisma.emailOutbox.findFirst({ where: { toAddress: "smoke.referral@mail.test" } })));
  } finally {
    if (ids.employee) {
      const e = await prisma.employee.findUnique({ where: { id: ids.employee } });
      await prisma.candidate.updateMany({ where: { convertedEmployeeId: ids.employee }, data: { convertedEmployeeId: null } });
      await prisma.employee.delete({ where: { id: ids.employee } });
      if (e?.userId) await prisma.user.delete({ where: { id: e.userId } });
    }
    const files = await prisma.storedFile.findMany({ where: { tenantId: tenant.id, createdAt: { gte: started } } });
    for (const x of files) await unlink(path.join(STORAGE_DIR, x.storageKey)).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { id: { in: files.map((x) => x.id) } } });
    if (ids.job) await prisma.job.delete({ where: { id: ids.job } }).catch(() => {});
    if (ids.req) await prisma.requisition.delete({ where: { id: ids.req } }).catch(() => {});
    await prisma.candidate.deleteMany({ where: { tenantId: tenant.id, email: { startsWith: "smoke." } } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started } } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started } } });
    const series = await prisma.employeeNumberSeries.findFirst({ where: { tenantId: tenant.id, isDefault: true } });
    const count = await prisma.employee.count({ where: { tenantId: tenant.id } });
    if (series) await prisma.employeeNumberSeries.update({ where: { id: series.id }, data: { nextNumber: count + 1 } });
  }
  report("Hiring");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
