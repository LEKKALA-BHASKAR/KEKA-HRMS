import type { Metadata } from "next";
import { prisma } from "@keka/db";
import { openApplicantLink, formatInZone } from "@keka/services";
import { GrowthForm, ActButton } from "@/components/growth-forms";
import { tenantFromHost } from "@/lib/tenant-host";
import { applicantUpdateDetailsAction, applicantChangeRequestAction, applicantRecordingConsentAction, applicantWithdrawAction } from "../../portal-actions";

export const metadata: Metadata = { title: "Your application", robots: { index: false } };

const STATUS: Record<string, string> = {
  ACTIVE: "In progress", ON_HOLD: "On hold", REJECTED: "Closed", WITHDRAWN: "Withdrawn", OFFER_EXTENDED: "Offer sent", OFFER_ACCEPTED: "Offer accepted", OFFER_DECLINED: "Offer declined", HIRED: "Hired",
};

/**
 * The applicant portal, behind the personal link emailed when they applied:
 * where their application stands, upcoming interviews in their own time
 * zone, and what they can change themselves.
 */
export default async function ApplicantStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await openApplicantLink(token, { recordView: true });
  const host = await tenantFromHost();
  if (!p || p.link.tenantId !== host?.id) return <div className="card" style={{ padding: 20 }}>This link is not valid any more. Ask the recruiter for a new one.</div>;
  const { app, consents, requests } = p;
  const stages = app.job.flow?.stages ?? [];
  // Applicants see where they are in the journey, not internal stage names past their own.
  const at = stages.findIndex((s) => s.id === app.currentStageId);
  const tz = app.candidate.sourcingProfile?.timeZone ?? "Asia/Kolkata";
  const closed = ["HIRED", "REJECTED", "WITHDRAWN"].includes(app.status);
  const upcoming = app.interviews.filter((i) => i.scheduledAt.getTime() > Date.now() && i.status !== "COMPLETED");
  const consent = new Map(consents.map((c) => [c.interviewId, c.status]));
  const reasons = await prisma.dispositionReason.findMany({ where: { tenantId: p.link.tenantId, kind: "WITHDRAW", isActive: true }, orderBy: { sortOrder: "asc" } });
  return (
    <div className="stack gap-3">
      <div>
        <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>{app.job.title}</h1>
        <div className="muted">Hi {app.candidate.firstName} — your application is <strong data-testid="applicant-status">{STATUS[app.status] ?? app.status}</strong>.</div>
      </div>
      {stages.length && !closed ? (
        <ol className="row gap-2 text-sm" style={{ listStyle: "none", padding: 0, flexWrap: "wrap" }} aria-label="Progress">
          {stages.filter((s) => s.stageKind !== "REJECTED").map((s, i) => (
            <li key={s.id} className="card" style={{ padding: "6px 10px", fontWeight: i === at ? 700 : 400, opacity: i <= at ? 1 : 0.55 }} aria-current={i === at ? "step" : undefined}>{i < at ? "✓ " : ""}{s.name}</li>
          ))}
        </ol>
      ) : null}
      <section className="card" style={{ padding: 16 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Interviews</h2>
        {upcoming.length === 0 ? <div className="text-sm muted">Nothing scheduled right now.</div> : upcoming.map((iv) => (
          <div key={iv.id} className="row gap-2" style={{ justifyContent: "space-between", flexWrap: "wrap", padding: "6px 0" }}>
            <div><strong>{iv.title}</strong> — {formatInZone(iv.scheduledAt, tz)} ({iv.durationMinutes} min, {iv.mode.toLowerCase()})</div>
            <div className="row gap-1">
              <span className="text-xs muted">Recording: {consent.get(iv.id)?.toLowerCase() ?? "not asked"}</span>
              <ActButton action={applicantRecordingConsentAction} hidden={{ token, interviewId: iv.id, status: "GRANTED" }} label="Allow recording" />
              <ActButton action={applicantRecordingConsentAction} hidden={{ token, interviewId: iv.id, status: "DECLINED" }} label="Don't record" />
            </div>
          </div>
        ))}
        <div className="text-xs muted">Times are shown in {tz}. Change your time zone below.</div>
      </section>
      {!closed ? (
        <>
          <section className="card" style={{ padding: 16 }}>
            <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Your contact details</h2>
            <GrowthForm action={applicantUpdateDetailsAction} hidden={{ token }} cols={3} submitLabel="Update" fields={[
              { name: "phone", label: "Phone", defaultValue: app.candidate.phone },
              { name: "city", label: "City", defaultValue: app.candidate.city },
              { name: "timeZone", label: "Time zone", defaultValue: tz, placeholder: "e.g. Asia/Kolkata" },
            ]} />
          </section>
          <section className="card" style={{ padding: 16 }}>
            <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Ask for a change</h2>
            <p className="text-sm muted">Your expected salary or notice period has changed? The hiring team will review it and email you.</p>
            <GrowthForm action={applicantChangeRequestAction} hidden={{ token }} cols={3} submitLabel="Send request" fields={[
              { name: "field", label: "What changed", type: "select", required: true, options: [{ value: "EXPECTED_CTC", label: "Expected annual CTC (₹)" }, { value: "NOTICE_PERIOD", label: "Notice period (days)" }] },
              { name: "value", label: "New value", type: "number", required: true },
              { name: "note", label: "Note" },
            ]} />
            {requests.length ? (
              <ul className="text-sm" style={{ marginTop: 8 }} data-testid="applicant-requests">
                {requests.map((r) => <li key={r.id}>{r.field === "EXPECTED_CTC" ? "Expected CTC" : "Notice period"} → {r.newValue}: {r.status.toLowerCase()}</li>)}
              </ul>
            ) : null}
          </section>
          <section className="card" style={{ padding: 16 }}>
            <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Withdraw</h2>
            <GrowthForm action={applicantWithdrawAction} hidden={{ token }} cols={2} submitLabel="Withdraw my application" fields={[
              ...(reasons.length ? [{ name: "reasonId", label: "Reason", type: "select" as const, options: reasons.map((r) => ({ value: r.id, label: r.label })) }] : [{ name: "reason", label: "Reason" }]),
              { name: "note", label: "Anything else" },
              { name: "confirm", label: "I want to withdraw my application", type: "checkbox" },
            ]} />
          </section>
        </>
      ) : null}
    </div>
  );
}
