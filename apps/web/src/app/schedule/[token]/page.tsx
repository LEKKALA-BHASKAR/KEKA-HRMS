import type { Metadata } from "next";
import { openSlotOffer } from "@keka/services";
import { throttled, clientIp } from "@/lib/throttle";
import { PickSlot } from "./pick";

/** The token is in the address: keep it out of search engines and other sites' referrer logs. */
export const metadata: Metadata = { title: "Pick an interview time", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

function Shell({ company, children }: { company?: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg, #f7f7f8)" }}>
      <header style={{ background: "#fff", borderBottom: "1px solid var(--border, #e4e4e7)" }}>
        <div style={{ maxWidth: 640, margin: "0 auto", padding: "16px" }}><span className="strong" style={{ fontSize: 18 }}>{company ? `${company} · Interview` : "Interview"}</span></div>
      </header>
      <main style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px" }}>{children}</main>
    </div>
  );
}

/**
 * Candidate self-scheduling, opened from the link the recruiter emailed. No
 * sign-in: the token is the credential. It shows only this invitation's
 * times, and booking one schedules the interview with the panel.
 */
export default async function SchedulePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = (await clientIp()) ?? "unknown";
  if (throttled(`slot-view|${ip}`, 60, 10 * 60_000)) return <Shell><div className="callout warning">Too many requests from your network just now. Please try again in a few minutes.</div></Shell>;
  const view = await openSlotOffer(token);
  if (!view) return <Shell><div className="card"><div className="card-body"><h1 style={{ fontSize: 20, margin: 0 }}>This link is not valid</h1><p className="muted">Check that you opened the full link from the email.</p></div></div></Shell>;
  return (
    <Shell company={view.company}>
      <div className="stack gap-4">
        <div>
          <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Hi {view.candidate}, pick a time</h1>
          <p className="muted" style={{ margin: 0 }}>{view.title} for {view.job} · {view.durationMinutes} minutes · {view.mode === "IN_PERSON" ? "in person" : view.mode.toLowerCase()}</p>
        </div>
        {view.status === "OPEN" ? <PickSlot token={token} slots={view.slots} />
          : view.status === "BOOKED" ? <div className="callout success">You are booked{view.chosenSlot ? ` for ${view.chosenSlot.slice(0, 16).replace("T", " ")} UTC` : ""}. The hiring team will send the details.</div>
          : <div className="callout warning">These times are no longer available. Please ask the hiring team for new ones.</div>}
      </div>
    </Shell>
  );
}
