import { redirect } from "next/navigation";
import { readPendingSignIn } from "@/lib/session";
import { VerifyForm } from "../auth-forms";

export const metadata = { title: "Verify — Keka" };

export default async function VerifyPage() {
  const pending = await readPendingSignIn();
  if (!pending) redirect("/signin");
  // Show the address partly masked, as it would appear on a shared screen.
  const [local, domain] = pending.email.split("@");
  return <VerifyForm email={`${local.slice(0, 2)}${"•".repeat(Math.max(1, local.length - 2))}@${domain}`} />;
}
