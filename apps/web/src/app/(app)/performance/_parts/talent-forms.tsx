"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, useForm } from "@/components/form";
import type { ActionState } from "@/lib/forms";
import {
  saveTimeframeAction, generateTimeframesAction, toggleTimeframeAction, saveGoalTemplateAction, archiveGoalTemplateAction, assignGoalAction,
  saveFormSectionAction, saveFormQuestionAction, removeFormItemAction, copyFormAction, saveStageDatesAction, addParticipantsAction, updateParticipantAction,
  saveBandsAction, saveFeedbackSettingsAction, requestFeedbackAction, answerFeedbackRequestAction, savePromotionPolicyAction,
  recommendSalaryAction, decideRecommendationAction, saveGrowthTemplateAction, toggleGrowthTemplateAction, startGrowthPlanAction, toggleGrowthItemAction,
} from "@/app/actions/talent-performance";

export interface Option { value: string; label: string }
type Act = (prev: ActionState, f: FormData) => Promise<ActionState>;

/** A small button that runs one action with hidden fields and shows its result inline. */
export function OpButton({ action, hidden, label, tone, confirm: ask }: { action: Act; hidden: Record<string, string>; label: string; tone?: "primary" | "danger" | "ghost"; confirm?: string }) {
  const [state, run, pending] = useForm(action);
  return (
    <form action={run} className="row gap-2" style={{ display: "inline-flex" }} onSubmit={(e) => { if (ask && !window.confirm(ask)) e.preventDefault(); }}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={`btn sm ${tone ?? ""}`} disabled={pending}>{pending ? "…" : label}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

const METRIC_OPTIONS: Option[] = [
  { value: "PERCENTAGE", label: "Percent complete" }, { value: "COMPLETION", label: "Done / not done" },
  { value: "NUMBER_INCREASE", label: "Number to increase" }, { value: "NUMBER_DECREASE", label: "Number to decrease" }, { value: "CURRENCY", label: "Amount (₹)" },
];

// ---------------------------------------------------------------------------
//  Goal library
// ---------------------------------------------------------------------------

export function TimeframeForms({ fy }: { fy: number }) {
  return (
    <div className="stack gap-4">
      <ActionForm action={generateTimeframesAction} submitLabel="Generate">
        {(state) => (
          <div className="grid grid-3">
            <Field label="Generate" name="kind" state={state}><SelectInput name="kind" state={state} defaultValue="QUARTER" options={[{ value: "QUARTER", label: "Quarters" }, { value: "HALF_YEAR", label: "Half-years" }, { value: "YEAR", label: "The financial year" }]} /></Field>
            <Field label="Financial year starting in" name="fy" state={state} hint="e.g. 2026 for FY 2026-27"><TextInput name="fy" type="number" state={state} defaultValue={fy} /></Field>
          </div>
        )}
      </ActionForm>
      <ActionForm action={saveTimeframeAction} submitLabel="Add custom timeframe">
        {(state) => (
          <div className="grid grid-3">
            <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} placeholder="Product launch window" required /></Field>
            <Field label="Starts" name="startDate" state={state} required><TextInput name="startDate" type="date" state={state} required /></Field>
            <Field label="Ends" name="endDate" state={state} required><TextInput name="endDate" type="date" state={state} required /></Field>
            <input type="hidden" name="kind" value="CUSTOM" />
          </div>
        )}
      </ActionForm>
    </div>
  );
}

export function ToggleTimeframe({ id, active }: { id: string; active: boolean }) {
  return <OpButton action={toggleTimeframeAction} hidden={{ id }} label={active ? "Hide" : "Show"} tone="ghost" />;
}

export function GoalTemplateForm() {
  const [metric, setMetric] = useState("PERCENTAGE");
  const numeric = !["PERCENTAGE", "COMPLETION"].includes(metric);
  return (
    <ActionForm action={saveGoalTemplateAction} submitLabel="Add to library">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Title" name="title" state={state} required><TextInput name="title" state={state} required placeholder="Improve NPS for key accounts" /></Field>
            <Field label="Category" name="category" state={state}><TextInput name="category" state={state} placeholder="Customer, Engineering…" /></Field>
            <Field label="Measured as" name="metricType" state={state}>
              <select name="metricType" className="select" value={metric} onChange={(e) => setMetric(e.target.value)}>{METRIC_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            </Field>
            {numeric ? <Field label="Starting value" name="startValue" state={state}><TextInput name="startValue" type="number" step="any" state={state} defaultValue={0} /></Field> : null}
            {numeric ? <Field label="Target" name="targetValue" state={state} required><TextInput name="targetValue" type="number" step="any" state={state} required /></Field> : null}
            {numeric ? <Field label="Metric name" name="metricName" state={state}><TextInput name="metricName" state={state} placeholder="NPS points" /></Field> : null}
            <Field label="Tags" name="tags" state={state} hint="Comma separated"><TextInput name="tags" state={state} /></Field>
          </div>
          <Field label="Description" name="description" state={state}><TextArea name="description" state={state} rows={2} /></Field>
        </>
      )}
    </ActionForm>
  );
}

export function ArchiveGoalTemplate({ id, active }: { id: string; active: boolean }) {
  return <OpButton action={archiveGoalTemplateAction} hidden={{ id }} label={active ? "Archive" : "Restore"} tone="ghost" />;
}

/**
 * Assign a goal — from a template or from scratch — to one person or, as a
 * team goal, to several at once.
 */
export function AssignGoalForm({ templates, timeframes, people, defaultTemplateId }: {
  templates: Array<Option & { metricType: string; target: number; start: number }>; timeframes: Option[]; people: Option[]; defaultTemplateId?: string;
}) {
  const [tpl, setTpl] = useState(defaultTemplateId ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [useDates, setUseDates] = useState(timeframes.length === 0);
  const t = templates.find((x) => x.value === tpl);
  return (
    <ActionForm action={assignGoalAction} submitLabel={picked.length > 1 ? `Assign to ${picked.length} people` : "Create goal"}>
      {(state) => (
        <>
          {picked.map((id) => <input key={id} type="hidden" name="employeeIds" value={id} />)}
          <div className="grid grid-3">
            <Field label="From the library" name="templateId" state={state}>
              <select name="templateId" className="select" value={tpl} onChange={(e) => setTpl(e.target.value)}>
                <option value="">Start from scratch</option>{templates.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Title" name="title" state={state} hint={t ? "Leave blank to use the template's" : undefined}><TextInput key={tpl} name="title" state={state} placeholder={t?.label ?? "What will be achieved"} /></Field>
            {!t ? <Field label="Measured as" name="metricType" state={state}><SelectInput name="metricType" state={state} options={METRIC_OPTIONS} defaultValue="PERCENTAGE" /></Field> : <div className="field"><div className="label">Measured as</div><div className="text-sm">{METRIC_OPTIONS.find((m) => m.value === t.metricType)?.label} · target {t.target}</div></div>}
            {!t ? <Field label="Target (numeric metrics)" name="targetValue" state={state}><TextInput name="targetValue" type="number" step="any" state={state} /></Field> : null}
            {!useDates ? (
              <Field label="Timeframe" name="timeframeId" state={state}><SelectInput name="timeframeId" state={state} options={timeframes} placeholder="Select…" /></Field>
            ) : (
              <>
                <Field label="Starts" name="startDate" state={state}><TextInput name="startDate" type="date" state={state} /></Field>
                <Field label="Due" name="dueDate" state={state}><TextInput name="dueDate" type="date" state={state} /></Field>
              </>
            )}
          </div>
          {timeframes.length ? <label className="checkbox-row" style={{ marginBottom: 10 }}><input type="checkbox" checked={useDates} onChange={(e) => setUseDates(e.target.checked)} /><span className="text-sm">Use custom dates instead of a timeframe</span></label> : null}
          <Field label="Assign to" name="employeeIds" state={state} hint="Pick several people to make it a team goal — everyone gets their own copy to track.">
            <div className="stack gap-2">
              <select className="select" value="" aria-label="Add a person" onChange={(e) => { const v = e.target.value; if (v && !picked.includes(v)) setPicked([...picked, v]); }}>
                <option value="">{picked.length ? "Add another person…" : "Myself (or add people…)"}</option>
                {people.filter((p) => !picked.includes(p.value)).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              {picked.length ? <div className="row gap-1 wrap">{picked.map((id) => <button key={id} type="button" className="btn ghost sm" onClick={() => setPicked(picked.filter((p) => p !== id))}>{people.find((p) => p.value === id)?.label} ×</button>)}</div> : null}
            </div>
          </Field>
          <Field label="Description" name="description" state={state}><TextArea name="description" state={state} rows={2} /></Field>
        </>
      )}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  Cycle setup: form builder, stage dates, participants
// ---------------------------------------------------------------------------

export function SectionForm({ cycleId }: { cycleId: string }) {
  return (
    <ActionForm action={saveFormSectionAction} submitLabel="Add section" hidden={{ cycleId }} compact>
      {(state) => (
        <div className="grid grid-2">
          <Field label="Section title" name="title" state={state} required><TextInput name="title" state={state} placeholder="Core competencies" required /></Field>
          <Field label="Guidance" name="description" state={state}><TextInput name="description" state={state} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

const REVIEWERS: Option[] = [{ value: "SELF", label: "Self" }, { value: "MANAGER", label: "Manager" }, { value: "SKIP_LEVEL", label: "Skip-level" }, { value: "PEER", label: "Peers" }, { value: "SUBORDINATE", label: "Direct reports" }];

export function QuestionForm({ cycleId, sectionId }: { cycleId: string; sectionId: string }) {
  const [kind, setKind] = useState("RATING");
  return (
    <ActionForm action={saveFormQuestionAction} submitLabel="Add question" hidden={{ cycleId, sectionId }} compact>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Type" name="kind" state={state}>
              <select name="kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="RATING">Rating scale (1–5)</option><option value="TEXT">Text answer</option><option value="COMPETENCY">Competency rating</option>
              </select>
            </Field>
            <Field label="Question" name="prompt" state={state} required><TextInput name="prompt" state={state} required placeholder="How well did they deliver on commitments?" /></Field>
            {kind === "COMPETENCY" ? <Field label="Competency" name="competency" state={state} required><TextInput name="competency" state={state} placeholder="Ownership" /></Field> : <div />}
          </div>
          <div className="row gap-3 wrap" style={{ marginBottom: 6 }}>
            <span className="text-xs subtle">Answered by (none ticked = everyone):</span>
            {REVIEWERS.map((r) => <label key={r.value} className="checkbox-row"><input type="checkbox" name="appliesTo" value={r.value} /><span className="text-sm">{r.label}</span></label>)}
            <CheckboxInput name="isRequired" label="Required" defaultChecked />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function RemoveFormItem({ cycleId, id, kind }: { cycleId: string; id: string; kind: "section" | "question" }) {
  return <OpButton action={removeFormItemAction} hidden={{ cycleId, id, kind }} label="Remove" tone="ghost" confirm={kind === "section" ? "Remove this section and its questions?" : undefined} />;
}

export function CopyFormForm({ cycleId, cycles }: { cycleId: string; cycles: Option[] }) {
  return (
    <ActionForm action={copyFormAction} submitLabel="Copy form" hidden={{ cycleId }} compact>
      {(state) => <Field label="Start from another cycle's form" name="fromCycleId" state={state}><SelectInput name="fromCycleId" state={state} options={cycles} placeholder="Choose a cycle…" /></Field>}
    </ActionForm>
  );
}

export function StageDatesForm({ cycleId, values }: { cycleId: string; values: Record<string, string> }) {
  const f = (name: string, label: string) => (state: ActionState) => <Field label={label} name={name} state={state}><TextInput name={name} type="date" state={state} defaultValue={values[name] ?? ""} /></Field>;
  return (
    <ActionForm action={saveStageDatesAction} submitLabel="Save stage dates" hidden={{ cycleId }}>
      {(state) => (
        <div className="grid grid-3">
          {f("selfStartsAt", "Self review opens")(state)}{f("selfEndsAt", "Self review closes")(state)}<div />
          {f("managerStartsAt", "Manager review opens")(state)}{f("managerEndsAt", "Manager review closes")(state)}<div />
          {f("calibrationStartsAt", "Calibration starts")(state)}{f("calibrationEndsAt", "Calibration ends")(state)}
          {f("publishOn", "Results published on")(state)}
        </div>
      )}
    </ActionForm>
  );
}

export function AddParticipantsForm({ cycleId, people, departments }: { cycleId: string; people: Option[]; departments: Option[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <ActionForm action={addParticipantsAction} submitLabel={picked.length ? `Add ${picked.length} people` : "Add department"} hidden={{ cycleId }}>
      {(state) => (
        <div className="grid grid-2">
          {picked.map((id) => <input key={id} type="hidden" name="employeeIds" value={id} />)}
          <Field label="People" name="employeeIds" state={state}>
            <div className="stack gap-2">
              <select className="select" value="" onChange={(e) => { const v = e.target.value; if (v && !picked.includes(v)) setPicked([...picked, v]); }} aria-label="Add a person">
                <option value="">Add a person…</option>{people.filter((p) => !picked.includes(p.value)).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              {picked.length ? <div className="row gap-1 wrap">{picked.map((id) => <button key={id} type="button" className="btn ghost sm" onClick={() => setPicked(picked.filter((p) => p !== id))}>{people.find((p) => p.value === id)?.label} ×</button>)}</div> : null}
            </div>
          </Field>
          <Field label="…or a whole department" name="departmentId" state={state}><SelectInput name="departmentId" state={state} options={departments} placeholder="—" /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function ParticipantRow({ cycleId, id, managerId, managers }: { cycleId: string; id: string; managerId: string | null; managers: Option[] }) {
  const [state, run, pending] = useForm(updateParticipantAction);
  return (
    <form action={run} className="row gap-2" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="cycleId" value={cycleId} /><input type="hidden" name="id" value={id} />
      <select name="managerId" className="select" defaultValue={managerId ?? ""} style={{ width: 200 }} aria-label="Reviewing manager">
        <option value="">Reporting manager</option>{managers.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
      <button className="btn sm" name="op" value="save" disabled={pending}>Save</button>
      <button className="btn sm ghost" name="op" value="remove" disabled={pending}>Remove</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Calibration: bands
// ---------------------------------------------------------------------------

export function BandsForm({ cycleId, bands }: { cycleId: string; bands: Array<{ id: string; name: string; min: number; max: number; target: number | null; color: string | null }> }) {
  const [state, run, pending] = useForm(saveBandsAction);
  return (
    <form action={run}>
      <FormBanner state={state} />
      <input type="hidden" name="cycleId" value={cycleId} />
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Band</th><th className="num">From</th><th className="num">To</th><th className="num">Target %</th><th>Colour</th></tr></thead>
        <tbody>
          {bands.map((b) => (
            <tr key={b.id}>
              <td><input className="input" name={`name:${b.id}`} defaultValue={b.name} aria-label="Band name" /></td>
              <td className="num"><input className="input num" style={{ width: 80 }} name={`min:${b.id}`} type="number" step="0.01" defaultValue={b.min} aria-label="From" /></td>
              <td className="num"><input className="input num" style={{ width: 80 }} name={`max:${b.id}`} type="number" step="0.01" defaultValue={b.max} aria-label="To" /></td>
              <td className="num"><input className="input num" style={{ width: 80 }} name={`target:${b.id}`} type="number" step="0.1" defaultValue={b.target ?? ""} aria-label="Target" /></td>
              <td><input className="input" style={{ width: 70, padding: 2 }} name={`color:${b.id}`} type="color" defaultValue={b.color ?? "#8891a3"} aria-label="Colour" /></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <button className="btn primary sm" style={{ marginTop: 10 }} disabled={pending}>{pending ? "Saving…" : "Save bands"}</button>
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Settings, feedback requests, recommendations
// ---------------------------------------------------------------------------

export function FeedbackSettingsForm({ v }: { v: { allowAnonymous: boolean; allowRequests: boolean; whoCanGive: string } }) {
  return (
    <ActionForm action={saveFeedbackSettingsAction} submitLabel="Save feedback settings">
      {(state) => (
        <div className="stack gap-2">
          <Field label="Who can give feedback" name="whoCanGive" state={state}>
            <SelectInput name="whoCanGive" state={state} defaultValue={v.whoCanGive} options={[{ value: "EVERYONE", label: "Anyone in the company" }, { value: "SAME_DEPARTMENT", label: "Colleagues in the same department (and managers)" }, { value: "REPORTING_LINE", label: "Only managers in the reporting line" }]} />
          </Field>
          <CheckboxInput name="allowAnonymous" label="Allow anonymous feedback" defaultChecked={v.allowAnonymous} hint="Givers may hide their name from the person it is about." />
          <CheckboxInput name="allowRequests" label="Let people request feedback" defaultChecked={v.allowRequests} hint="Employees ask colleagues; managers can also ask about their reports." />
        </div>
      )}
    </ActionForm>
  );
}

export function PromotionPolicyForm({ v }: { v: { minTenureMonths: number; minMonthsSinceLastPromotion: number; minRating: number; excludeOnPip: boolean; maxIncrementPercent: number } }) {
  return (
    <ActionForm action={savePromotionPolicyAction} submitLabel="Save eligibility">
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Minimum tenure (months)" name="minTenureMonths" state={state}><TextInput name="minTenureMonths" type="number" state={state} defaultValue={v.minTenureMonths} /></Field>
            <Field label="Months since last promotion" name="minMonthsSinceLastPromotion" state={state}><TextInput name="minMonthsSinceLastPromotion" type="number" state={state} defaultValue={v.minMonthsSinceLastPromotion} /></Field>
            <Field label="Minimum final rating" name="minRating" state={state}><TextInput name="minRating" type="number" step="0.1" state={state} defaultValue={v.minRating} /></Field>
            <Field label="Largest increment a manager may recommend (%)" name="maxIncrementPercent" state={state}><TextInput name="maxIncrementPercent" type="number" step="0.5" state={state} defaultValue={v.maxIncrementPercent} /></Field>
          </div>
          <CheckboxInput name="excludeOnPip" label="Not eligible while on an improvement plan" defaultChecked={v.excludeOnPip} />
        </>
      )}
    </ActionForm>
  );
}

export function RequestFeedbackForm({ colleagues, reports }: { colleagues: Option[]; reports: Option[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <ActionForm action={requestFeedbackAction} submitLabel="Send request">
      {(state) => (
        <>
          {picked.map((id) => <input key={id} type="hidden" name="askedIds" value={id} />)}
          <div className="grid grid-2">
            <Field label="Ask" name="askedIds" state={state} required>
              <div className="stack gap-2">
                <select className="select" value="" onChange={(e) => { const v = e.target.value; if (v && !picked.includes(v) && picked.length < 10) setPicked([...picked, v]); }} aria-label="Add a colleague">
                  <option value="">Add a colleague…</option>{colleagues.filter((c) => !picked.includes(c.value)).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                {picked.length ? <div className="row gap-1 wrap">{picked.map((id) => <button key={id} type="button" className="btn ghost sm" onClick={() => setPicked(picked.filter((p) => p !== id))}>{colleagues.find((c) => c.value === id)?.label} ×</button>)}</div> : null}
              </div>
            </Field>
            {reports.length ? <Field label="About" name="aboutEmployeeId" state={state}><SelectInput name="aboutEmployeeId" state={state} options={reports} placeholder="Me" /></Field> : <div />}
            <Field label="Respond by" name="dueDate" state={state}><TextInput name="dueDate" type="date" state={state} /></Field>
          </div>
          <Field label="What would you like feedback on?" name="message" state={state}><TextArea name="message" state={state} rows={2} placeholder="How I ran the Q3 planning workshop" /></Field>
        </>
      )}
    </ActionForm>
  );
}

export function AnswerRequestForm({ id, allowAnonymous }: { id: string; allowAnonymous: boolean }) {
  const [state, run, pending] = useForm(answerFeedbackRequestAction);
  if (state.ok) return <div className="callout success"><div>{state.message}</div></div>;
  return (
    <form action={run} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="id" value={id} />
      <TextArea name="message" state={state} rows={3} placeholder="Specific and kind: what they did, the effect, and what could be even better." />
      {allowAnonymous ? <label className="checkbox-row"><input type="checkbox" name="anonymous" /><span className="text-sm">Give anonymously</span></label> : null}
      <div className="row gap-2">
        <button className="btn sm primary" name="op" value="give" disabled={pending}>Send feedback</button>
        <button className="btn sm ghost" name="op" value="decline" disabled={pending}>Decline</button>
      </div>
    </form>
  );
}

export function RecommendForm({ reviewId, maxPercent, current }: { reviewId: string; maxPercent: number; current?: { pct: number; promote: boolean; title: string; why: string } }) {
  const [promote, setPromote] = useState(current?.promote ?? false);
  return (
    <ActionForm action={recommendSalaryAction} submitLabel={current ? "Update recommendation" : "Send recommendation"} hidden={{ reviewId }}>
      {(state) => (
        <>
          <Field label={`Increment % (up to ${maxPercent})`} name="incrementPercent" state={state} required><TextInput name="incrementPercent" type="number" step="0.5" min={0} max={maxPercent} state={state} defaultValue={current?.pct} required /></Field>
          <label className="checkbox-row" style={{ marginBottom: 8 }}><input type="checkbox" name="recommendPromotion" checked={promote} onChange={(e) => setPromote(e.target.checked)} /><span className="text-sm">Recommend a promotion</span></label>
          {promote ? <Field label="To role" name="proposedJobTitle" state={state} required><TextInput name="proposedJobTitle" state={state} defaultValue={current?.title} /></Field> : null}
          <Field label="Justification" name="justification" state={state} required><TextArea name="justification" state={state} rows={2} defaultValue={current?.why} /></Field>
        </>
      )}
    </ActionForm>
  );
}

export function DecideRecommendation({ id }: { id: string }) {
  const [state, run, pending] = useForm(decideRecommendationAction);
  if (state.ok) return <div className="callout success"><div>{state.message}</div></div>;
  return (
    <form action={run} className="stack gap-2" style={{ width: "100%" }}>
      <input type="hidden" name="id" value={id} />
      <input className="input" name="note" placeholder="Note (required to reject)" />
      <div className="row gap-2">
        <button className="btn sm primary" name="decision" value="approve" disabled={pending}>Approve</button>
        <button className="btn sm danger" name="decision" value="reject" disabled={pending}>Reject</button>
      </div>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Growth plans
// ---------------------------------------------------------------------------

export function GrowthTemplateForm() {
  return (
    <ActionForm action={saveGrowthTemplateAction} submitLabel="Add template">
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} required placeholder="New people manager — first 90 days" /></Field>
            <Field label="Description" name="description" state={state}><TextInput name="description" state={state} /></Field>
          </div>
          <Field label="Items" name="items" state={state} required hint="One per line: Title | SKILL, COURSE, MILESTONE or MENTORING | due in days">
            <TextArea name="items" state={state} rows={5} placeholder={"Complete the managing-people course | COURSE | 30\nRun weekly 1:1s with every report | MILESTONE | 45\nPair with a senior manager | MENTORING | 90"} />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

export function ToggleGrowthTemplate({ id, active }: { id: string; active: boolean }) {
  return <OpButton action={toggleGrowthTemplateAction} hidden={{ id }} label={active ? "Archive" : "Restore"} tone="ghost" />;
}

export function StartGrowthPlanForm({ templates, people }: { templates: Option[]; people: Option[] }) {
  return (
    <ActionForm action={startGrowthPlanAction} submitLabel="Start plan">
      {(state) => (
        <div className="grid grid-3">
          <Field label="Template" name="templateId" state={state} required><SelectInput name="templateId" state={state} options={templates} placeholder="Select…" required /></Field>
          <Field label="For" name="employeeId" state={state} required><SelectInput name="employeeId" state={state} options={people} placeholder="Select…" required /></Field>
          <Field label="Starts" name="startDate" state={state}><TextInput name="startDate" type="date" state={state} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function GrowthItemToggle({ id, done }: { id: string; done: boolean }) {
  return <OpButton action={toggleGrowthItemAction} hidden={{ id }} label={done ? "Reopen" : "Mark done"} tone={done ? "ghost" : undefined} />;
}
