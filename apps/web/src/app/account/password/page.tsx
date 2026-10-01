import { requireViewer } from "@/lib/context";
import { securityPolicy, describePolicy } from "@/lib/auth-policy";
import { ChangePasswordForm } from "../../signin/auth-forms";

export const metadata = { title: "Change password — Keka" };

export default async function ChangePasswordPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  const viewer = await requireViewer();
  const { required } = await searchParams;
  return <ChangePasswordForm required={!!required || viewer.user.mustChangePassword} rules={describePolicy(await securityPolicy(viewer.tenantId))} />;
}
