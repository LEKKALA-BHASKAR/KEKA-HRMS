/**
 * A return address after sign-in. Only same-site paths survive — never
 * another origin. Printable ASCII without spaces or backslashes, because
 * browsers drop tabs and newlines (so "/\t/evil.example" would become
 * "//evil.example").
 */
export function safeNext(raw: unknown): string | undefined {
  const v = typeof raw === "string" ? raw : undefined;
  if (!v || v.length > 512 || !/^\/(?![/\\])[\x21-\x5b\x5d-\x7e]*$/.test(v) || v.startsWith("/signin")) return undefined;
  return v;
}
