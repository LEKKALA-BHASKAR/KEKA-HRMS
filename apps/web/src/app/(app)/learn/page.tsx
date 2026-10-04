import { redirect } from "next/navigation";

/** Learn opens on the learner's own courses; old ?tab= links land on their new pages. */
const TABS: Record<string, string> = { mine: "/learn/my-courses", catalogue: "/learn/library", manage: "/learn/manage-courses", team: "/learn/reports" };

export default async function LearnPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  redirect(TABS[sp.tab ?? ""] ?? "/learn/my-courses");
}
