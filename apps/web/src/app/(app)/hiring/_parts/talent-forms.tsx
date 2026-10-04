"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, useForm } from "@/components/form";
import type { ActionState } from "@/lib/forms";
import {
  createPoolAction, addToPoolAction, removeFromPoolAction, poolToJobAction, applyInternallyAction, uploadResumeAction, saveCandidateProfileAction,
  saveCandidateFieldAction, toggleCandidateFieldAction, saveScoreConfigAction, saveScorecardLibraryAction, deleteScorecardLibraryAction, applyScorecardToJobAction,
  offerSlotsAction, cancelSlotOfferAction, saveApprovalRuleAction, toggleApprovalRuleAction, decideOfferStepAction, saveCareerSiteAction,
} from "@/app/actions/talent-hiring";

export interface Option { value: string; label: string }
type Act = (prev: ActionState, f: FormData) => Promise<ActionState>;

function Op({ action, hidden, label, tone }: { action: Act; hidden: Record<string, string>; label: string; tone?: string }) {
  const [state, run, pending] = useForm(action);
  return (
    <form action={run} className="row gap-2" style={{ display: "inline-flex" }}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={`btn sm ${tone ?? ""}`} disabled={pending}>{pending ? "…" : label}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

/** A picker that collects several values into hidden inputs, in the order chosen. */
function MultiPick({ name, options, placeholder, max = 50 }: { name: string; options: Option[]; placeholder: string; max?: number }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div className="stack gap-2">
      {picked.map((id) => <input key={id} type="hidden" name={name} value={id} />)}
      <select className="select" value="" aria-label={placeholder} onChange={(e) => { const v = e.target.value; if (v && !picked.includes(v) && picked.length < max) setPicked([...picked, v]); }}>
        <option value="">{placeholder}</option>{options.filter((o) => !picked.includes(o.value)).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {picked.length ? <div className="row gap-1 wrap">{picked.map((id, i) => <button key={id} type="button" className="btn ghost sm" onClick={() => setPicked(picked.filter((p) => p !== id))}>{i + 1}. {options.find((o) => o.value === id)?.label} ×</button>)}</div> : null}
    </div>
  );
}

// --- Talent pools --------------------------------------------------------------

export function CreatePoolForm() {
  return (
    <ActionForm action={createPoolAction} submitLabel="Create pool">
      {(state) => (
        <div className="grid grid-2">
          <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} required placeholder="Silver medallists — Engineering" /></Field>
          <Field label="Description" name="description" state={state}><TextInput name="description" state={state} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function AddToPoolForm({ candidateId, pools }: { candidateId: string; pools: Option[] }) {
  const [state, run, pending] = useForm(addToPoolAction);
  return (
    <form action={run} className="stack gap-2">
      <input type="hidden" name="candidateId" value={candidateId} />
      <div className="row gap-2">
        <select name="poolId" className="select" defaultValue="" aria-label="Talent pool"><option value="">Save to a pool…</option>{pools.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
        <button className="btn sm" disabled={pending}>Save</button>
      </div>
      <input name="note" className="input" placeholder="Why (optional)" />
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function RemoveFromPool({ id }: { id: string }) { return <Op action={removeFromPoolAction} hidden={{ id }} label="Remove" tone="ghost" />; }

export function PoolToJobForm({ candidateId, jobs }: { candidateId: string; jobs: Option[] }) {
  const [state, run, pending] = useForm(poolToJobAction);
  return (
    <form action={run} className="row gap-2" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="candidateId" value={candidateId} />
      <select name="jobId" className="select" defaultValue="" style={{ width: 180 }} aria-label="Open job"><option value="">Add to a job…</option>{jobs.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}</select>
      <button className="btn sm" disabled={pending}>Add</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

// --- Internal job board ---------------------------------------------------------

export function ApplyInternallyForm({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [state, run, pending] = useForm(applyInternallyAction);
  if (state.ok) return <span className="text-sm pos">{state.message}</span>;
  if (!open) return <button type="button" className="btn sm primary" onClick={() => setOpen(true)}>Apply</button>;
  return (
    <form action={run} className="stack gap-2" style={{ marginTop: 8 }}>
      <FormBanner state={state} />
      <input type="hidden" name="jobId" value={jobId} />
      <textarea name="note" className="textarea" rows={2} placeholder="Why you are interested (optional)" />
      <div className="row gap-2"><button className="btn sm primary" disabled={pending}>{pending ? "Applying…" : "Submit application"}</button><button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

// --- Candidate profile -----------------------------------------------------------

export function ResumeUploadForm({ candidateId, applicationId, has }: { candidateId: string; applicationId: string; has: boolean }) {
  const [state, run, pending] = useForm(uploadResumeAction);
  return (
    <form action={run} className="row gap-2 wrap">
      <input type="hidden" name="candidateId" value={candidateId} /><input type="hidden" name="applicationId" value={applicationId} />
      <input type="file" name="resume" accept="application/pdf" className="input" style={{ maxWidth: 260 }} aria-label="Résumé PDF" />
      <button className="btn sm" disabled={pending}>{pending ? "Uploading…" : has ? "Replace résumé" : "Upload résumé"}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export interface CustomFieldView { id: string; label: string; type: string; options: string[] | null; isMandatory: boolean; value: string | null }

export function CandidateProfileForm({ candidateId, applicationId, education, skills, experience, fields }: { candidateId: string; applicationId: string; education: string; skills: string; experience: string; fields: CustomFieldView[] }) {
  return (
    <ActionForm action={saveCandidateProfileAction} submitLabel="Save profile" hidden={{ candidateId, applicationId }}>
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Highest education" name="education" state={state}><TextInput name="education" state={state} defaultValue={education} placeholder="B.Tech, Computer Science" /></Field>
            <Field label="Total experience (years)" name="totalExperienceYears" state={state}><TextInput name="totalExperienceYears" type="number" step="0.5" state={state} defaultValue={experience} /></Field>
          </div>
          <Field label="Skills" name="skills" state={state} hint="Comma separated — matched against the job's skills for the profile score"><TextInput name="skills" state={state} defaultValue={skills} /></Field>
          {fields.length ? (
            <div className="grid grid-2">
              {fields.map((cf) => (
                <Field key={cf.id} label={cf.label} name={`cf_${cf.id}`} state={state} required={cf.isMandatory}>
                  {cf.type === "DROPDOWN" ? <SelectInput name={`cf_${cf.id}`} state={state} options={(cf.options ?? []).map((o) => ({ value: o, label: o }))} defaultValue={cf.value} placeholder="—" />
                    : cf.type === "CHECKBOX" ? <input type="checkbox" name={`cf_${cf.id}`} defaultChecked={cf.value === "true"} />
                    : cf.type === "MULTILINE" ? <TextArea name={`cf_${cf.id}`} state={state} defaultValue={cf.value} rows={2} />
                    : <TextInput name={`cf_${cf.id}`} state={state} defaultValue={cf.value} type={cf.type === "NUMBER" ? "number" : cf.type === "DATE" ? "date" : cf.type === "EMAIL" ? "email" : "text"} />}
                </Field>
              ))}
            </div>
          ) : null}
        </>
      )}
    </ActionForm>
  );
}

export function CandidateFieldForm() {
  const [type, setType] = useState("TEXT");
  return (
    <ActionForm action={saveCandidateFieldAction} submitLabel="Add field">
      {(state) => (
        <div className="grid grid-3">
          <Field label="Label" name="label" state={state} required><TextInput name="label" state={state} required placeholder="Willing to relocate" /></Field>
          <Field label="Type" name="type" state={state}>
            <select name="type" className="select" value={type} onChange={(e) => setType(e.target.value)}>{["TEXT", "NUMBER", "DATE", "DROPDOWN", "CHECKBOX", "MULTILINE", "EMAIL", "PHONE"].map((t) => <option key={t} value={t}>{t.toLowerCase()}</option>)}</select>
          </Field>
          {type === "DROPDOWN" ? <Field label="Options" name="options" state={state} hint="Comma or line separated"><TextInput name="options" state={state} /></Field> : <div className="field" style={{ paddingTop: 22 }}><CheckboxInput name="isMandatory" label="Required" /></div>}
        </div>
      )}
    </ActionForm>
  );
}

export function ToggleCandidateField({ id, active }: { id: string; active: boolean }) { return <Op action={toggleCandidateFieldAction} hidden={{ id }} label={active ? "Switch off" : "Switch on"} tone="ghost" />; }

export function ScoreConfigForm({ v }: { v: { skillsWeight: number; experienceWeight: number; educationWeight: number; skillKeywords: string[]; educationKeywords: string[]; idealExperienceYears: number } }) {
  return (
    <ActionForm action={saveScoreConfigAction} submitLabel="Save profile score">
      {(state) => (
        <>
          <div className="grid grid-4">
            <Field label="Skills weight" name="skillsWeight" state={state}><TextInput name="skillsWeight" type="number" state={state} defaultValue={v.skillsWeight} /></Field>
            <Field label="Experience weight" name="experienceWeight" state={state}><TextInput name="experienceWeight" type="number" state={state} defaultValue={v.experienceWeight} /></Field>
            <Field label="Education weight" name="educationWeight" state={state}><TextInput name="educationWeight" type="number" state={state} defaultValue={v.educationWeight} /></Field>
            <Field label="Ideal experience (years)" name="idealExperienceYears" state={state} hint="When the job sets none"><TextInput name="idealExperienceYears" type="number" step="0.5" state={state} defaultValue={v.idealExperienceYears} /></Field>
          </div>
          <Field label="Skill keywords" name="skillKeywords" state={state} hint="Matched alongside each job's own skills"><TextInput name="skillKeywords" state={state} defaultValue={v.skillKeywords.join(", ")} /></Field>
          <Field label="Education keywords" name="educationKeywords" state={state} hint="Full education marks when any appears; leave empty to credit any education"><TextInput name="educationKeywords" state={state} defaultValue={v.educationKeywords.join(", ")} /></Field>
        </>
      )}
    </ActionForm>
  );
}

export function ScorecardLibraryForm() {
  return (
    <ActionForm action={saveScorecardLibraryAction} submitLabel="Add scorecard">
      {(state) => (
        <>
          <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} required placeholder="Backend engineer" /></Field>
          <Field label="Sections" name="kit" state={state} required hint="One section per line — Section: skill, skill, skill">
            <TextArea name="kit" state={state} rows={4} placeholder={"Engineering: System design, Code quality, Debugging\nSoft Skills: Communication, Ownership"} />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

export function DeleteScorecard({ id }: { id: string }) { return <Op action={deleteScorecardLibraryAction} hidden={{ id }} label="Delete" tone="ghost" />; }

export function ApplyScorecardForm({ jobId, templates }: { jobId: string; templates: Option[] }) {
  const [state, run, pending] = useForm(applyScorecardToJobAction);
  return (
    <form action={run} className="row gap-2 wrap">
      <input type="hidden" name="jobId" value={jobId} />
      <select name="templateId" className="select" defaultValue="" aria-label="Scorecard from the library"><option value="">Use a library scorecard…</option>{templates.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
      <button className="btn sm" disabled={pending}>Apply</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

// --- Self-scheduling --------------------------------------------------------------

export function OfferSlotsForm({ applicationId, employees }: { applicationId: string; employees: Option[] }) {
  const [slots, setSlots] = useState<string[]>([""]);
  const [state, run, pending] = useForm(offerSlotsAction);
  if (state.ok) return <div className="callout success"><div>{state.message}{state.values?.url ? <div className="text-xs mono" style={{ wordBreak: "break-all", marginTop: 4 }}>{state.values.url}</div> : null}</div></div>;
  return (
    <form action={run} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="applicationId" value={applicationId} />
      <div className="grid grid-3">
        <Field label="Title" name="title" state={state}><TextInput name="title" state={state} defaultValue="Technical interview" /></Field>
        <Field label="Mode" name="mode" state={state}><SelectInput name="mode" state={state} defaultValue="VIDEO" options={[{ value: "VIDEO", label: "Video" }, { value: "IN_PERSON", label: "In person" }, { value: "PHONE", label: "Phone" }]} /></Field>
        <Field label="Minutes" name="durationMinutes" state={state}><TextInput name="durationMinutes" type="number" state={state} defaultValue={60} /></Field>
      </div>
      <Field label="Panel" name="panelIds" state={state} required><MultiPick name="panelIds" options={employees} placeholder="Add an interviewer…" max={6} /></Field>
      <Field label="Slots to offer (UTC)" name="slots" state={state} required>
        <div className="stack gap-1">
          {slots.map((v, i) => <input key={i} type="datetime-local" name="slots" className="input" value={v} onChange={(e) => setSlots(slots.map((x, k) => (k === i ? e.target.value : x)))} style={{ maxWidth: 260 }} aria-label={`Slot ${i + 1}`} />)}
          {slots.length < 10 ? <button type="button" className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setSlots([...slots, ""])}>+ another slot</button> : null}
        </div>
      </Field>
      <button className="btn primary sm" style={{ alignSelf: "flex-start" }} disabled={pending}>{pending ? "Sending…" : "Email the candidate a booking link"}</button>
    </form>
  );
}

export function CancelSlotOffer({ id, applicationId }: { id: string; applicationId: string }) { return <Op action={cancelSlotOfferAction} hidden={{ id, applicationId }} label="Cancel link" tone="ghost" />; }

// --- Approval chains ---------------------------------------------------------------

export function ApprovalRuleForm({ users, departments }: { users: Option[]; departments: Option[] }) {
  return (
    <ActionForm action={saveApprovalRuleAction} submitLabel="Add chain">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Approves" name="kind" state={state}><SelectInput name="kind" state={state} defaultValue="REQUISITION" options={[{ value: "REQUISITION", label: "Requisitions" }, { value: "OFFER", label: "Offers" }]} /></Field>
            <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} required placeholder="Senior hires" /></Field>
            <Field label="Order" name="priority" state={state} hint="Lower is checked first"><TextInput name="priority" type="number" state={state} defaultValue={100} /></Field>
            <Field label="Only for department" name="departmentId" state={state}><SelectInput name="departmentId" state={state} options={departments} placeholder="Any department" /></Field>
            <Field label="Only when the amount is at least (₹)" name="minAmount" state={state} hint="Max salary for requisitions, CTC for offers"><TextInput name="minAmount" type="number" state={state} /></Field>
          </div>
          <Field label="Approvers, in order" name="approverUserIds" state={state} required><MultiPick name="approverUserIds" options={users} placeholder="Add the next approver…" max={6} /></Field>
        </>
      )}
    </ActionForm>
  );
}

export function ToggleApprovalRule({ id, active }: { id: string; active: boolean }) { return <Op action={toggleApprovalRuleAction} hidden={{ id }} label={active ? "Pause" : "Resume"} tone="ghost" />; }

export function DecideOfferStep({ applicationId }: { applicationId: string }) {
  const [state, run, pending] = useForm(decideOfferStepAction);
  if (state.ok) return <div className="callout success"><div>{state.message}</div></div>;
  return (
    <form action={run} className="stack gap-2" style={{ width: "100%" }}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <input className="input" name="comment" placeholder="Comment (required to reject)" />
      <div className="row gap-2">
        <button className="btn sm primary" name="decision" value="approve" disabled={pending}>Approve</button>
        <button className="btn sm danger" name="decision" value="reject" disabled={pending}>Reject</button>
      </div>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

// --- Career site ----------------------------------------------------------------------

export function CareerSiteForm({ v }: { v: { headline: string; about: string; primaryColor: string; accentColor: string; embedEnabled: boolean; collectEeo: boolean; hasLogo: boolean; hasBanner: boolean } }) {
  return (
    <ActionForm action={saveCareerSiteAction} submitLabel="Save career site">
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Headline" name="headline" state={state}><TextInput name="headline" state={state} defaultValue={v.headline} placeholder="Build what's next with us" /></Field>
            <div className="row gap-3">
              <Field label="Brand colour" name="primaryColor" state={state}><input type="color" name="primaryColor" className="input" defaultValue={v.primaryColor} style={{ width: 70, padding: 2 }} /></Field>
              <Field label="Accent colour" name="accentColor" state={state}><input type="color" name="accentColor" className="input" defaultValue={v.accentColor} style={{ width: 70, padding: 2 }} /></Field>
            </div>
            <Field label={v.hasLogo ? "Replace logo" : "Logo"} name="logo" state={state} hint="PNG or JPEG, up to 2 MB"><input type="file" name="logo" accept="image/png,image/jpeg" className="input" /></Field>
            <Field label={v.hasBanner ? "Replace banner" : "Banner"} name="banner" state={state} hint="Wide image shown at the top of /careers"><input type="file" name="banner" accept="image/png,image/jpeg" className="input" /></Field>
          </div>
          <div className="row gap-4 wrap" style={{ marginBottom: 8 }}>
            {v.hasLogo ? <CheckboxInput name="removeLogo" label="Remove the logo" /> : null}
            {v.hasBanner ? <CheckboxInput name="removeBanner" label="Remove the banner" /> : null}
          </div>
          <Field label="About the company" name="about" state={state}><TextArea name="about" state={state} defaultValue={v.about} rows={5} /></Field>
          <CheckboxInput name="embedEnabled" label="Allow the jobs widget to be embedded on other websites" defaultChecked={v.embedEnabled} />
          <CheckboxInput name="collectEeo" label="Invite applicants to voluntary, optional EEO self-identification" defaultChecked={v.collectEeo} hint="Answers are never shown with an application — only counted in the EEO report." />
        </>
      )}
    </ActionForm>
  );
}
