import Link from "next/link";
import { formatDate } from "@keka/shared";
import { idCardStatus, qrSvg, formatCompanyDate } from "@keka/services";
import { prisma } from "@keka/db";
import { companyUrl } from "@/lib/tenant-host-shared";
import { requireViewer } from "@/lib/context";
import { idCardView, isHrFor } from "@/lib/core-hr";
import { PageHead, Card, Badge, Empty, Avatar, AccessDenied } from "@/components/ui";
import { ActionButton, SpecForm } from "@/components/spec-form";
import { requestIdCardAction, withdrawIdCardRequestAction } from "@/app/actions/core2-people";
import { issueIdCardAction, revokeIdCardAction } from "@/app/actions/self-service-depth";

export const metadata = { title: "ID card — BooS-HR" };

const BLOOD: Record<string, string> = { A_POS: "A+", A_NEG: "A−", B_POS: "B+", B_NEG: "B−", AB_POS: "AB+", AB_NEG: "AB−", O_POS: "O+", O_NEG: "O−" };

/**
 * The digital employee ID card: one's own, or (for HR) anyone's in scope via
 * ?employee=. Print it, download it as a PDF, or have security check its
 * number at /verify/id/<number>.
 */
export default async function IdCardPage({ searchParams }: { searchParams: Promise<{ employee?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const employeeId = sp.employee || viewer.employee?.id;
  if (!employeeId) return <><PageHead title="ID card" /><Card><Empty title="No employee profile">This account is not linked to an employee record.</Empty></Card></>;
  const self = employeeId === viewer.employee?.id;
  const hr = await isHrFor(viewer, employeeId);
  if (!self && !hr) return <AccessDenied permission="employee.record.update" what="this ID card" />;
  const { employee: e, card, company, subdomain } = await idCardView(viewer.tenantId, employeeId);
  // Whether employees request cards for approval instead of issuing their own, and any request waiting.
  const [gate, requests, profile] = await Promise.all([
    prisma.changeApprovalSetting.findUnique({ where: { tenantId_targetType: { tenantId: viewer.tenantId, targetType: "ID_CARD" } } }),
    prisma.idCardRequest.findMany({ where: { tenantId: viewer.tenantId, employeeId }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.companyProfile.findUnique({ where: { tenantId: viewer.tenantId }, select: { dateFormat: true } }),
  ]);
  const mustRequest = self && !hr && !!gate?.requireApproval;
  const pending = requests.find((r) => r.status === "PENDING");
  const verifyUrl = card ? `${companyUrl(subdomain)}/verify/id/${card.cardNumber}` : "";
  if (!e) return <AccessDenied permission="employee.record.update" what="this ID card" />;
  const status = card ? idCardStatus(card) : null;
  const name = e.displayName ?? `${e.firstName} ${e.lastName}`;
  const q = self ? "" : `?employee=${e.id}`;
  return (
    <>
      <PageHead title={self ? "My ID card" : `ID card — ${name}`} subtitle="A digital card you can print or save as a PDF"
        actions={<>{card && status === "VALID" ? <a className="btn" href={`/me/id-card/pdf${q}`}>Download PDF</a> : null}{mustRequest ? null : <ActionButton action={issueIdCardAction} hidden={self ? {} : { employeeId: e.id }} label={card ? "Reissue card" : "Issue card"} variant="primary" confirm={card ? "Reissuing replaces the current card number. Continue?" : undefined} />}</>} />
      {mustRequest ? (
        <Card title="Request a card" description="Cards here are issued by HR once your request is approved.">
          {pending ? <p className="row gap-2"><Badge tone="info">Requested {formatDate(pending.createdAt)}</Badge> <ActionButton action={withdrawIdCardRequestAction} hidden={{ id: pending.id }} label="Withdraw" /></p> : (
            <SpecForm action={requestIdCardAction} submitLabel="Request card" fields={[
              { name: "reason", label: "Why", kind: "select", required: true, options: [{ value: "NEW", label: "I have no card" }, { value: "LOST", label: "Lost" }, { value: "DAMAGED", label: "Damaged" }, { value: "DETAILS_CHANGED", label: "My details changed" }] },
              { name: "note", label: "Note" },
            ]} />
          )}
          {requests.filter((r) => r.status !== "PENDING").length ? <ul className="text-sm">{requests.filter((r) => r.status !== "PENDING").map((r) => <li key={r.id}>{formatDate(r.createdAt)} · {r.reason.toLowerCase().replace("_", " ")} · {r.status.toLowerCase()}</li>)}</ul> : null}
        </Card>
      ) : null}
      {!card ? <Card><Empty title="No card issued yet">Issue one to get a card number that security can verify.</Empty></Card> : (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <div className="id-card" style={{ width: 340, borderRadius: 14, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface, #fff)", boxShadow: "0 2px 10px rgba(0,0,0,.08)" }}>
            <div style={{ background: company.color, color: "#fff", padding: "12px 16px" }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{company.name}</div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>Employee identity card</div>
            </div>
            <div style={{ padding: 16, display: "flex", gap: 14 }}>
              <Avatar name={name} size="lg" photoUrl={e.photoUrl} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 17 }}>{name}</div>
                <div className="text-sm">{e.jobTitleName ?? ""}</div>
                <div className="text-sm muted">{e.department?.name ?? ""}{e.location ? ` · ${e.location.name}` : ""}</div>
              </div>
            </div>
            <table className="text-sm" style={{ margin: "0 16px 12px", borderCollapse: "collapse" }}>
              <tbody>
                <tr><td className="muted" style={{ paddingRight: 12 }}>Employee no.</td><td className="strong">{e.employeeNumber}</td></tr>
                <tr><td className="muted">Card no.</td><td className="mono">{card.cardNumber}</td></tr>
                {e.bloodGroup && BLOOD[e.bloodGroup] ? <tr><td className="muted">Blood group</td><td>{BLOOD[e.bloodGroup]}</td></tr> : null}
                <tr><td className="muted">Valid until</td><td>{formatCompanyDate(card.validUntil, profile?.dateFormat)}</td></tr>
              </tbody>
            </table>
            {status === "VALID" ? <div style={{ display: "flex", justifyContent: "center", padding: "0 16px 10px" }} data-qr="" dangerouslySetInnerHTML={{ __html: qrSvg(verifyUrl, { moduleSize: 3 }) }} /> : null}
            <div style={{ borderTop: "1px solid var(--border)", padding: "8px 16px", fontSize: 10.5 }} className="muted">
              If found, please return to {company.name}{company.address ? `, ${company.address}` : ""}{company.phone ? ` · ${company.phone}` : ""}.
            </div>
          </div>
          <Card title="Card status">
            <p>{status === "VALID" ? <Badge tone="success">Valid</Badge> : status === "EXPIRED" ? <Badge tone="warning">Expired — reissue it</Badge> : <Badge tone="danger">Revoked</Badge>}</p>
            <p className="text-sm">Issued {formatDate(card.issuedAt)}. Security can check it at <Link href={`/verify/id/${card.cardNumber}`}>/verify/id/{card.cardNumber}</Link>.</p>
            {hr && !self && card.status === "ACTIVE" ? <ActionButton action={revokeIdCardAction} hidden={{ id: card.id }} label="Revoke card" variant="danger" confirm="Revoke this card? It will stop verifying." /> : null}
          </Card>
        </div>
      )}
    </>
  );
}
