import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS as P, canAccessEmployee } from "@keka/rbac";
import { EMPLOYEE_VISIBLE } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { loadFile } from "@/lib/storage";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * A printable copy of a letter, with the signature and signing record.
 * Served with a policy that forbids scripts, since the body is template HTML.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const { id } = await params;
  const doc = await prisma.generatedDocument.findFirst({
    where: { id, employee: { tenantId: viewer.tenantId } },
    include: { template: { select: { name: true } }, employee: { select: { id: true, displayName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } },
  });
  const own = !!doc && doc.employeeId === viewer.employee?.id && EMPLOYEE_VISIBLE.includes(doc.status);
  const hr = !!doc && can(viewer, P.LETTER_GENERATE) && canAccessEmployee(viewer, doc.employee, P.LETTER_GENERATE);
  if (!doc || !(own || hr)) return new NextResponse("Not found.", { status: 404 });

  let signature = "";
  if (doc.signedAt && doc.signatureFileId) {
    const f = await prisma.storedFile.findFirst({ where: { id: doc.signatureFileId, tenantId: viewer.tenantId } });
    const img = f ? await loadFile(f.storageKey, f.sha256).catch(() => null) : null;
    signature = `<div class="sig">${img ? `<img alt="Signature" src="data:image/png;base64,${img.toString("base64")}"/>` : ""}
<div><strong>${esc(doc.signerName ?? "")}</strong></div>
<div class="meta">Signed electronically on ${doc.signedAt.toISOString().slice(0, 16).replace("T", " ")} UTC${doc.signedIp ? ` from ${esc(doc.signedIp)}` : ""}.<br/>Document fingerprint (SHA-256): ${esc(doc.contentHash ?? "")}</div></div>`;
  } else if (doc.acknowledgedAt) {
    signature = `<div class="sig meta">Acknowledged by ${esc(doc.employee.displayName ?? "")} on ${doc.acknowledgedAt.toISOString().slice(0, 10)}.</div>`;
  }
  const watermark = doc.status === "VOID" ? `<div class="void">WITHDRAWN</div>` : doc.status === "PENDING_APPROVAL" || doc.status === "REJECTED" ? `<div class="void">DRAFT</div>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.template.name)} · ${esc(doc.employee.displayName ?? "")}</title>
<style>body{font:15px/1.6 Georgia,serif;color:#111;margin:48px auto;max-width:720px;padding:0 24px}p{margin:0 0 12px}.sig{margin-top:36px;border-top:1px solid #ccc;padding-top:12px}.sig img{max-height:80px}.meta{font:12px/1.5 system-ui,sans-serif;color:#555}.void{position:fixed;top:40%;left:0;right:0;text-align:center;font:bold 96px system-ui;color:rgba(200,0,0,.12);transform:rotate(-20deg);pointer-events:none}@media print{body{margin:0 auto}}</style>
</head><body>${watermark}${doc.renderedBody}${signature}</body></html>`;
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
