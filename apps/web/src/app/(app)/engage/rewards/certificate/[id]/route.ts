import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { PdfDoc } from "@keka/documents";
import { getViewer, can } from "@/lib/context";

const GOLD: [number, number, number] = [0.78, 0.6, 0.18];
const INK: [number, number, number] = [0.12, 0.16, 0.26];
const MUTED: [number, number, number] = [0.42, 0.45, 0.52];

/**
 * Certificate of appreciation for a granted award, as a PDF. The awardee,
 * anyone who can manage awards, and (for a published award) anyone who can
 * see the awards wall may download it. A revoked award has no certificate.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const { id } = await params;
  const a = await prisma.employeeAward.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { awardType: true, employee: { select: { id: true, displayName: true, jobTitleName: true, department: { select: { name: true } } } } },
  });
  if (!a || a.revokedAt) return new NextResponse("Not found.", { status: 404 });
  const mine = viewer.employee?.id === a.employeeId;
  if (!mine && !can(viewer, PERMISSIONS.AWARD_MANAGE) && !(a.isPublished && can(viewer, PERMISSIONS.AWARD_VIEW))) return new NextResponse("Forbidden.", { status: 403 });

  const doc = new PdfDoc({ title: `Certificate of appreciation — ${a.employee.displayName}`, author: viewer.tenant.name });
  const pg = doc.page();
  const W = pg.width, cx = W / 2;
  pg.rect(24, 24, W - 48, pg.height - 48, { stroke: GOLD, width: 3 });
  pg.rect(34, 34, W - 68, pg.height - 68, { stroke: GOLD, width: 0.8 });
  pg.text(cx, 120, viewer.tenant.name.toUpperCase(), { size: 12, bold: true, align: "center", color: MUTED });
  pg.text(cx, 190, "Certificate of Appreciation", { size: 30, bold: true, align: "center", color: INK });
  pg.line(cx - 120, 210, cx + 120, 210, { width: 1.2, color: GOLD });
  pg.text(cx, 262, "This certificate is proudly presented to", { size: 12, align: "center", color: MUTED });
  pg.text(cx, 310, a.employee.displayName ?? "", { size: 26, bold: true, align: "center", color: INK });
  const role = [a.employee.jobTitleName, a.employee.department?.name].filter(Boolean).join(" · ");
  if (role) pg.text(cx, 334, role, { size: 11, align: "center", color: MUTED });
  pg.text(cx, 390, `in recognition of the ${a.awardType.name} award`, { size: 14, align: "center", color: INK });
  let y = 430;
  if (a.citation) {
    const lines: string[] = [];
    let line = "";
    for (const word of a.citation.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > 80 && line) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    for (const l of lines.slice(0, 6)) { pg.text(cx, y, `${l}`, { size: 11, align: "center", color: MUTED }); y += 16; }
  }
  const on = a.awardedOn.toISOString().slice(0, 10);
  pg.text(cx, 640, `Awarded on ${on}${a.period ? ` · ${a.period}` : ""}`, { size: 11, align: "center", color: INK });
  pg.line(cx - 90, 720, cx + 90, 720, { width: 0.8, color: MUTED });
  pg.text(cx, 736, "People & Culture", { size: 10, align: "center", color: MUTED });
  pg.text(cx, pg.height - 52, `Certificate ${a.id} · issued with BooS-HR`, { size: 7.5, align: "center", color: MUTED });

  const pdf = doc.toBuffer();
  return new NextResponse(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="certificate-${(a.employee.displayName ?? "award").replace(/\W+/g, "-").toLowerCase()}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
