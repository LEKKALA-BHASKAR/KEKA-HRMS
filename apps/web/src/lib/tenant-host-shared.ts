/**
 * Which company a host name belongs to, and the address of a company.
 *
 * With APP_BASE_DOMAIN=boss-hr.com, "bluecloud.boss-hr.com" is the company
 * "bluecloud" and "boss-hr.com" itself is no company (the platform panel and
 * the generic sign-in live there). "bluecloud.localhost:3100" works in
 * development. Pure functions, so both server code and tests can use them.
 */

export function subdomainFromHost(rawHost: string | null | undefined, baseDomain = process.env.APP_BASE_DOMAIN ?? ""): string | null {
  const host = (rawHost ?? "").toLowerCase().split(":")[0].replace(/\.$/, "");
  if (!host) return null;
  const base = baseDomain.trim().toLowerCase();
  const prefixOf = (suffix: string) => {
    const sub = host.slice(0, -(suffix.length + 1));
    return sub && !sub.includes(".") ? sub : null;
  };
  if (host.endsWith(".localhost")) return prefixOf("localhost");
  if (base) return host.endsWith(`.${base}`) ? prefixOf(base) : null;
  // No base domain configured: the first label of a three-part host.
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 3 ? labels[0] : null;
}

/** The address a company's people sign in at. */
export function companyUrl(subdomain: string): string {
  const appUrl = process.env.APP_URL || process.env.AUTH_URL || "http://localhost:3100";
  let url: URL;
  try { url = new URL(appUrl); } catch { url = new URL("http://localhost:3100"); }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return `${url.protocol}//${subdomain}.localhost${url.port ? `:${url.port}` : ""}`;
  }
  const base = process.env.APP_BASE_DOMAIN?.trim() || url.hostname;
  return `${url.protocol}//${subdomain}.${base}${url.port ? `:${url.port}` : ""}`;
}
