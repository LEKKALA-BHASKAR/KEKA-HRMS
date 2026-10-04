import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { idCardStatus } from "@keka/services";
import type { Viewer } from "@/lib/context";
import { Card, Badge, Empty } from "@/components/ui";
import { SpecForm, ActionButton } from "@/components/spec-form";
import { addInternalNoteAction, deleteInternalNoteAction, issueIdCardAction, revokeIdCardAction } from "@/app/actions/self-service-depth";

const TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "brand"> = { APPLIED: "success", PENDING: "warning", SCHEDULED: "brand", REJECTED: "danger", FAILED: "danger", WITHDRAWN: "neutral" };

/**
 * Employee › Notes & records — for HR and the person's managers, never the
 * employee: internal notes (HR-only ones hidden from managers), dotted-line
 * and L2 managers, the ID card, change requests and address history.
 */
export async function HrRecordsTab({ viewer, employeeId, isHr }: { viewer: Viewer; employeeId: string; isHr: boolean }) {
  const t = viewer.tenantId;
  const [notes, secondary, card, requests, addresses] = await Promise.all([
    prisma.employeeInternalNote.findMany({ where: { tenantId: t, employeeId, ...(isHr ? {} : { visibility: "MANAGERS_AND_HR" }) }, orderBy: { createdAt: "desc" } }),
    prisma.secondaryManager.findMany({ where: { tenantId: t, employeeId } }),
    prisma.employeeIdCard.findFirst({ where: { tenantId: t, employeeId }, orderBy: { issuedAt: "desc" } }),
    prisma.changeRequest.findMany({ where: { tenantId: t, employeeId }, orderBy: { createdAt: "desc" }, take: 20 }),
    isHr ? prisma.employeeAddressHistory.findMany({ where: { tenantId: t, employeeId }, orderBy: { validTo: "desc" }, take: 20 }) : Promise.resolve([]),
  ]);
  const managers = await prisma.employee.findMany({ where: { tenantId: t, id: { in: secondary.map((s) => s.managerId) } }, select: { id: true, displayName: true } });
  const mgr = new Map(managers.map((m) => [m.id, m.displayName]));
  const cardState = card ? idCardStatus(card) : null;
  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <Card title="Internal notes" description="Never shown to the employee." tight>
        <div style={{ padding: 14 }}>
          <SpecForm action={addInternalNoteAction} hidden={{ employeeId }} submitLabel="Add note" fields={[
            { name: "body", label: "Note", kind: "textarea", required: true },
            ...(isHr ? [{ name: "visibility", label: "Who can read it", kind: "select" as const, required: true, defaultValue: "MANAGERS_AND_HR", options: [{ value: "MANAGERS_AND_HR", label: "Managers and HR" }, { value: "HR_ONLY", label: "HR only" }] }] : []),
          ]} />
        </div>
        {notes.length === 0 ? <Empty title="No notes yet" /> : (
          <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>{notes.map((n) => (
            <li key={n.id} style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
              <div className="row gap-2" style={{ justifyContent: "space-between" }}>
                <span className="text-xs muted">{n.authorName} · {formatDate(n.createdAt)} {n.visibility === "HR_ONLY" ? <Badge tone="danger">HR only</Badge> : null}</span>
                {n.authorUserId === viewer.user.id || isHr ? <ActionButton action={deleteInternalNoteAction} hidden={{ id: n.id }} label="Delete" confirm="Delete this note?" /> : null}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
            </li>
          ))}</ul>
        )}
      </Card>
      <div className="stack gap-4">
        <Card title="Other managers" tight action={isHr ? <Link className="btn sm" href="/org/units?tab=managers">Manage</Link> : null}>
          {secondary.length === 0 ? <Empty title="No dotted-line or L2 manager" /> : (
            <ul className="stack" style={{ listStyle: "none", padding: 14, margin: 0 }}>{secondary.map((s) => <li key={s.id}>{mgr.get(s.managerId) ?? "—"} — {s.kind === "L2" ? "L2 manager" : "dotted line"}{s.effectiveTo ? ` until ${formatDate(s.effectiveTo)}` : ""}</li>)}</ul>
          )}
        </Card>
        <Card title="ID card" action={card ? <Link className="btn sm" href={`/me/id-card?employee=${employeeId}`}>View</Link> : null}>
          {card ? <p className="text-sm"><span className="mono">{card.cardNumber}</span> · {cardState === "VALID" ? <Badge tone="success">Valid until {formatDate(card.validUntil)}</Badge> : cardState === "REVOKED" ? <Badge tone="danger">Revoked</Badge> : <Badge tone="warning">Expired</Badge>}</p> : <p className="text-sm muted">No card issued.</p>}
          {isHr ? <div className="row gap-2"><ActionButton action={issueIdCardAction} hidden={{ employeeId }} label={card ? "Reissue" : "Issue card"} />{card?.status === "ACTIVE" ? <ActionButton action={revokeIdCardAction} hidden={{ id: card.id }} label="Revoke" confirm="Revoke this card?" /> : null}</div> : null}
        </Card>
        <Card title="Change requests" tight action={<Link className="btn sm" href="/admin/change-requests">Queue</Link>}>
          {requests.length === 0 ? <Empty title="None" /> : (
            <ul className="stack" style={{ listStyle: "none", padding: 14, margin: 0 }}>{requests.map((r) => <li key={r.id}>{r.title} <Badge tone={TONE[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge> <span className="text-xs muted">{formatDate(r.createdAt)}</span></li>)}</ul>
          )}
        </Card>
        {isHr ? (
          <Card title="Address history" tight>
            {addresses.length === 0 ? <Empty title="No earlier addresses" /> : (
              <ul className="stack" style={{ listStyle: "none", padding: 14, margin: 0 }}>{addresses.map((a) => <li key={a.id}><Badge>{a.type.toLowerCase()}</Badge> {[a.line1, a.city, a.postalCode].filter(Boolean).join(", ")} <span className="text-xs muted">until {formatDate(a.validTo)}</span></li>)}</ul>
            )}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
