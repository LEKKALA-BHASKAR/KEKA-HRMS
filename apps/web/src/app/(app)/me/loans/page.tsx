import { redirect } from "next/navigation";

/** Loans moved to My Finances › Loans; keep old links (and their ?apply=1) working. */
export default async function MyLoansRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString();
  redirect(`/finances/loans${qs ? `?${qs}` : ""}`);
}
