/**
 * Custom field values: what a field of each type accepts, how it is stored
 * (always a string, so one column holds every type) and how it reads back.
 */

export type CustomFieldKind = "TEXT" | "NUMBER" | "DATE" | "DROPDOWN" | "CHECKBOX" | "MULTILINE" | "EMAIL" | "PHONE";

export interface CustomFieldSpec {
  label: string;
  type: CustomFieldKind;
  options?: string[] | null;
  isMandatory: boolean;
}

/** A machine key from a label: "Blood group" → "blood_group". */
export function fieldKeyFor(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "field";
}

/** Dropdown options typed one per line or comma-separated, de-duplicated, order kept. */
export function parseOptions(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(o.toLowerCase())) { seen.add(o.toLowerCase()); out.push(o); }
  }
  return out;
}

/**
 * Check and normalise one submitted value. Returns the string to store (null
 * clears it) or an error message for the field.
 */
export function checkCustomValue(spec: CustomFieldSpec, raw: string | null | undefined): { value: string | null } | { error: string } {
  const v = (raw ?? "").trim();
  if (spec.type === "CHECKBOX") return { value: v === "on" || v === "true" || v === "yes" ? "true" : "false" };
  if (v === "") return spec.isMandatory ? { error: `${spec.label} is required` } : { value: null };
  switch (spec.type) {
    case "NUMBER":
      return /^-?\d+(\.\d+)?$/.test(v) ? { value: String(Number(v)) } : { error: `${spec.label} must be a number` };
    case "DATE": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
      return d && d.getUTCDate() === +m![3] ? { value: v } : { error: `${spec.label} must be a date` };
    }
    case "DROPDOWN": {
      const match = (spec.options ?? []).find((o) => o.toLowerCase() === v.toLowerCase());
      return match ? { value: match } : { error: `${spec.label} must be one of: ${(spec.options ?? []).join(", ")}` };
    }
    case "EMAIL":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? { value: v.toLowerCase() } : { error: `${spec.label} must be an email address` };
    case "PHONE":
      return /^\+?[\d\s()-]{7,20}$/.test(v) ? { value: v } : { error: `${spec.label} must be a phone number` };
    case "TEXT":
      return v.length <= 200 ? { value: v } : { error: `${spec.label} must be 200 characters or fewer` };
    default:
      return v.length <= 2000 ? { value: v } : { error: `${spec.label} must be 2000 characters or fewer` };
  }
}

/** A stored value as people read it. */
export function displayCustomValue(type: CustomFieldKind, value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (type === "CHECKBOX") return value === "true" ? "Yes" : "No";
  if (type === "DATE") {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }
  return value;
}
