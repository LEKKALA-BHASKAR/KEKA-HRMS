"use client";

import { useActionState, useState, useTransition } from "react";
import { saveJobDetailsAction, saveScorecardTemplateAction } from "@/app/actions/hiring";
import { generateJobDescriptionAction } from "@/app/actions/hiring-ai";
import { IconSparkle } from "@/components/icons";
import type { ActionState } from "@/lib/forms";
import s from "../hire.module.css";

/** The job's description and requirements, with "Generate using AI" for the description. */
export function JobDetailsForm({ jobId, title, departmentId, initial, aiOn, aiUnavailable }: {
  jobId: string; title: string; departmentId: string | null;
  initial: { description: string; requirements: string; minExperienceYears: string; employmentType: string };
  aiOn: boolean; aiUnavailable: string;
}) {
  const [state, action, pending] = useActionState(saveJobDetailsAction, {} as ActionState);
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [aiPending, start] = useTransition();
  const generate = () => {
    if (!aiOn) { setMsg(aiUnavailable); return; }
    setMsg(null);
    start(async () => {
      const res = await generateJobDescriptionAction({ title, departmentId, minExperienceYears: v.minExperienceYears ? Number(v.minExperienceYears) : null, employmentType: null });
      if (!res.ok) { setMsg(res.reason); return; }
      if (v.description.trim() && !window.confirm("Replace the current job description?")) return;
      setV((x) => ({ ...x, description: res.value }));
    });
  };
  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />
      {state.message ? <div className={`callout ${state.ok ? "success" : "danger"}`} style={{ marginBottom: 14 }}>{state.message}</div> : null}
      <div className={s.jdHead} style={{ marginTop: 0 }}>
        <label className={s.lbl} style={{ margin: 0 }} htmlFor="job-jd">Job Description<span className={s.req}>*</span></label>
        <button type="button" className={s.aiBtn} onClick={generate} disabled={aiPending}><IconSparkle /> {aiPending ? "Generating…" : "Generate using AI"}</button>
      </div>
      {msg ? <div className="callout warning" style={{ marginBottom: 10 }}>{msg}</div> : null}
      <textarea id="job-jd" name="description" className={`${s.editorArea} ${s.editor}`} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
      {state.errors?.description ? <div className={s.err}>{state.errors.description}</div> : null}
      <div className={s.formRow} style={{ marginTop: 20 }}>
        <div>
          <label className={s.lbl} htmlFor="job-exp">Experience (in years)</label>
          <input id="job-exp" name="minExperienceYears" type="number" min={0} max={50} step={0.5} className={s.ctl} value={v.minExperienceYears} onChange={(e) => setV({ ...v, minExperienceYears: e.target.value })} />
        </div>
        <span />
      </div>
      <div style={{ marginTop: 20 }}>
        <label className={s.lbl} htmlFor="job-req">Requirements <span className="subtle text-xs">(used as context when generating interview questions)</span></label>
        <textarea id="job-req" name="requirements" className="textarea" rows={5} maxLength={5000} value={v.requirements} onChange={(e) => setV({ ...v, requirements: e.target.value })} />
      </div>
      <div style={{ marginTop: 16 }}><button type="submit" className={s.primaryBtn} disabled={pending}>{pending ? "Saving…" : "Save"}</button></div>
    </form>
  );
}

interface Section { section: string; skills: Array<{ name: string; description: string }> }

/** Edit the job's scorecard: sections, and in each the skills interviewers rate. */
export function KitEditor({ jobId, initial }: { jobId: string; initial: Section[] }) {
  const [state, action, pending] = useActionState(saveScorecardTemplateAction, {} as ActionState);
  const [kit, setKit] = useState<Section[]>(initial);
  const update = (i: number, f: (s: Section) => Section) => setKit((k) => k.map((x, j) => (j === i ? f(x) : x)));
  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="kit" value={JSON.stringify(kit)} />
      {state.message ? <div className={`callout ${state.ok ? "success" : "danger"}`} style={{ marginBottom: 14 }}>{state.message}</div> : null}
      {kit.map((sec, i) => (
        <div key={i} className={s.cardAlone} style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input className={s.ctl} aria-label="Section name" value={sec.section} maxLength={80} placeholder="Section, e.g. Technical Skills"
              onChange={(e) => update(i, (x) => ({ ...x, section: e.target.value }))} />
            <button type="button" className={s.trash} aria-label="Remove section" onClick={() => setKit((k) => k.filter((_, j) => j !== i))}>Remove</button>
          </div>
          {sec.skills.map((sk, k) => (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr) auto", gap: 10, marginTop: 10 }}>
              <input className={s.ctl} aria-label="Skill" value={sk.name} maxLength={80} placeholder="Skill"
                onChange={(e) => update(i, (x) => ({ ...x, skills: x.skills.map((y, m) => (m === k ? { ...y, name: e.target.value } : y)) }))} />
              <input className={s.ctl} aria-label="What good looks like" value={sk.description} maxLength={400} placeholder="What good looks like"
                onChange={(e) => update(i, (x) => ({ ...x, skills: x.skills.map((y, m) => (m === k ? { ...y, description: e.target.value } : y)) }))} />
              <button type="button" className={s.trash} aria-label="Remove skill" onClick={() => update(i, (x) => ({ ...x, skills: x.skills.filter((_, m) => m !== k) }))}>×</button>
            </div>
          ))}
          <button type="button" className={s.linkBtn} style={{ marginTop: 10 }} onClick={() => update(i, (x) => ({ ...x, skills: [...x.skills, { name: "", description: "" }] }))}>+ Add skill</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button type="button" className={s.secondaryBtn} onClick={() => setKit((k) => [...k, { section: "", skills: [{ name: "", description: "" }] }])}>+ Add section</button>
        <button type="submit" className={s.primaryBtn} disabled={pending}>{pending ? "Saving…" : "Save scorecard"}</button>
      </div>
    </form>
  );
}
