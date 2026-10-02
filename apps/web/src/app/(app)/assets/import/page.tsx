import { redirect } from "next/navigation";

/** A bulk import starts from the Asset List's Bulk Add / Bulk Update. */
export default async function AssetImportStart({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  redirect(`/assets/list?import=${sp.mode === "UPDATE" ? "UPDATE" : "ADD"}${sp.type ? `&type=${encodeURIComponent(sp.type)}` : ""}`);
}
