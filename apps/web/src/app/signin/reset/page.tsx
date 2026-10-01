import Link from "next/link";
import { findResetChallenge, securityPolicy, describePolicy } from "@/lib/auth-policy";
import { ResetForm } from "../auth-forms";
import { AuthLayout } from "../auth-layout";
import s from "../auth.module.css";

export const metadata = { title: "Choose a password — Keka" };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const challenge = token ? await findResetChallenge(token) : null;
  if (!token || !challenge) {
    return (
      <AuthLayout title="Link expired" subtitle="This reset link has expired or was already used.">
        <Link className={s.submit} href="/signin/forgot">Request a new link</Link>
        <div className={s.links}><Link href="/signin">Back to sign in</Link></div>
      </AuthLayout>
    );
  }
  return <ResetForm token={token} rules={describePolicy(await securityPolicy(challenge.tenantId))} />;
}
