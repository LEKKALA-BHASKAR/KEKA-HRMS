import { redirect } from "next/navigation";
import { getViewer } from "@/lib/context";
import { safeNext } from "@/lib/safe-next";
import { prisma } from "@keka/db";
import { tenantFromHost, hostSubdomain } from "@/lib/tenant-host";
import { SSO_ERRORS } from "../auth/sso/_lib";
import { SignInForm } from "./form";

export const metadata = { title: "Sign in — BooS-HR" };


export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[]; sso?: string }> }) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (viewer) redirect(next ?? "/");
  const tenant = await tenantFromHost({ includeSuspended: true });
  const sub = await hostSubdomain();
  // An address no company owns, or a suspended company: say so instead of offering a form that cannot work.
  const blocked = sub && !tenant ? "There is no BooS-HR company at this address. Check the link your administrator sent you."
    : tenant && !tenant.isActive ? `${tenant.name}'s BooS-HR account is suspended${tenant.suspendedReason ? `: ${tenant.suspendedReason}` : "."} Contact your administrator.`
    : null;
  const conn = tenant?.isActive ? await prisma.ssoConnection.findUnique({ where: { tenantId: tenant.id }, select: { enabled: true, enforced: true, providerName: true } }) : null;
  const ssoError = sp.sso && sp.sso in SSO_ERRORS ? SSO_ERRORS[sp.sso as keyof typeof SSO_ERRORS] : null;
  return (
    <SignInForm
      next={next}
      company={tenant ? { subdomain: tenant.subdomain, name: tenant.name } : null}
      blocked={blocked}
      sso={conn?.enabled ? { name: conn.providerName, required: conn.enforced } : null}
      ssoError={ssoError}
    />
  );
}
