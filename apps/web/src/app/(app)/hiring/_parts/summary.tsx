"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { saveFeedbackSummaryAction, saveCandidateFeedbackAction } from "@/app/actions/hiring";
import { summarizeFeedbackAction, rephraseSummaryAction, candidateFeedbackAction } from "@/app/actions/hiring-ai";
import { IconSparkle } from "@/components/icons";
import type { ActionState } from "@/lib/forms";
import { HireDialog } from "./dialog";
import { Toast } from "./toast";
import s from "../hire.module.css";

type Individual = { panelistId: string; name: string; text: string };
const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const MAX_VERSIONS = 5;

/**
 * "Summarize feedback through AI" (S01–S03): the panel's submitted feedback
 * distilled, editable, with "Rephrase feedback" producing further versions
 * to page between. Confirm keeps it on the candidate.
 */
export function SummarizeButton({ applicationId, enabled, aiOn, aiUnavailable, label = "Summarize feedback" }: {
  applicationId: string; enabled: boolean; aiOn: boolean; aiUnavailable: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<string[]>([]);
  const [at, setAt] = useState(0);
  const [individual, setIndividual] = useState<Individual[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [state, action, saving] = useActionState(saveFeedbackSummaryAction, {} as ActionState);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { if (state.ok) { setOpen(false); setToast(state.message ?? "Summary saved successfully"); } }, [state]);

  const begin = () => {
    setOpen(true); setMsg(null); setVersions([]); setAt(0); setIndividual([]);
    if (!aiOn) { setMsg(aiUnavailable); return; }
    start(async () => {
      const res = await summarizeFeedbackAction({ applicationId });
      if (res.ok) { setVersions([res.value.summary]); setIndividual(res.value.individual); } else setMsg(res.reason);
    });
  };
  const rephrase = () => {
    const current = versions[at];
    if (!current) return;
    start(async () => {
      const res = await rephraseSummaryAction({ applicationId, text: current });
      if (res.ok) { setVersions((v) => [...v, res.value].slice(-MAX_VERSIONS)); setAt(Math.min(versions.length, MAX_VERSIONS - 1)); } else setMsg(res.reason);
    });
  };
  const text = versions[at] ?? "";

  return (
    <>
      <button type="button" className={s.aiOutline} disabled={!enabled} onClick={begin} title={enabled ? undefined : "Available once a panel member has submitted feedback"}>
        <IconSparkle width={15} height={15} /> {label}
      </button>
      <HireDialog open={open} onClose={() => setOpen(false)} title="Summarize feedback through AI" side width={680}
        footer={<>
          <button type="button" className={s.outlineBtn} onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" form="hire-summary-form" className={s.primaryBtn} disabled={saving || !text.trim()}>{saving ? "Saving…" : "Confirm"}</button>
        </>}>
        <form id="hire-summary-form" action={action}>
          <input type="hidden" name="applicationId" value={applicationId} />
          <input type="hidden" name="detail" value={JSON.stringify(individual.map((i) => ({ panelistId: i.panelistId, text: i.text })))} />
          <div className={s.versionRow}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Feedback Summary</span>
            <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {versions.length ? (
                <span className={s.versionPager}>
                  <button type="button" aria-label="Previous version" disabled={at === 0} onClick={() => setAt((x) => x - 1)}>‹</button>
                  {at + 1}/{versions.length}
                  <button type="button" aria-label="Next version" disabled={at >= versions.length - 1} onClick={() => setAt((x) => x + 1)}>›</button>
                </span>
              ) : null}
              <button type="button" className={s.aiOutline} onClick={rephrase} disabled={busy || !text || versions.length >= MAX_VERSIONS}><IconSparkle width={15} height={15} /> Rephrase feedback</button>
            </span>
          </div>
          {msg ? <div className="callout warning" style={{ marginBottom: 12 }}>{msg}</div> : null}
          {busy && !text ? <div className="muted text-sm" style={{ padding: "30px 0", textAlign: "center" }}>Summarizing the panel&rsquo;s feedback…</div> : null}
          {text || !busy ? (
            <div className={s.editor}>
              <textarea name="summary" className={s.editorArea} style={{ minHeight: 170 }} value={text} aria-label="Feedback summary"
                onChange={(e) => setVersions((v) => v.map((x, i) => (i === at ? e.target.value : x)))} disabled={!versions.length} />
            </div>
          ) : null}
          {individual.length ? (
            <>
              <div className={s.indivHead}>Summarized Individual Feedback</div>
              {individual.map((i) => (
                <div key={i.panelistId} className={s.indivItem}>
                  <span className={s.face} style={{ background: "#f0a91d" }}>{initials(i.name)}</span>
                  <div><div style={{ fontSize: 14 }}>{i.name}</div><div style={{ fontSize: 14, marginTop: 2 }}>{i.text}</div></div>
                </div>
              ))}
            </>
          ) : null}
        </form>
      </HireDialog>
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}

/** "Candidate friendly feedback" (S04): the saved summary, rewritten for the candidate. */
export function CandidateFeedbackButton({ applicationId, saved, aiOn, aiUnavailable }: { applicationId: string; saved: string | null; aiOn: boolean; aiUnavailable: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(saved ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [state, action, saving] = useActionState(saveCandidateFeedbackAction, {} as ActionState);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => { if (state.ok) { setOpen(false); setToast(state.message ?? "Saved"); } }, [state]);
  const generate = () => {
    if (!aiOn) { setMsg(aiUnavailable); return; }
    setMsg(null);
    start(async () => {
      const res = await candidateFeedbackAction({ applicationId });
      if (res.ok) setText(res.value); else setMsg(res.reason);
    });
  };
  return (
    <>
      <button type="button" className={s.aiOutline} onClick={() => { setOpen(true); if (!text) generate(); }}><IconSparkle width={15} height={15} /> Candidate friendly feedback</button>
      <HireDialog open={open} onClose={() => setOpen(false)} title="Candidate friendly feedback" side width={640}
        footer={<>
          <button type="button" className={s.outlineBtn} onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" className={s.outlineBtn} onClick={() => navigator.clipboard?.writeText(text)} disabled={!text}>Copy</button>
          <button type="submit" form="hire-cand-fb" className={s.primaryBtn} disabled={saving || !text.trim()}>{saving ? "Saving…" : "Save"}</button>
        </>}>
        <form id="hire-cand-fb" action={action}>
          <input type="hidden" name="applicationId" value={applicationId} />
          <div className={s.versionRow}>
            <span className="text-sm muted">Written for the candidate: no scores, no interviewer names, no decision.</span>
            <button type="button" className={s.aiOutline} onClick={generate} disabled={busy}><IconSparkle width={15} height={15} /> {busy ? "Writing…" : text ? "Rewrite" : "Generate"}</button>
          </div>
          {msg ? <div className="callout warning" style={{ marginBottom: 12 }}>{msg}</div> : null}
          <div className={s.editor}><textarea name="text" className={s.editorArea} style={{ minHeight: 200 }} value={text} onChange={(e) => setText(e.target.value)} aria-label="Candidate feedback" /></div>
        </form>
      </HireDialog>
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
