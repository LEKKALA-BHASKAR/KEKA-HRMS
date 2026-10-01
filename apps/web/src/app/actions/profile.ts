"use server";

import { prisma } from "@keka/db";
import { recomputeProfileCompletion } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { z, parseForm, writeAudit, actionDone, toErrorState, type ActionState } from "@/lib/forms";

/**
 * Self-service profile edits from the Home → Welcome screen. Every action
 * here writes only the signed-in person's own employee record: no id is read
 * from the form, so there is nothing to tamper with.
 */

const ABOUT_MAX = 1000;

const aboutSchema = z.object({
  aboutMe: z.string().max(ABOUT_MAX, `Keep it to ${ABOUT_MAX} characters or fewer`).optional().default(""),
});

/** "Introduce yourself": save (or clear) the viewer's About text. */
export async function saveAboutMeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record is linked to this login." };

  const parsed = parseForm(aboutSchema, formData);
  if (parsed.state) return parsed.state;
  // Normalise line endings and collapse runs of blank lines; keep the person's own paragraphs.
  const about = parsed.data.aboutMe.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() || null;

  try {
    const me = await prisma.employee.findFirst({
      where: { id: viewer.employee.id, tenantId: viewer.tenantId },
      select: { id: true, aboutMe: true },
    });
    if (!me) return { ok: false, message: "Your employee record could not be found." };
    if ((me.aboutMe ?? null) === about) return { ok: true, message: "No changes to save." };

    await prisma.employee.update({ where: { id: me.id }, data: { aboutMe: about } });
    await recomputeProfileCompletion(me.id);
    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "UPDATE", entityType: "Employee", entityId: me.id,
      summary: about ? "Updated their About (Introduce yourself)" : "Cleared their About (Introduce yourself)",
      oldValue: { aboutMe: me.aboutMe }, newValue: { aboutMe: about },
    });
    return actionDone(["/home/welcome", `/directory/${me.id}`], about ? "Saved. Colleagues will see this on your profile." : "Your About has been cleared.");
  } catch (err) {
    return toErrorState(err, { aboutMe: parsed.data.aboutMe });
  }
}
