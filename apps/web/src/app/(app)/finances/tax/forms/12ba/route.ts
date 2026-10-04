import { NextResponse, type NextRequest } from "next/server";
import { form12baPdf } from "@keka/services";
import { getViewer } from "@/lib/context";

/** The signed-in employee's own Form 12BA for a year (?fy=). */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!viewer.employee) return new NextResponse("This login is not linked to an employee record.", { status: 404 });
  const fy = Number(req.nextUrl.searchParams.get("fy"));
  if (!(fy > 2000 && fy < 2100)) return new NextResponse("Choose a financial year.", { status: 400 });
  try {
    const f = await form12baPdf(viewer.tenantId, viewer.employee.id, fy);
    return new NextResponse(new Uint8Array(f.content), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${f.filename}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Could not build Form 12BA.", { status: 409 });
  }
}
