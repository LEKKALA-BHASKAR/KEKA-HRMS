import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";
import { rupees, kDate } from "../_lib/data";
import s from "../hire.module.css";

const P = PERMISSIONS;
export const metadata = { title: "Offers · Hire" };
const TONE: Record<string, string> = { ACCEPTED: "good", EXTENDED: "info", APPROVED: "info", PENDING_APPROVAL: "warn", DECLINED: "bad", WITHDRAWN: "", EXPIRED: "", DRAFT: "" };
const FILTERS = [["", "All"], ["PENDING_APPROVAL", "Pending approval"], ["APPROVED", "Approved"], ["EXTENDED", "Extended"], ["ACCEPTED", "Accepted"], ["DECLINED", "Declined"]] as const;

/** Org › Hiring › Offers: every offer and where it stands. */
export default async function OffersPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const viewer = await requireViewer();
  if (!can(viewer, P.OFFER_MANAGE) && !can(viewer, P.OFFER_APPROVE)) forbidden();
  const status = (await searchParams).status ?? "";
  const offers = await prisma.offer.findMany({
    where: { application: { tenantId: viewer.tenantId }, ...(FILTERS.some(([k]) => k === status) && status ? { status: status as never } : {}) },
    include: { application: { include: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true, code: true, maxAnnualCtc: true } } } } },
    orderBy: { updatedAt: "desc" }, take: 300,
  });
  const managers = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: offers.map((o) => o.reportingManagerId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } });
  const mn = new Map(managers.map((m) => [m.id, m.displayName]));
  return (
    <>
      <div className={s.head}><div><h1 className={s.h1}>Offers</h1><p className={s.sub}>Offers within the requisition&rsquo;s budget are approved at once; anything above it waits for an approver.</p></div></div>
      <nav className={s.segTabs} aria-label="Offer status">
        {FILTERS.map(([k, label]) => <Link key={k} href={k ? `/hiring/offers?status=${k}` : "/hiring/offers"} className={`${s.segTab}${status === k ? ` ${s.active}` : ""}`}>{label}</Link>)}
      </nav>
      <div className={s.cardAlone}>
        {offers.length === 0 ? <div className={s.empty}>No offers{status ? " in this state" : " yet"}.</div> : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>Candidate</th><th>Job</th><th>Annual CTC</th><th>Budget</th><th>Reports to</th><th>Joining</th><th>Expires</th><th>Status</th></tr></thead>
              <tbody>
                {offers.map((o) => {
                  const over = o.application.job.maxAnnualCtc !== null && Number(o.annualCtc) > Number(o.application.job.maxAnnualCtc);
                  return (
                    <tr key={o.id}>
                      <td><Link className={s.reqLink} href={`/hiring/applications/${o.applicationId}`}>{o.application.candidate.firstName} {o.application.candidate.lastName}</Link></td>
                      <td>{o.application.job.title}<div className={s.code}>{o.application.job.code}</div></td>
                      <td className="nowrap">{rupees(o.annualCtc)}{over ? <div className="text-xs neg">above budget</div> : null}</td>
                      <td className="nowrap">{o.application.job.maxAnnualCtc ? `up to ${rupees(o.application.job.maxAnnualCtc)}` : "—"}</td>
                      <td>{o.reportingManagerId ? mn.get(o.reportingManagerId) ?? "—" : "—"}</td>
                      <td className="nowrap">{kDate(o.proposedJoiningDate)}</td>
                      <td className="nowrap">{kDate(o.expiresOn)}</td>
                      <td><span className={`${s.statusChip} ${s[TONE[o.status]] ?? ""}`}>{o.status.charAt(0) + o.status.slice(1).toLowerCase().replace(/_/g, " ")}</span></td>
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
