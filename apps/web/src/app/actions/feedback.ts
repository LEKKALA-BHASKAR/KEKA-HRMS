"use server";

import { unstable_rethrow } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { notify } from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { foreignReference } from "@/lib/ownership";
import { directoryWhere, nameOf } from "@/lib/directory";
import { z, zId, parseForm, writeAudit, actionDone, toErrorState, type ActionState } from "@/lib/forms";
import { PRAISE_BADGES, MESSAGE_MAX, TOPIC_MAX } from "@/app/(app)/me/performance/constants";
import { givePraise } from "./workplace";
import { feedbackBlocker, feedbackRules } from "@/lib/talent";

/**
 * Praise and continuous feedback between colleagues, from Me → Performance.
 *
 * Praise is written by the workplace module's `givePraise`, the same path the
 * organisation praise wall uses; this wraps it with field-level validation,
 * an audit entry and a notification to the person praised. Feedback is
 * shared with its subject; an internal note is a manager's private record
 * about someone in their reporting line and is never shown or sent to them.
 */

const P = PERMISSIONS;
const PERF_PATH = "/me/performance";

const message = z.string().min(1, "Write a message").max(MESSAGE_MAX, `Keep it under ${MESSAGE_MAX} characters`);

const praiseSchema = z.object({
  toEmployeeId: zId(),
  badge: z.string().optional()
    .transform((v) => (v && v.length > 0 ? v : null))
    .refine((v) => v === null || (PRAISE_BADGES as readonly string[]).includes(v), "Pick a badge from the list"),
  message,
});

const feedbackSchema = z.object({
  aboutEmployeeId: zId(),
  kind: z.enum(["FEEDBACK", "INTERNAL_NOTE"]).default("FEEDBACK"),
  topic: z.string().max(TOPIC_MAX, `Keep it under ${TOPIC_MAX} characters`).optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  message,
});

/**
 * The colleague a form names: in this tenant, in the directory (not exited
 * or preboarding), and not the viewer. Returns an ActionState on failure.
 */
async function colleague(viewer: Viewer, field: string, id: string, values: Record<string, string>): Promise<
  { error: ActionState; person?: never } | { error?: never; person: { id: string; userId: string | null; name: string } }
> {
  const me = viewer.employee!.id;
  if (id === me) return { error: { ok: false, message: "Choose a colleague other than yourself.", errors: { [field]: "You cannot choose yourself" }, values } };
  const foreign = await foreignReference(viewer.tenantId, { employee: id });
  if (foreign) return { error: { ok: false, message: foreign, errors: { [field]: "Not found" }, values } };
  const person = await prisma.employee.findFirst({
    where: { id, ...directoryWhere(viewer.tenantId) },
    select: { id: true, userId: true, displayName: true, firstName: true, lastName: true },
  });
  if (!person) return { error: { ok: false, message: "That colleague is not in the directory.", errors: { [field]: "Not available" }, values } };
  return { person: { id: person.id, userId: person.userId, name: nameOf(person) } };
}

const echo = (formData: FormData) => {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string") out[k] = v.trim();
  return out;
};

export async function givePraiseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record is linked to this login." };
  if (!can(viewer, P.PRAISE_GIVE)) return { ok: false, message: "Your role does not allow giving praise." };
  const parsed = parseForm(praiseSchema, formData);
  if (parsed.state) return parsed.state;
  const { toEmployeeId, badge, message: text } = parsed.data;
  const values = echo(formData);

  const found = await colleague(viewer, "toEmployeeId", toEmployeeId, values);
  if (found.error) return found.error;
  const { person } = found;

  try {
    // The workplace module owns how praise is stored (public, on the wall).
    const fd = new FormData();
    fd.set("toEmployeeId", person.id);
    fd.set("message", text);
    if (badge) fd.set("badge", badge);
    const since = new Date(Date.now() - 5_000);
    await givePraise(fd);
    const praise = await prisma.praise.findFirst({
      where: { tenantId: viewer.tenantId, fromEmployeeId: viewer.employee.id, toEmployeeId: person.id, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" }, select: { id: true },
    });

    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "CREATE", entityType: "Praise", entityId: praise?.id ?? null,
      summary: `Praised ${person.name}${badge ? ` — ${badge}` : ""}`,
    });
    await notify({
      tenantId: viewer.tenantId, userIds: [person.userId], kind: "PRAISE",
      title: `${viewer.employee.displayName} praised you${badge ? ` — ${badge}` : ""}`,
      body: text, link: `${PERF_PATH}?tab=praises-received`,
      relatedType: "Praise", relatedId: praise?.id,
    });
    return actionDone([PERF_PATH, "/awards"], `Praise sent to ${person.name}.`);
  } catch (err) {
    unstable_rethrow(err);
    return toErrorState(err, values);
  }
}

export async function giveFeedbackAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record is linked to this login." };
  const parsed = parseForm(feedbackSchema, formData);
  if (parsed.state) return parsed.state;
  const { aboutEmployeeId, kind, topic, message: text } = parsed.data;
  const values = echo(formData);

  const found = await colleague(viewer, "aboutEmployeeId", aboutEmployeeId, values);
  if (found.error) return found.error;
  const { person } = found;
  const note = kind === "INTERNAL_NOTE";
  if (note && !viewer.allReportIds.has(person.id)) {
    return { ok: false, message: "Internal notes can only be written about people in your reporting line.", errors: { aboutEmployeeId: "Not in your reporting line" }, values };
  }
  // The company's feedback settings: who may give it, and whether anonymously.
  const anonymous = !note && formData.get("anonymous") === "on";
  if (!note) {
    const why = await feedbackBlocker(viewer.tenantId, viewer.employee.id, person.id);
    if (why) return { ok: false, message: why, errors: { aboutEmployeeId: "Not allowed" }, values };
    if (anonymous && !(await feedbackRules(viewer.tenantId)).allowAnonymous) return { ok: false, message: "Your company does not allow anonymous feedback.", values };
  }

  try {
    const row = await prisma.feedback.create({
      data: { tenantId: viewer.tenantId, fromEmployeeId: viewer.employee.id, aboutEmployeeId: person.id, kind, topic, message: text, isAnonymous: anonymous },
      select: { id: true },
    });
    // An internal note's words stay out of the audit trail and the subject's inbox.
    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "CREATE", entityType: "Feedback", entityId: row.id,
      summary: note ? `Internal note about ${person.name}` : `Feedback to ${person.name}${topic ? ` on ${topic}` : ""}`,
    });
    if (!note) {
      await notify({
        tenantId: viewer.tenantId, userIds: [person.userId], kind: "FEEDBACK",
        title: anonymous ? "A colleague shared feedback with you" : `${viewer.employee.displayName} shared feedback with you`,
        body: topic ? `${topic}: ${text}` : text, link: `${PERF_PATH}?tab=feedback-received`,
        relatedType: "Feedback", relatedId: row.id,
      });
    }
    return actionDone([PERF_PATH], note ? `Internal note about ${person.name} saved.` : `Feedback sent to ${person.name}.`);
  } catch (err) {
    unstable_rethrow(err);
    return toErrorState(err, values);
  }
}
