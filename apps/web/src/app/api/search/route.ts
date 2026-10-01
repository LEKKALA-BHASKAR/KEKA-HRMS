import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { getViewer } from "@/lib/context";
import { directoryWhere, nameOf } from "@/lib/directory";

/** Colleagues for the top-bar search: directory fields only, this tenant only. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ people: [] }, { status: 401 });
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 60);
  if (q.length < 2) return NextResponse.json({ people: [] });
  const like = { contains: q, mode: "insensitive" as const };
  const rows = await prisma.employee.findMany({
    where: { ...directoryWhere(viewer.tenantId), OR: [{ displayName: like }, { firstName: like }, { lastName: like }, { employeeNumber: like }, { jobTitleName: like }, { workEmail: like }] },
    select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true, photoUrl: true, department: { select: { name: true } } },
    orderBy: { firstName: "asc" }, take: 8,
  });
  return NextResponse.json(
    { people: rows.map((r) => ({ id: r.id, name: nameOf(r), title: r.jobTitleName, department: r.department?.name ?? null, photoUrl: r.photoUrl })) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
