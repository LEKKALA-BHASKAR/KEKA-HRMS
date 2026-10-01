import { prisma } from "@keka/db";
import { formatDate, fyLabel, fyStartYear } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { EmptyState, InfoBanner } from "@/components/keka";
import { IconFile } from "@/components/icons";
import { IconDoc, IconDown } from "../../_components/icons";
import s from "../../finances.module.css";

export const metadata = { title: "Tax Forms" };

/** Form 16 Part B, as issued by the payroll team for each financial year. */
export default async function TaxFormsPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconFile />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const employeeId = viewer.employee.id;
  const [files, pan] = await Promise.all([
    prisma.storedFile.findMany({
      where: { tenantId: viewer.tenantId, employeeId, relatedType: "Form16" },
      orderBy: [{ relatedId: "desc" }, { createdAt: "desc" }],
      select: { id: true, filename: true, relatedId: true, createdAt: true, sizeBytes: true },
    }),
    prisma.employeeIdentity.findFirst({ where: { employeeId, type: "PAN" }, select: { id: true } }),
  ]);
  const currentFy = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const ay = (fy: number) => `AY ${fy + 1}-${String((fy + 2) % 100).padStart(2, "0")}`;

  return (
    <>
      <div className={s.titleRow}><div className={s.titleLeft}><h1 className={s.bigTitle}>Forms</h1></div></div>
      <p className={s.pageSub}>Your Form 16 — the certificate of salary paid and tax deducted — for each financial year it has been issued.</p>

      {files.length > 0 ? (
        <div className={s.mt}>
          <InfoBanner>
            {pan ? "Your Form 16 is password protected. To open the downloaded file, enter your PAN in all uppercase."
              : "No PAN is on record, so your Form 16 is not password protected."}
          </InfoBanner>
        </div>
      ) : null}

      <div className={s.mt}>
        {files.length === 0 ? (
          <div className={s.boxed}>
            <EmptyState icon={<IconDoc />} title="No Form 16 issued yet">
              Your payroll team issues Form 16 after the financial year ends, usually by 15 June. The one for {fyLabel(currentFy)} will appear here once it is generated.
            </EmptyState>
          </div>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr><th scope="col">Form</th><th scope="col">Financial Year</th><th scope="col">Assessment Year</th><th scope="col">Issued On</th><th scope="col"><span className="sr-only">Download</span></th></tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const fy = Number(f.relatedId);
                  const provisional = Number.isFinite(fy) && fy >= currentFy;
                  return (
                    <tr key={f.id}>
                      <td>
                        <span className={s.inlineRow}><IconDoc width={18} height={18} /> Form 16 — Part B</span>
                        {provisional ? <div className={s.muted} style={{ fontSize: 12.5 }}>Provisional: the year is not over yet</div> : null}
                      </td>
                      <td>{Number.isFinite(fy) ? fyLabel(fy) : "—"}</td>
                      <td>{Number.isFinite(fy) ? ay(fy) : "—"}</td>
                      <td>{formatDate(f.createdAt)}</td>
                      <td className={s.right}>
                        <a className="btn sm" href={`/files/${f.id}`} download aria-label={`Download Form 16 for ${Number.isFinite(fy) ? fyLabel(fy) : f.filename}`}>
                          <IconDown width={14} height={14} /> Download
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
