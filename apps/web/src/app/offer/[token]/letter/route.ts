import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { openOfferLink } from "@keka/services";
import { loadFile } from "@/lib/storage";
import { throttled, clientIp } from "@/lib/throttle";

/**
 * The offer PDF for the candidate holding the link: the letter as sent, or
 * the signed copy. Only the file recorded on this link's own offer is ever
 * served, and only while the link is live.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const ip = (await clientIp()) ?? "unknown";
  if (throttled(`offer-pdf|${ip}`, 30, 10 * 60_000)) return new NextResponse("Too many requests.", { status: 429, headers: { "Retry-After": "600" } });
  const { token } = await params;
  const view = await openOfferLink(token);
  if (!view || !["OPEN", "ACCEPTED", "DECLINED"].includes(view.state)) return new NextResponse("Not found.", { status: 404 });
  const url = new URL(req.url).searchParams.get("copy") === "signed" ? view.signedLetterUrl : view.letterUrl;
  const id = url?.startsWith("/files/") ? url.slice("/files/".length) : null;
  const file = id ? await prisma.storedFile.findFirst({ where: { id, tenantId: view.tenantId, relatedType: "Offer", relatedId: view.applicationId, mimeType: "application/pdf" } }) : null;
  if (!file) return new NextResponse("Not found.", { status: 404 });
  const data = await loadFile(file.storageKey, file.sha256);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${file.filename.replace(/[^\w.-]/g, "_")}"`,
      "Content-Length": String(data.length),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
