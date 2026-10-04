"use client";

import { useActionState, useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { saveScorecardAction } from "@/app/actions/hiring";
import { draftFeedbackAction } from "@/app/actions/hiring-ai";
import { IconSparkle } from "@/components/icons";
import type { ActionState } from "@/lib/forms";
import { HireDialog } from "./dialog";
import { QuestionsModal, type QSection } from "./questions";
import s from "../hire.module.css";

type Rating = { rating: number | null; na: boolean; comment: string; showComment: boolean };
const key = (section: string, skill: string) => `${section}\u0000${skill}`;

const ICONS: Record<string, ReactNode> = {
  NO_HIRE: <path d="M7 4v10M7 14l4 6c1.2 0 2-.8 2-2v-3h5.2a2 2 0 0 0 2-2.3l-1.2-7A2 2 0 0 0 17 4H7z" />,
  NOT_SURE: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" /></>,
  AVERAGE: <><circle cx="12" cy="12" r="9" /><path d="M12 12 7.5 8.5M12 3v2M21 12h-2M5 12H3" /></>,
  HIRE: <path d="M7 20V10M7 10l4-6c1.2 0 2 .8 2 2v3h5.2a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17 20H7z" />,
  MUST_HIRE: <path d="M12 3c1 3 4 4.5 4 8.5a4 4 0 0 1-8 0c0-1.7.8-2.9 1.6-3.8.2 1.4 1 2.3 2 2.3-.4-2.6-.2-4.8.4-7z" />,
};
const DECISIONS: Array<[string, string]> = [["NO_HIRE", "No Hire"], ["NOT_SURE", "Not Sure"], ["AVERAGE", "Average"], ["HIRE", "Hire"], ["MUST_HIRE", "Must Hire"]];

const Star = ({ lit }: { lit: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill={lit ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" strokeLinejoin="round" />
  </svg>
);

/**
 * "Feedback on {name}" (Q02): Keka's five-level recommendation, the written
 * feedback (with "Harness AI" to polish rough notes), and the scorecard —
 * sections of skills rated 1–5 stars or N/A, each with an optional comment.
 * Save as draft keeps it private; Submit makes it final.
 */
export function FeedbackDrawer({ interviewId, firstName, sections, draft, closeHref, aiOn, aiUnavailable, jobId, maxQuestions }: {
  interviewId: string; firstName: string; sections: QSection[];
  draft: { recommendation: string | null; notes: string; ratings: Array<{ section: string; skill: string; rating: number | null; comment: string | null }>; aiAssisted: boolean } | null;
  closeHref: string; aiOn: boolean; aiUnavailable: string; jobId: string; maxQuestions: number;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveScorecardAction, {} as ActionState);
  const [decision, setDecision] = useState<string | null>(draft?.recommendation ?? null);
  const [notes, setNotes] = useState(draft?.notes ?? "");
  const [aiAssisted, setAiAssisted] = useState(draft?.aiAssisted ?? false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [aiPending, startAi] = useTransition();
  const [open, setOpen] = useState<Record<string, boolean>>(Object.fromEntries(sections.map((x, i) => [x.section, i === 0])));
  const [qFor, setQFor] = useState<QSection | null>(null);
  const [ratings, setRatings] = useState<Record<string, Rating>>(() => {
    const m: Record<string, Rating> = {};
    for (const r of draft?.ratings ?? []) m[key(r.section, r.skill)] = { rating: r.rating, na: r.rating === null, comment: r.comment ?? "", showComment: !!r.comment };
    return m;
  });
  const get = (sec: string, sk: string): Rating => ratings[key(sec, sk)] ?? { rating: null, na: false, comment: "", showComment: false };
  const put = (sec: string, sk: string, r: Partial<Rating>) => setRatings((m) => ({ ...m, [key(sec, sk)]: { ...get(sec, sk), ...r } }));
  const list = sections.flatMap((sec) => sec.skills.map((sk) => {
    const r = get(sec.section, sk.name);
    return { section: sec.section, skill: sk.name, rating: r.na ? null : r.rating, comment: r.comment.trim() || null };
  })).filter((r) => r.rating !== null || r.comment);

  useEffect(() => { if (state.ok) router.replace(`${closeHref}&flash=${state.message === "Feedback submitted." ? "feedback" : "draft"}`, { scroll: false }); }, [state, router, closeHref]);

  const harness = () => {
    if (!aiOn) { setAiMsg(aiUnavailable); return; }
    setAiMsg(null);
    startAi(async () => {
      const res = await draftFeedbackAction({ interviewId, decision, ratings: list, notes });
      if (res.ok) { setNotes(res.value); setAiAssisted(true); } else setAiMsg(res.reason);
    });
  };
  const anySets = sections.some((x) => x.sets.length);

  return (
    <HireDialog open onClose={() => router.replace(closeHref, { scroll: false })} title={`Feedback on ${firstName}`} side width={680}
      headExtra={anySets ? <button type="button" className={s.linkBtn} style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--text)" }} onClick={() => setQFor(sections.find((x) => x.sets.length) ?? null)}><IconSparkle width={16} height={16} /> View generated questions</button> : null}>
      <form action={action}>
        <input type="hidden" name="interviewId" value={interviewId} />
        <input type="hidden" name="recommendation" value={decision ?? ""} />
        <input type="hidden" name="ratings" value={JSON.stringify(list)} />
        <input type="hidden" name="aiAssisted" value={aiAssisted ? "1" : "0"} />
        {state.message && !state.ok ? <div className="callout danger" style={{ marginBottom: 14 }}>{state.message}</div> : null}
        <div className={s.drawerHead}>
          <span className={s.drawerLabel}>Recommendation and feedback:</span>
          <button type="button" className={s.roundAi} onClick={harness} disabled={aiPending} aria-label="Write feedback with AI" title="Harness AI: polish my notes into feedback">
            {aiPending ? "…" : <IconSparkle width={16} height={16} />}
          </button>
        </div>
        <div className={s.pills} role="radiogroup" aria-label="Recommendation">
          {DECISIONS.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={decision === v} className={`${s.pill}${decision === v ? ` ${s.on}` : ""}`} onClick={() => setDecision(v)}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[v]}</svg>{label}
            </button>
          ))}
        </div>
        {aiMsg ? <div className="callout warning" style={{ marginTop: 12 }}>{aiMsg}</div> : null}
        <div className={`${s.editor} ${s.fbEditor}`}>
          <textarea name="notes" className={s.editorArea} style={{ minHeight: 170 }} placeholder="Add Feedback" value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} aria-label="Feedback" />
        </div>
        {aiAssisted ? <div className="text-xs subtle" style={{ marginTop: 6 }}>Drafted with AI from your ratings and notes — review before you submit.</div> : null}
        {state.errors?.biasReviewed ? (
          <label className="row gap-2 text-sm" style={{ marginTop: 8 }} data-testid="bias-ack">
            <input type="checkbox" name="biasReviewed" value="1" /> I have reviewed the flagged wording and it is about job-related evidence
          </label>
        ) : null}

        <h3 className={s.scoreTitle}>Scorecard</h3>
        {sections.map((sec) => (
          <div key={sec.section}>
            <div className={s.secHead}>
              <button type="button" className={s.secToggle} onClick={() => setOpen((o) => ({ ...o, [sec.section]: !o[sec.section] }))} aria-expanded={!!open[sec.section]}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ transform: open[sec.section] ? "none" : "rotate(-90deg)" }}><path d="m6 9 6 6 6-6" /></svg>
                {sec.section} <span className={s.secCount}>({sec.skills.length})</span>
              </button>
              <button type="button" className={s.roundAi} onClick={() => setQFor(sec)} aria-label={`Generate questions for ${sec.section} using AI`} title="Generate Questions using AI"><IconSparkle width={16} height={16} /></button>
            </div>
            {open[sec.section] ? sec.skills.map((sk) => {
              const r = get(sec.section, sk.name);
              return (
                <div key={sk.name} className={s.skill}>
                  <div className={s.skillTop}>
                    <span className={s.skillName}>{sk.name}</span>
                    <span className={s.stars}>
                      <button type="button" className={`${s.na}${r.na ? ` ${s.lit}` : ""}`} aria-label={`${sk.name}: not applicable`} aria-pressed={r.na} title="Not applicable" onClick={() => put(sec.section, sk.name, { na: !r.na, rating: null })}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></svg>
                      </button>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} type="button" className={`${s.star}${!r.na && (r.rating ?? 0) >= n ? ` ${s.lit}` : ""}`} aria-label={`${sk.name}: ${n} of 5`} aria-pressed={!r.na && r.rating === n}
                          onClick={() => put(sec.section, sk.name, { rating: r.rating === n ? null : n, na: false })}><Star lit={!r.na && (r.rating ?? 0) >= n} /></button>
                      ))}
                    </span>
                  </div>
                  {sk.description ? <div className={s.skillDesc}>{sk.description}</div> : null}
                  {r.showComment
                    ? <textarea className="textarea" rows={2} style={{ marginTop: 10 }} maxLength={1000} value={r.comment} placeholder={`Comment on ${sk.name}`} onChange={(e) => put(sec.section, sk.name, { comment: e.target.value })} aria-label={`Comment on ${sk.name}`} />
                    : <button type="button" className={s.addComment} onClick={() => put(sec.section, sk.name, { showComment: true })}>+ Add comment</button>}
                </div>
              );
            }) : null}
          </div>
        ))}
        <div className={s.footer}>
          <button type="button" className={s.outlineBtn} onClick={() => router.replace(closeHref, { scroll: false })}>Cancel</button>
          <button type="submit" name="intent" value="draft" className={s.secondaryBtn} disabled={pending}>Save as draft</button>
          <button type="submit" name="intent" value="submit" className={s.primaryBtn} disabled={pending}>{pending ? "Saving…" : "Submit"}</button>
        </div>
      </form>
      {qFor ? <QuestionsModal jobId={jobId} section={qFor} max={maxQuestions} aiOn={aiOn} aiUnavailable={aiUnavailable} open onClose={() => setQFor(null)} /> : null}
    </HireDialog>
  );
}
