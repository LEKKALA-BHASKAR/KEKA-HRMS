import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PdfDoc, type RGB } from "@keka/documents";
import { formatDate } from "@keka/shared";
import { idCardStatus } from "@keka/services";
import { getViewer } from "@/lib/context";
import { idCardView, isHrFor } from "@/lib/core-hr";

const hex = (h: string): RGB => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h); return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : [0.07, 0.4, 0.66]; };

/** The ID card as a printable PDF: card-sized panel at the top of an A4 page. Own card, or HR for anyone in scope. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const employeeId = req.nextUrl.searchParams.get("employee") || viewer.employee?.id;
  if (!employeeId) return new NextResponse("No employee record.", { status: 404 });
  if (employeeId !== viewer.employee?.id && !(await isHrFor(viewer, employeeId))) return new NextResponse("Forbidden.", { status: 403 });
  const { employee: e, card, company } = await idCardView(viewer.tenantId, employeeId);
  if (!e || !card) return new NextResponse("No card issued.", { status: 404 });
  if (idCardStatus(card) !== "VALID") return new NextResponse("This card is no longer valid; reissue it.", { status: 409 });
  const name = e.displayName ?? `${e.firstName} ${e.lastName}`;
  const doc = new PdfDoc({ title: `ID card ${card.cardNumber}`, author: company.name });
  const pg = doc.page();
  const x = 40, y = 40, w = 243, h = 153; // 85.6 x 54 mm
  pg.rect(x, y, w, h, { stroke: [0.8, 0.8, 0.82], width: 0.8 });
  pg.rect(x, y, w, 30, { fill: hex(company.color) });
  pg.text(x + 10, y + 19, company.name.slice(0, 40), { size: 11, bold: true, color: [1, 1, 1] });
  pg.text(x + 10, y + 46, name.slice(0, 36), { size: 12, bold: true });
  pg.text(x + 10, y + 60, (e.jobTitleName ?? "").slice(0, 44), { size: 8.5 });
  pg.text(x + 10, y + 72, [e.department?.name, e.location?.name].filter(Boolean).join(" · ").slice(0, 50), { size: 8, color: [0.4, 0.4, 0.45] });
  const rows: Array<[string, string]> = [["Employee no.", e.employeeNumber], ["Card no.", card.cardNumber], ["Valid until", formatDate(card.validUntil)]];
  rows.forEach(([k, v], i) => { pg.text(x + 10, y + 92 + i * 13, k, { size: 8, color: [0.4, 0.4, 0.45] }); pg.text(x + 80, y + 92 + i * 13, v, { size: 8.5, bold: i === 0 }); });
  pg.text(x + 10, y + h - 8, `Verify: /verify/id/${card.cardNumber}`, { size: 6.5, color: [0.4, 0.4, 0.45] });
  pg.text(x, y + h + 24, "Cut along the border. If found, please return to the company.", { size: 8, color: [0.4, 0.4, 0.45] });
  await prisma.auditLog.create({ data: { tenantId: viewer.tenantId, module: "EMPLOYEE", action: "EXPORT", entityType: "EmployeeIdCard", entityId: card.id, summary: `Downloaded ID card ${card.cardNumber}`, actorId: viewer.user.id, actorLabel: viewer.user.email } });
  return new NextResponse(new Uint8Array(doc.toBuffer()), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="id-card-${e.employeeNumber}.pdf"`, "Cache-Control": "no-store" },
  });
}
