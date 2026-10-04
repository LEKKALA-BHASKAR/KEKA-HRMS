"use client";

import { useState, type FormEvent } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, useForm } from "@/components/form";
import { visibleQuestionIds } from "@keka/services/src/engage-depth-math";
import {
  createSurveyAction, addQuestionAction, removeQuestionAction, surveyOpAction, submitSurveyAction, editQuestionAction,
} from "@/app/actions/engage";

export interface Option { value: string; label: string }

export function CreateSurveyForm({ departments, templates = [] }: { departments: Option[]; templates?: Option[] }) {
  const [kind, setKind] = useState("PULSE");
  return (
    <ActionForm action={createSurveyAction} submitLabel={kind === "POLL" ? "Create poll" : "Create from template"}>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Type" name="kind" state={state}>
              <select name="kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="PULSE">Pulse survey (5 questions)</option>
                <option value="ENGAGEMENT">Engagement survey (13 questions)</option>
                <option value="ENPS">eNPS (2 questions)</option>
                <option value="POLL">Quick poll</option>
              </select>
            </Field>
            <Field label="Title" name="title" state={state} required>
              <TextInput name="title" state={state} required placeholder={kind === "POLL" ? "Team offsite venue" : "October pulse"} />
            </Field>
            <Field label="Closes on" name="closesAt" state={state} hint="Optional — you can close it by hand">
              <TextInput name="closesAt" type="date" state={state} />
            </Field>
          </div>
          {kind === "POLL" ? (
            <div className="grid grid-2">
              <Field label="Question" name="pollQuestion" state={state} required><TextInput name="pollQuestion" state={state} placeholder="Where should we go?" /></Field>
              <Field label="Options, one per line" name="pollOptions" state={state} required><TextArea name="pollOptions" state={state} rows={4} placeholder={"Coorg\nGoa\nOoty"} /></Field>
              <CheckboxInput name="pollMulti" label="Allow more than one choice" />
            </div>
          ) : (
            <div className="grid grid-2">
              {templates.length ? (
                <Field label="Start from your template library" name="templateId" state={state} hint="Leave as the built-in template, or pick one saved from an earlier survey">
                  <SelectInput name="templateId" state={state} placeholder="Built-in template" options={templates} />
                </Field>
              ) : null}
              <Field label="Remind non-respondents every" name="reminderEveryDays" state={state} hint="Days; leave blank for no automatic reminders">
                <TextInput name="reminderEveryDays" type="number" min={1} max={30} state={state} />
              </Field>
              <CheckboxInput name="onSignIn" label="Ask the first question on the dashboard at sign-in" hint="A one-tap pulse card on Home for everyone invited." />
              <CheckboxInput name="randomize" label="Randomise question order per person" hint="Follow-up questions stay right after the question they depend on." />
              <CheckboxInput name="isAnonymous" label="Anonymous responses" defaultChecked hint="Answers are stored without names; only who has responded is tracked." />
              <Field label="Minimum group size for results" name="minGroupSize" state={state} hint="Breakdowns with fewer respondents are hidden">
                <TextInput name="minGroupSize" type="number" min={1} max={20} state={state} defaultValue={3} />
              </Field>
            </div>
          )}
          <Field label="Description" name="description" state={state}><TextArea name="description" state={state} rows={2} placeholder="Why you are asking and what you will do with the answers" /></Field>
          <div className="label">Send to</div>
          <div className="row gap-3 wrap" style={{ marginBottom: 10 }}>
            {departments.map((d) => (
              <label key={d.value} className="row gap-1 text-sm"><input type="checkbox" name="departmentIds" value={d.value} />{d.label}</label>
            ))}
            <span className="text-xs subtle">Leave all unticked to send to everyone.</span>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function AddQuestionForm({ surveyId, drivers, earlier = [] }: { surveyId: string; drivers: string[]; earlier?: Array<{ id: string; label: string; type: string }> }) {
  const [type, setType] = useState("RATING");
  const [parent, setParent] = useState("");
  const parentType = earlier.find((q) => q.id === parent)?.type;
  return (
    <ActionForm action={addQuestionAction} submitLabel="Add question" hidden={{ surveyId }} compact>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Question" name="prompt" state={state} required><TextInput name="prompt" state={state} required /></Field>
            <Field label="Answer type" name="type" state={state}>
              <select name="type" className="select" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="RATING">Agreement, 1–5</option>
                <option value="NPS">Likelihood, 0–10</option>
                <option value="SINGLE_CHOICE">Single choice</option>
                <option value="MULTI_CHOICE">Multiple choice</option>
                <option value="TEXT">Free text</option>
              </select>
            </Field>
            {type === "RATING" ? (
              <Field label="Driver" name="driver" state={state}>
                <SelectInput name="driver" state={state} placeholder="None" options={drivers.map((d) => ({ value: d, label: d }))} />
              </Field>
            ) : <div />}
          </div>
          {type === "SINGLE_CHOICE" || type === "MULTI_CHOICE" ? (
            <Field label="Options, one per line" name="options" state={state}><TextArea name="options" state={state} rows={3} /></Field>
          ) : null}
          {earlier.length ? (
            <div className="grid grid-2">
              <Field label="Only ask when (branching)" name="showIfQuestionId" state={state} hint="Leave blank to ask everyone">
                <select name="showIfQuestionId" className="select" value={parent} onChange={(e) => setParent(e.target.value)}>
                  <option value="">Always ask</option>
                  {earlier.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
                </select>
              </Field>
              {parent ? (
                <Field label={parentType === "SINGLE_CHOICE" || parentType === "MULTI_CHOICE" ? "…was answered with option number(s)" : parentType === "NPS" ? "…was scored (0–10)" : "…was scored (1–5)"} name="showIfValues" state={state} hint="Comma separated, e.g. 1, 2">
                  <TextInput name="showIfValues" state={state} placeholder="1, 2" />
                </Field>
              ) : null}
            </div>
          ) : null}
          <CheckboxInput name="required" label="Required" defaultChecked={type !== "TEXT"} />
        </>
      )}
    </ActionForm>
  );
}

/** Inline editor for a draft question's wording, driver, options and required flag. */
export function EditQuestionForm({ q, drivers }: { q: { id: string; prompt: string; type: string; driver: string | null; options: string[]; required: boolean }; drivers: string[] }) {
  return (
    <details>
      <summary className="text-xs" style={{ cursor: "pointer" }}>Edit</summary>
      <ActionForm action={editQuestionAction} submitLabel="Save question" hidden={{ questionId: q.id }} compact>
        {(state) => (
          <>
            <Field label="Question" name="prompt" state={state} required><TextInput name="prompt" state={state} defaultValue={q.prompt} required /></Field>
            {q.type === "RATING" ? (
              <Field label="Driver" name="driver" state={state}><SelectInput name="driver" state={state} placeholder="None" defaultValue={q.driver ?? ""} options={drivers.map((d) => ({ value: d, label: d }))} /></Field>
            ) : null}
            {q.type === "SINGLE_CHOICE" || q.type === "MULTI_CHOICE" ? (
              <Field label="Options, one per line" name="options" state={state}><TextArea name="options" state={state} rows={3} defaultValue={q.options.join("\n")} /></Field>
            ) : null}
            <CheckboxInput name="required" label="Required" defaultChecked={q.required} />
          </>
        )}
      </ActionForm>
    </details>
  );
}

export function RemoveQuestion({ questionId }: { questionId: string }) {
  const [state, action, pending] = useForm(removeQuestionAction);
  return (
    <form action={action}>
      <input type="hidden" name="questionId" value={questionId} />
      <button className="btn ghost sm" disabled={pending} style={{ color: "var(--danger)" }}>{pending ? "…" : "Remove"}</button>
      {state.message && !state.ok ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

export function SurveyOp({ surveyId, op, label, variant = "default", confirmText }: {
  surveyId: string; op: "launch" | "close" | "delete" | "submit" | "remind" | "archive" | "unarchive"; label: string; variant?: "primary" | "default" | "danger"; confirmText?: string;
}) {
  const [state, action, pending] = useForm(surveyOpAction);
  return (
    <form action={action} onSubmit={(e) => { if (confirmText && !confirm(confirmText)) e.preventDefault(); }} className="stack" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="surveyId" value={surveyId} />
      <input type="hidden" name="op" value={op} />
      <button className={`btn ${variant === "primary" ? "primary" : variant === "danger" ? "danger" : ""}`} disabled={pending}>{pending ? "…" : label}</button>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</div> : null}
    </form>
  );
}

export interface RespondQuestion { id: string; prompt: string; type: string; options: string[]; required: boolean; showIfQuestionId?: string | null; showIfValues?: number[] }

/** The response form: a 1–5 or 0–10 row of buttons, choices, or a text box per question. */
export function RespondForm({ surveyId, questions, anonymous, isPoll }: {
  surveyId: string; questions: RespondQuestion[]; anonymous: boolean; isPoll: boolean;
}) {
  const [state, action, pending] = useForm(submitSurveyAction);
  // Branching: re-evaluate which questions are asked as answers change.
  const [answers, setAnswers] = useState<Map<string, { score: number | null; choices: number[] }>>(new Map());
  const shown = visibleQuestionIds(questions, answers);
  const onChange = (e: FormEvent<HTMLFormElement>) => {
    const fd = new FormData(e.currentTarget);
    const next = new Map<string, { score: number | null; choices: number[] }>();
    for (const q of questions) {
      const vals = fd.getAll(`q_${q.id}`).map(String).filter(Boolean);
      if (q.type === "RATING" || q.type === "NPS") next.set(q.id, { score: vals.length ? Number(vals[0]) : null, choices: [] });
      else if (q.type === "SINGLE_CHOICE" || q.type === "MULTI_CHOICE") next.set(q.id, { score: null, choices: vals.map(Number) });
    }
    setAnswers(next);
  };
  let n = 0;
  if (state.ok) {
    return <div className="callout success"><div><div className="callout-title">{state.message}</div>{isPoll ? "Reload to see how everyone voted." : "You can close this page."}</div></div>;
  }
  return (
    <form action={action} className="stack gap-4" onChange={onChange}>
      <input type="hidden" name="surveyId" value={surveyId} />
      <FormBanner state={state} />
      {!isPoll ? (
        <div className="k-banner info"><span aria-hidden="true">ⓘ</span><div>{anonymous
          ? "This survey is anonymous. Your answers are stored without your name, and results are only shown for groups large enough that nobody can be singled out."
          : "This survey is not anonymous — your name will be visible with your answers."}</div></div>
      ) : null}
      {questions.map((q) => {
        const key = `q_${q.id}`;
        const error = state.errors?.[key];
        if (!shown.has(q.id)) return null;
        n++;
        return (
          <fieldset key={q.id} className="survey-q" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 14, borderColor: error ? "var(--danger)" : undefined }}>
            <legend className="strong text-sm" style={{ padding: "0 4px" }}>
              {isPoll ? "" : `${n}. `}{q.prompt}{q.required ? <span style={{ color: "var(--danger)" }}> *</span> : null}
            </legend>
            {q.type === "RATING" ? (
              <div className="row gap-2 wrap" role="radiogroup" style={{ alignItems: "flex-start" }}>
                {["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"].map((l, v) => (
                  <label key={v} className="scale-opt"><input type="radio" name={key} value={v + 1} /><span>{v + 1}</span><small>{l}</small></label>
                ))}
              </div>
            ) : q.type === "NPS" ? (
              <>
                <div className="row gap-1 wrap" role="radiogroup">
                  {Array.from({ length: 11 }, (_, v) => (
                    <label key={v} className="scale-opt nps"><input type="radio" name={key} value={v} /><span>{v}</span></label>
                  ))}
                </div>
                <div className="row text-xs subtle" style={{ justifyContent: "space-between", maxWidth: 540, marginTop: 4 }}><span>Not at all likely</span><span>Extremely likely</span></div>
              </>
            ) : q.type === "SINGLE_CHOICE" || q.type === "MULTI_CHOICE" ? (
              <div className="stack gap-1">
                {q.options.map((o, oi) => (
                  <label key={oi} className="row gap-2 text-sm"><input type={q.type === "SINGLE_CHOICE" ? "radio" : "checkbox"} name={key} value={oi} />{o}</label>
                ))}
              </div>
            ) : (
              <textarea name={key} className="textarea" rows={3} maxLength={2000} />
            )}
            {error ? <div className="text-xs neg" style={{ marginTop: 6 }}>{error}</div> : null}
          </fieldset>
        );
      })}
      <div><button className="btn primary" disabled={pending}>{pending ? "Submitting…" : isPoll ? "Vote" : "Submit response"}</button></div>
    </form>
  );
}
