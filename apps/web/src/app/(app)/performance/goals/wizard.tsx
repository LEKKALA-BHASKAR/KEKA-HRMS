"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { suggestGoalsAction, publishGoalsAction, type GoalDraftInput } from "@/app/actions/performance";
import { IconSparkle, IconTarget, IconTrash, IconChevronDown, IconArrowLeft } from "@/components/icons";
import s from "../_parts/perform.module.css";

export interface Option { value: string; label: string }
export interface TimeframeOption { label: string; kind: "QUARTER" | "HALF_YEAR" | "YEAR"; start: string; end: string }
type Metric = "PERCENTAGE" | "COMPLETION" | "NUMBER" | "CURRENCY";

interface Draft {
  key: string; title: string; description: string; level: "INDIVIDUAL" | "DEPARTMENT" | "COMPANY";
  employeeId: string; departmentId: string; metric: Metric; direction: "INCREASE" | "DECREASE";
  startValue: string; targetValue: string; metricName: string; timeframe: string; startDate: string; dueDate: string;
  tags: string[]; visibility: "EVERYONE" | "MANAGER_CHAIN"; countsInReview: boolean; parentGoalId: string; source: "AI" | "MANUAL";
  showDescription: boolean;
}

interface Suggestion {
  title: string; description: string | null; metricType: string; startValue: number | null; targetValue: number | null;
  metricName: string | null; parentGoalId: string | null; parentTitle: string | null;
}

const LEVEL_LABEL = { INDIVIDUAL: "Individual", DEPARTMENT: "Department", COMPANY: "Company" } as const;
const KIND_LABEL = { QUARTER: "Quarter", HALF_YEAR: "Half year", YEAR: "Year" } as const;
let seq = 0;
const key = () => `g${Date.now().toString(36)}${seq++}`;

export function GoalWizard(props: {
  mode: "ai" | "custom"; ai: boolean; aiReason: string; canOrg: boolean; back: string;
  jobTitles: string[]; departments: Option[]; owners: Option[]; parents: Option[]; timeframes: TimeframeOption[];
  defaults: { jobTitle: string; departmentId: string; employeeId: string; today: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<1 | 2>(props.mode === "ai" ? 1 : 2);
  const [level, setLevel] = useState<Draft["level"]>("INDIVIDUAL");
  const [kind, setKind] = useState<TimeframeOption["kind"]>("QUARTER");
  const [jobTitle, setJobTitle] = useState(props.defaults.jobTitle || props.jobTitles[0] || "");
  const [departmentId, setDepartmentId] = useState(props.defaults.departmentId || props.departments[0]?.value || "");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});

  const current = (k: TimeframeOption["kind"]) =>
    props.timeframes.find((t) => t.kind === k && t.start <= props.defaults.today && t.end >= props.defaults.today) ?? props.timeframes.find((t) => t.kind === k)!;

  const blank = (over: Partial<Draft> = {}): Draft => {
    const tf = current(kind);
    return {
      key: key(), title: "", description: "", level, employeeId: props.defaults.employeeId, departmentId,
      metric: "PERCENTAGE", direction: "INCREASE", startValue: "", targetValue: "", metricName: "",
      timeframe: tf.label, startDate: tf.start, dueDate: tf.end, tags: [], visibility: "EVERYONE", countsInReview: true,
      parentGoalId: "", source: "MANUAL", showDescription: true, ...over,
    };
  };
  const [goals, setGoals] = useState<Draft[]>(() => (props.mode === "custom" ? [blank()] : []));
  const [active, setActive] = useState(0);

  const sentenceOk = level === "COMPANY" || !!departmentId;
  const generate = () => {
    setAiMessage(null);
    start(async () => {
      const r = await suggestGoalsAction({ level, timeframe: kind, jobTitle, departmentId });
      if (!r.ok || !r.goals) { setAiMessage(r.message ?? "No suggestions came back."); return; }
      setSuggestions(r.goals);
      setPicked(new Set([0]));
    });
  };
  const addPicked = () => {
    if (!suggestions) return;
    const added = suggestions.filter((_, i) => picked.has(i)).map((g) => {
      const metric: Metric = g.metricType === "COMPLETION" ? "COMPLETION" : g.metricType === "CURRENCY" ? "CURRENCY" : g.metricType.startsWith("NUMBER") ? "NUMBER" : "PERCENTAGE";
      return blank({
        title: g.title, description: g.description ?? "", metric, direction: g.metricType === "NUMBER_DECREASE" ? "DECREASE" : "INCREASE",
        startValue: g.startValue !== null ? String(g.startValue) : "", targetValue: g.targetValue !== null ? String(g.targetValue) : "",
        metricName: g.metricName ?? "", parentGoalId: g.parentGoalId ?? "", source: "AI",
      });
    });
    setGoals((prev) => [...prev, ...added]);
    setActive(goals.length);
    setStep(2);
  };
  const patch = (i: number, p: Partial<Draft>) => setGoals((prev) => prev.map((g, k) => (k === i ? { ...g, ...p } : g)));
  const remove = (i: number) => {
    setGoals((prev) => prev.filter((_, k) => k !== i));
    setErrors({});
    setActive((a) => Math.max(0, Math.min(a, goals.length - 2)));
  };

  const save = (draft: boolean) => {
    setMessage(null);
    const payload: GoalDraftInput[] = goals.map((g) => ({
      title: g.title, description: g.description, level: g.level,
      employeeId: g.level === "INDIVIDUAL" ? g.employeeId : null, departmentId: g.level === "DEPARTMENT" ? g.departmentId : null,
      metricType: g.metric === "NUMBER" ? (g.direction === "DECREASE" ? "NUMBER_DECREASE" : "NUMBER_INCREASE") : g.metric,
      metricName: g.metricName, startValue: g.startValue, targetValue: g.targetValue,
      timeframe: g.timeframe || null, startDate: g.startDate, dueDate: g.dueDate, tags: g.tags, visibility: g.visibility,
      countsInReview: g.countsInReview, parentGoalId: g.parentGoalId || null, source: g.source,
    }));
    start(async () => {
      const r = await publishGoalsAction({ goals: payload, draft });
      if (!r.ok) {
        setMessage(r.message);
        setErrors(r.errors ?? {});
        const first = Object.keys(r.errors ?? {})[0];
        if (first !== undefined) setActive(Number(first));
        return;
      }
      router.push(`${props.back}${props.back.includes("?") ? "&" : "?"}done=${encodeURIComponent(r.message)}`);
    });
  };

  const g = goals[active];
  const levels = (props.canOrg ? ["INDIVIDUAL", "DEPARTMENT", "COMPANY"] : ["INDIVIDUAL"]) as Draft["level"][];

  return (
    <div className={s.wizard}>
      <div className={s.wizTop}>
        <div className={s.wizTitle}><span className={s.wizIcon}><IconSparkle /></span>{props.mode === "ai" ? "Add goals using AI" : "Add goal"}</div>
        <div className={s.stepper} aria-label="Steps">
          <span className={step === 1 ? s.stepOn : undefined}><span className={s.stepNum}>1</span>Add goal</span>
          <span aria-hidden="true">›</span>
          <span className={step === 2 ? s.stepOn : undefined}><span className={s.stepNum}>2</span>Set metrics</span>
        </div>
        <div className={s.wizButtons}>
          <Link href={props.back} className="btn">Cancel</Link>
          <button type="button" className="btn" style={{ color: "var(--brand-600)", borderColor: "var(--brand-500)" }} disabled={step !== 2 || goals.length === 0 || pending} onClick={() => save(true)}>Save as draft</button>
          <button type="button" className="btn primary" disabled={step !== 2 || goals.length === 0 || pending} onClick={() => save(false)}>{pending && step === 2 ? "Saving…" : "Publish"}</button>
        </div>
      </div>

      {step === 1 ? (
        <>
          <div className={`${s.sentenceBar}${suggestions ? ` ${s.compact}` : ""}`}>
            <span>
              Create
              <select className={s.blank} value={level} onChange={(e) => setLevel(e.target.value as Draft["level"])} aria-label="Goal type">
                {levels.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
              </select>
              goal that can be achieved in a
              <select className={s.blank} value={kind} onChange={(e) => setKind(e.target.value as TimeframeOption["kind"])} aria-label="Time frame">
                {(["QUARTER", "HALF_YEAR", "YEAR"] as const).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
              {level !== "COMPANY" ? (
                <>
                  {level === "INDIVIDUAL" ? <>for a
                    <select className={s.blank} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} aria-label="Role">
                      {props.jobTitles.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select></> : null}
                  from
                  <select className={s.blank} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department">
                    {props.departments.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                  department
                </>
              ) : null}
            </span>
            {suggestions ? (
              <button type="button" className="btn" onClick={generate} disabled={!props.ai || pending || !sentenceOk}><IconSparkle width={16} height={16} aria-hidden="true" /> {pending ? "Generating…" : "Regenerate goals list"}</button>
            ) : null}
          </div>
          {!suggestions ? (
            <div style={{ textAlign: "center" }}>
              <button type="button" className={s.aiBtn} onClick={generate} disabled={!props.ai || pending || !sentenceOk}><IconSparkle aria-hidden="true" />{pending ? "Generating goals…" : "Generate goals"}</button>
              {!props.ai ? <div className={s.aiOff} style={{ margin: "10px auto 0" }}>{props.aiReason}</div> : null}
              {aiMessage ? <div className="callout danger" style={{ maxWidth: 520, margin: "16px auto 0" }}><div>{aiMessage}</div></div> : null}
              <div className={s.placeholder}>Generated goals will appear here…</div>
              <div className={s.placeholder} style={{ fontSize: 14 }}>
                Prefer to write your own? <button type="button" className={s.linkBtn} style={{ fontSize: 14 }} onClick={() => { setGoals((p) => [...p, blank()]); setActive(goals.length); setStep(2); }}>Create a custom goal</button>
              </div>
            </div>
          ) : (
            <div className={s.picks}>
              {aiMessage ? <div className="callout danger" style={{ marginBottom: 14 }}><div>{aiMessage}</div></div> : null}
              <div className={s.picksTitle}><IconTarget width={22} height={22} aria-hidden="true" />Here are few goals you can pick :</div>
              {suggestions.map((sg, i) => (
                <label key={`${sg.title}-${i}`} className={s.pick}>
                  <input type="checkbox" checked={picked.has(i)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
                  <span>{sg.title}{sg.description || sg.parentTitle ? <span className={s.pickDesc}>{sg.description}{sg.parentTitle ? ` Aligns to “${sg.parentTitle}”.` : ""}</span> : null}</span>
                </label>
              ))}
              <button type="button" className="btn primary" style={{ marginTop: 18, background: "#16264f", borderColor: "#16264f" }} disabled={picked.size === 0} onClick={addPicked}>Add selected goal{picked.size > 1 ? "s" : ""}</button>
              {goals.length ? <button type="button" className="btn ghost" style={{ marginTop: 18, marginLeft: 10 }} onClick={() => setStep(2)}>Back to {goals.length} picked goal{goals.length > 1 ? "s" : ""}</button> : null}
            </div>
          )}
        </>
      ) : (
        <div className={s.step2}>
          <div className={s.step2Left}>
            {goals.map((d, i) => (
              <button key={d.key} type="button" className={`${s.goalChip}${errors[i] ? ` ${s.goalChipErr}` : ""}`} aria-current={i === active ? "true" : undefined} onClick={() => setActive(i)}>
                <IconTarget aria-hidden="true" /><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title || "Untitled goal"}</span>
              </button>
            ))}
            <div className={s.leftLinks}>
              <button type="button" onClick={() => setStep(1)}><IconArrowLeft width={14} height={14} style={{ verticalAlign: -2 }} aria-hidden="true" /> Add more goals using AI</button>
              <span aria-hidden="true">|</span>
              <button type="button" onClick={() => { setGoals((p) => [...p, blank()]); setActive(goals.length); }}>Create custom goal</button>
            </div>
            {message ? <div className="callout danger" style={{ marginTop: 8 }}><div>{message}</div></div> : null}
          </div>
          <div className={s.step2Right}>
            {g ? (
              <div className={s.goalCard}>
                {errors[active] ? <div className={`callout danger ${s.cardError}`}><div>{errors[active]}</div></div> : null}
                <div className={s.goalCardHead}>
                  <IconTarget width={22} height={22} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
                  <input value={g.title} onChange={(e) => patch(active, { title: e.target.value })} placeholder="Goal title" aria-label="Goal title" maxLength={200} />
                  <button type="button" className="btn ghost sm" aria-label="Remove this goal" onClick={() => remove(active)}><IconTrash width={16} height={16} /></button>
                </div>
                <div className={s.formGrid}>
                  <div className={`field ${s.full}`}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <label className="label" htmlFor="g-desc">Description <span className="subtle">(Optional)</span></label>
                      <button type="button" className={s.linkBtn} onClick={() => patch(active, { showDescription: !g.showDescription })}>{g.showDescription ? "— Hide description" : "+ Add description"}</button>
                    </div>
                    {g.showDescription ? <textarea id="g-desc" className="textarea" rows={3} value={g.description} maxLength={2000} onChange={(e) => patch(active, { description: e.target.value })} /> : null}
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="g-metric">Metric type</label>
                    <select id="g-metric" className="select" value={g.metric} onChange={(e) => patch(active, { metric: e.target.value as Metric })}>
                      <option value="PERCENTAGE">Percentage</option>
                      <option value="COMPLETION">Completed/Not completed</option>
                      <option value="NUMBER">Number</option>
                      <option value="CURRENCY">Currency (₹)</option>
                    </select>
                  </div>
                  <div className="field">
                    {g.metric === "NUMBER" || g.metric === "CURRENCY" ? (
                      <>
                        <label className="label">Target is to{" "}
                          {g.metric === "NUMBER" ? (
                            <select className={s.inlineSelect} value={g.direction} onChange={(e) => patch(active, { direction: e.target.value as Draft["direction"] })} aria-label="Direction">
                              <option value="INCREASE">Increase from</option><option value="DECREASE">Decrease from</option>
                            </select>
                          ) : <span style={{ color: "var(--brand-600)" }}>Increase from</span>}
                        </label>
                        <div className={s.range}>
                          <input type="number" step="any" value={g.startValue} onChange={(e) => patch(active, { startValue: e.target.value })} aria-label="Starting value" placeholder="0" />
                          <span>TO</span>
                          <input type="number" step="any" value={g.targetValue} onChange={(e) => patch(active, { targetValue: e.target.value })} aria-label="Target value" placeholder="Target" style={{ textAlign: "right" }} />
                        </div>
                      </>
                    ) : (
                      <>
                        <label className="label">Target</label>
                        <div className="input" style={{ background: "var(--surface-sunken)", color: "var(--text-muted)" }}>{g.metric === "COMPLETION" ? "Mark it completed when done" : "0 % → 100 %"}</div>
                      </>
                    )}
                  </div>
                  {g.metric === "NUMBER" ? (
                    <div className="field">
                      <label className="label" htmlFor="g-mname">Metric name <span className="subtle">(optional)</span></label>
                      <input id="g-mname" className="input" value={g.metricName} maxLength={60} onChange={(e) => patch(active, { metricName: e.target.value })} placeholder="deployments, tickets, ms…" />
                    </div>
                  ) : null}
                  <div className="field">
                    <label className="label" htmlFor="g-level">Goal type</label>
                    <select id="g-level" className="select" value={g.level} onChange={(e) => patch(active, { level: e.target.value as Draft["level"] })}>
                      {levels.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                    </select>
                  </div>
                  {g.level === "INDIVIDUAL" ? (
                    <div className="field">
                      <label className="label" htmlFor="g-owner">Goal owner</label>
                      <select id="g-owner" className="select" value={g.employeeId} onChange={(e) => patch(active, { employeeId: e.target.value })} disabled={props.owners.length < 2}>
                        {props.owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                  ) : g.level === "DEPARTMENT" ? (
                    <div className="field">
                      <label className="label" htmlFor="g-dept">Department</label>
                      <select id="g-dept" className="select" value={g.departmentId} onChange={(e) => patch(active, { departmentId: e.target.value })}>
                        {props.departments.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                      </select>
                    </div>
                  ) : <div className="field"><label className="label">Goal owner</label><div className="input" style={{ background: "var(--surface-sunken)" }}>The company</div></div>}
                  <div className="field">
                    <label className="label" htmlFor="g-tf">Time frame</label>
                    <select id="g-tf" className="select" value={g.timeframe} onChange={(e) => {
                      const t = props.timeframes.find((x) => x.label === e.target.value);
                      patch(active, t ? { timeframe: t.label, startDate: t.start, dueDate: t.end } : { timeframe: "" });
                    }}>
                      {props.timeframes.map((t) => <option key={t.label} value={t.label}>{t.label}</option>)}
                      <option value="">Custom dates</option>
                    </select>
                  </div>
                  <div className="field">
                    <label className="label">Start date - End date</label>
                    <div className="row gap-2">
                      <input type="date" className="input" value={g.startDate} onChange={(e) => patch(active, { startDate: e.target.value, timeframe: "" })} aria-label="Start date" />
                      <input type="date" className="input" value={g.dueDate} onChange={(e) => patch(active, { dueDate: e.target.value, timeframe: "" })} aria-label="End date" />
                    </div>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="g-parent">Aligns to <span className="subtle">(optional)</span></label>
                    <select id="g-parent" className="select" value={g.parentGoalId} onChange={(e) => patch(active, { parentGoalId: e.target.value })}>
                      <option value="">Nothing</option>
                      {props.parents.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </div>
                  <div className={`field ${s.full}`}>
                    <label className="label">Tags <span className="subtle">(optional)</span></label>
                    <TagInput tags={g.tags} onChange={(tags) => patch(active, { tags })} />
                  </div>
                  <div className={`field ${s.full}`}>
                    <div className="row gap-2" style={{ alignItems: "center", fontSize: 14 }}>
                      Make this goal visible for :
                      <select className={s.inlineSelect} style={{ fontSize: 14 }} value={g.visibility} onChange={(e) => patch(active, { visibility: e.target.value as Draft["visibility"] })} aria-label="Visibility">
                        <option value="EVERYONE">Everyone</option>
                        <option value="MANAGER_CHAIN">Owner and their managers</option>
                      </select>
                      <IconChevronDown width={14} height={14} aria-hidden="true" style={{ color: "var(--brand-600)", marginLeft: -6 }} />
                    </div>
                  </div>
                  <label className={`checkbox-row ${s.full}`}>
                    <input type="checkbox" checked={g.countsInReview} onChange={(e) => patch(active, { countsInReview: e.target.checked })} />
                    <span className="text-sm">Include in review</span>
                  </label>
                </div>
              </div>
            ) : (
              <div className={s.placeholder}>No goals yet. Add some using AI or create a custom goal.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim().toLowerCase().slice(0, 30);
    if (t && !tags.includes(t) && tags.length < 8) onChange([...tags, t]);
    setText("");
  };
  const list = useMemo(() => tags, [tags]);
  return (
    <div className={s.tags}>
      {list.map((t) => <span key={t} className={s.tag}>{t}<button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>×</button></span>)}
      <input className="input" style={{ width: 180, padding: "5px 9px" }} value={text} placeholder="+ Add Tags" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }} onBlur={add} aria-label="Add a tag" />
    </div>
  );
}
