import type { PrismaClient } from "@prisma/client";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/** A small deterministic generator, so every seed produces the same answers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const LEVELS = ["Beginner", "Working knowledge", "Proficient", "Expert"];

/**
 * Seeds surveys and polls, the skill catalogue, career paths, courses with
 * enrolments at every stage, and comp-off and encashment requests waiting
 * for a decision.
 *
 * The demo personas are left with something to do: Meera has a pulse survey
 * and a poll to answer and a mandatory course half done; Ananya (her
 * manager) has a comp-off to approve and a self-rated skill to confirm;
 * Priya (HR) has an encashment to approve.
 */
export async function seedEngageLearn(prisma: PrismaClient, ctx: { tenantId: string; empIdByNumber: Map<string, string> }) {
  const { tenantId } = ctx;
  const id = (n: string) => ctx.empIdByNumber.get(n)!;
  const rand = rng(20261001);
  const people = await prisma.employee.findMany({
    where: { tenantId, status: { notIn: ["EXITED", "INACTIVE"] } },
    select: { id: true, employeeNumber: true, departmentId: true, jobTitleName: true, reportingManagerId: true },
    orderBy: { employeeNumber: "asc" },
  });
  const vikramUser = (await prisma.employee.findUniqueOrThrow({ where: { id: id("ACM0001") }, select: { userId: true } })).userId;

  // ---------------------------------------------------------------------
  //  Surveys
  // ---------------------------------------------------------------------
  const engagementQs: Array<[string, "RATING" | "NPS" | "TEXT", string | null, number]> = [
    ["I am proud to work for this organisation.", "RATING", "Alignment", 0.6],
    ["I understand how my work contributes to company goals.", "RATING", "Alignment", 0.5],
    ["I receive appropriate recognition when I do good work.", "RATING", "Recognition", -0.4],
    ["I have had a conversation about my growth in the last six months.", "RATING", "Growth", -0.2],
    ["There are opportunities for me to learn new skills.", "RATING", "Growth", 0.3],
    ["My manager gives me useful feedback.", "RATING", "Manager", 0.4],
    ["I can switch off from work in my own time.", "RATING", "Wellbeing", -0.6],
    ["My team mates help each other out.", "RATING", "Peers", 0.8],
    ["Leadership keeps us informed about what is happening.", "RATING", "Communication", 0.1],
    ["How likely are you to recommend this organisation as a place to work?", "NPS", null, 0.3],
    ["What one thing would make this a better place to work?", "TEXT", null, 0],
  ];
  const comments = [
    "Clearer promotion criteria would help a lot.",
    "Fewer late-evening meetings with the US team.",
    "More recognition for the quiet work that keeps things running.",
    "A proper learning budget per person.",
    "Better onboarding documentation for new joiners.",
    "Keep the Friday demos — they are the best part of the week.",
    "Quieter spaces in the office for focused work.",
  ];
  /** A 1–5 score around 3.6 nudged by the question's bias. */
  const rating = (bias: number) => Math.max(1, Math.min(5, Math.round(3.6 + bias + (rand() - 0.5) * 2.6)));
  const nps = (bias: number) => Math.max(0, Math.min(10, Math.round(7.4 + bias * 2 + (rand() - 0.5) * 5)));

  const engagement = await prisma.survey.create({
    data: {
      tenantId, title: "H1 2026 Engagement Survey", kind: "ENGAGEMENT", status: "CLOSED", isAnonymous: true, minGroupSize: 3,
      description: "Our twice-yearly look at how it feels to work here. Results are shared with every team.",
      launchedAt: utc(2026, 7, 1), opensAt: utc(2026, 7, 1), closesAt: utc(2026, 7, 21), closedAt: utc(2026, 7, 21), createdBy: vikramUser,
      questions: { create: engagementQs.map(([prompt, type, driver], i) => ({ sequence: i + 1, prompt, type, driver, required: type !== "TEXT" })) },
    },
    include: { questions: true },
  });
  const respondents = people.filter((_, i) => i % 7 !== 3); // most, not all, took part
  for (const [i, p] of respondents.entries()) {
    await prisma.surveyParticipant.create({ data: { surveyId: engagement.id, employeeId: p.id, submittedAt: utc(2026, 7, 2 + (i % 15)) } });
    await prisma.surveyResponse.create({
      data: {
        surveyId: engagement.id, departmentId: p.departmentId, submittedAt: utc(2026, 7, 2 + ((i * 5) % 15)),
        answers: {
          create: engagement.questions.flatMap((q) => {
            const bias = engagementQs[q.sequence - 1][3];
            if (q.type === "RATING") return [{ questionId: q.id, score: rating(bias) }];
            if (q.type === "NPS") return [{ questionId: q.id, score: nps(bias) }];
            return i % 3 === 0 ? [{ questionId: q.id, text: comments[(i / 3) % comments.length] }] : [];
          }),
        },
      },
    });
  }

  const pulse = await prisma.survey.create({
    data: {
      tenantId, title: "October Pulse", kind: "PULSE", status: "ACTIVE", isAnonymous: true, minGroupSize: 3,
      description: "Five quick questions — two minutes, fully anonymous.",
      launchedAt: utc(2026, 9, 28), opensAt: utc(2026, 9, 28), closesAt: utc(2026, 10, 10), createdBy: vikramUser,
      questions: {
        create: [
          { sequence: 1, prompt: "I feel recognised for the work I do.", type: "RATING", driver: "Recognition" },
          { sequence: 2, prompt: "I have a clear path to grow here.", type: "RATING", driver: "Growth" },
          { sequence: 3, prompt: "My manager supports me when I need it.", type: "RATING", driver: "Manager" },
          { sequence: 4, prompt: "My workload is manageable.", type: "RATING", driver: "Wellbeing" },
          { sequence: 5, prompt: "Anything you would like us to know?", type: "TEXT", required: false },
        ],
      },
    },
    include: { questions: true },
  });
  // The personas have not answered yet, so the pulse is waiting for them.
  const skip = new Set(["ACM0001", "ACM0003", "ACM0005", "ACM0007", "ACM0009"]);
  const pulseDone = people.filter((p, i) => !skip.has(p.employeeNumber) && i % 3 === 0);
  for (const p of pulseDone) {
    await prisma.surveyParticipant.create({ data: { surveyId: pulse.id, employeeId: p.id, submittedAt: utc(2026, 9, 29) } });
    await prisma.surveyResponse.create({
      data: {
        surveyId: pulse.id, departmentId: p.departmentId, submittedAt: utc(2026, 9, 29),
        answers: { create: pulse.questions.filter((q) => q.type === "RATING").map((q) => ({ questionId: q.id, score: rating(q.sequence === 4 ? -0.5 : 0.1) })) },
      },
    });
  }

  const poll = await prisma.survey.create({
    data: {
      tenantId, title: "Diwali celebration", kind: "POLL", status: "ACTIVE", isAnonymous: true, minGroupSize: 1,
      launchedAt: utc(2026, 9, 29), opensAt: utc(2026, 9, 29), closesAt: utc(2026, 10, 15), createdBy: vikramUser,
      questions: { create: [{ sequence: 1, prompt: "Where should we celebrate Diwali this year?", type: "SINGLE_CHOICE", options: ["Office terrace party", "Team lunch at a restaurant", "Day trip to Nandi Hills"] }] },
    },
    include: { questions: true },
  });
  const voters = people.filter((p, i) => !skip.has(p.employeeNumber) && i % 2 === 1);
  for (const [i, p] of voters.entries()) {
    await prisma.surveyParticipant.create({ data: { surveyId: poll.id, employeeId: p.id, submittedAt: utc(2026, 9, 30) } });
    await prisma.surveyResponse.create({
      data: { surveyId: poll.id, departmentId: p.departmentId, submittedAt: utc(2026, 9, 30), answers: { create: [{ questionId: poll.questions[0].id, choices: [[0, 2, 0, 1, 2, 0][i % 6]] }] } },
    });
  }

  await prisma.survey.create({
    data: {
      tenantId, title: "Q3 eNPS check", kind: "ENPS", status: "DRAFT", isAnonymous: true, minGroupSize: 3, createdBy: vikramUser,
      questions: {
        create: [
          { sequence: 1, prompt: "How likely are you to recommend this organisation as a place to work?", type: "NPS" },
          { sequence: 2, prompt: "What is the main reason for your score?", type: "TEXT", required: false },
        ],
      },
    },
  });

  // ---------------------------------------------------------------------
  //  Skills and career paths
  // ---------------------------------------------------------------------
  const skillDefs: Array<[string, string]> = [
    ["TypeScript", "Engineering"], ["React", "Engineering"], ["Node.js", "Engineering"], ["SQL", "Engineering"],
    ["System Design", "Engineering"], ["Automated Testing", "Engineering"], ["Figma", "Design"],
    ["People Management", "Leadership"], ["Stakeholder Communication", "Leadership"], ["Negotiation", "Sales"],
    ["Information Security Awareness", "Compliance"],
  ];
  const skill = new Map<string, string>();
  for (const [name, category] of skillDefs) {
    skill.set(name, (await prisma.skill.create({ data: { tenantId, name, category, levels: LEVELS } })).id);
  }

  // Levels people hold, by job title — confirmed by their managers.
  const byTitle: Record<string, Array<[string, number]>> = {
    "Software Engineer": [["TypeScript", 1], ["React", 1], ["SQL", 0], ["Node.js", 1]],
    "Senior Software Engineer": [["TypeScript", 2], ["React", 2], ["SQL", 2], ["Node.js", 2], ["System Design", 1], ["Automated Testing", 1]],
    "Staff Engineer": [["TypeScript", 3], ["Node.js", 3], ["SQL", 2], ["System Design", 3], ["Stakeholder Communication", 2]],
    "Engineering Manager": [["TypeScript", 2], ["System Design", 2], ["People Management", 2], ["Stakeholder Communication", 2]],
    "Director of Engineering": [["System Design", 3], ["People Management", 3], ["Stakeholder Communication", 3]],
    "QA Engineer": [["Automated Testing", 2], ["SQL", 1]],
    "Product Designer": [["Figma", 3], ["Stakeholder Communication", 1]],
    "Account Executive": [["Negotiation", 1], ["Stakeholder Communication", 1]],
  };
  let skillRows = 0;
  for (const p of people) {
    for (const [name, level] of byTitle[p.jobTitleName ?? ""] ?? []) {
      // A little spread so not every Software Engineer is identical.
      const l = Math.max(0, Math.min(3, level + (rand() < 0.2 ? 1 : 0)));
      await prisma.employeeSkill.create({ data: { employeeId: p.id, skillId: skill.get(name)!, level: l, source: "MANAGER", isApproved: true, approvedBy: p.reportingManagerId, approvedAt: utc(2026, 6, 15) } });
      skillRows++;
    }
  }
  // Meera has rated herself on testing; Ananya has to confirm it.
  await prisma.employeeSkill.create({ data: { employeeId: id("ACM0009"), skillId: skill.get("Automated Testing")!, level: 1, source: "SELF", isApproved: false } });

  const step = async (pathId: string, sequence: number, title: string, minYears: number, description: string, reqs: Array<[string, number]>) => {
    const s = await prisma.careerPathStep.create({ data: { pathId, sequence, title, minYears, description } });
    for (const [name, level] of reqs) await prisma.careerStepSkill.create({ data: { stepId: s.id, skillId: skill.get(name)!, level } });
    return s;
  };
  const eng = await prisma.careerPath.create({ data: { tenantId, name: "Software Engineering", description: "The individual-contributor ladder for engineers." } });
  await step(eng.id, 1, "Software Engineer", 0, "Delivers well-scoped tasks with guidance.", [["TypeScript", 1], ["SQL", 0]]);
  const senior = await step(eng.id, 2, "Senior Software Engineer", 3, "Owns features end to end and reviews others' work.", [["TypeScript", 2], ["React", 2], ["SQL", 2], ["Automated Testing", 1], ["System Design", 1]]);
  await step(eng.id, 3, "Staff Engineer", 7, "Shapes the architecture across teams.", [["TypeScript", 3], ["System Design", 3], ["Stakeholder Communication", 2]]);
  const mgmt = await prisma.careerPath.create({ data: { tenantId, name: "Engineering Management", description: "From leading a team to leading an organisation." } });
  await step(mgmt.id, 1, "Engineering Manager", 6, "Leads a team of 5–8 engineers.", [["People Management", 2], ["System Design", 2], ["Stakeholder Communication", 2]]);
  await step(mgmt.id, 2, "Director of Engineering", 10, "Leads several teams and sets technical direction.", [["People Management", 3], ["Stakeholder Communication", 3], ["System Design", 3]]);
  const qa = await prisma.careerPath.create({ data: { tenantId, name: "Quality Engineering" } });
  await step(qa.id, 1, "QA Engineer", 0, "Tests features and automates regressions.", [["Automated Testing", 1]]);
  await step(qa.id, 2, "Senior QA Engineer", 4, "Owns the test strategy for a product area.", [["Automated Testing", 3], ["SQL", 2]]);
  const sales = await prisma.careerPath.create({ data: { tenantId, name: "Sales" } });
  await step(sales.id, 1, "Account Executive", 0, "Runs deals from first call to close.", [["Negotiation", 1]]);
  await step(sales.id, 2, "Senior Account Executive", 3, "Carries the largest accounts.", [["Negotiation", 2], ["Stakeholder Communication", 2]]);
  await prisma.careerAspiration.create({ data: { employeeId: id("ACM0009"), stepId: senior.id, note: "Aiming for senior by next April." } });

  // ---------------------------------------------------------------------
  //  Courses
  // ---------------------------------------------------------------------
  const course = async (data: {
    title: string; summary: string; category: string; level?: "BEGINNER" | "INTERMEDIATE" | "ADVANCED"; isMandatory?: boolean; dueInDays?: number;
    skillName?: string; skillLevel?: number; colour: string; status?: "DRAFT" | "PUBLISHED";
    lessons: Array<{ title: string; kind: "ARTICLE" | "VIDEO" | "DOCUMENT" | "QUIZ"; body?: string; url?: string; minutes: number; quiz?: Array<[string, string[], number]> }>;
  }) => prisma.course.create({
    data: {
      tenantId, title: data.title, summary: data.summary, category: data.category, level: data.level ?? "BEGINNER",
      isMandatory: data.isMandatory ?? false, dueInDays: data.dueInDays ?? null, status: data.status ?? "PUBLISHED",
      skillId: data.skillName ? skill.get(data.skillName)! : null, skillLevel: data.skillLevel ?? 1, coverColour: data.colour, createdBy: vikramUser,
      lessons: {
        create: data.lessons.map((l, i) => ({
          sequence: i + 1, title: l.title, kind: l.kind, body: l.body ?? null, url: l.url ?? null, durationMinutes: l.minutes,
          questions: l.quiz ? { create: l.quiz.map(([prompt, options, correctIndex], k) => ({ sequence: k + 1, prompt, options, correctIndex })) } : undefined,
        })),
      },
    },
    include: { lessons: true },
  });

  const infosec = await course({
    title: "Information Security Essentials", category: "Compliance", isMandatory: true, dueInDays: 30, colour: "#3b6fe0",
    skillName: "Information Security Awareness", skillLevel: 1,
    summary: "How to spot phishing, handle customer data and keep your laptop safe. Required for everyone, every year.",
    lessons: [
      { title: "Why security is everyone's job", kind: "ARTICLE", minutes: 6, body: "Most breaches do not start with a clever attack on our servers. They start with a convincing email, a reused password or a laptop left unlocked in a café.\n\nThis course covers the handful of habits that prevent the large majority of incidents. None of them take more than a few seconds a day." },
      { title: "Spotting a phishing email", kind: "ARTICLE", minutes: 8, body: "Check the sender's address, not just the display name. Hover over links before clicking. Be suspicious of urgency — 'your account will be closed today' — and of requests to bypass the normal process.\n\nIf in doubt, forward the email to security@acme.test and delete it. Reporting a false alarm costs nothing; missing a real one can cost a great deal." },
      { title: "Handling customer data", kind: "ARTICLE", minutes: 7, body: "Customer data stays in approved systems. Do not export it to personal drives, paste it into public tools, or attach it to email unless it is encrypted and the recipient is authorised.\n\nWhen you no longer need a copy, delete it." },
      { title: "Check your understanding", kind: "QUIZ", minutes: 5, quiz: [
        ["An email from 'IT Support' asks you to confirm your password urgently. What do you do?", ["Reply with the password", "Click the link and log in", "Report it to security and delete it"], 2],
        ["Where may customer data be stored?", ["Only in approved company systems", "On a personal USB drive if encrypted", "In any cloud folder"], 0],
        ["You are stepping away from your desk for two minutes. You should…", ["Leave it — it is only two minutes", "Lock your screen", "Close the lid only if it is the end of the day"], 1],
        ["Which is the strongest password practice?", ["A different long passphrase per site, kept in a password manager", "One strong password used everywhere", "Writing passwords on a sticky note"], 0],
      ] },
    ],
  });
  const posh = await course({
    title: "Prevention of Sexual Harassment (POSH)", category: "Compliance", isMandatory: true, dueInDays: 45, colour: "#9b7ede",
    summary: "What the POSH Act requires, what counts as harassment, and how the Internal Committee handles a complaint.",
    lessons: [
      { title: "The law and our policy", kind: "ARTICLE", minutes: 8, body: "The Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act, 2013 requires every organisation with ten or more employees to constitute an Internal Committee.\n\nOur policy applies to everyone — employees, interns, contractors and visitors — at the office, at client sites, at offsites and online." },
      { title: "Read the policy", kind: "DOCUMENT", minutes: 10, url: "https://www.indiacode.nic.in/handle/123456789/2104", body: "Read the full Act. Our own policy, in the Documents section, follows it closely." },
      { title: "Quiz", kind: "QUIZ", minutes: 5, quiz: [
        ["Who does our POSH policy cover?", ["Only permanent employees", "Everyone at work, including interns, contractors and visitors", "Only women employees"], 1],
        ["Who looks into a complaint?", ["Your reporting manager", "The Internal Committee", "The CEO"], 1],
        ["Does the policy apply at a team offsite?", ["Yes", "No"], 0],
      ] },
    ],
  });
  const ts = await course({
    title: "TypeScript Fundamentals", category: "Engineering", level: "BEGINNER", colour: "#36b8c9", skillName: "TypeScript", skillLevel: 1,
    summary: "Types, interfaces, generics and narrowing — enough to be productive in our codebase.",
    lessons: [
      { title: "Types and inference", kind: "VIDEO", minutes: 12, url: "https://www.youtube.com/watch?v=ahCwqrYpIuM", body: "Watch the overview, then try the examples in the playground." },
      { title: "Narrowing and unions", kind: "ARTICLE", minutes: 10, body: "A union type says a value is one of several shapes. Narrowing — with typeof, in, equality checks or a discriminant field — tells the compiler which one you have in each branch.\n\nPrefer a discriminated union over optional fields that only make sense together." },
      { title: "Quiz", kind: "QUIZ", minutes: 5, quiz: [
        ["What does `unknown` force you to do before using a value?", ["Nothing", "Narrow it to a specific type", "Cast it to any"], 1],
        ["Which is a discriminated union?", ["{ kind: 'a'; x: number } | { kind: 'b'; y: string }", "string | number", "Array<string>"], 0],
      ] },
    ],
  });
  const feedback = await course({
    title: "Giving Effective Feedback", category: "Leadership", level: "INTERMEDIATE", colour: "#f5b83d", dueInDays: 60,
    skillName: "People Management", skillLevel: 1,
    summary: "A simple structure for feedback people can act on — for managers and anyone who reviews others' work.",
    lessons: [
      { title: "Situation, behaviour, impact", kind: "ARTICLE", minutes: 8, body: "Describe the situation, the specific behaviour you saw, and its impact. Leave out guesses about intent.\n\nThen ask a question and listen." },
      { title: "Quiz", kind: "QUIZ", minutes: 4, quiz: [["Which is the best feedback?", ["You're careless.", "In Tuesday's release, the migration wasn't tested on staging, so checkout was down for 20 minutes.", "Try harder next time."], 1]] },
    ],
  });
  await course({
    title: "Advanced SQL for Analysts", category: "Data", level: "ADVANCED", colour: "#8bc34a", status: "DRAFT", skillName: "SQL", skillLevel: 2,
    summary: "Window functions, CTEs and reading a query plan.",
    lessons: [{ title: "Window functions", kind: "ARTICLE", minutes: 15, body: "Draft." }],
  });

  /** Enrol with a given number of lessons done; quiz lessons get a passing score. */
  let enrolments = 0;
  const enrol = async (c: Awaited<ReturnType<typeof course>>, employeeId: string, done: number, assignedAt: Date, opts: { due?: Date | null; source?: string } = {}) => {
    const lessons = [...c.lessons].sort((a, b) => a.sequence - b.sequence);
    const finished = lessons.slice(0, done);
    const complete = done >= lessons.length;
    const quizScores = finished.filter((l) => l.kind === "QUIZ").map(() => 75 + Math.floor(rand() * 6) * 5);
    await prisma.courseEnrolment.create({
      data: {
        tenantId, courseId: c.id, employeeId, source: opts.source ?? (c.isMandatory ? "MANDATORY" : "ASSIGNED"),
        assignedAt, dueDate: opts.due === undefined ? (c.dueInDays ? new Date(assignedAt.getTime() + c.dueInDays * 86_400_000) : null) : opts.due,
        status: complete ? "COMPLETED" : done > 0 ? "IN_PROGRESS" : "ASSIGNED",
        startedAt: done > 0 ? new Date(assignedAt.getTime() + 86_400_000) : null,
        completedAt: complete ? new Date(assignedAt.getTime() + 5 * 86_400_000) : null,
        progressPercent: Math.floor((done / lessons.length) * 100),
        score: quizScores.length ? Math.round(quizScores.reduce((a, b) => a + b, 0) / quizScores.length) : null,
        lessons: {
          create: finished.map((l) => ({
            lessonId: l.id, completedAt: new Date(assignedAt.getTime() + 2 * 86_400_000), attempts: 1,
            score: l.kind === "QUIZ" ? quizScores.shift() ?? 80 : null,
          })),
        },
      },
    });
    if (complete && c.skillId) {
      const has = await prisma.employeeSkill.findUnique({ where: { employeeId_skillId: { employeeId, skillId: c.skillId } } });
      if (!has) await prisma.employeeSkill.create({ data: { employeeId, skillId: c.skillId, level: c.skillLevel, source: "COURSE_COMPLETION", isApproved: true, approvedAt: assignedAt } });
    }
    enrolments++;
  };

  for (const [i, p] of people.entries()) {
    // Security: assigned 15 Sep; most done, a few behind, one not started.
    const sec = p.employeeNumber === "ACM0009" ? 2 : i % 6 === 0 ? 0 : i % 4 === 0 ? 2 : infosec.lessons.length;
    await enrol(infosec, p.id, sec, utc(2026, 9, 15));
    // POSH: assigned in July; everyone but two has finished.
    await enrol(posh, p.id, i % 13 === 5 ? 1 : posh.lessons.length, utc(2026, 7, 10));
  }
  for (const n of ["ACM0009", "ACM0010", "ACM0024", "ACM0025", "ACM0027", "ACM0026"]) {
    await enrol(ts, id(n), n === "ACM0010" ? ts.lessons.length : n === "ACM0009" ? 1 : n === "ACM0026" ? 0 : 2, utc(2026, 8, 20), { source: n === "ACM0010" ? "SELF" : "ASSIGNED" });
  }
  for (const n of ["ACM0005", "ACM0006", "ACM0007", "ACM0015", "ACM0013"]) {
    await enrol(feedback, id(n), n === "ACM0006" ? feedback.lessons.length : n === "ACM0007" ? 1 : 0, utc(2026, 9, 1));
  }

  // ---------------------------------------------------------------------
  //  Requests waiting on a decision
  // ---------------------------------------------------------------------
  await prisma.compOffRequest.create({
    data: {
      tenantId, employeeId: id("ACM0010"), fromDate: utc(2026, 9, 26), toDate: utc(2026, 9, 26), days: 1,
      note: "Production hotfix for the payments outage on Saturday.", createdAt: utc(2026, 9, 28),
    },
  });
  await prisma.compOffRequest.create({
    data: {
      tenantId, employeeId: id("ACM0011"), fromDate: utc(2026, 9, 20), toDate: utc(2026, 9, 20), days: 0.5, status: "REJECTED",
      note: "Regression run before release.", decidedBy: id("ACM0005"), decidedAt: utc(2026, 9, 22),
      decisionNote: "Only 2 hours recorded — please log your time next time and claim again.", createdAt: utc(2026, 9, 21),
    },
  });
  const svc = await import("@keka/services");
  const el = await prisma.leaveType.findFirst({ where: { tenantId, code: "EL" } });
  let encash = 0;
  if (el) {
    const r = await svc.raiseEncashmentRequest({ employeeId: id("ACM0008"), leaveTypeId: el.id, days: 3, note: "Family wedding expenses." });
    if (r.ok) encash++;
  }

  return {
    surveys: 4, responses: respondents.length + pulseDone.length + voters.length,
    skills: skillDefs.length, skillRows, paths: 4, courses: 5, enrolments, encash,
  };
}
