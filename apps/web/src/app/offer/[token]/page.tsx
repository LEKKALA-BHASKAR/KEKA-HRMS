import type { Metadata } from "next";
import { openOfferLink, closedMessage, inr } from "@keka/services";
import { throttled, clientIp } from "@/lib/throttle";
import { LetterFrame } from "../../(app)/documents/letters/forms";
import { RespondToOffer } from "./respond";

/** The token is in the address: keep it out of search engines and other sites' referrer logs. */
export const metadata: Metadata = { title: "Your offer", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

const fmt = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "To be confirmed");

function Shell({ company, children }: { company?: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg, #f7f7f8)" }}>
      <header style={{ background: "#fff", borderBottom: "1px solid var(--border, #e4e4e7)" }}>
        <div style={{ maxWidth: 860, margin: "0 auto", padding: "16px" }}>
          <span className="strong" style={{ fontSize: 18 }}>{company ? `${company} · Your offer` : "Your offer"}</span>
        </div>
      </header>
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px" }}>{children}</main>
    </div>
  );
}

/**
 * The candidate offer portal, opened from the link in the offer email. No
 * sign-in: the token is the credential. It shows this candidate's offer and
 * nothing else, and is rate-limited per address.
 */
export default async function OfferPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = (await clientIp()) ?? "unknown";
  if (throttled(`offer-view|${ip}`, 60, 10 * 60_000)) {
    return <Shell><div className="callout warning">Too many requests from your network just now. Please try again in a few minutes.</div></Shell>;
  }
  const view = await openOfferLink(token, { recordView: true });
  if (!view) {
    return <Shell><div className="card"><div className="card-body stack gap-2"><h1 style={{ fontSize: 20, margin: 0 }}>This link is not valid</h1><p className="muted">Check that you opened the full link from your offer email. If it still does not work, ask the hiring team to send it again.</p></div></div></Shell>;
  }
  const facts: Array<[string, string]> = [
    ["Role", view.jobTitle],
    ["Annual cost to company", inr(view.annualCtc)],
    ...(view.joiningBonus ? [["Joining bonus", inr(view.joiningBonus)] as [string, string]] : []),
    ["Joining date", fmt(view.joiningDate)],
    ["Offer valid until", fmt(view.offerExpiresOn)],
  ];
  const visible = view.state === "OPEN" || view.state === "ACCEPTED" || view.state === "DECLINED";

  return (
    <Shell company={view.company}>
      <div className="stack gap-4">
        <div>
          <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>{view.state === "ACCEPTED" ? `Welcome aboard, ${view.firstName}` : `Congratulations, ${view.firstName}`}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {view.state === "OPEN" ? `${view.company} is pleased to offer you the role of ${view.jobTitle}. Read the letter below, then accept it with your e-signature or let us know you are declining.` : closedMessage(view.state)}
          </p>
        </div>

        {visible ? (
          <>
            <div className="card"><div className="card-body">
              <dl className="grid grid-2" style={{ margin: 0, gap: 12 }}>
                {facts.map(([k, v]) => <div key={k}><dt className="text-xs subtle">{k}</dt><dd className="strong" style={{ margin: 0 }}>{v}</dd></div>)}
              </dl>
            </div></div>

            <div className="card">
              <div className="card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="card-title">Offer letter</span>
                <span className="row gap-2">
                  {view.letterUrl ? <a className="btn sm" href={`/offer/${token}/letter`} rel="noreferrer">Download PDF</a> : null}
                  {view.signedLetterUrl ? <a className="btn sm" href={`/offer/${token}/letter?copy=signed`} rel="noreferrer">Download signed copy</a> : null}
                </span>
              </div>
              <div className="card-body"><LetterFrame html={view.html} height={560} /></div>
            </div>

            {view.state === "OPEN" ? (
              <div className="card">
                <div className="card-head"><span className="card-title">Your answer</span></div>
                <div className="card-body"><RespondToOffer token={token} name={view.candidateName} /></div>
              </div>
            ) : view.state === "ACCEPTED" && view.signedAt ? (
              <div className="callout success">You signed this offer as {view.signerName} on {fmt(view.signedAt)}. The hiring team will be in touch about your first day.</div>
            ) : view.state === "DECLINED" ? (
              <div className="callout">You declined this offer{view.declineReason ? `: “${view.declineReason}”` : ""}. Thank you for letting us know.</div>
            ) : null}
            <p className="text-xs subtle">This page is personal to you; please do not forward the link. It works until {fmt(view.linkExpiresAt)}.</p>
          </>
        ) : null}
      </div>
    </Shell>
  );
}
