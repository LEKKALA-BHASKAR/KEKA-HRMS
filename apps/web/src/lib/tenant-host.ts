import "server-only";
import { headers } from "next/headers";
import { prisma } from "@keka/db";
import { subdomainFromHost } from "./tenant-host-shared";

/** The subdomain in the request's host, e.g. "acme" for acme.boss-hr.com; null on the bare domain. */
export async function hostSubdomain(): Promise<string | null> {
  const h = await headers();
  return subdomainFromHost(h.get("host"));
}

/**
 * The company a public (signed-out) page belongs to, from the request's host:
 * acme.boss-hr.com → "acme". Signed-in pages take the company from the
 * session instead; this is for sign-in and pages anyone can open, like careers.
 */
export async function tenantFromHost(opts: { includeSuspended?: boolean } = {}) {
  const sub = await hostSubdomain();
  if (!sub) return null;
  const t = await prisma.tenant.findUnique({ where: { subdomain: sub }, select: { id: true, name: true, subdomain: true, isActive: true, suspendedReason: true, logoUrl: true } });
  // A suspended company has no public pages; only sign-in explains why.
  return t && (t.isActive || opts.includeSuspended) ? t : null;
}
