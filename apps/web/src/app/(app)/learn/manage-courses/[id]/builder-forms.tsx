"use client";

import { useState } from "react";
import { Field, TextInput, TextArea, FormBanner, SubmitButton, useForm } from "@/components/form";
import { saveModuleAction, saveQuestionAction, bulkUploadQuestionsAction, submitAssessmentAction } from "@/app/actions/performance-learn";

/** Add or edit a module; the fields follow its type. */
export function ModuleForm({ courseId, sections, module }: {
  courseId: string; sections: Array<{ value: string; label: string }>;
  module?: { id: string; type: string; title: string; durationMinutes: number; body: string | null; url: string | null; passPercent: number | null; sectionId: string | null };
}) {
  const [state, act, pending] = useForm(saveModuleAction);
  const [type, setType] = useState(module?.type ?? "PAGE");
  return (
    <form action={act} encType="multipart/form-data">
      <input type="hidden" name="courseId" value={courseId} />
      {module ? <input type="hidden" name="moduleId" value={module.id} /> : null}
      <FormBanner state={state} />
      <div className="grid grid-4">
        <Field label="Title" name="title" state={state} required><TextInput name="title" state={state} defaultValue={module?.title} required /></Field>
        <Field label="Type" name="type" state={state}>
          <select className="select" name="type" value={type} onChange={(e) => setType(e.target.value)} disabled={!!module}>
            <option value="PAGE">Page</option><option value="VIDEO">Video</option><option value="DOCUMENT">PDF document</option><option value="ASSESSMENT">Assessment</option>
          </select>
        </Field>
        <Field label="Section" name="sectionId" state={state}>
          <select className="select" name="sectionId" defaultValue={module?.sectionId ?? ""} disabled={!!module}>
            <option value="">No section</option>
            {sections.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Minutes" name="durationMinutes" state={state}><TextInput name="durationMinutes" type="number" min={0} max={1440} state={state} defaultValue={module?.durationMinutes ?? 10} /></Field>
      </div>
      {type === "PAGE" ? <Field label="Content" name="body" state={state}><TextArea name="body" state={state} rows={6} defaultValue={module?.body} /></Field> : null}
      {type === "VIDEO" ? <Field label="Video link (YouTube, Vimeo, Drive, OneDrive or SharePoint)" name="url" state={state} required><TextInput name="url" state={state} defaultValue={module?.url} placeholder="https://" /></Field> : null}
      {type === "DOCUMENT" ? <Field label="PDF" name="file" state={state} hint={module ? "Leave empty to keep the current file" : undefined}><input className="input" type="file" name="file" accept="application/pdf" /></Field> : null}
      {type === "ASSESSMENT" ? <Field label="Pass mark (%)" name="passPercent" state={state}><TextInput name="passPercent" type="number" min={1} max={100} state={state} defaultValue={module?.passPercent ?? 70} /></Field> : null}
      <SubmitButton pending={pending} size="sm">{module ? "Save module" : "Add module"}</SubmitButton>
    </form>
  );
}

/** One question: options typed one per line, the correct ones ticked. */
export function QuestionForm({ moduleId, question }: {
  moduleId: string;
  question?: { id: string; type: string; prompt: string; options: Array<{ id: string; text: string }>; correct: string[] };
}) {
  const [state, act, pending] = useForm(saveQuestionAction);
  const [type, setType] = useState(question?.type ?? "SINGLE_CHOICE");
  const [lines, setLines] = useState<string[]>(question?.options.map((o) => o.text) ?? (type === "TRUE_FALSE" ? ["True", "False"] : ["", "", "", ""]));
  const [correct, setCorrect] = useState<number[]>(question ? question.options.map((o, i) => (question.correct.includes(o.id) ? i : -1)).filter((i) => i >= 0) : [0]);
  const options = lines.map((text, i) => ({ id: `o${i + 1}`, text: text.trim() })).filter((o) => o.text);
  const correctIds = correct.filter((i) => lines[i]?.trim()).map((i) => `o${i + 1}`);
  const multi = type === "MULTIPLE_CHOICE";
  return (
    <form action={act}>
      <input type="hidden" name="moduleId" value={moduleId} />
      {question ? <input type="hidden" name="questionId" value={question.id} /> : null}
      <input type="hidden" name="options" value={JSON.stringify(options)} />
      <input type="hidden" name="correct" value={JSON.stringify(correctIds)} />
      <FormBanner state={state} />
      <div className="grid grid-3">
        <div style={{ gridColumn: "span 2" }}><Field label="Question" name="prompt" state={state} required><TextInput name="prompt" state={state} defaultValue={question?.prompt} required /></Field></div>
        <Field label="Type" name="type" state={state}>
          <select className="select" name="type" value={type} onChange={(e) => { setType(e.target.value); if (e.target.value === "TRUE_FALSE") { setLines(["True", "False"]); setCorrect([0]); } }}>
            <option value="SINGLE_CHOICE">Single choice</option><option value="MULTIPLE_CHOICE">Multiple choice</option><option value="TRUE_FALSE">True / false</option>
          </select>
        </Field>
      </div>
      <div className="stack gap-1" style={{ marginBottom: 8 }}>
        {lines.map((l, i) => (
          <label key={i} className="row gap-2 text-sm">
            <input type={multi ? "checkbox" : "radio"} name={`c_${moduleId}_${question?.id ?? "new"}`} checked={correct.includes(i)} onChange={() => setCorrect(multi ? (correct.includes(i) ? correct.filter((x) => x !== i) : [...correct, i]) : [i])} aria-label="Correct" />
            <input className="input" value={l} onChange={(e) => setLines(lines.map((x, k) => (k === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} disabled={type === "TRUE_FALSE"} />
          </label>
        ))}
        {type !== "TRUE_FALSE" && lines.length < 6 ? <button type="button" className="btn sm ghost" onClick={() => setLines([...lines, ""])}>+ Option</button> : null}
      </div>
      <SubmitButton pending={pending} size="sm">{question ? "Save question" : "Add question"}</SubmitButton>
    </form>
  );
}

export function BulkQuestions({ moduleId }: { moduleId: string }) {
  const [state, act, pending] = useForm(bulkUploadQuestionsAction);
  return (
    <form action={act} encType="multipart/form-data" className="row gap-2 wrap">
      <input type="hidden" name="moduleId" value={moduleId} />
      <input className="input" type="file" name="file" accept=".csv,text/csv" style={{ maxWidth: 260 }} />
      <SubmitButton pending={pending} size="sm" variant="default">Upload CSV</SubmitButton>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

/** The learner's side of an assessment module. */
export function TakeAssessment({ moduleId, passPercent, questions }: {
  moduleId: string; passPercent: number;
  questions: Array<{ id: string; type: string; prompt: string; options: Array<{ id: string; text: string }> }>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form className="stack gap-3" onSubmit={async (e) => {
      e.preventDefault();
      setPending(true);
      try { setResult(await submitAssessmentAction({ moduleId, answers })); } finally { setPending(false); }
    }}>
      {result ? <div className={`callout ${result.ok ? "success" : "danger"}`}>{result.message}</div> : null}
      <div className="text-sm muted">You need {passPercent}% to pass.</div>
      {questions.map((q, i) => (
        <fieldset key={q.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 12 }}>
          <legend className="strong text-sm" style={{ padding: "0 4px" }}>{i + 1}. {q.prompt}</legend>
          <div className="stack gap-1">
            {q.options.map((o) => (
              <label key={o.id} className="row gap-2 text-sm">
                <input type={q.type === "MULTIPLE_CHOICE" ? "checkbox" : "radio"} name={`a_${q.id}`} checked={(answers[q.id] ?? []).includes(o.id)}
                  onChange={() => setAnswers({ ...answers, [q.id]: q.type === "MULTIPLE_CHOICE" ? ((answers[q.id] ?? []).includes(o.id) ? (answers[q.id] ?? []).filter((x) => x !== o.id) : [...(answers[q.id] ?? []), o.id]) : [o.id] })} />
                {o.text}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div><button className="btn primary" disabled={pending}>{pending ? "Marking…" : "Submit answers"}</button></div>
    </form>
  );
}
