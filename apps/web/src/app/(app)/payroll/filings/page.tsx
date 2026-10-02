import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, fyLabel, fyStartYear } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { GenerateButton, Generate24q, MarkFiled, GenerateForm16 } from "./forms";

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Filing = { id: string; status: string; fileUrl: string | null; receiptNumber: string | null; filedAt: Date | null; meta: unknown };

function FilingCell({ f, runId, kind, due }: { f?: Filing; runId?: string; kind: "PF_ECR" | "ESI_ECR"; due: Date }) {
  const meta = (f?.meta ?? {}) as { summary?: string; issues?: string[] };
  const overdue = (!f || f.status === "GENERATED" || f.status === "DRAFT") && due < new Date();
  return (
    <div className="stack gap-2">
      <div className="row gap-2">
        {f && ["FILED", "ACKNOWLEDGED"].includes(f.status)
          ? <Badge tone="success">filed</Badge>
          : f?.status === "GENERATED" ? <Badge tone={overdue ? "danger" : "warning"}>{overdue ? "generated · overdue" : "generated"}</Badge>
          : <Badge tone={overdue ? "danger" : "neutral"}>{overdue ? "overdue" : "not started"}</Badge>}
        <span className="text-xs subtle">due {formatDate(due)}</span>
      </div>
      {meta.summary ? <div className="text-xs muted">{meta.summary}</div> : null}
      {meta.issues?.length ? <div className="text-xs" style={{ color: "var(--warning)" }}>{meta.issues.length} issue(s): {meta.issues[0]}</div> : null}
      {f?.receiptNumber ? <div className="text-xs subtle">Ack {f.receiptNumber} · {f.filedAt ? formatDate(f.filedAt) : ""}</div> : null}
      <div className="row gap-2 wrap">
        {f?.fileUrl ? <a className="btn sm" href={f.fileUrl}>Download</a> : null}
        {runId && !(f && ["FILED", "ACKNOWLEDGED"].includes(f.status)) ? <GenerateButton runId={runId} kind={kind} label={f?.fileUrl ? "Regenerate" : "Generate"} /> : null}
        {f?.status === "GENERATED" ? <MarkFiled filingId={f.id} hint={kind === "PF_ECR" ? "TRRN" : "Challan no."} /> : null}
      </div>
    </div>
  );
}

export default async function FilingsPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.STATUTORY_MANAGE);
  const fy = Number((await searchParams).fy) || fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const [runs, filings, form16Files, bankFiles] = await Promise.all([
    prisma.payrollRun.findMany({
      where: { tenantId: viewer.tenantId, status: "FINALIZED", rolledBackAt: null, OR: [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: 3 } }] },
      orderBy: [{ year: "asc" }, { month: "asc" }], include: { payGroup: { select: { name: true } } },
    }),
    prisma.statutoryFiling.findMany({ where: { tenantId: viewer.tenantId, fyStartYear: fy } }),
    prisma.storedFile.count({ where: { tenantId: viewer.tenantId, relatedType: "Form16", relatedId: String(fy) } }),
    prisma.storedFile.findMany({ where: { tenantId: viewer.tenantId, relatedType: "PayrollOutput" }, orderBy: { createdAt: "desc" } }),
  ]);
  const find = (type: string, month?: number, quarter?: number) => filings.find((f) => f.type === type && (month === undefined || f.month === month) && (quarter === undefined || f.quarter === quarter));
  const due15 = (y: number, m: number) => new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 15));
  const f16 = find("FORM_16");
  const quarterDue = [new Date(Date.UTC(fy, 6, 31)), new Date(Date.UTC(fy, 9, 31)), new Date(Date.UTC(fy + 1, 0, 31)), new Date(Date.UTC(fy + 1, 4, 31))];

  return (
    <>
      <PageHead title="Statutory filings" subtitle={`Files for the PF, ESIC and TRACES portals, from finalised payroll · ${fyLabel(fy)}`}
        actions={<div className="row gap-2"><Link className="btn sm" href={`/payroll/filings?fy=${fy - 1}`}>‹ {fyLabel(fy - 1)}</Link><Link className="btn sm" href={`/payroll/filings?fy=${fy + 1}`}>{fyLabel(fy + 1)} ›</Link></div>} />
      <Callout tone="info" title="How this works">
        Generate a file, upload it on the portal, then record the acknowledgement here. Only finalised months appear;
        a filed return is locked — corrections are revised returns on the portal.
      </Callout>

      <Card tight title="Monthly — PF, ESI and salary transfer" description="PF and ESI are due on the 15th of the following month.">
        {runs.length === 0 ? <Empty title="No finalised payroll in this year" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Wage month</th><th>PF ECR</th><th>ESI contribution</th><th>Bank advice</th></tr></thead>
              <tbody>
                {runs.map((r) => {
                  const bank = bankFiles.find((b) => b.relatedId === r.id);
                  return (
                    <tr key={r.id} style={{ verticalAlign: "top" }}>
                      <td className="strong">{MONTHS[r.month]} {r.year}<div className="text-xs subtle">{r.payGroup.name}</div></td>
                      <td><FilingCell f={find("PF_ECR", r.month)} runId={r.id} kind="PF_ECR" due={due15(r.year, r.month)} /></td>
                      <td><FilingCell f={find("ESI_ECR", r.month)} runId={r.id} kind="ESI_ECR" due={due15(r.year, r.month)} /></td>
                      <td>
                        <div className="stack gap-2">
                          {bank ? <a className="btn sm" href={`/files/${bank.id}`}>Download</a> : null}
                          <GenerateButton runId={r.id} kind="BANK" label={bank ? "Regenerate" : "Generate"} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-2" style={{ marginTop: 16, alignItems: "start" }}>
        <Card tight title="Quarterly — Form 24Q" description="Salary TDS return. Annexure I is generated here; prepare the FVU in the RPU utility.">
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {[1, 2, 3, 4].map((q) => {
                  const f = find("FORM_24Q", undefined, q);
                  const meta = (f?.meta ?? {}) as { summary?: string; issues?: string[] };
                  return (
                    <tr key={q} style={{ verticalAlign: "top" }}>
                      <td className="strong">Q{q}<div className="text-xs subtle">due {formatDate(quarterDue[q - 1])}</div></td>
                      <td>
                        {f ? <Badge tone={f.status === "FILED" ? "success" : "warning"}>{f.status.toLowerCase()}</Badge> : <Badge>not started</Badge>}
                        {meta.summary ? <div className="text-xs muted" style={{ marginTop: 4 }}>{meta.summary}</div> : null}
                        {meta.issues?.length ? <div className="text-xs" style={{ color: "var(--warning)" }}>{meta.issues[0]}</div> : null}
                      </td>
                      <td className="right">
                        <div className="stack gap-2" style={{ alignItems: "flex-end" }}>
                          <Link className="btn sm" href={`/payroll/filings/24q?fy=${fy}&q=${q}`}>Challans &amp; 24Q data</Link>
                          {f?.fileUrl ? <a className="btn sm" href={f.fileUrl}>Download</a> : null}
                          {f?.status !== "FILED" ? <Generate24q fy={fy} quarter={q} label={f ? "Regenerate" : "Generate"} /> : null}
                          {f?.status === "GENERATED" ? <MarkFiled filingId={f.id} hint="Token no." /> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Yearly — Form 16 Part B" description="Issued by 15 June after the year ends. Each PDF opens with the employee's PAN.">
          <div className="stack gap-3">
            <div className="text-sm">{form16Files ? `${form16Files} employee(s) have a Form 16 for ${fyLabel(fy)}.` : "Not generated yet."}{f16?.meta && (f16.meta as { summary?: string }).summary ? <span className="muted"> {(f16.meta as { summary?: string }).summary}</span> : null}</div>
            {f16?.generatedAt ? <div className="text-xs subtle">Last generated {formatDate(f16.generatedAt)}. Employees download theirs from My Tax.</div> : null}
            <GenerateForm16 fy={fy} />
          </div>
        </Card>
      </div>
    </>
  );
}
