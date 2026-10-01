"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { requireViewer } from "@/lib/context";
import { directoryWhere, nameOf } from "@/lib/directory";
import { z, parseForm, writeAudit, actionDone, toErrorState, type ActionState } from "@/lib/forms";
import { aiForViewer, aiText } from "@/lib/ai";

/**
 * The richer profile: answers to the organisation's "Introduce yourself"
 * questions, a professional summary, and the AI profile narrative. Answers
 * and the summary are only ever written to the signed-in person's own record.
 */

const P = PERMISSIONS;
const ANSWER_MAX = 1000;

const answerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().max(ANSWER_MAX, `Keep it to ${ANSWER_MAX} characters or fewer`).optional().default(""),
});

export async function saveProfileAnswerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record is linked to this login." };
  const parsed = parseForm(answerSchema, formData);
  if (parsed.state) return parsed.state;
  const q = await prisma.profileQuestion.findFirst({ where: { id: parsed.data.questionId, tenantId: viewer.tenantId, isActive: true }, select: { id: true, prompt: true } });
  if (!q) return { ok: false, message: "That question is no longer asked." };
  const text = parsed.data.answer.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const key = { questionId_employeeId: { questionId: q.id, employeeId: viewer.employee.id } };
  try {
    const before = await prisma.profileAnswer.findUnique({ where: key, select: { answer: true } });
    if (!text) {
      if (before) await prisma.profileAnswer.delete({ where: key });
    } else {
      await prisma.profileAnswer.upsert({ where: key, create: { questionId: q.id, employeeId: viewer.employee.id, answer: text }, update: { answer: text } });
    }
    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "UPDATE", entityType: "ProfileAnswer", entityId: q.id,
      summary: `${text ? "Answered" : "Cleared their answer to"} "${q.prompt}"`, oldValue: { answer: before?.answer ?? null }, newValue: { answer: text || null },
    });
    return actionDone(["/home/welcome", `/directory/${viewer.employee.id}`], text ? "Saved. Colleagues will see this on your profile." : "Your answer has been cleared.");
  } catch (err) {
    return toErrorState(err, { answer: parsed.data.answer });
  }
}

const summarySchema = z.object({
  professionalSummary: z.string().max(2000, "Keep it to 2,000 characters or fewer").optional().default(""),
});

export async function saveProfessionalSummaryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record is linked to this login." };
  const parsed = parseForm(summarySchema, formData);
  if (parsed.state) return parsed.state;
  const text = parsed.data.professionalSummary.replace(/\r\n?/g, "\n").trim() || null;
  const me = await prisma.employee.findFirst({ where: { id: viewer.employee.id, tenantId: viewer.tenantId }, select: { id: true, professionalSummary: true } });
  if (!me) return { ok: false, message: "Your employee record could not be found." };
  await prisma.employee.update({ where: { id: me.id }, data: { professionalSummary: text } });
  await writeAudit(viewer, {
    module: "EMPLOYEE", action: "UPDATE", entityType: "Employee", entityId: me.id, summary: "Updated their professional summary",
    oldValue: { professionalSummary: me.professionalSummary }, newValue: { professionalSummary: text },
  });
  return actionDone([`/directory/${me.id}`], "Professional summary saved.");
}

/**
 * A short narrative of someone's journey at the company, written from facts
 * only: first name, tenure, roles by year, awards, praise badge counts,
 * skills and completed trainings. Never salary, birth date, contact details,
 * documents, ratings or notes. Visible to the person and to anyone who may
 * view their record; nothing is stored.
 */
export async function profileNarrativeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("employeeId") ?? "");
  const e = await prisma.employee.findFirst({
    where: { ...directoryWhere(viewer.tenantId), id },
    select: {
      id: true, firstName: true, lastName: true, displayName: true, dateOfJoining: true, jobTitleName: true,
      departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true,
      department: { select: { name: true } },
      jobHistory: { orderBy: { effectiveFrom: "asc" }, select: { effectiveFrom: true, reason: true, jobTitle: { select: { name: true } } } },
      awards: { where: { isPublished: true }, select: { awardedOn: true, awardType: { select: { name: true } } } },
      praiseReceived: { where: { isPublic: true }, select: { badge: true } },
      employeeSkills: { select: { skill: { select: { name: true } } } },
      trainingEnrolments: { where: { status: "COMPLETED" }, select: { program: { select: { title: true } } } },
    },
  });
  const isSelf = viewer.employee?.id === id;
  if (!e || (!isSelf && !canAccessEmployee(viewer, e, P.EMPLOYEE_VIEW))) return { ok: false, message: "You can generate a narrative for yourself, or for people whose record you can view." };

  const years = Math.max(0, (Date.now() - e.dateOfJoining.getTime()) / (365.25 * 86_400_000));
  const badges = new Map<string, number>();
  for (const p of e.praiseReceived) if (p.badge) badges.set(p.badge, (badges.get(p.badge) ?? 0) + 1);
  const facts = [
    `First name: ${e.firstName}`,
    `Joined: ${e.dateOfJoining.getUTCFullYear()} (${years.toFixed(1)} years)`,
    `Current role: ${e.jobTitleName ?? "—"}${e.department ? `, ${e.department.name}` : ""}`,
    e.jobHistory.length ? `Role history: ${e.jobHistory.map((j) => `${j.effectiveFrom.getUTCFullYear()} ${j.jobTitle?.name ?? j.reason.toLowerCase().replace(/_/g, " ")}`).join("; ")}` : null,
    e.awards.length ? `Awards: ${e.awards.map((a) => `${a.awardType.name} (${a.awardedOn.getUTCFullYear()})`).join("; ")}` : null,
    badges.size ? `Praise from colleagues: ${[...badges].map(([b, n]) => `${b} ×${n}`).join(", ")} (${e.praiseReceived.length} in all)` : (e.praiseReceived.length ? `Praise from colleagues: ${e.praiseReceived.length}` : null),
    e.employeeSkills.length ? `Skills: ${e.employeeSkills.map((s) => s.skill.name).join(", ")}` : null,
    e.trainingEnrolments.length ? `Completed training: ${e.trainingEnrolments.map((t) => t.program.title).join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const result = await aiForViewer(viewer, { feature: "PROFILE_NARRATIVE", subjectId: e.id, inputChars: facts.length }, () => aiText({
    system: "You write a short, warm third-person narrative of an employee's journey at their company for their internal profile. Use only the facts given; never invent projects, numbers or opinions. Three or four sentences, plain English, no headings, no lists.",
    prompt: facts, maxTokens: 350,
  }));
  if (!result.ok) return { ok: false, message: result.reason };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "VIEW", entityType: "Employee", entityId: e.id, summary: `Generated a profile narrative for ${nameOf(e)}` });
  return { ok: true, message: "Generated by AI · may be inaccurate", values: { text: result.value.slice(0, 1500) } };
}
