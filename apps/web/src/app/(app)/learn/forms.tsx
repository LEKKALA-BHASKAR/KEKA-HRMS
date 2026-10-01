"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, useForm } from "@/components/form";
import {
  saveCourseAction, addLessonAction, removeLessonAction, addQuizQuestionAction, courseOpAction,
  assignCourseAction, enrolSelfAction, completeLessonAction, submitQuizAction, removeEnrolmentAction,
} from "@/app/actions/learning";

export interface Option { value: string; label: string }

export function CourseForm({ skills, course }: {
  skills: Option[];
  course?: { id: string; title: string; summary: string | null; category: string; level: string; isMandatory: boolean; dueInDays: number | null; passPercent: number; skillId: string | null; skillLevel: number; coverColour: string | null };
}) {
  return (
    <ActionForm action={saveCourseAction} submitLabel={course ? "Save course" : "Create course"} hidden={course ? { id: course.id } : undefined}>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Title" name="title" state={state} required><TextInput name="title" state={state} required defaultValue={course?.title} placeholder="Information security essentials" /></Field>
            <Field label="Category" name="category" state={state} required><TextInput name="category" state={state} required defaultValue={course?.category} placeholder="Compliance" /></Field>
            <Field label="Level" name="level" state={state}>
              <SelectInput name="level" state={state} defaultValue={course?.level ?? "BEGINNER"} options={[{ value: "BEGINNER", label: "Beginner" }, { value: "INTERMEDIATE", label: "Intermediate" }, { value: "ADVANCED", label: "Advanced" }]} />
            </Field>
            <Field label="Days to complete once assigned" name="dueInDays" state={state} hint="Leave blank for no deadline"><TextInput name="dueInDays" type="number" min={1} state={state} defaultValue={course?.dueInDays} /></Field>
            <Field label="Quiz pass mark (%)" name="passPercent" state={state}><TextInput name="passPercent" type="number" min={0} max={100} state={state} defaultValue={course?.passPercent ?? 70} /></Field>
            <Field label="Card colour" name="coverColour" state={state}><TextInput name="coverColour" type="color" state={state} defaultValue={course?.coverColour ?? "#3b6fe0"} /></Field>
            <Field label="Skill earned on completion" name="skillId" state={state}><SelectInput name="skillId" state={state} placeholder="None" options={skills} defaultValue={course?.skillId} /></Field>
            <Field label="…at level" name="skillLevel" state={state} hint="0 is the first level of the skill"><TextInput name="skillLevel" type="number" min={0} max={10} state={state} defaultValue={course?.skillLevel ?? 1} /></Field>
          </div>
          <Field label="Summary" name="summary" state={state}><TextArea name="summary" state={state} rows={2} defaultValue={course?.summary} /></Field>
          <CheckboxInput name="isMandatory" label="Mandatory for everyone" defaultChecked={course?.isMandatory} hint="Assigned to every active employee on publish, and to new joiners automatically" />
        </>
      )}
    </ActionForm>
  );
}

export function LessonForm({ courseId }: { courseId: string }) {
  const [kind, setKind] = useState("ARTICLE");
  return (
    <ActionForm action={addLessonAction} submitLabel="Add lesson" hidden={{ courseId }} compact>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Lesson title" name="title" state={state} required><TextInput name="title" state={state} required /></Field>
            <Field label="Type" name="kind" state={state}>
              <select name="kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="ARTICLE">Article</option><option value="VIDEO">Video</option><option value="DOCUMENT">Document</option><option value="QUIZ">Quiz</option>
              </select>
            </Field>
            <Field label="Minutes" name="durationMinutes" state={state}><TextInput name="durationMinutes" type="number" min={1} state={state} defaultValue={kind === "QUIZ" ? 10 : 5} /></Field>
          </div>
          {kind === "VIDEO" || kind === "DOCUMENT" ? (
            <Field label={kind === "VIDEO" ? "Video link (YouTube links play in place)" : "Document link"} name="url" state={state} required><TextInput name="url" state={state} placeholder="https://" /></Field>
          ) : null}
          {kind !== "QUIZ" ? (
            <Field label={kind === "ARTICLE" ? "Text" : "Notes"} name="body" state={state} required={kind === "ARTICLE"} hint="Blank lines start a new paragraph"><TextArea name="body" state={state} rows={kind === "ARTICLE" ? 8 : 3} /></Field>
          ) : <div className="hint" style={{ marginBottom: 8 }}>Add the quiz questions after creating the lesson.</div>}
        </>
      )}
    </ActionForm>
  );
}

export function QuizQuestionForm({ lessonId }: { lessonId: string }) {
  return (
    <ActionForm action={addQuizQuestionAction} submitLabel="Add question" hidden={{ lessonId }} compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Question" name="prompt" state={state} required><TextInput name="prompt" state={state} required /></Field>
          <Field label="Options, one per line" name="options" state={state} required><TextArea name="options" state={state} rows={3} /></Field>
          <Field label="Correct option number" name="correct" state={state} required><TextInput name="correct" type="number" min={1} max={10} state={state} defaultValue={1} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

function SmallAction({ action, hidden, label, variant = "default", confirmText }: {
  action: Parameters<typeof useForm>[0]; hidden: Record<string, string>; label: string; variant?: "primary" | "default" | "danger" | "ghost"; confirmText?: string;
}) {
  const [state, act, pending] = useForm(action);
  return (
    <form action={act} onSubmit={(e) => { if (confirmText && !confirm(confirmText)) e.preventDefault(); }}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={`btn sm ${variant === "default" ? "" : variant}`} disabled={pending} style={variant === "ghost" ? { color: "var(--danger)" } : undefined}>{pending ? "…" : label}</button>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ marginTop: 4 }}>{state.message}</div> : null}
    </form>
  );
}

export const RemoveLesson = ({ lessonId }: { lessonId: string }) => <SmallAction action={removeLessonAction} hidden={{ lessonId }} label="Remove" variant="ghost" confirmText="Remove this lesson?" />;
export const CourseOp = ({ courseId, op, label, primary }: { courseId: string; op: "publish" | "archive"; label: string; primary?: boolean }) =>
  <SmallAction action={courseOpAction} hidden={{ courseId, op }} label={label} variant={primary ? "primary" : "default"} confirmText={op === "archive" ? "Archive this course? Learners will no longer see it in the catalogue." : undefined} />;
export const EnrolSelf = ({ courseId }: { courseId: string }) => <SmallAction action={enrolSelfAction} hidden={{ courseId }} label="Enrol" variant="primary" />;
export const RemoveEnrolment = ({ enrolmentId }: { enrolmentId: string }) => <SmallAction action={removeEnrolmentAction} hidden={{ enrolmentId }} label="Remove" variant="ghost" confirmText="Remove this enrolment and its progress?" />;

export function MarkComplete({ enrolmentId, lessonId }: { enrolmentId: string; lessonId: string }) {
  return <SmallAction action={completeLessonAction} hidden={{ enrolmentId, lessonId }} label="Mark as complete" variant="primary" />;
}

export function AssignForm({ courseId, people }: { courseId: string; people: Option[] }) {
  const [filter, setFilter] = useState("");
  const shown = people.filter((p) => p.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <ActionForm action={assignCourseAction} submitLabel="Assign" hidden={{ courseId }} compact>
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Find people" name="filter"><input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type a name" /></Field>
            <Field label="Due date" name="dueDate" state={state} hint="Defaults to the course's completion window"><TextInput name="dueDate" type="date" state={state} /></Field>
          </div>
          <div className="stack gap-1" style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 10, marginBottom: 6 }}>
            {people.length === 0 ? <span className="text-sm subtle">Everyone in your scope is already enrolled.</span> : null}
            {people.map((p) => (
              <label key={p.value} className="row gap-2 text-sm" style={{ display: shown.includes(p) ? undefined : "none" }}>
                <input type="checkbox" name="employeeIds" value={p.value} />{p.label}
              </label>
            ))}
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function QuizForm({ enrolmentId, lessonId, questions, passPercent }: {
  enrolmentId: string; lessonId: string; passPercent: number;
  questions: Array<{ id: string; prompt: string; options: string[] }>;
}) {
  const [state, action, pending] = useForm(submitQuizAction);
  const marked = state.values ?? {};
  return (
    <form action={action} className="stack gap-3">
      <input type="hidden" name="enrolmentId" value={enrolmentId} />
      <input type="hidden" name="lessonId" value={lessonId} />
      <FormBanner state={state} />
      <div className="text-sm muted">Answer every question. You need {passPercent}% to pass, and you can retry as often as you like.</div>
      {questions.map((q, i) => {
        const mark = marked[`r_${q.id}`];
        return (
          <fieldset key={q.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 12, borderColor: mark === "1" ? "var(--success)" : mark === "0" ? "var(--danger)" : undefined }}>
            <legend className="strong text-sm" style={{ padding: "0 4px" }}>{i + 1}. {q.prompt}{mark ? <span className={mark === "1" ? "pos" : "neg"}> — {mark === "1" ? "correct" : "incorrect"}</span> : null}</legend>
            <div className="stack gap-1">
              {q.options.map((o, oi) => (
                <label key={oi} className="row gap-2 text-sm"><input type="radio" name={`qq_${q.id}`} value={oi} required />{o}</label>
              ))}
            </div>
          </fieldset>
        );
      })}
      <div><button className="btn primary" disabled={pending}>{pending ? "Marking…" : "Submit answers"}</button></div>
    </form>
  );
}
