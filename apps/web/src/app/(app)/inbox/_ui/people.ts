import "server-only";
import { prisma } from "@keka/db";

/**
 * Who did something, as the inbox shows them: a name and a picture — the
 * directory card, nothing more. Decision fields across modules store either
 * an employee id or a user id, so both are resolved, always within the
 * viewer's tenant.
 */
export interface PersonRef {
  /** The employee id, for a link to their directory card. */
  id: string | null;
  name: string;
  photoUrl: string | null;
}

export const SYSTEM: PersonRef = { id: null, name: "System", photoUrl: null };

export async function resolvePeople(tenantId: string, ids: Array<string | null | undefined>): Promise<Map<string, PersonRef>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x && x !== "system"))];
  const out = new Map<string, PersonRef>();
  if (wanted.length === 0) return out;
  const [employees, users] = await Promise.all([
    prisma.employee.findMany({
      where: { tenantId, id: { in: wanted } },
      select: { id: true, displayName: true, firstName: true, lastName: true, photoUrl: true },
    }),
    prisma.user.findMany({
      where: { tenantId, id: { in: wanted } },
      select: { id: true, employee: { select: { id: true, displayName: true, firstName: true, lastName: true, photoUrl: true } } },
    }),
  ]);
  for (const e of employees) out.set(e.id, { id: e.id, name: e.displayName ?? `${e.firstName} ${e.lastName}`, photoUrl: e.photoUrl });
  for (const u of users) {
    const e = u.employee;
    out.set(u.id, e
      ? { id: e.id, name: e.displayName ?? `${e.firstName} ${e.lastName}`, photoUrl: e.photoUrl }
      : { id: null, name: "Administrator", photoUrl: null });
  }
  return out;
}

/** Look one up, falling back to "System" for automated changes. */
export function who(map: Map<string, PersonRef>, id: string | null | undefined): PersonRef {
  if (!id || id === "system") return SYSTEM;
  return map.get(id) ?? { id: null, name: "Someone", photoUrl: null };
}
