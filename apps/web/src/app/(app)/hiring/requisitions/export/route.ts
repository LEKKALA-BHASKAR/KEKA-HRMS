import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { getViewer, canAny } from "@/lib/context";
import { requisitionRows, readFilters, type View } from "../../_lib/data";

const P = PERMISSIONS;

/** The requisitions list as CSV — exactly the rows the screen shows for the same view and filters. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!canAny(viewer, [P.REQUISITION_VIEW, P.REQUISITION_MANAGE, P.REQUISITION_APPROVE])) return new NextResponse("Forbidden.", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const view: View = sp.view === "pending" ? "pending" : sp.view === "archived" ? "archived" : "all";
  const { rows } = await requisitionRows(viewer, view, readFilters(sp), { all: true });
  // Spreadsheet apps execute cells that start with = + - @; neutralise them.
  const esc = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ["Code", "Requisition For", "Department", "Requested By", "Requested On", "Location", "Priority", "Positions", "Open Positions", "Salary Range", "Status", ""];
  const lines = [
    head.slice(0, -1).map(esc).join(","),
    ...rows.map((r) => [r.code ?? "", r.title, r.department, r.requestedBy, r.requestedOn, r.location, r.priority ? "Yes" : "No", String(r.positions), String(r.openPositions), r.salary, [r.status, r.statusSub].filter(Boolean).join(" ")].map(esc).join(",")),
  ];
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "EMPLOYEE", action: "EXPORT", entityType: "Requisition", summary: `Exported ${rows.length} requisitions (${view})`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse("﻿" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="requisitions-${view}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
