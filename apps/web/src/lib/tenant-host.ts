import "server-only";
import { headers } from "next/headers";
import { prisma } from "@keka/db";

/**
 * The company a public (signed-out) page belongs to, from the request's host:
 * acme.keka.example → "acme". Signed-in pages take the company from the
 * session instead; this is only for pages anyone can open, like careers.
 */
export async function tenantFromHost() {
  const host = ((await headers()).get("host") ?? "").toLowerCase().split(":")[0];
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  return prisma.tenant.findUnique({ where: { subdomain: labels[0] }, select: { id: true, name: true, subdomain: true } });
}
