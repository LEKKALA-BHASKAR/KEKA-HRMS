import { hostSubdomain } from "@/lib/tenant-host";
import { ForgotForm } from "../auth-forms";

export const metadata = { title: "Reset password — BooS-HR" };

export default async function ForgotPage() {
  return <ForgotForm hasCompany={!!(await hostSubdomain())} />;
}
