import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { bandCheck, offerComparison, offerTurnaround, hireDepthConfig, hireStringList, pendingHireRequest, LOCALE_NAMES } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Callout, KeyValue, Empty } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import {
  applyOfferClausesAction, tickOfferChecklistAction, logNegotiationAction, resolveNegotiationAction, confirmCompensationAction, requestOfferRevisionAction, withdrawOfferAction,
} from "@/app/actions/hire-offers";
import { inr, day, when, pretty } from "../../_parts/depth-tabs";

export const metadata = { title: "Offer · Hire" };

/**
 * One offer in depth: its versions, how it compares with what the candidate
 * earns and asked for, the pay-band check, the clauses in the letter, the
 * checklist before extending, negotiations, revisions and withdrawal.
 */
export default async function OfferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.OFFER_MANAGE);
  const { id } = await params;
  const app = await prisma.application.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { offer: true, candidate: true, job: true } });
  if (!app?.offer) notFound();
  const o = app.offer;
  const [versions, negotiations, extra, clauses, checks, cfg, revision, grade] = await Promise.all([
    prisma.offerVersion.findMany({ where: { tenantId: viewer.tenantId, applicationId: app.id }, orderBy: { version: "desc" } }),
    prisma.offerNegotiation.findMany({ where: { tenantId: viewer.tenantId, applicationId: app.id }, orderBy: { createdAt: "desc" } }),
    prisma.offerExtra.findUnique({ where: { applicationId: app.id } }),
    prisma.offerClause.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: [{ locale: "asc" }, { sortOrder: "asc" }] }),
    prisma.offerChecklistCheck.findMany({ where: { tenantId: viewer.tenantId, applicationId: app.id } }),
    hireDepthConfig(viewer.tenantId),
    pendingHireRequest(viewer.tenantId, "OFFER_REVISION", app.id),
    o.payGradeId ? prisma.payGrade.findFirst({ where: { id: o.payGradeId, tenantId: viewer.tenantId } }) : null,
  ]);
  const ctc = Number(o.annualCtc);
  const competitor = negotiations.find((n) => n.competitorCtc)?.competitorCtc;
  const band = bandCheck(ctc, grade ? { name: grade.name, minAnnual: grade.minAnnual === null ? null : Number(grade.minAnnual), maxAnnual: grade.maxAnnual === null ? null : Number(grade.maxAnnual), midAnnual: grade.midAnnual === null ? null : Number(grade.midAnnual) } : null);
  const compare = offerComparison({ offered: ctc, current: app.candidate.currentAnnualCtc === null ? null : Number(app.candidate.currentAnnualCtc), expected: app.candidate.expectedAnnualCtc === null ? null : Number(app.candidate.expectedAnnualCtc), competitor: competitor ? Number(competitor) : null, budgetMax: app.job.maxAnnualCtc === null ? null : Number(app.job.maxAnnualCtc) });
  const turn = offerTurnaround(o);
  const chosen = new Set(hireStringList(extra?.clauseIds));
  const ticked = new Set(checks.map((c) => c.item));
  const preExtend = ["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(o.status);
  return (
    <>
      <PageHead title={`Offer to ${app.candidate.firstName} ${app.candidate.lastName}`} subtitle={<>{app.job.title} · <Link href={`/hiring/applications/${app.id}?tab=offer`}>open the application</Link></>} actions={<Badge tone={o.status === "ACCEPTED" ? "success" : o.status === "DECLINED" || o.status === "WITHDRAWN" ? "danger" : "info"}>{pretty(o.status)}</Badge>} />
      {revision ? <Callout tone="warning">A revision is waiting for approval.</Callout> : null}
      {extra?.withdrawReason && o.status === "WITHDRAWN" ? <Callout tone="danger" title="Withdrawn">{extra.withdrawReason}</Callout> : null}
      <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
        <div className="stack gap-3">
          <Card title="Terms">
            <KeyValue items={[
              ["Annual CTC", inr(ctc)], ["Joining bonus", inr(o.joiningBonus)], ["Joining date", day(o.proposedJoiningDate)], ["Expires", day(o.expiresOn)],
              ["Pay band", <span key="b" className={band.ok ? "pos" : "neg"} data-testid="band-check">{band.message}</span>],
              ["Compensation confirmed", extra?.compConfirmedAt ? `${when(extra.compConfirmedAt)} — ${extra.compConfirmedNote ?? ""}` : null],
              ["Turnaround (days)", `approve ${turn.toApprove ?? "—"} · extend ${turn.toExtend ?? "—"} · answer ${turn.toRespond ?? "—"}`],
            ]} />
            {!extra?.compConfirmedAt ? <div style={{ marginTop: 8 }}><ActButton action={confirmCompensationAction} hidden={{ applicationId: app.id }} label="Confirm compensation" input={{ name: "note", placeholder: "e.g. checked with payroll", required: true }} /></div> : null}
          </Card>
          <Card title="Comparison" tight>
            <table className="data" data-testid="offer-comparison"><tbody>
              {compare.map((r) => <tr key={r.label}><td>{r.label}</td><td>{inr(r.amount)}</td><td className="text-sm">{r.note}</td></tr>)}
            </tbody></table>
          </Card>
          <Card title="Versions" tight>
            {versions.length === 0 ? <Empty title="No versions recorded" /> : (
              <table className="data" data-testid="offer-versions"><tbody>
                {versions.map((v) => <tr key={v.id}><td>v{v.version} · {pretty(v.event)}</td><td>{inr(v.annualCtc)}{v.joiningBonus ? ` + ${inr(v.joiningBonus)}` : ""}</td><td className="text-xs">{v.reason ?? ""}</td><td className="text-xs">{when(v.createdAt)}</td></tr>)}
              </tbody></table>
            )}
          </Card>
        </div>
        <div className="stack gap-3">
          {cfg.offerChecklist.length ? (
            <Card title="Before extending" description={`${ticked.size} of ${cfg.offerChecklist.length} done. The offer cannot be extended until all are ticked.`}>
              <ul className="stack gap-1" style={{ listStyle: "none", padding: 0 }} data-testid="offer-checklist">
                {cfg.offerChecklist.map((item) => <li key={item} className="row gap-2"><ActButton action={tickOfferChecklistAction} hidden={{ applicationId: app.id, item }} label={ticked.has(item) ? "✓" : "○"} /> {item}</li>)}
              </ul>
            </Card>
          ) : null}
          <Card title="Clauses in the letter" description={`Language: ${LOCALE_NAMES[extra?.locale ?? "en"] ?? extra?.locale ?? "English"}.`}>
            <div className="text-sm">{clauses.filter((c) => chosen.has(c.id)).map((c) => c.title).join(", ") || "None"}</div>
            {preExtend ? (
              <Reveal label="Change clauses">
                <GrowthForm action={applyOfferClausesAction} hidden={{ applicationId: app.id }} cols={2} submitLabel="Apply" fields={[
                  { name: "locale", label: "Letter language", type: "select", options: Object.entries(LOCALE_NAMES).map(([k, v]) => ({ value: k, label: v })), defaultValue: extra?.locale ?? "en" },
                  { name: "mode", label: "Choose", type: "select", options: [{ value: "rules", label: "By the clause rules" }, { value: "manual", label: "The ones ticked below" }], defaultValue: "rules" },
                  { name: "clauseIds", label: "Clauses", type: "checklist", options: clauses.map((c) => ({ value: c.id, label: `${c.title} (${c.locale})` })), checked: [...chosen] },
                ]} />
              </Reveal>
            ) : null}
          </Card>
          <Card title="Negotiation" tight>
            {negotiations.length === 0 ? <div className="text-sm subtle" style={{ padding: 12 }}>No requests from the candidate.</div> : (
              <table className="data" data-testid="negotiations"><tbody>
                {negotiations.map((n) => (
                  <tr key={n.id}>
                    <td>{pretty(n.kind)}<div className="text-xs muted">{n.requestedCtc ? `asks ${inr(n.requestedCtc)}` : ""}{n.requestedJoiningDate ? ` · join ${day(n.requestedJoiningDate)}` : ""}{n.competitorName ? ` · ${n.competitorName} ${inr(n.competitorCtc)}` : ""}{n.note ? ` · ${n.note}` : ""}</div></td>
                    <td><Badge tone={n.status === "AGREED" ? "success" : n.status === "DECLINED" ? "danger" : "warning"}>{pretty(n.status)}</Badge>{n.resolution ? <div className="text-xs">{n.resolution}</div> : null}</td>
                    <td className="right">{n.status === "OPEN" ? <><ActButton action={resolveNegotiationAction} hidden={{ id: n.id, status: "AGREED" }} label="Agree" input={{ name: "resolution", placeholder: "Outcome", required: true }} /> <ActButton action={resolveNegotiationAction} hidden={{ id: n.id, status: "DECLINED" }} label="Decline" input={{ name: "resolution", placeholder: "Why", required: true }} /></> : null}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
            <div style={{ padding: 12 }}>
              <Reveal label="Log a request">
                <GrowthForm action={logNegotiationAction} hidden={{ applicationId: app.id }} cols={2} submitLabel="Log" fields={[
                  { name: "kind", label: "They ask for", type: "select", required: true, options: [{ value: "COUNTER_OFFER", label: "More pay" }, { value: "JOINING_DATE", label: "Another joining date" }, { value: "OTHER", label: "Something else" }] },
                  { name: "requestedCtc", label: "CTC asked (₹)", type: "number" }, { name: "requestedJoiningDate", label: "Joining date asked", type: "date" },
                  { name: "competitorName", label: "Competing company" }, { name: "competitorCtc", label: "Competing CTC (₹)", type: "number" }, { name: "note", label: "Note", type: "textarea" },
                ]} />
              </Reveal>
            </div>
          </Card>
          {["APPROVED", "EXTENDED", "DECLINED"].includes(o.status) && !revision ? (
            <Card title="Revise the offer" description="A revision is approved like the original; the candidate's old link stops working and a new version is recorded.">
              <GrowthForm action={requestOfferRevisionAction} hidden={{ applicationId: app.id }} cols={2} submitLabel="Request revision" fields={[
                { name: "annualCtc", label: "Revised CTC (₹)", type: "number", required: true, defaultValue: ctc }, { name: "joiningBonus", label: "Joining bonus (₹)", type: "number", defaultValue: o.joiningBonus === null ? null : Number(o.joiningBonus) },
                { name: "proposedJoiningDate", label: "Joining date", type: "date", defaultValue: o.proposedJoiningDate?.toISOString().slice(0, 10) }, { name: "expiresOn", label: "Expires", type: "date", defaultValue: o.expiresOn?.toISOString().slice(0, 10) },
                { name: "reason", label: "Why", type: "textarea", required: true },
              ]} />
            </Card>
          ) : null}
          {["DRAFT", "PENDING_APPROVAL", "APPROVED", "EXTENDED"].includes(o.status) ? (
            <Card title="Withdraw">
              <ActButton action={withdrawOfferAction} hidden={{ applicationId: app.id }} label="Withdraw the offer" variant="danger" confirmText="Withdraw this offer? The candidate's link stops working." input={{ name: "reason", placeholder: "Reason", required: true }} />
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
