import { redirect } from "next/navigation";
import { getViewer } from "@/lib/context";
import { safeNext } from "@/lib/safe-next";
import { SignInForm } from "./form";

export const metadata = { title: "Sign in — Keka" };


export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const viewer = await getViewer();
  const next = safeNext((await searchParams).next);
  if (viewer) redirect(next ?? "/");
  return <SignInForm next={next} />;
}
