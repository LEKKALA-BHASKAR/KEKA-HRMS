"use client";

import { useState, useTransition } from "react";
import { generateQuestionsAction } from "@/app/actions/hiring-ai";
import { IconSparkle } from "@/components/icons";
import { HireDialog } from "./dialog";
import s from "../hire.module.css";

export interface QSet { attempt: number; questions: Array<{ skill: string; questions: string[] }> }
export interface QSection { section: string; skills: Array<{ name: string; description: string | null }>; sets: QSet[] }

const CopyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>
);

function copy(text: string, done: (msg: string) => void) {
  navigator.clipboard?.writeText(text).then(() => done("Copied"), () => done("Copy failed — select and copy the text instead"));
}

/**
 * "Generate questions using AI" (Q03): pick skills in one scorecard section,
 * generate (at most twice per section), copy them. Generated sets are kept
 * on the job, so every interviewer on the panel sees the same questions.
 */
export function QuestionsModal({ jobId, section, max, aiOn, aiUnavailable, open, onClose }: {
  jobId: string; section: QSection; max: number; aiOn: boolean; aiUnavailable: string; open: boolean; onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(section.skills.slice(0, 2).map((k) => k.name));
  const [sets, setSets] = useState<QSet[]>(section.sets);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const used = sets.length;
  const latest = sets[sets.length - 1] ?? null;
  const exhausted = used >= max;

  const generate = () => {
    if (!aiOn) { setMsg(aiUnavailable); return; }
    setMsg(null);
    start(async () => {
      const res = await generateQuestionsAction({ jobId, section: section.section, skills: chosen });
      if (res.ok) setSets((xs) => [...xs, { attempt: res.value.used, questions: res.value.questions }]);
      else setMsg(res.reason);
    });
  };
  const all = latest ? latest.questions.map((q) => `${q.skill}\n${q.questions.map((x, i) => `${i + 1}. ${x}`).join("\n")}`).join("\n\n") : "";

  return (
    <HireDialog open={open} onClose={onClose} width={720} title={<>Generate questions using AI <span className={s.beta}>BETA</span></>}>
      <div style={{ fontSize: 14 }}>Section</div>
      <div style={{ fontSize: 14, fontWeight: 600, textTransform: "uppercase", marginTop: 4 }}>{section.section}</div>
      <div className={s.qLabel}>Select skills that you want to generate the questions for</div>
      <div className={s.qChips}>
        {section.skills.map((k) => (
          <label key={k.name} className={s.qChip}>
            <input type="checkbox" checked={chosen.includes(k.name)} onChange={() => setChosen((c) => (c.includes(k.name) ? c.filter((x) => x !== k.name) : [...c, k.name]))} />
            {k.name}
          </label>
        ))}
      </div>
      <div className={s.regen}>
        <button type="button" className={s.aiBtn} onClick={generate} disabled={pending || exhausted || chosen.length === 0}>
          <IconSparkle /> {pending ? "Generating…" : used ? "Re-generate" : "Generate"}
        </button>
        <span>Questions can be generated only {max === 2 ? "twice" : `${max} times`} per section in a scorecard · {used}/{max} used</span>
      </div>
      {msg ? <div className="callout warning" style={{ marginTop: 8 }}>{msg}</div> : null}
      {latest ? (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center" }}>
            {copied ? <span className="text-xs muted">{copied}</span> : null}
            <button type="button" className={s.copyBtn} onClick={() => copy(all, setCopied)}><CopyIcon /> Copy all</button>
          </div>
          {latest.questions.map((q) => (
            <div key={q.skill}>
              <div className={s.qSkill}>
                <div className={s.qSkillName}>{q.skill}</div>
                <button type="button" className={s.copyBtn} onClick={() => copy(q.questions.map((x, i) => `${i + 1}. ${x}`).join("\n"), setCopied)}><CopyIcon /> Copy questions</button>
              </div>
              <ol className={s.qList}>{q.questions.map((x, i) => <li key={i}>{x}</li>)}</ol>
            </div>
          ))}
          {sets.length > 1 ? <p className="text-xs subtle" style={{ marginTop: 16 }}>Showing set {latest.attempt} of {sets.length}.</p> : null}
        </div>
      ) : null}
    </HireDialog>
  );
}

/** A sparkle button that opens the generator for one section. */
export function QuestionsButton({ jobId, section, max, aiOn, aiUnavailable, round = true, label }: {
  jobId: string; section: QSection; max: number; aiOn: boolean; aiUnavailable: string; round?: boolean; label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {round
        ? <button type="button" className={s.roundAi} onClick={() => setOpen(true)} aria-label={`Generate questions for ${section.section} using AI`} title="Generate Questions using AI"><IconSparkle width={16} height={16} /></button>
        : <button type="button" className={s.aiOutline} onClick={() => setOpen(true)}><IconSparkle width={15} height={15} /> {label ?? (section.sets.length ? "View generated questions" : "Generate questions using AI")}</button>}
      {open ? <QuestionsModal jobId={jobId} section={section} max={max} aiOn={aiOn} aiUnavailable={aiUnavailable} open onClose={() => setOpen(false)} /> : null}
    </>
  );
}
