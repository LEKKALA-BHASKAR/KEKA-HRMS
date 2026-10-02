import type { PrismaClient, Prisma } from "@prisma/client";

/**
 * Hire, Keka-parity demo data on top of `seedHiring`: hiring settings with a
 * default approver, job-description templates, a full requisitions list
 * (pending on different approvers, a backfill with reasons, a monthly range,
 * one approved without a job, one archived) with their activity trail, the
 * Senior Backend Engineer's two-section interview kit, every scorecard in
 * Keka's five-level form with per-skill ratings, an interview still waiting
 * on feedback, a saved panel summary and hiring-team notes.
 *
 * Idempotent: it clears the rows it owns first, then recreates them. Safe to
 * run on its own against a seeded database.
 */

const DAY = 86_400_000;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
/** An IST wall-clock time as a UTC instant. */
const ist = (base: Date, dayOffset: number, h: number, min: number) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dayOffset, h, min) - 330 * 60_000);

const jd = (about: string, resp: string[], req: string[], nice: string[] = []) => [
  "**About the role:**", about, "",
  "**Your responsibilities:**", ...resp.map((r) => `- ${r}`), "",
  "**Skill sets/Experience we require:**", ...req.map((r) => `- ${r}`),
  ...(nice.length ? ["", "**Nice to have:**", ...nice.map((r) => `- ${r}`)] : []),
].join("\n");

const TEMPLATES: Array<[string, string]> = [
  ["Software Engineer", jd("Build and run the services behind our HR, payroll and finance products, from design through production.",
    ["Design, build and ship features end to end with your squad", "Write tests and own the quality of what you ship", "Review code and help peers grow", "Take part in an on-call rotation and improve reliability"],
    ["2+ years building production web services", "Strong fundamentals in one of TypeScript, Java or Go", "Comfort with SQL and relational data modelling", "Clear written communication"],
    ["Experience with payments, payroll or accounting systems"])],
  ["Product Designer", jd("Shape how thousands of employees and HR teams get their work done, from research to polished interaction design.",
    ["Run discovery with customers and internal teams", "Turn problems into flows, wireframes and high-fidelity designs", "Partner with engineers through build and launch", "Contribute to and evolve our design system"],
    ["3+ years designing B2B or SaaS products", "A portfolio showing problem framing, not just visuals", "Fluency in Figma and prototyping", "Comfort presenting and defending design decisions"])],
  ["Account Executive", jd("Grow our mid-market customer base across India by running full sales cycles with HR and finance leaders.",
    ["Own a territory and build pipeline with SDRs and partners", "Run discovery, demos and commercial negotiations", "Forecast accurately and keep the CRM honest", "Hand customers over cleanly to onboarding"],
    ["1-4 years of B2B SaaS sales with a quota", "Track record of closing deals with multiple stakeholders", "Strong spoken and written English; Hindi a plus"])],
];

const BACKEND_KIT = [
  { section: "Technical Skills", skills: [
    { name: "System Design", description: "Designs services that scale, fail safely and stay simple to operate." },
    { name: "Data Consistency & Idempotency", description: "Reasons about transactions, retries and exactly-once effects in payments flows." },
    { name: "Code Quality & Testing", description: "Writes readable, tested code and knows what to test at which level." },
    { name: "Production Ownership", description: "Debugs live issues calmly, uses observability, and follows through on fixes." },
  ] },
  { section: "Soft Skills", skills: [
    { name: "Communication", description: "Explains trade-offs clearly to engineers and non-engineers." },
    { name: "Collaboration", description: "Works well across teams; shares context and credit." },
    { name: "Critical Thinking", description: "Breaks problems down and challenges assumptions with evidence." },
    { name: "Ownership", description: "Takes responsibility for outcomes and follows through without being chased." },
  ] },
];

const SEEDED_TITLES = ["Software Engineer", "Data Analyst", "Account Executive", "DevOps Engineer", "Engineering Manager - Payments", "Customer Success Manager", "Technical Writer"];
const NOTE_BODIES = [
  "Spoke to Arjun about the joining date — he can move it up by a week if we need him before the festive code freeze.",
  "Strong on design. I'd like a second opinion on testing practice before we decide on the offer.",
];

export async function seedHire(prisma: PrismaClient, ctx: { tenantId: string; today?: Date }) {
  const { tenantId } = ctx;
  const today = ctx.today ?? utc(2026, 10, 1);
  const svc = await import("@keka/services");
  const users = await prisma.user.findMany({ where: { tenantId, email: { in: ["vikram.menon@acme.test", "priya.sharma@acme.test", "sneha.reddy@acme.test"] } }, select: { id: true, email: true } });
  const user = (e: string) => {
    const u = users.find((x) => x.email === e);
    if (!u) throw new Error(`seedHire: no user ${e}`);
    return u.id;
  };
  const vikram = user("vikram.menon@acme.test"), priya = user("priya.sharma@acme.test"), sneha = user("sneha.reddy@acme.test");
  const emps = await prisma.employee.findMany({ where: { tenantId }, select: { id: true, employeeNumber: true, displayName: true } });
  const emp = (n: string) => {
    const e = emps.find((x) => x.employeeNumber === n);
    if (!e) throw new Error(`seedHire: no employee ${n}`);
    return e.id;
  };
  const byName = (name: string) => emps.find((e) => e.displayName === name)?.id ?? null;
  const dept = async (code: string) => (await prisma.department.findFirstOrThrow({ where: { tenantId, code }, select: { id: true, businessUnitId: true } }));
  const loc = async (name: string) => (await prisma.location.findFirstOrThrow({ where: { tenantId, name: { startsWith: name } }, select: { id: true } })).id;

  // --- Settings and templates --------------------------------------------------
  await prisma.hiringSetting.upsert({
    where: { tenantId },
    create: { tenantId, requisitionInstructions: "Please raise requisitions only for budgeted roles, and add the business case in Additional Comments.", defaultApproverUserId: vikram, aiQuestionAttempts: 2 },
    update: { requisitionInstructions: "Please raise requisitions only for budgeted roles, and add the business case in Additional Comments.", defaultApproverUserId: vikram, aiQuestionAttempts: 2 },
  });
  for (const [title, body] of TEMPLATES) {
    await prisma.jobDescriptionTemplate.upsert({ where: { tenantId_title: { tenantId, title } }, create: { tenantId, title, body }, update: { body, isActive: true } });
  }

  // --- Requisitions ----------------------------------------------------------------
  // Clear the ones this module created (no job hangs off them), with their trail.
  const old = await prisma.requisition.findMany({ where: { tenantId, title: { in: SEEDED_TITLES }, jobs: { none: {} } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { tenantId, entityType: "Requisition", entityId: { in: old.map((o) => o.id) } } });
  await prisma.requisition.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });

  // The three from seedHiring keep their rows; give them codes and Keka's fields.
  const base = await prisma.requisition.findMany({ where: { tenantId, title: { in: ["Product Designer", "Growth Marketer", "Senior Backend Engineer"] } }, orderBy: { createdAt: "asc" } });
  const codes = (await prisma.requisition.findMany({ where: { tenantId, code: { not: null } }, select: { code: true } })).map((r) => r.code);
  const nextCode = () => { const c = svc.nextRequisitionCode(codes); codes.push(c); return c; };
  const [design, mktg, plat, prod, fin, sales, cs] = await Promise.all(["DSGN", "MKTG", "PLAT", "PROD", "FIN", "SALES", "CS"].map(dept));
  const [blr, mum, che, hyd] = await Promise.all(["Bengaluru", "Mumbai", "Chennai", "Hyderabad"].map(loc));

  const trail: Array<{ id: string; actor: string; summary: string; at: Date; action: "CREATE" | "APPROVE" | "REJECT" | "UPDATE" }> = [];
  const baseFields: Record<string, Partial<Prisma.RequisitionUncheckedUpdateInput> & { at: number }> = {
    "Product Designer": {
      at: -9, departmentId: design.id, businessUnitId: design.businessUnitId, locationId: blr, minExperienceYears: 4, newPositions: 1, positions: 1,
      salaryMin: 1400000, salaryMax: 2200000, salaryFrequency: "ANNUAL", minAnnualCtc: 1400000, maxAnnualCtc: 2200000, employmentType: "PERMANENT",
      approverUserId: vikram, targetStartDate: new Date(today.getTime() + 45 * DAY), hiringManagerId: emp("ACM0013"), recruiterId: priya,
      description: TEMPLATES[1][1], justification: "Second designer for the mobile app redesign.",
    },
    "Growth Marketer": {
      at: -25, departmentId: mktg.id, businessUnitId: mktg.businessUnitId, locationId: mum, minExperienceYears: 3, newPositions: 1, positions: 1,
      salaryMin: 1000000, salaryMax: 1500000, salaryFrequency: "ANNUAL", minAnnualCtc: 1000000, maxAnnualCtc: 1500000, employmentType: "PERMANENT",
      approverUserId: vikram, description: jd("Run paid acquisition experiments across search and social for our SMB plan.",
        ["Plan and run paid campaigns end to end", "Own CAC and payback reporting", "Work with design on landing pages"],
        ["3+ years in performance marketing", "Hands-on with Google Ads and Meta Ads", "Comfort with analytics and attribution"]),
      justification: "Paid acquisition experiments.",
    },
    "Senior Backend Engineer": {
      at: -30, departmentId: plat.id, businessUnitId: plat.businessUnitId, locationId: blr, minExperienceYears: 6, newPositions: 2, positions: 2, isPriority: true,
      salaryMin: 2400000, salaryMax: 3600000, salaryFrequency: "ANNUAL", minAnnualCtc: 2400000, maxAnnualCtc: 3600000, employmentType: "PERMANENT",
      approverUserId: vikram, hiringManagerId: emp("ACM0005"), recruiterId: priya,
      description: jd("Own the payments ledger service end to end as we scale for the festive season.",
        ["Design and build ledger and settlement services", "Make every money movement idempotent and auditable", "Lead incident reviews and reliability work", "Mentor engineers on the platform team"],
        ["6+ years building backend services in production", "Deep experience with relational databases and transactions", "Has run services with real on-call and SLOs", "Clear written design docs"],
        ["Payments, UPI or banking integrations"]),
      justification: "Payments platform scale-out ahead of the festive season.",
    },
  };
  for (const r of base) {
    const f = baseFields[r.title];
    const createdAt = new Date(today.getTime() + f.at * DAY);
    const { at: _at, ...data } = f;
    await prisma.requisition.update({ where: { id: r.id }, data: { ...data, code: r.code ?? nextCode(), currency: "INR", jobType: "FULL_TIME", raisedBy: priya, createdAt } });
    await prisma.auditLog.deleteMany({ where: { tenantId, entityType: "Requisition", entityId: r.id } });
    trail.push({ id: r.id, actor: priya, summary: "Created Requisition", at: createdAt, action: "CREATE" });
    if (r.status === "APPROVED" || r.status === "FULFILLED") {
      await prisma.requisition.update({ where: { id: r.id }, data: { approvedBy: vikram, approvedAt: new Date(createdAt.getTime() + DAY) } });
      trail.push({ id: r.id, actor: vikram, summary: "Approved Requisition", at: new Date(createdAt.getTime() + DAY), action: "APPROVE" });
    }
    if (r.status === "REJECTED") trail.push({ id: r.id, actor: vikram, summary: `Rejected Requisition: ${r.rejectReason ?? "Deferred to Q4 budget."}`, at: new Date(createdAt.getTime() + 2 * DAY), action: "REJECT" });
  }

  type New = {
    title: string; d: { id: string; businessUnitId: string | null }; loc: string; exp: number; newPositions: number; backfills?: Array<[string, string]>;
    salary: [number, number, "ANNUAL" | "MONTHLY"]; at: number; priority?: boolean; raisedBy: string; approver: string | null;
    status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED"; archived?: boolean; reason?: string; jobType?: string; employmentType?: string; desc: string; comments?: string;
  };
  const fresh: New[] = [
    { title: "Software Engineer", d: prod, loc: blr, exp: 2, newPositions: 1, backfills: [["Gaurav Mishra", "RELIEVED"]], salary: [1200000, 1800000, "ANNUAL"], at: -6, priority: true, raisedBy: priya, approver: vikram, status: "PENDING_APPROVAL", employmentType: "PERMANENT", desc: TEMPLATES[0][1], comments: "Gaurav's last day is 31 Oct; we need overlap for the checkout handover." },
    { title: "Data Analyst", d: fin, loc: mum, exp: 2, newPositions: 1, salary: [900000, 1400000, "ANNUAL"], at: -4, priority: true, raisedBy: priya, approver: vikram, status: "PENDING_APPROVAL", employmentType: "PERMANENT",
      desc: jd("Turn payroll, headcount and revenue data into decisions for the finance team.", ["Build and maintain finance dashboards", "Own the monthly variance analysis", "Automate recurring reports"], ["2+ years in analytics with SQL", "Strong Excel and one BI tool", "Comfort explaining numbers to non-analysts"]) },
    { title: "Account Executive", d: sales, loc: mum, exp: 1, newPositions: 3, salary: [600000, 900000, "ANNUAL"], at: -3, raisedBy: priya, approver: vikram, status: "PENDING_APPROVAL", employmentType: "PERMANENT", desc: TEMPLATES[2][1], comments: "West region expansion; three hires to cover Mumbai, Pune and Ahmedabad." },
    { title: "DevOps Engineer", d: plat, loc: hyd, exp: 5, newPositions: 1, salary: [150000, 220000, "MONTHLY"], at: -2, raisedBy: priya, approver: vikram, status: "PENDING_APPROVAL", employmentType: "CONTRACT",
      desc: jd("Run and harden the infrastructure behind our platform as we move to multi-region.", ["Own CI/CD and infrastructure as code", "Improve observability and incident response", "Drive cost and capacity planning"], ["5+ years in DevOps or SRE roles", "Hands-on with Kubernetes and Terraform", "Strong Linux and networking basics"]) },
    { title: "Engineering Manager - Payments", d: plat, loc: blr, exp: 8, newPositions: 1, salary: [4500000, 6000000, "ANNUAL"], at: -1, raisedBy: sneha, approver: priya, status: "PENDING_APPROVAL", employmentType: "PERMANENT",
      desc: jd("Lead the payments squad: people, delivery and the reliability of everything that moves money.", ["Hire, grow and retain a team of 6-8 engineers", "Own delivery and quality for payments", "Partner with product and finance on the roadmap"], ["8+ years in engineering, 2+ leading teams", "Background in backend or payments systems", "Track record of growing engineers"]) },
    { title: "Customer Success Manager", d: cs, loc: che, exp: 4, newPositions: 0, backfills: [["Anjali Desai", "RELOCATED"]], salary: [1000000, 1500000, "ANNUAL"], at: -12, raisedBy: priya, approver: vikram, status: "APPROVED", employmentType: "PERMANENT",
      desc: jd("Own a book of mid-market customers from onboarding to renewal.", ["Run onboarding and quarterly business reviews", "Drive adoption and renewals", "Be the customer's voice to product"], ["4+ years in customer success for B2B SaaS", "Calm with escalations", "Data-driven account planning"]) },
    { title: "Technical Writer", d: prod, loc: blr, exp: 3, newPositions: 1, salary: [800000, 1200000, "ANNUAL"], at: -40, raisedBy: priya, approver: vikram, status: "REJECTED", archived: true, reason: "Merged into the documentation agency contract.", employmentType: "CONTRACT",
      desc: jd("Write the help centre and API docs for our payroll product.", ["Own help-centre articles", "Document APIs with engineers"], ["3+ years of technical writing", "Comfort reading code samples"]) },
  ];
  for (const n of fresh) {
    const createdAt = new Date(today.getTime() + n.at * DAY);
    const backfills = (n.backfills ?? []).map(([name, reason]) => ({ employeeId: byName(name), reason })).filter((b): b is { employeeId: string; reason: string } => !!b.employeeId);
    const [min, max, freq] = n.salary;
    const budget = svc.annualBudget({ currency: "INR", salaryMin: min, salaryMax: max, salaryFrequency: freq });
    const r = await prisma.requisition.create({
      data: {
        tenantId, code: nextCode(), title: n.title, type: n.newPositions ? "NEW_HIRE" : "BACKFILL", status: n.status,
        departmentId: n.d.id, businessUnitId: n.d.businessUnitId, locationId: n.loc, minExperienceYears: n.exp,
        newPositions: n.newPositions, positions: n.newPositions + backfills.length, isPriority: !!n.priority,
        replacingEmployeeId: backfills[0]?.employeeId ?? null,
        currency: "INR", salaryMin: min, salaryMax: max, salaryFrequency: freq, minAnnualCtc: budget.minAnnualCtc, maxAnnualCtc: budget.maxAnnualCtc,
        jobType: n.jobType ?? "FULL_TIME", employmentType: n.employmentType ?? null, description: n.desc, justification: n.comments ?? null,
        targetStartDate: new Date(today.getTime() + 50 * DAY), raisedBy: n.raisedBy, approverUserId: n.approver, recruiterId: priya,
        approvedBy: n.status === "APPROVED" ? vikram : null, approvedAt: n.status === "APPROVED" ? new Date(createdAt.getTime() + DAY) : null,
        rejectReason: n.status === "REJECTED" ? n.reason ?? null : null,
        archivedAt: n.archived ? new Date(createdAt.getTime() + 5 * DAY) : null, archivedBy: n.archived ? priya : null,
        createdAt,
        backfills: { create: backfills.map((b) => ({ tenantId, employeeId: b.employeeId, reason: b.reason as never })) },
      },
    });
    trail.push({ id: r.id, actor: n.raisedBy, summary: "Created Requisition", at: createdAt, action: "CREATE" });
    if (n.status === "APPROVED") trail.push({ id: r.id, actor: vikram, summary: "Approved Requisition", at: new Date(createdAt.getTime() + DAY), action: "APPROVE" });
    if (n.status === "REJECTED") trail.push({ id: r.id, actor: vikram, summary: `Rejected Requisition: ${n.reason}`, at: new Date(createdAt.getTime() + 2 * DAY), action: "REJECT" });
    if (n.archived) trail.push({ id: r.id, actor: priya, summary: "Archived Requisition", at: new Date(createdAt.getTime() + 5 * DAY), action: "UPDATE" });
  }
  const emails = new Map((await prisma.user.findMany({ where: { id: { in: [vikram, priya, sneha] } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]));
  await prisma.auditLog.createMany({
    data: trail.map((t) => ({ tenantId, module: "EMPLOYEE" as const, action: t.action, entityType: "Requisition", entityId: t.id, summary: t.summary, actorId: t.actor, actorLabel: emails.get(t.actor) ?? null, createdAt: t.at })),
  });

  // --- The backend job's interview kit, and Keka-form scorecards --------------------
  const job = await prisma.job.findFirst({ where: { tenantId, title: "Senior Backend Engineer" }, select: { id: true } });
  let converted = 0, interviews = 0;
  if (job) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        scorecardTemplate: BACKEND_KIT, minExperienceYears: 6,
        requirements: "6+ years building backend services; relational databases and transactions; on-call ownership; payments or ledger experience preferred.",
        description: baseFields["Senior Backend Engineer"].description as string,
      },
    });
    const cards = await prisma.scorecard.findMany({ where: { interview: { application: { tenantId } } }, include: { interview: { select: { application: { select: { jobId: true } } } } } });
    const offsets = [0, -1, 0, 1, 1, 0, -1, 0];
    for (const c of cards) {
      const kit = c.interview.application.jobId === job.id ? BACKEND_KIT : svc.DEFAULT_SCORECARD;
      const existing = svc.parseRatings(c.ratings).filter((r) => r.section !== "Overall");
      const decided = svc.normaliseDecision(c.recommendation);
      const centre = c.overallScore !== null ? Math.round(Number(c.overallScore)) : decided === "MUST_HIRE" ? 5 : decided === "HIRE" ? (c.notes?.includes("Concern") ? 3 : 4) : decided === "NO_HIRE" ? 2 : 3;
      let i = 0;
      const ratings = existing.length ? existing : kit.flatMap((sec) => sec.skills.map((sk) => ({ section: sec.section, skill: sk.name, rating: Math.max(1, Math.min(5, centre + offsets[i++ % offsets.length])), comment: null })));
      const decision = decided;
      const notes = c.notes ?? ([c.strengths, c.concerns ? `Concern: ${c.concerns}` : null].filter(Boolean).join(" ") || null);
      await prisma.scorecard.update({ where: { id: c.id }, data: { recommendation: decision, notes, ratings, overallScore: svc.ratingsAverage(ratings) } });
      converted++;
    }
    const apps = await prisma.application.findMany({ where: { tenantId, jobId: job.id }, include: { candidate: { select: { firstName: true } } } });
    for (const a of apps) await svc.recomputeApplicationScore(a.id);

    // Rohan's screening: Karthik has given feedback, Sneha has not — "Remind" and "+ Add feedback".
    const rohan = apps.find((a) => a.candidate.firstName === "Rohan");
    if (rohan) {
      await prisma.interview.deleteMany({ where: { applicationId: rohan.id, title: "Screening call" } });
      const iv = await prisma.interview.create({
        data: {
          applicationId: rohan.id, round: 1, title: "Screening call", scheduledAt: ist(today, -1, 11, 0), durationMinutes: 45, mode: "VIDEO", meetingUrl: "https://meet.example/rohan-screen",
          panel: { create: [{ employeeId: emp("ACM0005"), isLead: true, response: "ACCEPTED" }, { employeeId: emp("ACM0006"), response: "ACCEPTED" }] },
        },
      });
      const ratings = BACKEND_KIT.flatMap((sec) => sec.skills.map((sk, k) => ({ section: sec.section, skill: sk.name, rating: [4, 3, 4, 3][k] ?? 4, comment: k === 1 && sec.section === "Technical Skills" ? "Handled retries well; less sure on exactly-once semantics." : null })));
      await prisma.scorecard.create({
        data: {
          interviewId: iv.id, panelistId: emp("ACM0006"), status: "SUBMITTED", submittedAt: ist(today, -1, 12, 10), recommendation: "HIRE",
          notes: "Good grasp of API design and SQL. Walked through a recent incident clearly and owned his part in it. Needs depth on distributed transactions, which the technical round should probe.",
          ratings, overallScore: svc.ratingsAverage(ratings),
        },
      });
      interviews++;
      await svc.recomputeApplicationScore(rohan.id);
    }

    // Arjun: the panel's feedback summarised and kept; a note for the team.
    const arjun = apps.find((a) => a.candidate.firstName === "Arjun");
    const kabir = apps.find((a) => a.candidate.firstName === "Kabir");
    await prisma.candidateNote.deleteMany({ where: { tenantId, body: { in: NOTE_BODIES } } });
    if (arjun) {
      const panel = await prisma.scorecard.findMany({ where: { interview: { applicationId: arjun.id }, status: "SUBMITTED" }, select: { panelistId: true } });
      const lines: Record<string, string> = {
        [emp("ACM0006")]: "Clear thinking on consistency and idempotency; strong ownership of production issues.",
        [emp("ACM0014")]: "Excellent system design depth; would raise the bar on the team.",
        [emp("ACM0005")]: "Great culture add; motivated by the ledger problem space.",
      };
      await prisma.application.update({
        where: { id: arjun.id },
        data: {
          feedbackSummary: "The panel is unanimous and positive. Arjun showed clear thinking on consistency, idempotency and failure handling in payments flows, and strong ownership of production incidents. System design depth stood out in the technical round, and the manager round confirmed motivation for the ledger problem space and good collaboration habits. No significant risks were raised; one interviewer suggested pairing him early with the SRE team on on-call practices.",
          feedbackSummaryDetail: [...new Set(panel.map((p) => p.panelistId))].filter((id) => lines[id]).map((panelistId) => ({ panelistId, text: lines[panelistId] })),
          feedbackSummaryById: priya, feedbackSummaryAt: new Date(today.getTime() - 3 * DAY),
        },
      });
      await prisma.candidateNote.create({ data: { tenantId, applicationId: arjun.id, authorId: priya, body: NOTE_BODIES[0], createdAt: new Date(today.getTime() - 2 * DAY) } });
    }
    if (kabir) await prisma.candidateNote.create({ data: { tenantId, applicationId: kabir.id, authorId: sneha, body: NOTE_BODIES[1], createdAt: new Date(today.getTime() - DAY) } });

    // One question set, written by hand, so "View generated questions" shows something without an API key.
    await prisma.interviewQuestionSet.deleteMany({ where: { tenantId, createdById: null } });
    await prisma.interviewQuestionSet.create({
      data: {
        tenantId, jobId: job.id, section: "Soft Skills", attempt: 1, createdById: null,
        questions: [
          { skill: "Communication", questions: [
            "Tell us about a time you had to explain a technical trade-off to someone outside engineering. How did you make sure they understood?",
            "Describe a design document you wrote that changed someone's mind. What made it persuasive?",
            "How do you keep stakeholders informed during a long-running incident?",
            "Give an example of feedback you received about how you communicate, and what you changed.",
          ] },
          { skill: "Collaboration", questions: [
            "Describe a project where you depended on another team that had different priorities. How did you get it done?",
            "Tell us about a disagreement in a code review. How was it resolved?",
            "How have you helped a newer engineer on your team become productive?",
            "Describe a time you shared credit for a success. Why did it matter?",
          ] },
        ],
      },
    });
  }
  return { requisitions: base.length + fresh.length, templates: TEMPLATES.length, converted, interviews };
}
