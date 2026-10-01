import { NextResponse, type NextRequest } from "next/server";

/**
 * Passes the requested path to the server, so a page that finds no session
 * can send the visitor to sign-in and back to where they were going.
 */
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/|api/|files/|favicon|.*\\.(?:png|svg|ico|css|js)$).*)"],
};
