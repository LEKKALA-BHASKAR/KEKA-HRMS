import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { ASSET_IMPORT_FIELDS, type AssetImportIssue } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { mapAssetImportAction, commitAssetImportAction } from "@/app/actions/assets";
import { FullScreen, StepForm } from "../../_ui";
import { Yellow } from "../../_parts";
import s from "../../assets.module.css";

/**
 * Bulk add / update, after the upload: map each column of the file to a
 * field, review every row the file would change (and why any is refused),
 * then import. Nothing touches the inventory until the last step.
 */

const P = PERMISSIONS;

export default async function AssetImportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) redirect("/assets/list");
  const imp = await prisma.assetImport.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!imp) notFound();
  const type = imp.assetTypeId ? await prisma.assetType.findFirst({ where: { id: imp.assetTypeId }, include: { category: true } }) : null;
  const headers = imp.headers as string[];
  const rows = (imp.rows ?? []) as string[][];
  const mapping = (imp.mapping ?? {}) as Record<string, string>;
  const issues = (imp.errors ?? []) as unknown as AssetImportIssue[];
  const step = imp.status === "IMPORTED" ? 3 : imp.status === "VALIDATED" && sp.step !== "map" ? 2 : 1;
  const close = type ? `/assets/list?type=${type.id}` : "/assets/list";
  const here = `/assets/import/${imp.id}`;
  const verb = imp.mode === "ADD" ? "add" : "update";

  const stepper = (
    <div className={s.stepper} aria-label="Steps">
      <span><span className={s.num}>✓</span>Upload</span><span className={s.chev}>›</span>
      <span className={step === 1 ? s.on : undefined}><span className={s.num}>{step > 1 ? "✓" : 2}</span>Map columns</span><span className={s.chev}>›</span>
      <span className={step >= 2 ? s.on : undefined}><span className={s.num}>{step > 2 ? "✓" : 3}</span>Review &amp; import</span>
    </div>
  );

  return (
    <FullScreen title={`Bulk ${verb}${type ? ` · ${type.category.name} › ${type.name}` : ""}`} closeHref={close} center={stepper}>
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        <p className="text-sm muted" style={{ marginBottom: 16 }}>{imp.totalRows} row{imp.totalRows === 1 ? "" : "s"} uploaded on {imp.createdAt.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" })}.</p>

        {step === 1 ? (
          <StepForm action={mapAssetImportAction} hidden={{ id: imp.id }} next={here} submitLabel="Validate rows"
            secondary={<Link className="btn" href={close}>Cancel</Link>}>
            <h2 className={s.formSection}>Map the columns in your file to asset fields</h2>
            <div className={`${s.tableCard} ${s.alone}`}>
              <table className={s.table}>
                <thead><tr><th>Column in your file</th><th>Sample value</th><th>Asset field</th></tr></thead>
                <tbody>
                  {headers.map((h, i) => (
                    <tr key={`${h}-${i}`}>
                      <td>{h}</td>
                      <td className="muted">{rows[0]?.[i] || "—"}</td>
                      <td>
                        <select name={`map_${i}`} className="select" defaultValue={mapping[h] ?? ""} aria-label={`Field for ${h}`}>
                          <option value="">Do not import</option>
                          {ASSET_IMPORT_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}{f.required ? " *" : ""}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs muted" style={{ marginTop: 8 }}>* Required: {ASSET_IMPORT_FIELDS.filter((f) => f.required).map((f) => f.label).join(", ")}.</p>
          </StepForm>
        ) : null}

        {step === 2 ? (
          <>
            {imp.okRows > 0
              ? <div className="callout success" style={{ marginBottom: 14 }}>{imp.okRows} of {imp.totalRows} row{imp.totalRows === 1 ? "" : "s"} will be {verb === "add" ? "added" : "updated"}.{issues.length ? " Rows with problems are skipped — fix them in the file and import it again if you need them." : ""}</div>
              : <Yellow>None of the rows can be imported yet. Fix the problems below, or change the mapping.</Yellow>}
            {issues.length ? <IssueTable issues={issues} /> : null}
            <StepForm action={commitAssetImportAction} hidden={{ id: imp.id }} next={here} submitLabel={`Import ${imp.okRows} asset${imp.okRows === 1 ? "" : "s"}`}
              secondary={<Link className="btn" href={`${here}?step=map`}>Back to mapping</Link>}>
              <span />
            </StepForm>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <div className="callout success" style={{ marginBottom: 14 }}>
              {verb === "add" ? "Added" : "Updated"} {imp.okRows} asset{imp.okRows === 1 ? "" : "s"}{imp.committedAt ? ` on ${imp.committedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}.
            </div>
            {issues.length ? <><h2 className={s.formSection}>Rows that were skipped</h2><IssueTable issues={issues} /></> : null}
            <div className="row gap-2" style={{ marginTop: 18 }}><Link className="btn primary" href={close}>Back to the asset list</Link></div>
          </>
        ) : null}
      </div>
    </FullScreen>
  );
}

function IssueTable({ issues }: { issues: AssetImportIssue[] }) {
  return (
    <div className={`${s.tableCard} ${s.alone}`} style={{ marginBottom: 14 }}>
      <div className={s.toolbar}><span className={s.total}>Problems: {issues.length}</span></div>
      <div className={s.tableWrap} style={{ maxHeight: 420, overflowY: "auto" }}>
        <table className={s.table}>
          <thead><tr><th>Row</th><th>Field</th><th>Problem</th></tr></thead>
          <tbody>
            {issues.slice(0, 500).map((i, k) => <tr key={k}><td>{i.row}</td><td>{i.field}</td><td>{i.message}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
