import { NextResponse, type NextRequest } from "next/server";
import { travelReport } from "@keka/services";
import { getViewer } from "@/lib/context";
import { moneyCsv } from "@/lib/money";
import { tripEmployeeScope, tripFilter, TRAVEL_REPORTS, type TravelReportKind } from "../data";

/** Travel reports as CSV, limited to the trips the viewer can see. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const k = sp.kind ?? "trips";
  if (!(k in TRAVEL_REPORTS)) return new NextResponse("Unknown report.", { status: 400 });
  const kind = k as TravelReportKind;
  const r = await travelReport(viewer.tenantId, kind, tripFilter(sp, await tripEmployeeScope(viewer)));
  return moneyCsv(viewer, { module: "FINANCE", filename: `travel-${kind}.csv`, head: r.head, rows: r.rows, entityType: "TravelReport", summary: `Exported ${r.title.toLowerCase()} (${r.rows.length} rows)` });
}
