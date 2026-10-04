import { redirect } from "next/navigation";
import { getViewer } from "@/lib/context";
import { safeNext } from "@/lib/safe-next";
import { prisma } from "@keka/db";
import { tenantFromHost } from "@/lib/tenant-host";
import { SSO_ERRORS } from "../auth/sso/_lib";
import { SignInForm } from "./form";

export const metadata = { title: "Sign in — BooS-HR" };


export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[]; sso?: string }> }) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (viewer) redirect(next ?? "/");
  const tenant = await tenantFromHost();
  const conn = tenant ? await prisma.ssoConnection.findUnique({ where: { tenantId: tenant.id }, select: { enabled: true, enforced: true, providerName: true } }) : null;
  const ssoError = sp.sso && sp.sso in SSO_ERRORS ? SSO_ERRORS[sp.sso as keyof typeof SSO_ERRORS] : null;
  return <SignInForm next={next} sso={conn?.enabled ? { name: conn.providerName, required: conn.enforced } : null} ssoError={ssoError} />;
}
