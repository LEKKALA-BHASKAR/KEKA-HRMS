import { redirect } from "next/navigation";
import { getViewer } from "@/lib/context";
import { SignInForm } from "./form";

export const metadata = { title: "Sign in — Keka" };

export default async function SignInPage() {
  const viewer = await getViewer();
  if (viewer) redirect("/");
  return <SignInForm />;
}
