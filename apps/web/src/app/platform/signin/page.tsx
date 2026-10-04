import { redirect } from "next/navigation";
import { getPlatformAdmin } from "@/lib/platform/session";
import { PlatformSignInForm } from "./form";

export const metadata = { title: "Platform sign in — BooS-HR" };

export default async function PlatformSignInPage({ searchParams }: { searchParams: Promise<{ changed?: string }> }) {
  if (await getPlatformAdmin()) redirect("/platform");
  const { changed } = await searchParams;
  return <PlatformSignInForm changed={!!changed} />;
}
