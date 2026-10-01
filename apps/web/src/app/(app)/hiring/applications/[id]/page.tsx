import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { kitOf, parseRatings, normaliseDecision, decisionLabel, decisionTally, type KitSection } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { aiEnabled, AI_UNAVAILABLE } from "@/lib/ai";
import { KeyValue } from "@/components/ui";
import { OfferForm, OfferOps, HireButton } from "../../forms";
import { StageSelect, ArchiveButton, ScheduleButton, RemindButton, NoteForm } from "../../_parts/candidate";
import { FeedbackDrawer } from "../../_parts/feedback-drawer";
import { SummarizeButton, CandidateFeedbackButton } from "../../_parts/summary";
import { QuestionsButton, type QSection } from "../../_parts/questions";
import { FlashToast } from "../../_parts/toast";
import { userNames, kDate, kDateTime } from "../../_lib/data";
import s from "../../hire.module.css";

const P = PERMISSIONS;
const TABS = [["profile", "Profile"], ["feedback", "Feedback"], ["activity", "Activity"]] as const;
const PALETTE = ["#e8772e", "#f0a91d", "#3b8fe3", "#2f9e62", "#9b59b6", "#e5534b", "#16a3b8"];
const colour = (name: string) => PALETTE[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const when = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const time = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }).toUpperCase();
const DEC_COLOUR: Record<string, string> = { NO_HIRE: "#e5534b", NOT_SURE: "#c6871b", AVERAGE: "#f0a91d", HIRE: "#ef8a80", MUST_HIRE: "#2f9e62" };
const FLASH = { feedback: "Feedback submitted successfully", draft: "Feedback saved as draft" };

export const metadata = { title: "Candidate · Hire" };

/**
 * A candidate on a job — Keka Hire's candidate page (Q01, S01): the header
 * with the hiring stage, Archive and Schedule; then Profile, Feedback (the
 * panel's scorecards, the AI summary, notes) and Activity.
 */
export default async function ApplicationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const sp = await searchParams;
  const app = await prisma.application.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      candidate: { include: { referredBy: { select: { displayName: true } } } },
      job: { include: { flow: { include: { stages: { orderBy: { sequence: "asc" } } } }, questionSets: { orderBy: [{ section: "asc" }, { attempt: "asc" }] } } },
      stageHistory: { include: { stage: true }, orderBy: { enteredAt: "asc" } },
      interviews: { include: { panel: { include: { employee: { select: { id: true, displayName: true } } }, orderBy: { isLead: "desc" } }, scorecards: true }, orderBy: { scheduledAt: "asc" } },
      offer: true,
      notes: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!app) notFound();
  const me = viewer.employee?.id;
  const recruiter = can(viewer, P.CANDIDATE_MANAGE);
  const panelist = app.interviews.some((i) => i.panel.some((p) => p.employeeId === me));
  if (!recruiter && !panelist) notFound();

  const c = app.candidate;
  const name = `${c.firstName} ${c.lastName}`;
  const stages = app.job.flow?.stages ?? [];
  const current = stages.find((x) => x.id === app.currentStageId);
  const tab = (TABS.some(([k]) => k === sp.tab) ? sp.tab : recruiter ? "profile" : "feedback") as (typeof TABS)[number][0];
  const base = `/hiring/applications/${app.id}`;

  // "‹ 1 of 3 ›" — the other active candidates in the same job and stage.
  const peers = recruiter && app.currentStageId
    ? await prisma.application.findMany({ where: { jobId: app.jobId, currentStageId: app.currentStageId, status: { in: ["ACTIVE", "ON_HOLD", "OFFER_EXTENDED", "OFFER_ACCEPTED"] } }, orderBy: { appliedAt: "asc" }, select: { id: true } })
    : [];
  const at = peers.findIndex((p) => p.id === app.id);
  const prev = at > 0 ? peers[at - 1].id : null, next = at >= 0 && at < peers.length - 1 ? peers[at + 1].id : null;

  const addedBy = app.stageHistory[0]?.movedBy ?? null;
  const people = await userNames(viewer.tenantId, [addedBy, app.ownerId, app.feedbackSummaryById, ...app.notes.map((n) => n.authorId), ...app.stageHistory.map((h) => h.movedBy)]);
  const sourceLabel = c.source.toLowerCase().replace(/_/g, " ");

  // Feedback drawer: only for a panellist with feedback still to give on a started interview.
  const fbId = sp.feedback;
  const fbInterview = fbId ? app.interviews.find((i) => i.id === fbId && i.panel.some((p) => p.employeeId === me) && i.status !== "CANCELLED" && i.scheduledAt.getTime() <= Date.now()) : null;
  const myCard = fbInterview ? fbInterview.scorecards.find((x) => x.panelistId === me) : null;
  const kit: KitSection[] = kitOf(app.job.scorecardTemplate);
  const setting = await prisma.hiringSetting.findUnique({ where: { tenantId: viewer.tenantId }, select: { aiQuestionAttempts: true } });
  const maxQ = setting?.aiQuestionAttempts ?? 2;
  const sections: QSection[] = kit.map((k) => ({
    section: k.section, skills: k.skills.map((x) => ({ name: x.name, description: x.description ?? null })),
    sets: app.job.questionSets.filter((q) => q.section === k.section).map((q) => ({ attempt: q.attempt, questions: q.questions as QSection["sets"][number]["questions"] })),
  }));
  const employees = recruiter && can(viewer, P.INTERVIEW_MANAGE)
    ? await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } })
    : [];
  const opt = employees.map((e) => ({ value: e.id, label: e.displayName }));

  return (
    <>
      <section className={s.candHead}>
        <div className={s.crumbs}>
          {recruiter ? <Link href={`/hiring/jobs/${app.jobId}`}>{app.job.title}</Link> : <span style={{ color: "var(--brand-600)" }}>{app.job.title}</span>}
          <span className="subtle">›</span><span className={s.crumbStage}>{current?.name ?? app.status.replace(/_/g, " ")}</span>
          {peers.length > 1 ? (
            <span className={s.pagerMini}>
              {prev ? <Link href={`/hiring/applications/${prev}?tab=${tab}`} aria-label="Previous candidate">‹</Link> : <span className={s.box}>‹</span>}
              <span>{at + 1} of {peers.length}</span>
              {next ? <Link href={`/hiring/applications/${next}?tab=${tab}`} aria-label="Next candidate">›</Link> : <span className={s.box}>›</span>}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <Link href={recruiter ? `/hiring/jobs/${app.jobId}` : "/hiring/interviews"} className={s.iconBtn} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </Link>
        </div>
        <div className={s.candGrid}>
          <div className={s.bigAvatar} style={{ background: colour(name) }}>{initials(name)}</div>
          <div style={{ minWidth: 0 }}>
            <div className={s.candName}>{name}</div>
            <div className={s.candLine}>
              Sourced from {sourceLabel}{c.referredBy ? ` (referred by ${c.referredBy.displayName})` : ""}{addedBy ? ` by ${people.get(addedBy) ?? "the hiring team"}` : ""} on {formatDate(app.appliedAt)}
              {app.ownerId ? <> &nbsp;|&nbsp; Owner: {people.get(app.ownerId) ?? "—"}</> : null}
            </div>
            <div className={s.candContact}>
              {recruiter && c.phone ? <span>☏ {c.phone}</span> : null}
              {recruiter ? <span>✉ {c.email}</span> : <span>{c.currentTitle ?? ""}{c.currentEmployer ? ` at ${c.currentEmployer}` : ""}</span>}
            </div>
          </div>
          {recruiter ? (
            <div className={s.candSide}>
              <div>
                <div className={s.sideLabel}>Hiring stage</div>
                <div style={{ display: "flex", gap: 12 }}>
                  <StageSelect applicationId={app.id} current={app.currentStageId} disabled={app.status !== "ACTIVE" && app.status !== "ON_HOLD"} stages={stages.map((x) => ({ value: x.id, label: x.name }))} />
                  {["ACTIVE", "ON_HOLD"].includes(app.status) ? <ArchiveButton applicationId={app.id} name={name} /> : null}
                </div>
              </div>
              <span className={s.divider} />
              <div>
                <div className={s.sideLabel}>Interactions</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {app.status === "ACTIVE" && can(viewer, P.INTERVIEW_MANAGE) ? <ScheduleButton applicationId={app.id} employees={opt} round={app.interviews.length + 1} /> : null}
                  <a className={s.iconBtn} href={`mailto:${c.email}`} aria-label={`Email ${name}`}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="1.5" /><path d="m4 7 8 6 8-6" /></svg>
                  </a>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <nav className={s.candTabs} style={{ marginTop: 6 }}>
        {TABS.filter(([k]) => recruiter || k !== "profile").map(([k, label]) => <Link key={k} href={`${base}?tab=${k}`} className={`${s.candTab}${tab === k ? ` ${s.active}` : ""}`}>{label}</Link>)}
      </nav>

      {tab === "feedback" ? <Feedback /> : tab === "activity" ? <Activity /> : <Profile />}
      {fbInterview && myCard?.status !== "SUBMITTED" ? (
        <FeedbackDrawer interviewId={fbInterview.id} firstName={name} sections={sections} jobId={app.jobId} maxQuestions={maxQ} closeHref={`${base}?tab=feedback`} aiOn={aiEnabled()} aiUnavailable={AI_UNAVAILABLE}
          draft={myCard ? { recommendation: normaliseDecision(myCard.recommendation), notes: myCard.notes ?? "", ratings: parseRatings(myCard.ratings), aiAssisted: myCard.aiAssisted } : null} />
      ) : null}
      <FlashToast messages={FLASH} />
    </>
  );

  function Profile() {
    return (
      <div className={s.feedbackLayout}>
        <div className="stack gap-4">
          <div className={s.box} style={{ padding: 20 }}>
            <div className={s.fbTitle} style={{ marginBottom: 14 }}>Profile</div>
            <KeyValue items={[
              ["Current role", `${c.currentTitle ?? "—"}${c.currentEmployer ? ` at ${c.currentEmployer}` : ""}`],
              ["Total experience", c.totalExperienceYears ? `${Number(c.totalExperienceYears)} years` : "—"],
              ["Current CTC", c.currentAnnualCtc ? formatINR(Number(c.currentAnnualCtc)) : "—"],
              ["Expected CTC", c.expectedAnnualCtc ? formatINR(Number(c.expectedAnnualCtc)) : "—"],
              ["Notice period", c.noticePeriodDays ? `${c.noticePeriodDays} days` : "—"],
              ["City", c.city ?? "—"],
              ["Source", `${sourceLabel}${c.referredBy ? ` — ${c.referredBy.displayName}` : ""}`],
              ["Applied on", kDate(app.appliedAt)],
              ["Average score", app.averageScore ? `${Number(app.averageScore).toFixed(1)} / 5` : "—"],
            ]} />
          </div>
          <OfferCard />
        </div>
        <NotesCard />
      </div>
    );
  }

  function OfferCard() {
    if (!can(viewer, P.OFFER_MANAGE) && !app!.offer) return null;
    const offer = app!.offer;
    return (
      <div className={s.box} style={{ padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span className={s.fbTitle}>Offer</span>
          {offer ? <span className={`${s.statusChip} ${offer.status === "ACCEPTED" ? s.good : offer.status === "PENDING_APPROVAL" ? s.warn : s.info}`}>{offer.status.toLowerCase().replace(/_/g, " ")}</span> : null}
        </div>
        {offer && !["DECLINED", "WITHDRAWN", "EXPIRED"].includes(offer.status) ? (
          <div className="stack gap-3">
            <KeyValue items={[
              ["Annual CTC", formatINR(Number(offer.annualCtc))],
              ["Joining", offer.proposedJoiningDate ? formatDate(offer.proposedJoiningDate) : "—"],
              ["Expires", offer.expiresOn ? formatDate(offer.expiresOn) : "—"],
              ...(offer.letterUrl ? [["Letter", <a key="l" href={offer.letterUrl}>Download PDF</a>] as [string, React.ReactNode]] : []),
            ]} />
            {can(viewer, P.OFFER_MANAGE) ? <OfferOps applicationId={app!.id} status={offer.status} canApprove={can(viewer, P.OFFER_APPROVE)} /> : null}
            {app!.status === "OFFER_ACCEPTED" && can(viewer, P.EMPLOYEE_CREATE)
              ? <HireButton applicationId={app!.id} suggestedEmail={`${c.firstName}.${c.lastName}`.toLowerCase().replace(/[^a-z.]/g, "") + "@" + viewer.user.email.split("@")[1]} /> : null}
          </div>
        ) : app!.status === "ACTIVE" && can(viewer, P.OFFER_MANAGE) ? (
          <OfferForm applicationId={app!.id} managers={opt} max={app!.job.maxAnnualCtc ? Number(app!.job.maxAnnualCtc) : null} />
        ) : <p className="muted text-sm">{app!.status === "HIRED" ? "Hired." : "No offer."}</p>}
        {offer?.declineReason ? <div className="text-xs neg" style={{ marginTop: 6 }}>Declined: {offer.declineReason}</div> : null}
      </div>
    );
  }

  function NotesCard() {
    return (
      <aside className={`${s.box} ${s.notesCard}`}>
        <svg className={s.notesArt} viewBox="0 0 220 150" fill="none" aria-hidden="true">
          <circle cx="92" cy="72" r="64" fill="#e8f5fa" />
          <rect x="70" y="22" width="120" height="44" rx="8" fill="#fff" stroke="#22a3c4" strokeWidth="3" />
          <circle cx="94" cy="44" r="11" stroke="#22a3c4" strokeWidth="3" /><path d="M112 40h52M112 50h40" stroke="#22a3c4" strokeWidth="3" strokeLinecap="round" />
          <rect x="48" y="80" width="120" height="44" rx="8" fill="#fff" stroke="#22a3c4" strokeWidth="3" />
          <circle cx="144" cy="102" r="11" stroke="#22a3c4" strokeWidth="3" /><path d="M62 98h52M62 108h40" stroke="#22a3c4" strokeWidth="3" strokeLinecap="round" />
          <circle cx="44" cy="40" r="5" stroke="#22a3c4" strokeWidth="2.5" />
        </svg>
        <p className={s.notesText}>Collaborate seamlessly with your hiring team and share feedback, notes and thoughts in one dedicated place</p>
        <div style={{ marginTop: 18 }}><NoteForm applicationId={app!.id} /></div>
        {app!.notes.length ? (
          <div style={{ marginTop: 18 }}>
            {app!.notes.map((n) => (
              <div key={n.id} className={s.note}>
                <div><span className={s.noteWho}>{people.get(n.authorId) ?? "Hiring team"}</span><span className={s.noteWhen}>{kDateTime(n.createdAt)}</span></div>
                <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{n.body}</div>
              </div>
            ))}
          </div>
        ) : null}
      </aside>
    );
  }

  function Feedback() {
    const submitted = app!.interviews.flatMap((iv) => iv.scorecards.filter((x) => x.status === "SUBMITTED"));
    const tally = decisionTally(submitted.map((x) => x.recommendation));
    const scored = submitted.filter((x) => x.overallScore !== null);
    const avg = scored.length ? scored.reduce((n, x) => n + Number(x.overallScore), 0) / scored.length : 0;
    const top = tally[0];
    const panelNames = new Map(app!.interviews.flatMap((iv) => iv.panel.map((p) => [p.employeeId, p.employee.displayName] as const)));
    const detail = (Array.isArray(app!.feedbackSummaryDetail) ? app!.feedbackSummaryDetail : []) as Array<{ panelistId: string; text: string }>;
    const groups = new Map<string, NonNullable<typeof app>["interviews"]>();
    for (const iv of app!.interviews) {
      const stage = stages.find((x) => x.name === iv.title)?.name ?? `Round ${iv.round}`;
      groups.set(stage, [...(groups.get(stage) ?? []), iv]);
    }
    return (
      <div className={s.feedbackLayout}>
        <div>
          <div className={s.fbHead}>
            <span className={s.fbTitle}>Feedback</span>
            {recruiter ? (
              app!.feedbackSummary
                ? <span style={{ display: "flex", gap: 8 }}>
                    <CandidateFeedbackButton applicationId={app!.id} saved={app!.candidateFeedback} aiOn={aiEnabled()} aiUnavailable={AI_UNAVAILABLE} />
                    <SummarizeButton applicationId={app!.id} enabled={submitted.length > 0} aiOn={aiEnabled()} aiUnavailable={AI_UNAVAILABLE} label="Re-summarize" />
                  </span>
                : <SummarizeButton applicationId={app!.id} enabled={submitted.length > 0} aiOn={aiEnabled()} aiUnavailable={AI_UNAVAILABLE} />
            ) : null}
          </div>
          <div className={s.box}>
            {recruiter && submitted.length ? (
              <>
                <div className={s.summaryRow}>
                  <div className={s.avg}>
                    <span className={s.avgCircle}><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" strokeLinejoin="round" /></svg></span>
                    <div><div className={s.avgNum}>{avg ? avg.toFixed(1) : 0}/5</div><div className={s.avgLbl}>Average Rating</div></div>
                  </div>
                  <div className={s.decWrap}>
                    <div className={s.decBar} role="img" aria-label={tally.map((t) => `${t.count} ${t.label}`).join(", ")}>
                      {tally.map((t) => <span key={t.decision} style={{ width: `${(t.count / submitted.length) * 100}%`, background: DEC_COLOUR[t.decision] }} />)}
                    </div>
                    {top ? <span className={s.decLegend}><strong>{top.count}/{submitted.length}</strong> {top.label}</span> : null}
                  </div>
                  <div>
                    <div className="text-sm">Feedback by :</div>
                    <div className={s.faces}>{[...new Set(submitted.map((x) => x.panelistId))].map((pid) => { const n = panelNames.get(pid) ?? "?"; return <span key={pid} className={s.face} style={{ background: colour(n) }} title={n}>{initials(n)}</span>; })}</div>
                  </div>
                </div>
                {app!.feedbackSummary ? (
                  <div className={s.summaryBlock}>
                    <div className={s.summaryTitle}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 3.5l1.7 5.1 5.1 1.7-5.1 1.7L12 17.1l-1.7-5.1-5.1-1.7 5.1-1.7z" /></svg>Feedback Summary</div>
                    <div className={s.summaryText}>{app!.feedbackSummary}</div>
                    {detail.length ? (
                      <details className={s.individual}>
                        <summary>Summarized Individual Feedback</summary>
                        {detail.map((d) => { const n = panelNames.get(d.panelistId) ?? "Panel member"; return (
                          <div key={d.panelistId} className={s.indivItem}><span className={s.face} style={{ background: colour(n) }}>{initials(n)}</span><div><div className="text-sm strong">{n}</div><div className="text-sm">{d.text}</div></div></div>
                        ); })}
                      </details>
                    ) : null}
                    <div className="text-xs subtle" style={{ marginTop: 10 }}>Saved by {app!.feedbackSummaryById ? people.get(app!.feedbackSummaryById) ?? "a recruiter" : "a recruiter"}{app!.feedbackSummaryAt ? ` on ${kDate(app!.feedbackSummaryAt)}` : ""} · AI-assisted</div>
                  </div>
                ) : null}
              </>
            ) : null}
            {app!.interviews.length === 0 ? <div className={s.empty}>No interviews yet.{recruiter ? " Schedule one from Interactions." : ""}</div> : [...groups.entries()].map(([stage, ivs]) => (
              <div key={stage} className={s.round}>
                <div className={s.roundHead}>
                  <div className={s.roundStage}>⌄ {stage}</div>
                  {ivs.map((iv) => {
                    const mine = iv.panel.some((p) => p.employeeId === me);
                    const mySubmitted = iv.scorecards.some((x) => x.panelistId === me && x.status === "SUBMITTED");
                    // Interviewers see others' feedback only after giving their own, so it cannot anchor them.
                    const seeAll = recruiter || mySubmitted;
                    const started = iv.scheduledAt.getTime() <= Date.now();
                    return (
                      <div key={iv.id}>
                        <div className={s.roundTitle}>⌄ {iv.mode === "VIDEO" ? "Online Interview" : iv.mode === "PHONE" ? "Phone Interview" : "In-person Interview"}</div>
                        <div className={s.roundMeta}><span>{when(iv.scheduledAt)} &nbsp;{time(iv.scheduledAt)} ({iv.durationMinutes >= 60 ? `${iv.durationMinutes / 60}h` : `${iv.durationMinutes}m`})</span><span>{app!.job.title} - {iv.title}</span>{iv.status === "CANCELLED" ? <span className="neg">Cancelled</span> : null}</div>
                        <table className={s.panelTable}>
                          <thead><tr><th>Panel member</th><th>Overall decision</th><th>Scorecard average</th><th>Feedback</th></tr></thead>
                          <tbody>
                            {iv.panel.map((p) => {
                              const card = iv.scorecards.find((x) => x.panelistId === p.employeeId);
                              const done = card?.status === "SUBMITTED";
                              const isMe = p.employeeId === me;
                              const visible = done && (seeAll || isMe);
                              const ratings = visible ? parseRatings(card!.ratings) : [];
                              return (
                                <tr key={p.id}>
                                  <td><span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}><span className={s.face} style={{ background: colour(p.employee.displayName) }}>{initials(p.employee.displayName)}</span>{p.employee.displayName}</span></td>
                                  <td>{visible ? decisionLabel(card!.recommendation) : done ? "Submitted" : "Feedback not submitted yet"}</td>
                                  <td>{visible && card!.overallScore !== null ? `${Number(card!.overallScore).toFixed(1)}/5` : visible ? "—" : ""}</td>
                                  <td>
                                    {visible ? (
                                      <div className={s.excerpt}>
                                        {card!.notes ?? [card!.strengths, card!.concerns].filter(Boolean).join(" · ")}
                                        {ratings.length ? <div className="text-xs subtle" style={{ marginTop: 4 }}>{ratings.filter((r) => r.rating !== null).map((r) => `${r.skill} ${r.rating}★`).join(" · ")}</div> : null}
                                      </div>
                                    ) : done ? <span className="text-xs subtle">Visible after you submit yours</span> : (
                                      <span>
                                        {isMe && started && iv.status !== "CANCELLED" ? <Link className={s.addFb} href={`${base}?tab=feedback&feedback=${iv.id}`} scroll={false}>+ {card?.status === "DRAFT" ? "Continue feedback (draft)" : "Add feedback"}</Link> : null}
                                        {isMe && recruiter && started ? <span className={s.sep}>|</span> : null}
                                        {recruiter && !isMe && started ? <RemindButton interviewId={iv.id} employeeId={p.employeeId} /> : null}
                                        {!started ? <span className="text-xs subtle">Upcoming</span> : null}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {mine && !started ? (
                          <div style={{ padding: "0 22px 18px", display: "flex", gap: 10, flexWrap: "wrap" }}>
                            {sections.map((sec) => <QuestionsButton key={sec.section} jobId={app!.jobId} section={sec} max={maxQ} aiOn={aiEnabled()} aiUnavailable={AI_UNAVAILABLE} round={false} label={`Prepare: ${sec.section}`} />)}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <NotesCard />
      </div>
    );
  }

  function Activity() {
    type Entry = { at: Date; who: string; text: string };
    const entries: Entry[] = [
      ...app!.stageHistory.map((h) => ({ at: h.enteredAt, who: h.movedBy ? people.get(h.movedBy) ?? "Hiring team" : "System", text: `Moved to ${h.stage.name}${h.note && h.note !== "Applied" ? ` — ${h.note}` : ""}` })),
      ...app!.interviews.map((iv) => ({ at: iv.createdAt, who: "Hiring team", text: `Scheduled round ${iv.round}: ${iv.title} for ${kDateTime(iv.scheduledAt)}` })),
      ...app!.interviews.flatMap((iv) => iv.scorecards.filter((x) => x.status === "SUBMITTED").map((x) => ({ at: x.submittedAt, who: iv.panel.find((p) => p.employeeId === x.panelistId)?.employee.displayName ?? "Panel member", text: `Submitted feedback for ${iv.title}` }))),
      ...(app!.feedbackSummaryAt ? [{ at: app!.feedbackSummaryAt, who: app!.feedbackSummaryById ? people.get(app!.feedbackSummaryById) ?? "Recruiter" : "Recruiter", text: "Saved the feedback summary" }] : []),
      ...(app!.offer ? [{ at: app!.offer.createdAt, who: "Hiring team", text: `Offer ${app!.offer.status.toLowerCase().replace(/_/g, " ")}` }] : []),
      ...(app!.rejectedAt ? [{ at: app!.rejectedAt, who: "Hiring team", text: `Archived: ${app!.rejectReason ?? ""}` }] : []),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    return (
      <div className={s.box} style={{ padding: "20px 22px" }}>
        <div className={s.fbTitle} style={{ marginBottom: 16 }}>Activity</div>
        {entries.map((e, i) => (
          <div key={i} className={s.activity}>
            <span className={s.activityDot} />
            <div><span className={s.activityWho}>{e.who}</span><span className={s.activityWhen}>on {kDateTime(e.at)}</span><div className={s.activityText}>{e.text}</div></div>
          </div>
        ))}
      </div>
    );
  }
}
