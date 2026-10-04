import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { pendingHireRequests } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { ActButton } from "@/components/growth-forms";
import { requestReferralBonusAction, markReferralBonusPaidAction } from "@/app/actions/hire-ops";
import { SourcingTabs, day, inr, pretty } from "../_parts/depth-tabs";

export const metadata = { title: "Referrals · Hire" };

/**
 * Employee referrals: who referred whom, how far each got, and the referral
 * bonus — requested once the candidate accepts, approved on the workflow
 * engine, then marked paid.
 */
export default async function ReferralsPage() {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const cands = await prisma.candidate.findMany({
    where: { tenantId: viewer.tenantId, referredById: { not: null } },
    include: { referredBy: { select: { displayName: true } }, referralRecord: true, applications: { select: { id: true, status: true, job: { select: { title: true } } } } },
    orderBy: { createdAt: "desc" }, take: 500,
  });
  const pending = await pendingHireRequests(viewer.tenantId, "REFERRAL_BONUS", cands.map((c) => c.referralRecord?.id).filter((x): x is string => !!x));
  const hired = cands.filter((c) => c.applications.some((a) => a.status === "HIRED")).length;
  const paid = cands.reduce((s, c) => s + (c.referralRecord?.bonusStatus === "PAID" ? Number(c.referralRecord.bonusAmount ?? 0) : 0), 0);
  return (
    <>
      <SourcingTabs />
      <PageHead title="Referrals" subtitle="Track referred candidates and the bonuses owed to the employees who referred them." />
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Referred candidates" value={cands.length} />
        <Stat label="Hired" value={hired} meta={cands.length ? `${Math.round((hired / cands.length) * 100)}% conversion` : undefined} />
        <Stat label="Bonuses paid" value={inr(paid)} />
      </div>
      <Card tight>
        {cands.length === 0 ? <Empty title="No referrals yet" /> : (
          <div className="table-wrap">
            <table className="data" data-testid="referral-table">
              <thead><tr><th>Candidate</th><th>Referred by</th><th>Applications</th><th>Bonus</th><th /></tr></thead>
              <tbody>
                {cands.map((c) => {
                  const r = c.referralRecord;
                  const eligible = c.applications.some((a) => a.status === "HIRED" || a.status === "OFFER_ACCEPTED");
                  return (
                    <tr key={c.id}>
                      <td><Link href={`/hiring/candidates/${c.id}`}>{c.firstName} {c.lastName}</Link><div className="text-xs muted">since {day(c.createdAt)}{r?.relationship ? ` · ${r.relationship}` : ""}</div></td>
                      <td>{c.referredBy?.displayName ?? "—"}</td>
                      <td className="text-xs">{c.applications.map((a) => <div key={a.id}>{a.job.title} · {pretty(a.status)}</div>)}</td>
                      <td>{r && r.bonusStatus !== "NONE" ? <><Badge tone={r.bonusStatus === "PAID" ? "success" : r.bonusStatus === "REJECTED" ? "danger" : "warning"}>{pending.has(r.id) ? "Awaiting approval" : pretty(r.bonusStatus)}</Badge> {inr(r.bonusAmount)}</> : <span className="subtle">—</span>}</td>
                      <td className="right">
                        {eligible && (!r || ["NONE", "REJECTED"].includes(r.bonusStatus)) ? <ActButton action={requestReferralBonusAction} hidden={{ candidateId: c.id }} label="Request bonus" input={{ name: "amount", placeholder: "₹", type: "number", required: true }} /> : null}
                        {r?.bonusStatus === "APPROVED" ? <ActButton action={markReferralBonusPaidAction} hidden={{ id: r.id }} label="Mark paid" variant="primary" /> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
