import type { PrismaClient } from "@prisma/client";

/**
 * Hiring seed: a default flow, requisitions at each stage, an open job with
 * candidates spread across the pipeline, past interviews with feedback, one
 * offer out and one accepted — ready for HR to press "Hire". Nobody is hired
 * here, so seeded headcount stays at thirty.
 */
const DAY = 86_400_000;

export async function seedHiring(prisma: PrismaClient, ctx: { tenantId: string; empIdByNumber: Map<string, string> }) {
  const svc = await import("@keka/services");
  const t = ctx.tenantId, id = (n: string) => ctx.empIdByNumber.get(n)!;
  const vikram = await prisma.user.findFirstOrThrow({ where: { tenantId: t, email: "vikram.menon@acme.test" } });
  const priya = await prisma.user.findFirstOrThrow({ where: { tenantId: t, email: "priya.sharma@acme.test" } });
  // HR runs recruitment day to day.
  const recruiterRole = await prisma.role.findFirst({ where: { tenantId: t, key: "REQUISITION_MANAGER" } });
  if (recruiterRole) await prisma.userRoleAssignment.create({ data: { userId: priya.id, roleId: recruiterRole.id } });

  await prisma.hiringFlow.create({
    data: {
      tenantId: t, name: "Standard", isDefault: true,
      stages: { create: ["Applied", "Screening", "Technical interview", "Manager round", "Offer"].map((name, i) => ({ name, sequence: i + 1, requireScorecard: name.includes("interview") || name.includes("round"), staleAfterDays: i < 2 ? 5 : 7, stageKind: i === 4 ? "OFFER" : i === 0 ? "APPLIED" : "INTERVIEW" })) },
    },
  });
  const flow = await prisma.hiringFlow.findFirstOrThrow({ where: { tenantId: t, isDefault: true }, include: { stages: { orderBy: { sequence: "asc" } } } });
  const stage = (name: string) => flow.stages.find((s) => s.name === name)!.id;
  const dept = async (name: string) => (await prisma.department.findFirstOrThrow({ where: { tenantId: t, name } })).id;
  const blr = await prisma.location.findFirstOrThrow({ where: { tenantId: t }, orderBy: { name: "asc" } });

  // Requisitions: pending, rejected, approved-and-open.
  await prisma.requisition.create({ data: { tenantId: t, title: "Product Designer", departmentId: await dept("Design"), locationId: blr.id, positions: 1, minAnnualCtc: 1400000, maxAnnualCtc: 2200000, justification: "Second designer for the mobile app redesign.", status: "PENDING_APPROVAL", raisedBy: priya.id } });
  await prisma.requisition.create({ data: { tenantId: t, title: "Growth Marketer", departmentId: await dept("Marketing"), positions: 1, justification: "Paid acquisition experiments.", status: "REJECTED", raisedBy: priya.id, rejectReason: "Deferred to Q4 budget." } });
  const req = await prisma.requisition.create({ data: { tenantId: t, title: "Senior Backend Engineer", departmentId: await dept("Platform Engineering"), locationId: blr.id, positions: 2, minAnnualCtc: 2400000, maxAnnualCtc: 3600000, justification: "Payments platform scale-out ahead of the festive season.", status: "PENDING_APPROVAL", raisedBy: priya.id, targetStartDate: new Date(Date.now() + 60 * DAY) } });
  await svc.decideRequisition({ requisitionId: req.id, approve: true, byUserId: vikram.id });
  const opened = await svc.openJobFromRequisition(req.id, { hiringManagerId: id("ACM0005"), recruiterId: priya.id, description: "Own the payments ledger service end to end." });
  const jobId = opened.jobId!;

  const people: Array<[string, string, string, string, number, number, string, "REFERRAL" | "JOB_BOARD" | "DIRECT_SOURCING" | "AGENCY"]> = [
    ["Arjun", "Rao", "arjun.rao@mail.test", "Flipkart", 7, 3100000, "Offer", "REFERRAL"],
    ["Ishita", "Banerjee", "ishita.b@mail.test", "Razorpay", 6, 2900000, "Offer", "JOB_BOARD"],
    ["Kabir", "Malhotra", "kabir.m@mail.test", "Swiggy", 8, 3400000, "Manager round", "DIRECT_SOURCING"],
    ["Nandini", "Iyer", "nandini.i@mail.test", "PhonePe", 5, 2600000, "Technical interview", "AGENCY"],
    ["Rohan", "Sethi", "rohan.s@mail.test", "Zomato", 4, 2100000, "Screening", "JOB_BOARD"],
    ["Tara", "Menon", "tara.m@mail.test", "CRED", 6, 2800000, "Applied", "JOB_BOARD"],
    ["Vivek", "Chandra", "vivek.c@mail.test", "Ola", 3, 1800000, "Screening", "DIRECT_SOURCING"],
  ];
  const order = flow.stages.map((s) => s.name);
  let interviews = 0;
  for (const [first, last, email, employer, exp, expected, target, source] of people) {
    const r = await svc.applyCandidate({ tenantId: t, jobId, firstName: first, lastName: last, email, currentEmployer: employer, currentTitle: "Senior Software Engineer", totalExperienceYears: exp, expectedAnnualCtc: expected, currentAnnualCtc: Math.round(expected * 0.8), noticePeriodDays: 60, source, referredById: source === "REFERRAL" ? id("ACM0006") : null, byUserId: priya.id });
    const appId = r.applicationId!;
    const upto = order.indexOf(target);
    for (let i = 1; i <= upto; i++) {
      const prev = order[i - 1];
      // Interview stages need feedback before the candidate moves on.
      if (prev === "Technical interview" || prev === "Manager round") {
        const panel = prev === "Technical interview" ? [id("ACM0006"), id("ACM0014")] : [id("ACM0005")];
        const at = new Date(Date.now() - (upto - i + 2) * 3 * DAY);
        const iv = await prisma.interview.create({ data: { applicationId: appId, round: prev === "Technical interview" ? 1 : 2, title: prev, scheduledAt: at, durationMinutes: 60, mode: "VIDEO", status: "SCHEDULED", panel: { create: panel.map((e, k) => ({ employeeId: e, isLead: k === 0, response: "ACCEPTED" })) } } });
        for (const p of panel) {
          await svc.submitScorecard({ interviewId: iv.id, panelistEmployeeId: p, overallScore: first === "Kabir" ? 3 : 4, recommendation: first === "Kabir" ? "YES" : "STRONG_YES", strengths: "Clear thinking on consistency and idempotency; strong ownership.", concerns: first === "Kabir" ? "Light on testing practice." : null });
        }
        interviews++;
      }
      await svc.moveStage({ applicationId: appId, stageId: stage(order[i]), byUserId: priya.id });
    }
    // Nandini is in the technical round: interview booked for later this week.
    if (first === "Nandini") {
      await prisma.interview.create({ data: { applicationId: appId, round: 1, title: "Technical interview", scheduledAt: new Date(Date.now() + 2 * DAY), durationMinutes: 60, mode: "VIDEO", meetingUrl: "https://meet.example/abc", panel: { create: [{ employeeId: id("ACM0006"), isLead: true }, { employeeId: id("ACM0009") }] } } });
      interviews++;
    }
    if (first === "Arjun" || first === "Ishita") {
      await svc.draftOffer({ applicationId: appId, annualCtc: first === "Arjun" ? 3300000 : 3000000, proposedJoiningDate: new Date(Date.now() + 50 * DAY), expiresOn: new Date(Date.now() + 7 * DAY), reportingManagerId: id("ACM0005") });
      await prisma.offer.update({ where: { applicationId: appId }, data: { status: "EXTENDED", extendedAt: new Date(Date.now() - 2 * DAY) } });
      await prisma.application.update({ where: { id: appId }, data: { status: "OFFER_EXTENDED" } });
      if (first === "Arjun") await svc.recordOfferResponse(appId, true);
    }
  }
  // One rejected at screening, with the reason kept.
  const rej = await svc.applyCandidate({ tenantId: t, jobId, firstName: "Sameer", lastName: "Khan", email: "sameer.k@mail.test", currentEmployer: "Infosys", totalExperienceYears: 2, source: "JOB_BOARD", byUserId: priya.id });
  await svc.rejectApplication(rej.applicationId!, "Two years of experience against a senior role.");
  return { candidates: people.length + 1, interviews };
}
