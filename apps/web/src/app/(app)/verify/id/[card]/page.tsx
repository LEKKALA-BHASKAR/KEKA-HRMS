import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { idCardStatus } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Avatar } from "@/components/ui";

export const metadata = { title: "Verify an ID card — BooS-HR" };

/**
 * Check an ID card number: anyone signed in to the company (reception,
 * security) sees whether it is valid and whose it is — name, photo and
 * department only. Cards from other companies are never found.
 */
export default async function VerifyIdPage({ params }: { params: Promise<{ card: string }> }) {
  const viewer = await requireViewer();
  const { card: number } = await params;
  const card = await prisma.employeeIdCard.findFirst({ where: { tenantId: viewer.tenantId, cardNumber: decodeURIComponent(number).slice(0, 64) } });
  const e = card ? await prisma.employee.findFirst({ where: { id: card.employeeId, tenantId: viewer.tenantId }, select: { displayName: true, firstName: true, lastName: true, employeeNumber: true, photoUrl: true, status: true, jobTitleName: true, department: { select: { name: true } } } }) : null;
  const status = card ? idCardStatus(card) : null;
  const valid = status === "VALID" && e && e.status !== "EXITED";
  return (
    <>
      <PageHead title="Verify an ID card" subtitle={`Card ${decodeURIComponent(number)}`} />
      {!card || !e ? <Card><Empty title="No such card">This number was not issued by this company.</Empty></Card> : (
        <Card>
          <div className="row gap-3" style={{ alignItems: "center" }}>
            <Avatar name={e.displayName ?? e.firstName} size="lg" photoUrl={e.photoUrl} />
            <div>
              <div className="strong" style={{ fontSize: 18 }}>{e.displayName ?? `${e.firstName} ${e.lastName}`}</div>
              <div className="text-sm">{e.jobTitleName ?? ""}{e.department ? ` · ${e.department.name}` : ""} · {e.employeeNumber}</div>
              <div style={{ marginTop: 6 }}>{valid ? <Badge tone="success">Valid until {formatDate(card.validUntil)}</Badge> : status === "REVOKED" ? <Badge tone="danger">Revoked {formatDate(card.revokedAt)}</Badge> : e.status === "EXITED" ? <Badge tone="danger">No longer employed</Badge> : <Badge tone="warning">Expired {formatDate(card.validUntil)}</Badge>}</div>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
