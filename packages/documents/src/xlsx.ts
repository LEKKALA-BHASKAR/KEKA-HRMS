import { zipFiles } from "./zip";

/**
 * A minimal Office Open XML workbook writer: one or more sheets of a header
 * row and data rows, numbers as numbers, text as inline strings, a bold
 * header and frozen first row. Enough for report downloads that open in
 * Excel, LibreOffice and Google Sheets, without a dependency.
 */

export type XlsxCell = string | number | null | undefined;
export interface XlsxSheet { name: string; columns: string[]; rows: XlsxCell[][] }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // XML 1.0 forbids most control characters.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** Column letters: 0 → A, 25 → Z, 26 → AA. */
export function xlsxColumn(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Sheet names: at most 31 characters, none of []:*?/\, unique. */
function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n, i) => {
    let base = (n.replace(/[[\]:*?/\\]/g, " ").trim() || `Sheet${i + 1}`).slice(0, 31);
    let name = base, k = 2;
    while (used.has(name.toLowerCase())) { const suffix = ` (${k++})`; name = base.slice(0, 31 - suffix.length) + suffix; }
    used.add(name.toLowerCase());
    return name;
  });
}

function cell(ref: string, v: XlsxCell, style = 0): string {
  if (v === null || v === undefined || v === "") return "";
  const s = style ? ` s="${style}"` : "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
  // Text that a spreadsheet would read as a formula stays text.
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

function sheetXml(sh: XlsxSheet): string {
  const rows = [sh.columns as XlsxCell[], ...sh.rows];
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(`${xlsxColumn(ci)}${ri + 1}`, v, ri === 0 ? 1 : 0)).join("")}</row>`).join("");
  const widths = sh.columns.map((c, i) => {
    const longest = Math.max(c.length, ...sh.rows.slice(0, 200).map((r) => String(r[i] ?? "").length));
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, longest + 2))}" customWidth="1"/>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${widths ? `<cols>${widths}</cols>` : ""}<sheetData>${body}</sheetData></worksheet>`;
}

export function renderXlsx(sheets: XlsxSheet[], when = new Date()): Buffer {
  if (!sheets.length) throw new Error("A workbook needs at least one sheet.");
  const names = sheetNames(sheets.map((s) => s.name));
  const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
  const files = [
    { name: "[Content_Types].xml", data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`) },
    { name: "_rels/.rels", data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: "xl/styles.xml", data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`) },
    ...sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc(sheetXml(sh)) })),
  ];
  return zipFiles(files, when);
}
