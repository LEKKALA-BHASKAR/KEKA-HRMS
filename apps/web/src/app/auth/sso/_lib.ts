import type { NextRequest } from "next/server";

/** The origin this request came in on, as the browser sees it. */
export function originOf(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function subdomainOf(req: NextRequest): string | null {
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").toLowerCase().split(":")[0]!;
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? labels[0]! : null;
}

/** Why an SSO attempt ended on the sign-in page; codes, so nothing is reflected. */
export const SSO_ERRORS = {
  off: "Single sign-on is not set up for this company.",
  idp: "Your identity provider could not be reached. Try again, or sign in with your password.",
  expired: "That sign-in took too long or was started elsewhere. Start again.",
  denied: "Your identity provider did not complete the sign-in.",
  invalid: "The sign-in response could not be verified.",
  domain: "Your email domain is not allowed to sign in here.",
  nouser: "No active login matches your email address. Ask your administrator to invite you.",
  ipblocked: "Your company only allows sign-in from approved networks. Connect from the office or VPN.",
} as const;
export type SsoError = keyof typeof SSO_ERRORS;
