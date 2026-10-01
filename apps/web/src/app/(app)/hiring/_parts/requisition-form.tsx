"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { raiseRequisitionAction, updateRequisitionAction } from "@/app/actions/hiring";
import { generateJobDescriptionAction } from "@/app/actions/hiring-ai";
import { IconSparkle } from "@/components/icons";
import type { ActionState } from "@/lib/forms";
import s from "../hire.module.css";

export interface Option { value: string; label: string }
export interface Emp { id: string; name: string; number: string; title: string | null }
export interface ReqValues {
  title: string; isPriority: boolean; departmentId: string; minExperienceYears: string;
  newHire: boolean; newPositions: string; backfill: boolean; backfills: Array<{ employeeId: string; reason: string }>;
  locationId: string; targetStartDate: string; currency: string; salaryMin: string; salaryMax: string; salaryFrequency: string;
  jobType: string; employmentType: string; description: string; justification: string; hiringManagerId: string; recruiterId: string;
}

const REASONS: Option[] = [
  { value: "INTERNAL_MOVEMENT", label: "Internal movement" }, { value: "MATERNITY_LEAVE", label: "Maternity leave" }, { value: "PROMOTION", label: "Promotion" },
  { value: "RELIEVED", label: "Relieved" }, { value: "RELOCATED", label: "Relocated" }, { value: "RETIRED", label: "Retired" }, { value: "OTHERS", label: "Others" },
];
const CURRENCIES: Option[] = [
  ["INR", "India Rupee - INR"], ["USD", "United States Dollar - USD"], ["EUR", "Euro - EUR"], ["GBP", "British Pound - GBP"],
  ["AED", "UAE Dirham - AED"], ["SGD", "Singapore Dollar - SGD"], ["AUD", "Australian Dollar - AUD"], ["CAD", "Canadian Dollar - CAD"],
].map(([value, label]) => ({ value, label }));
const STEP1 = ["title", "departmentId", "minExperienceYears", "positions", "newPositions", "backfills", "locationId", "targetStartDate", "currency", "salaryMin", "salaryMax", "salaryFrequency", "jobType", "description"];

const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

/**
 * Create / Edit Requisition (C03–C13): a full-screen two-step form —
 * Requisition details, then Hiring team (optional) — with Continue and
 * Create in the header. Every field is controlled so a refused submit keeps
 * what was typed.
 */
export function RequisitionForm({ mode, id, initial, options, approverName, aiOn, aiUnavailable, closeHref }: {
  mode: "create" | "edit"; id?: string; initial: ReqValues;
  options: { departments: Option[]; locations: Option[]; jobTitles: string[]; employees: Emp[]; recruiters: Option[]; templates: Array<{ id: string; title: string; body: string }> };
  approverName: string | null; aiOn: boolean; aiUnavailable: string; closeHref: string;
}) {
  const router = useRouter();
  const [v, setV] = useState<ReqValues>(initial);
  const [step, setStep] = useState<1 | 2>(1);
  const [state, action, pending] = useActionState(mode === "create" ? raiseRequisitionAction : updateRequisitionAction, {} as ActionState);
  const [query, setQuery] = useState("");
  const [showSuggest, setShowSuggest] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [aiPending, startAi] = useTransition();
  const [showAllBackfills, setShowAllBackfills] = useState(true);
  const area = useRef<HTMLTextAreaElement>(null);
  const set = <K extends keyof ReqValues>(k: K, val: ReqValues[K]) => setV((x) => ({ ...x, [k]: val }));
  const err = state.errors ?? {};

  useEffect(() => {
    if (state.ok) router.replace(`${closeHref}${closeHref.includes("?") ? "&" : "?"}flash=${mode === "create" ? "saved" : "updated"}`, { scroll: false });
    else if (state.errors && Object.keys(state.errors).some((k) => STEP1.includes(k))) setStep(1);
  }, [state, router, closeHref, mode]);

  const empById = useMemo(() => new Map(options.employees.map((e) => [e.id, e])), [options.employees]);
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.employees.filter((e) => !v.backfills.some((b) => b.employeeId === e.id) && (!q || e.name.toLowerCase().includes(q) || e.number.toLowerCase().includes(q))).slice(0, 8);
  }, [query, options.employees, v.backfills]);
  const total = (v.newHire ? Number(v.newPositions) || 0 : 0) + (v.backfill ? v.backfills.length : 0);

  const replaceDescription = (text: string) => {
    if (v.description.trim() && !window.confirm("Replace the current job description?")) return;
    set("description", text);
  };
  const generate = () => {
    if (!aiOn) { setAiMsg(aiUnavailable); return; }
    setAiMsg(null);
    startAi(async () => {
      const res = await generateJobDescriptionAction({
        title: v.title, departmentId: v.departmentId || null, minExperienceYears: v.minExperienceYears ? Number(v.minExperienceYears) : null,
        jobType: v.jobType, employmentType: v.employmentType || null,
      });
      if (res.ok) replaceDescription(res.value); else setAiMsg(res.reason);
    });
  };
  const wrap = (kind: "b" | "i" | "ol" | "ul" | "link") => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const sel = value.slice(a, b) || (kind === "link" ? "link text" : "text");
    let out = sel;
    if (kind === "b") out = `**${sel}**`;
    if (kind === "i") out = `*${sel}*`;
    if (kind === "ol") out = sel.split("\n").map((l, i) => `${i + 1}. ${l}`).join("\n");
    if (kind === "ul") out = sel.split("\n").map((l) => `- ${l}`).join("\n");
    if (kind === "link") out = `[${sel}](https://)`;
    const next = value.slice(0, a) + out + value.slice(b);
    set("description", next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a, a + out.length); });
  };

  const ctl = (name: string) => `${s.ctl}${err[name] ? ` ${s.ctlErr}` : ""}`;
  const E = ({ name }: { name: string }) => (err[name] ? <div className={s.err}>{err[name]}</div> : null);

  return (
    <form action={action} noValidate>
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <div className={s.stepBar}>
        <div className={s.steps}>
          <button type="button" className={`${s.step} ${s.on}`} onClick={() => setStep(1)}><span className={s.stepNum}>1</span>Requisition details</button>
          <button type="button" className={`${s.step}${step === 2 ? ` ${s.on}` : ""}`} onClick={() => setStep(2)}><span className={s.stepNum}>2</span>Hiring team (optional)</button>
        </div>
        <div className={s.stepActions}>
          {step === 1 ? <button type="button" className={s.secondaryBtn} onClick={() => setStep(2)}>Continue</button> : <button type="button" className={s.secondaryBtn} onClick={() => setStep(1)}>Back</button>}
          <button type="submit" className={s.primaryBtn} disabled={pending}>{pending ? "Saving…" : mode === "create" ? "Create" : "Save"}</button>
        </div>
      </div>

      <div className={s.formCol}>
        {state.message && !state.ok ? <div className="callout danger" style={{ marginBottom: 18 }}>{state.message}</div> : null}

        <div style={{ display: step === 1 ? "block" : "none" }}>
          <div className={s.titleRow}>
            <div>
              <label className={s.lbl} htmlFor="req-title">Job Title<span className={s.req}>*</span></label>
              <input id="req-title" name="title" className={ctl("title")} list="req-job-titles" placeholder="Select or enter new job title" value={v.title} maxLength={120} onChange={(e) => set("title", e.target.value)} />
              <datalist id="req-job-titles">{options.jobTitles.map((t) => <option key={t} value={t} />)}</datalist>
            </div>
            <label className={s.checkLabel}><input type="checkbox" name="isPriority" checked={v.isPriority} onChange={(e) => set("isPriority", e.target.checked)} />Mark as priority</label>
          </div>
          <E name="title" />

          <div className={`${s.formRow} ${s.fieldGap}`}>
            <div>
              <label className={s.lbl} htmlFor="req-dept">Department<span className={s.req}>*</span></label>
              <select id="req-dept" name="departmentId" className={ctl("departmentId")} value={v.departmentId} onChange={(e) => set("departmentId", e.target.value)}>
                <option value="">Select department</option>
                {options.departments.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <E name="departmentId" />
            </div>
            <div>
              <label className={s.lbl} htmlFor="req-exp">Experience (in years)</label>
              <input id="req-exp" name="minExperienceYears" type="number" min={0} max={50} step={0.5} className={ctl("minExperienceYears")} placeholder="Eg: 6 yrs" value={v.minExperienceYears} onChange={(e) => set("minExperienceYears", e.target.value)} />
              <E name="minExperienceYears" />
            </div>
          </div>

          <div className={s.posBox} style={err.positions ? { borderColor: "var(--danger)" } : undefined}>
            <div className={s.posRow}>
              <label className={s.checkLabel} style={{ paddingBottom: 0 }}><input type="checkbox" name="newHire" checked={v.newHire} onChange={(e) => set("newHire", e.target.checked)} />New Hire</label>
              <input name="newPositions" type="number" min={1} max={100} className={ctl("newPositions")} placeholder="No.of positions" disabled={!v.newHire}
                value={v.newHire ? v.newPositions : ""} onChange={(e) => set("newPositions", e.target.value)} style={!v.newHire ? { background: "var(--surface-sunken)" } : undefined} />
            </div>
            {err.newPositions ? <div className={s.err} style={{ marginTop: -6, marginBottom: 6 }}>{err.newPositions}</div> : null}
            <div className={s.posRow}>
              <label className={s.checkLabel} style={{ paddingBottom: 0 }}><input type="checkbox" name="backfill" checked={v.backfill} onChange={(e) => set("backfill", e.target.checked)} />Backfill</label>
              <span />
            </div>
            {v.backfill ? (
              <div className={s.backfillArea}>
                <label className={s.lbl}>Backfill employees<span className={s.req}>*</span></label>
                <div className={s.chips} style={err.backfills ? { borderColor: "var(--danger)" } : undefined}>
                  {v.backfills.map((b) => {
                    const e = empById.get(b.employeeId);
                    return (
                      <span key={b.employeeId} className={s.chip}>
                        <span className={s.chipAvatar}>{initials(e?.name ?? "?")}</span>{e?.name ?? "Employee"}
                        <button type="button" className={s.chipX} aria-label={`Remove ${e?.name}`} onClick={() => set("backfills", v.backfills.filter((x) => x.employeeId !== b.employeeId))}>×</button>
                      </span>
                    );
                  })}
                  <input className={s.chipInput} placeholder="Search Employee by Name or Employee Number" value={query}
                    onFocus={() => setShowSuggest(true)} onBlur={() => setTimeout(() => setShowSuggest(false), 150)} onChange={(e) => { setQuery(e.target.value); setShowSuggest(true); }} aria-label="Search employees to backfill" />
                  {showSuggest && suggestions.length ? (
                    <div className={s.suggest}>
                      {suggestions.map((e) => (
                        <button type="button" key={e.id} onMouseDown={(ev) => ev.preventDefault()} onClick={() => { set("backfills", [...v.backfills, { employeeId: e.id, reason: "" }]); setQuery(""); }}>
                          <span className={s.chipAvatar}>{initials(e.name)}</span>
                          <span>{e.name} <span className="subtle text-xs">{e.number}{e.title ? ` · ${e.title}` : ""}</span></span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                {v.backfills.length ? (
                  <>
                    <label className={s.lbl} style={{ marginTop: 18 }}>Backfill reason<span className={s.req}>*</span></label>
                    {(showAllBackfills ? v.backfills : v.backfills.slice(0, 1)).map((b, i) => {
                      const e = empById.get(b.employeeId);
                      return (
                        <div key={b.employeeId} className={s.reasonRow}>
                          <span className={s.person}><span className={s.chipAvatar} style={{ width: 28, height: 28, fontSize: 11 }}>{initials(e?.name ?? "?")}</span>{e?.name}</span>
                          <select className={`${s.ctl}${err.backfills && !b.reason ? ` ${s.ctlErr}` : ""}`} value={b.reason} aria-label={`Backfill reason for ${e?.name}`}
                            onChange={(ev) => set("backfills", v.backfills.map((x, k) => (k === i ? { ...x, reason: ev.target.value } : x)))}>
                            <option value="">Select Backfill Reason</option>
                            {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                          <button type="button" className={s.trash} aria-label={`Remove ${e?.name}`} onClick={() => set("backfills", v.backfills.filter((x) => x.employeeId !== b.employeeId))}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          </button>
                        </div>
                      );
                    })}
                    {v.backfills.length > 1 ? <div style={{ textAlign: "right", marginTop: 10 }}><button type="button" className={s.linkBtn} onClick={() => setShowAllBackfills((x) => !x)}>{showAllBackfills ? "Show less" : `Show all ${v.backfills.length}`}</button></div> : null}
                  </>
                ) : null}
                <E name="backfills" />
              </div>
            ) : null}
          </div>
          {v.backfill ? v.backfills.map((b) => (
            <span key={b.employeeId}>
              <input type="hidden" name="backfillEmployeeId" value={b.employeeId} />
              <input type="hidden" name="backfillReason" value={b.reason} />
            </span>
          )) : null}
          <E name="positions" />
          <div className={s.total}>Total no.of positions <span className={s.totalPill}>{String(total).padStart(2, "0")}</span></div>

          <div className={s.fieldGap}>
            <label className={s.lbl} htmlFor="req-loc">Location</label>
            <select id="req-loc" name="locationId" className={ctl("locationId")} value={v.locationId} onChange={(e) => set("locationId", e.target.value)}>
              <option value="">Select Location</option>
              {options.locations.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          <div className={`${s.formRow} ${s.fieldGap}`}>
            <div>
              <label className={s.lbl} htmlFor="req-date">Target Hiring Date</label>
              <input id="req-date" name="targetStartDate" type="date" className={ctl("targetStartDate")} value={v.targetStartDate} onChange={(e) => set("targetStartDate", e.target.value)} />
              <E name="targetStartDate" />
            </div>
            <span />
          </div>

          <div className={s.fieldGap}>
            <label className={s.lbl}>Salary Range <span title="The budget approved with this requisition. An offer above an INR annual range needs a further approval." className="subtle">ⓘ</span></label>
            <div className={s.salaryBox}>
              <select name="currency" className={ctl("currency")} aria-label="Currency" value={v.currency} onChange={(e) => set("currency", e.target.value)}>
                {CURRENCIES.map((c) => <option key={c.value} value={c.value}>{c.value}</option>)}
              </select>
              <input name="salaryMin" type="number" min={0} className={ctl("salaryMin")} placeholder="Min range" aria-label="Min range" value={v.salaryMin} onChange={(e) => set("salaryMin", e.target.value)} />
              <input name="salaryMax" type="number" min={0} className={ctl("salaryMax")} placeholder="Max range" aria-label="Max range" value={v.salaryMax} onChange={(e) => set("salaryMax", e.target.value)} />
              <select name="salaryFrequency" className={ctl("salaryFrequency")} aria-label="Salary frequency" value={v.salaryFrequency} onChange={(e) => set("salaryFrequency", e.target.value)}>
                <option value="">NA</option><option value="HOURLY">Hourly</option><option value="BIWEEKLY">Bi Weekly</option><option value="MONTHLY">Monthly</option><option value="ANNUAL">Annual</option>
              </select>
            </div>
            <E name="salaryMin" /><E name="salaryMax" /><E name="salaryFrequency" /><E name="currency" />
          </div>

          <div className={`${s.formRow} ${s.fieldGap}`}>
            <div>
              <label className={s.lbl} htmlFor="req-jobtype">Job Type<span className={s.req}>*</span></label>
              <select id="req-jobtype" name="jobType" className={ctl("jobType")} value={v.jobType} onChange={(e) => set("jobType", e.target.value)}>
                <option value="PART_TIME">Part Time</option><option value="FULL_TIME">Full Time</option>
              </select>
            </div>
            <span />
          </div>

          <h3 className={s.sectionTitle}>Custom Job Fields</h3>
          <div className={s.formRow} style={{ marginTop: 14 }}>
            <div>
              <label className={s.lbl} htmlFor="req-emptype">Employment Type</label>
              <select id="req-emptype" name="employmentType" className={s.ctl} value={v.employmentType} onChange={(e) => set("employmentType", e.target.value)}>
                <option value="" />
                <option value="PERMANENT">Permanent</option><option value="CONTRACT">Contract</option><option value="INTERN">Intern</option><option value="CONSULTANT">Consultant</option>
              </select>
            </div>
            <span />
          </div>

          <div className={s.jdHead}>
            <label className={s.lbl} style={{ margin: 0 }} htmlFor="req-jd">Job Description<span className={s.req}>*</span></label>
            <div className={s.jdLinks}>
              {options.templates.length ? <button type="button" className={s.linkBtn} onClick={() => setShowTemplates((x) => !x)} aria-expanded={showTemplates}>Pick from template</button> : null}
              <button type="button" className={s.aiBtn} onClick={generate} disabled={aiPending || v.title.trim().length < 2} title={v.title.trim().length < 2 ? "Enter a job title first" : undefined}>
                <IconSparkle /> {aiPending ? "Generating…" : "Generate using AI"}
              </button>
              {showTemplates ? (
                <div className={s.popList} role="menu">
                  {options.templates.map((t) => <button type="button" role="menuitem" key={t.id} onClick={() => { setShowTemplates(false); replaceDescription(t.body); }}>{t.title}</button>)}
                </div>
              ) : null}
            </div>
          </div>
          {aiMsg ? <div className={`callout warning ${s.aiNote}`} style={{ marginBottom: 10 }}>{aiMsg}</div> : null}
          <div className={s.editor} style={err.description ? { borderColor: "var(--danger)" } : undefined}>
            <div className={s.editorBar}>
              <button type="button" onClick={() => wrap("b")} aria-label="Bold">B</button>
              <button type="button" onClick={() => wrap("i")} aria-label="Italic" style={{ fontStyle: "italic", fontFamily: "serif" }}>I</button>
              <button type="button" onClick={() => wrap("ol")} aria-label="Numbered list">1.</button>
              <button type="button" onClick={() => wrap("ul")} aria-label="Bulleted list">•</button>
              <button type="button" onClick={() => wrap("link")} aria-label="Link">🔗</button>
            </div>
            <textarea ref={area} id="req-jd" name="description" className={s.editorArea} placeholder="Enter job description" value={v.description} onChange={(e) => set("description", e.target.value)} />
          </div>
          <E name="description" />

          <div className={s.fieldGap}>
            <label className={s.lbl} htmlFor="req-comments">Additional Comments</label>
            <textarea id="req-comments" name="justification" className="textarea" rows={3} maxLength={2000} value={v.justification} onChange={(e) => set("justification", e.target.value)} />
          </div>
        </div>

        <div style={{ display: step === 2 ? "block" : "none" }}>
          <h3 style={{ fontSize: 17, fontWeight: 450 }}>Hiring team</h3>
          <p className="muted text-sm" style={{ marginTop: 4 }}>Optional. The job opened from this requisition starts with this team.</p>
          <div className={s.fieldGap}>
            <label className={s.lbl} htmlFor="req-hm">Hiring Manager</label>
            <select id="req-hm" name="hiringManagerId" className={s.ctl} value={v.hiringManagerId} onChange={(e) => set("hiringManagerId", e.target.value)}>
              <option value="">Select hiring manager</option>
              {options.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div className={s.fieldGap}>
            <label className={s.lbl} htmlFor="req-rec">Recruiter</label>
            <select id="req-rec" name="recruiterId" className={s.ctl} value={v.recruiterId} onChange={(e) => set("recruiterId", e.target.value)}>
              <option value="">Select recruiter</option>
              {options.recruiters.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="callout info" style={{ marginTop: 26 }}>
            {approverName ? <>This requisition will go to <strong>{approverName}</strong> for approval.</> : <>This requisition will go to the requisition approvers.</>}
          </div>
        </div>
      </div>
    </form>
  );
}
