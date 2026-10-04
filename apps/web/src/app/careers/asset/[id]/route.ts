import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { tenantFromHost } from "@/lib/tenant-host";
import { loadFile } from "@/lib/storage";

/**
 * The career site's logo and banner, public by design. Only the images the
 * host company currently uses on its career site are served — never any
 * other stored file.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromHost();
  if (!tenant) return new NextResponse("Not found.", { status: 404 });
  const { id } = await params;
  const site = await prisma.careerSiteSetting.findUnique({ where: { tenantId: tenant.id }, select: { logoFileId: true, bannerFileId: true } });
  if (!site || (site.logoFileId !== id && site.bannerFileId !== id)) return new NextResponse("Not found.", { status: 404 });
  const file = await prisma.storedFile.findFirst({ where: { id, tenantId: tenant.id, relatedType: "CareerSiteAsset" } });
  if (!file || !file.mimeType.startsWith("image/")) return new NextResponse("Not found.", { status: 404 });
  const data = await loadFile(file.storageKey, file.sha256);
  return new NextResponse(new Uint8Array(data), {
    headers: { "Content-Type": file.mimeType, "Content-Length": String(data.length), "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}
