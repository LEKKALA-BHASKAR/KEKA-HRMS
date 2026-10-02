import { prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { courseCompletionPct, gradeAttempt, validateQuestion, type QuestionInput } from "./performance-learning-math";

export * from "./performance-learning-math";

/**
 * Perform's 1:1 meetings and Learn's self-paced courses.
 *
 * A 1:1 is a Meeting with meetingType ONE_ON_ONE between a manager and one of
 * their reports; `minutes` holds the notes both of them share, private notes
 * live in their own table and never leave their author. A course is a
 * TrainingProgram with format COURSE; an enrolment's progress and score are
 * derived from module completions and assessment attempts, never typed in.
 */

export const RECURRENCES = ["NONE", "WEEKLY", "BIWEEKLY", "MONTHLY"] as const;
export type Recurrence = (typeof RECURRENCES)[number];
/** How many meetings one "repeat" creates. */
export const SERIES_LENGTH = 6;

function shift(d: Date, recurrence: Recurrence, n: number): Date {
  const x = new Date(d.getTime());
  if (recurrence === "WEEKLY") x.setUTCDate(x.getUTCDate() + 7 * n);
  else if (recurrence === "BIWEEKLY") x.setUTCDate(x.getUTCDate() + 14 * n);
  else if (recurrence === "MONTHLY") x.setUTCMonth(x.getUTCMonth() + n);
  return x;
}

export interface ScheduleInput {
  tenantId: string;
  organiserId: string;
  employeeId: string;
  optionalIds?: string[];
  title: string;
  startsAt: Date;
  endsAt: Date;
  roomId?: string | null;
  meetingUrl?: string | null;
  purpose?: string | null;
  agenda?: string | null;
  templateId?: string | null;
  recurrence: Recurrence;
}

/**
 * Create a 1:1 (or a series of them). The caller has already decided the two
 * people may meet; this checks the times and writes the meeting rows, the
 * attendee list and the invitations.
 */
export async function scheduleOneOnOne(i: ScheduleInput): Promise<{ ok: boolean; message: string; meetingIds?: string[] }> {
  if (i.organiserId === i.employeeId) return { ok: false, message: "A 1:1 needs two people." };
  if (!(i.endsAt.getTime() > i.startsAt.getTime())) return { ok: false, message: "The meeting must end after it starts." };
  if (i.endsAt.getTime() - i.startsAt.getTime() > 8 * 3_600_000) return { ok: false, message: "Keep a 1:1 under eight hours." };
  const optional = [...new Set((i.optionalIds ?? []).filter((x) => x !== i.organiserId && x !== i.employeeId))];
  const count = i.recurrence === "NONE" ? 1 : SERIES_LENGTH;
  const seriesId = count > 1 ? `series_${i.organiserId.slice(-6)}_${Date.now().toString(36)}` : null;
  const ids: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (let n = 0; n < count; n++) {
      const m = await tx.meeting.create({
        data: {
          tenantId: i.tenantId, meetingType: "ONE_ON_ONE", title: i.title,
          startsAt: shift(i.startsAt, i.recurrence, n), endsAt: shift(i.endsAt, i.recurrence, n),
          roomId: i.roomId ?? null, meetingUrl: i.meetingUrl ?? null,
          purpose: i.purpose ?? null, agenda: i.agenda ?? null, templateId: i.templateId ?? null,
          recurrence: i.recurrence, seriesId, organiserId: i.organiserId, status: "SCHEDULED",
          attendees: {
            create: [
              { employeeId: i.organiserId, attendance: "REQUIRED", response: "ACCEPTED" },
              { employeeId: i.employeeId, attendance: "REQUIRED", response: "PENDING" },
              ...optional.map((employeeId) => ({ employeeId, attendance: "OPTIONAL", response: "PENDING" })),
            ],
          },
        },
      });
      ids.push(m.id);
    }
  });
  const people = await prisma.employee.findMany({ where: { tenantId: i.tenantId, id: { in: [i.organiserId, i.employeeId, ...optional] } }, select: { id: true, userId: true, displayName: true } });
  const organiser = people.find((p) => p.id === i.organiserId);
  const when = `${i.startsAt.toISOString().slice(0, 10)} at ${i.startsAt.toISOString().slice(11, 16)}`;
  await notify({
    tenantId: i.tenantId, userIds: people.filter((p) => p.id !== i.organiserId).map((p) => p.userId), kind: "PERFORMANCE",
    title: `${organiser?.displayName ?? "Your manager"} scheduled a 1:1 with you`,
    body: `${i.title} — ${when}${count > 1 ? `, repeating ${i.recurrence.toLowerCase()}` : ""}`,
    link: `/performance/one-on-ones/${ids[0]}`,
  });
  return { ok: true, message: count > 1 ? `${count} meetings scheduled.` : "Meeting scheduled successfully.", meetingIds: ids };
}

/** The two people a 1:1 is between: its organiser and the other required attendee. */
export function oneOnOnePair(m: { organiserId: string | null; attendees: Array<{ employeeId: string; attendance: string }> }): [string, string] | null {
  const other = m.attendees.find((a) => a.employeeId !== m.organiserId && a.attendance === "REQUIRED");
  return m.organiserId && other ? [m.organiserId, other.employeeId] : null;
}

/** Busy blocks for people on a day: meetings they are in and approved leave. */
export async function busySlots(tenantId: string, employeeIds: string[], day: Date): Promise<Array<{ employeeId: string; start: Date; end: Date; label: string }>> {
  const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const to = new Date(from.getTime() + 86_400_000);
  const [meetings, leave] = await Promise.all([
    prisma.meetingAttendee.findMany({
      where: { employeeId: { in: employeeIds }, meeting: { tenantId, status: { not: "CANCELLED" }, startsAt: { lt: to }, endsAt: { gt: from } } },
      select: { employeeId: true, meeting: { select: { startsAt: true, endsAt: true, meetingType: true } } },
    }),
    prisma.leaveRequest.findMany({
      where: { tenantId, employeeId: { in: employeeIds }, status: "APPROVED", fromDate: { lt: to }, toDate: { gte: from } },
      select: { employeeId: true },
    }),
  ]);
  return [
    ...meetings.map((a) => ({ employeeId: a.employeeId, start: a.meeting.startsAt, end: a.meeting.endsAt, label: a.meeting.meetingType === "ONE_ON_ONE" ? "1:1" : "Meeting" })),
    ...leave.map((l) => ({ employeeId: l.employeeId, start: from, end: to, label: "On leave" })),
  ].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Open action items from this pair's earlier 1:1s, to carry into this one. */
export async function carriedOverActions(meetingId: string) {
  const m = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { tenantId: true, startsAt: true, organiserId: true, attendees: { select: { employeeId: true, attendance: true } } } });
  if (!m) return [];
  const pair = oneOnOnePair(m);
  if (!pair) return [];
  return prisma.meetingActionItem.findMany({
    where: {
      status: { in: ["OPEN", "IN_PROGRESS"] },
      meeting: {
        tenantId: m.tenantId, meetingType: "ONE_ON_ONE", id: { not: meetingId }, startsAt: { lt: m.startsAt },
        AND: pair.map((employeeId) => ({ attendees: { some: { employeeId } } })),
      },
    },
    include: { owner: { select: { id: true, displayName: true } }, meeting: { select: { id: true, startsAt: true } } },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
//  Learn
// ---------------------------------------------------------------------------

/** What stops a course from being published, if anything. */
export async function courseProblems(programId: string): Promise<string[]> {
  const modules = await prisma.courseModule.findMany({ where: { programId }, include: { questions: true } });
  const out: string[] = [];
  if (modules.length === 0) out.push("Add at least one module.");
  for (const m of modules) {
    if (m.type === "PAGE" && !m.body?.trim()) out.push(`“${m.title}” has no content yet.`);
    if (m.type === "VIDEO" && !m.url) out.push(`“${m.title}” needs a video link.`);
    if (m.type === "DOCUMENT" && !m.fileId) out.push(`“${m.title}” needs a document.`);
    if (m.type === "ASSESSMENT") {
      if (m.questions.length === 0) out.push(`The assessment “${m.title}” has no questions.`);
      if (m.passPercent === null) out.push(`The assessment “${m.title}” needs a pass mark.`);
      for (const q of m.questions) {
        const problem = validateQuestion({ type: q.type, prompt: q.prompt, options: q.options as unknown as QuestionInput["options"], correctOptionIds: q.correctOptionIds as unknown as string[] });
        if (problem) { out.push(`A question in “${m.title}”: ${problem}`); break; }
      }
    }
  }
  return out;
}

/**
 * Bring an enrolment's progress, status and score in line with its module
 * completions and attempts. Completion awards the course's skills to the
 * learner when those skills exist in the skills repository.
 */
export async function recomputeEnrolment(enrolmentId: string): Promise<{ progress: number; completed: boolean }> {
  const e = await prisma.trainingEnrolment.findUnique({
    where: { id: enrolmentId },
    include: { program: { select: { id: true, tenantId: true, skills: true, modules: { select: { id: true } } } }, moduleProgress: { select: { moduleId: true } }, attempts: { select: { scorePercent: true } } },
  });
  if (!e) return { progress: 0, completed: false };
  const ids = new Set(e.program.modules.map((m) => m.id));
  const done = e.moduleProgress.filter((p) => ids.has(p.moduleId)).length;
  const progress = courseCompletionPct(ids.size, done);
  const completed = ids.size > 0 && progress >= 100;
  const best = e.attempts.reduce<number | null>((b, a) => (b === null || Number(a.scorePercent) > b ? Number(a.scorePercent) : b), null);
  await prisma.trainingEnrolment.update({
    where: { id: enrolmentId },
    data: {
      progressPercent: progress,
      status: completed ? "COMPLETED" : progress > 0 || e.attempts.length > 0 ? "IN_PROGRESS" : e.status === "WITHDRAWN" ? "WITHDRAWN" : "ASSIGNED",
      completedAt: completed ? e.completedAt ?? new Date() : null,
      score: best,
    },
  });
  if (completed && !e.completedAt) {
    const names = Array.isArray(e.program.skills) ? (e.program.skills as unknown[]).filter((s): s is string => typeof s === "string") : [];
    if (names.length) {
      const skills = await prisma.skill.findMany({ where: { tenantId: e.program.tenantId, name: { in: names } }, select: { id: true } });
      for (const s of skills) {
        await prisma.employeeSkill.upsert({
          where: { employeeId_skillId: { employeeId: e.employeeId, skillId: s.id } },
          create: { employeeId: e.employeeId, skillId: s.id, level: 1, source: "COURSE_COMPLETION", isApproved: true, approvedAt: new Date() },
          update: {},
        });
      }
    }
  }
  return { progress, completed };
}

/** Mark a non-assessment module done (idempotent) and refresh the enrolment. */
export async function completeModule(enrolmentId: string, moduleId: string) {
  await prisma.moduleProgress.upsert({
    where: { enrolmentId_moduleId: { enrolmentId, moduleId } },
    create: { enrolmentId, moduleId },
    update: {},
  });
  return recomputeEnrolment(enrolmentId);
}

/**
 * Grade an assessment on the server (the browser never sees which options are
 * right), record the attempt, and complete the module on a pass.
 */
export async function submitAttempt(enrolmentId: string, moduleId: string, answers: Record<string, string[]>) {
  const mod = await prisma.courseModule.findUnique({ where: { id: moduleId }, include: { questions: { orderBy: { displayOrder: "asc" } } } });
  if (!mod || mod.type !== "ASSESSMENT") return { ok: false as const, message: "That is not an assessment." };
  if (mod.questions.length === 0) return { ok: false as const, message: "This assessment has no questions yet." };
  const graded = gradeAttempt(mod.questions.map((q) => ({ id: q.id, correctOptionIds: q.correctOptionIds as unknown as string[] })), answers);
  const passed = graded.percent >= (mod.passPercent ?? 0);
  const clean = Object.fromEntries(mod.questions.map((q) => [q.id, (answers[q.id] ?? []).slice(0, 6)]));
  await prisma.assessmentAttempt.create({
    data: { enrolmentId, moduleId, answers: clean, correctCount: graded.correct, totalCount: graded.total, scorePercent: graded.percent, passed },
  });
  if (passed) await prisma.moduleProgress.upsert({ where: { enrolmentId_moduleId: { enrolmentId, moduleId } }, create: { enrolmentId, moduleId }, update: {} });
  const r = await recomputeEnrolment(enrolmentId);
  return { ok: true as const, ...graded, passed, passPercent: mod.passPercent ?? 0, progress: r.progress, completed: r.completed };
}
