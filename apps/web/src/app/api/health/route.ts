import { NextResponse } from "next/server";
import { prisma } from "@keka/db";

/**
 * Liveness and readiness for a load balancer. Unauthenticated, so it says
 * only whether the app can reach its database — never versions or counts.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "ok", ms: Date.now() - started }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "degraded", db: "unreachable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
