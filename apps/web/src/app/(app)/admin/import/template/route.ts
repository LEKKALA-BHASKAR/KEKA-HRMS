import { NextResponse } from "next/server";
import { requireViewer, can } from "@/lib/context";
import { IMPORTS, IMPORT_KINDS, templateCsv, type ImportKind } from "@/lib/imports";

export async function GET(req: Request) {
  const viewer = await requireViewer();
  const kind = new URL(req.url).searchParams.get("kind") as ImportKind;
  if (!IMPORT_KINDS.includes(kind)) return new NextResponse("Unknown import type", { status: 404 });
  if (!can(viewer, IMPORTS[kind].permission)) return new NextResponse("Forbidden", { status: 403 });
  return new NextResponse(templateCsv(kind), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${kind}-template.csv"`,
    },
  });
}
