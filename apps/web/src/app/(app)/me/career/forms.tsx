"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, useForm } from "@/components/form";
import {
  createSkillAction, addMySkillAction, removeMySkillAction, rateSkillAction, rejectSkillAction,
  createPathAction, addStepAction, setStepSkillAction, removeStepSkillAction, setAspirationAction,
} from "@/app/actions/career";

export interface Option { value: string; label: string }
export interface SkillOption { id: string; name: string; levels: string[] }

function Tiny({ action, hidden, label, danger }: { action: Parameters<typeof useForm>[0]; hidden: Record<string, string>; label: string; danger?: boolean }) {
  const [state, act, pending] = useForm(action);
  return (
    <form action={act}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className="btn ghost sm" disabled={pending} style={danger ? { color: "var(--danger)" } : undefined}>{pending ? "…" : label}</button>
      {state.message && !state.ok ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

/** Pick a skill, then one of its own named levels. */
function SkillLevelPicker({ skills, name = "skillId", levelName = "level" }: { skills: SkillOption[]; name?: string; levelName?: string }) {
  const [id, setId] = useState(skills[0]?.id ?? "");
  const levels = skills.find((s) => s.id === id)?.levels ?? [];
  return (
    <>
      <select name={name} className="select" value={id} onChange={(e) => setId(e.target.value)} aria-label="Skill" style={{ width: "auto", minWidth: 200 }}>
        {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <select name={levelName} className="select" aria-label="Level" key={id} defaultValue="1" style={{ width: "auto", minWidth: 170 }}>
        {levels.map((l, i) => <option key={l} value={i}>{l}</option>)}
      </select>
    </>
  );
}

export function AddMySkill({ skills }: { skills: SkillOption[] }) {
  const [state, act, pending] = useForm(addMySkillAction);
  if (skills.length === 0) return <div className="text-sm subtle">You have every skill in the catalogue on your profile.</div>;
  return (
    <form action={act} className="stack gap-1">
      <div className="row gap-2 wrap"><SkillLevelPicker skills={skills} /><button className="btn primary sm" disabled={pending}>{pending ? "…" : "Add skill"}</button></div>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</div> : null}
    </form>
  );
}

export const RemoveMySkill = ({ id }: { id: string }) => <Tiny action={removeMySkillAction} hidden={{ id }} label="Remove" danger />;
export const RejectSkill = ({ id }: { id: string }) => <Tiny action={rejectSkillAction} hidden={{ id }} label="Decline" danger />;
export const RemoveStepSkill = ({ id }: { id: string }) => <Tiny action={removeStepSkillAction} hidden={{ id }} label="×" danger />;

/** A manager's level picker for one person and skill; saving approves it. */
export function RateSkill({ employeeId, skillId, levels, current, label = "Confirm" }: { employeeId: string; skillId: string; levels: string[]; current: number | null; label?: string }) {
  const [state, act, pending] = useForm(rateSkillAction);
  return (
    <form action={act} className="row gap-1">
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="skillId" value={skillId} />
      <select name="level" className="select" defaultValue={current ?? 0} aria-label="Level" style={{ padding: "3px 6px", fontSize: 12 }}>
        {levels.map((l, i) => <option key={l} value={i}>{l}</option>)}
      </select>
      <button className="btn sm" disabled={pending}>{pending ? "…" : label}</button>
      {state.message && !state.ok ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function AspirationForm({ steps, current }: { steps: Option[]; current: string | null }) {
  const [state, act, pending] = useForm(setAspirationAction);
  return (
    <form action={act} className="stack gap-1">
      <div className="row gap-2 wrap">
        <select name="stepId" className="select" defaultValue={current ?? ""} aria-label="Target role" style={{ minWidth: 260 }}>
          <option value="">No target role</option>
          {steps.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button className="btn primary sm" disabled={pending}>{pending ? "…" : "Save"}</button>
      </div>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</div> : null}
    </form>
  );
}

export function SkillForm() {
  return (
    <ActionForm action={createSkillAction} submitLabel="Add skill" compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Skill" name="name" state={state} required><TextInput name="name" state={state} required placeholder="TypeScript" /></Field>
          <Field label="Category" name="category" state={state}><TextInput name="category" state={state} placeholder="Engineering" /></Field>
          <Field label="Levels, comma separated" name="levels" state={state} hint="Blank for Beginner, Working knowledge, Proficient, Expert"><TextInput name="levels" state={state} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function PathForm({ departments }: { departments: Option[] }) {
  return (
    <ActionForm action={createPathAction} submitLabel="Create path" compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Path" name="name" state={state} required><TextInput name="name" state={state} required placeholder="Software engineering" /></Field>
          <Field label="Department" name="departmentId" state={state}><SelectInput name="departmentId" state={state} options={departments} placeholder="Any" /></Field>
          <Field label="Description" name="description" state={state}><TextArea name="description" state={state} rows={1} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function StepForm({ pathId }: { pathId: string }) {
  return (
    <ActionForm action={addStepAction} submitLabel="Add step" hidden={{ pathId }} compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Role" name="title" state={state} required hint="Matched to job titles to place people"><TextInput name="title" state={state} required /></Field>
          <Field label="Typical years of experience" name="minYears" state={state}><TextInput name="minYears" type="number" min={0} state={state} defaultValue={0} /></Field>
          <Field label="What changes at this level" name="description" state={state}><TextInput name="description" state={state} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function StepSkillForm({ stepId, skills }: { stepId: string; skills: SkillOption[] }) {
  const [state, act, pending] = useForm(setStepSkillAction);
  return (
    <form action={act} className="stack gap-1">
      <input type="hidden" name="stepId" value={stepId} />
      <div className="row gap-2 wrap"><SkillLevelPicker skills={skills} /><button className="btn sm" disabled={pending}>{pending ? "…" : "Require"}</button></div>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</div> : null}
    </form>
  );
}
