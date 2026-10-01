"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, Field, TextInput, SelectInput, TextArea, FormBanner } from "@/components/form";
import {
  scheduleOneOnOneAction, busySlotsAction, saveAgendaTemplateAction, deleteAgendaTemplateAction, generateAgendaAction,
  saveAgendaAction, addTalkingPointAction, toggleTalkingPointAction, saveSharedNotesAction, savePrivateNoteAction,
  addOneOnOneActionItemAction, toggleOneOnOneActionItemAction, completeOneOnOneAction, cancelOneOnOneAction,
  summariseOneOnOneAction, saveOneOnOneSummaryAction, addSuggestedActionAction,
} from "@/app/actions/performance-one-on-ones";

type Opt = { value: string; label: string };
const today = () => new Date().toISOString().slice(0, 10);

export function ScheduleOneOnOne({ people, rooms, templates, ai }: { people: Opt[]; rooms: Opt[]; templates: Array<{ id: string; name: string; items: string; purpose: string | null }>; ai: boolean }) {
  const [state, formAction, pending] = useForm(scheduleOneOnOneAction);
  const router = useRouter();
  const [employeeId, setEmployeeId] = useState(state.values?.employeeId ?? "");
  const [date, setDate] = useState(state.values?.date ?? today());
  const [purpose, setPurpose] = useState(state.values?.purpose ?? "");
  const [agenda, setAgenda] = useState(state.values?.agenda ?? "");
  const [recurrence, setRecurrence] = useState(state.values?.recurrence ?? "NONE");
  const [location, setLocation] = useState(state.values?.location ?? "VIRTUAL");
  const [note, setNote] = useState<string | null>(null);
  const [slots, setSlots] = useState<Array<{ who: string; from: string; to: string; label: string }> | null>(null);
  const [busy, start] = useTransition();
  if (state.ok && "meetingId" in state && state.meetingId) {
    return <div className="callout success"><div>{state.message} <button type="button" className="btn sm" onClick={() => router.push(`/performance/one-on-ones/${(state as { meetingId: string }).meetingId}`)}>Open it</button></div></div>;
  }
  return (
    <form action={formAction} className="stack gap-3">
      <FormBanner state={state} />
      <div className="grid grid-3">
        <Field label="With" name="employeeId" state={state} required>
          <select id="employeeId" name="employeeId" className="select" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
            <option value="">Choose…</option>
            {people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </Field>
        <Field label="Title" name="title" state={state} required><TextInput name="title" state={state} defaultValue="Weekly 1:1" required maxLength={160} /></Field>
        <Field label="Repeats" name="recurrence" state={state}>
          <select id="recurrence" name="recurrence" className="select" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            <option value="NONE">Does not repeat</option><option value="WEEKLY">Weekly</option><option value="BIWEEKLY">Every two weeks</option><option value="MONTHLY">Monthly</option>
          </select>
        </Field>
        <Field label="Date" name="date" state={state} required><input id="date" name="date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <Field label="Starts (UTC)" name="startTime" state={state} required><TextInput name="startTime" type="time" state={state} defaultValue="10:00" required /></Field>
        <Field label="Ends (UTC)" name="endTime" state={state} required><TextInput name="endTime" type="time" state={state} defaultValue="10:30" required /></Field>
        <Field label="Where" name="location" state={state}>
          <select id="location" name="location" className="select" value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="VIRTUAL">Video call</option><option value="ROOM">Meeting room</option>
          </select>
        </Field>
        {location === "VIRTUAL"
          ? <Field label="Call link" name="meetingUrl" state={state} required><TextInput name="meetingUrl" state={state} placeholder="https://" required /></Field>
          : <Field label="Room" name="roomId" state={state}><SelectInput name="roomId" state={state} options={rooms} placeholder="No room" /></Field>}
        <Field label="Purpose" name="purpose" state={state} hint="Career, feedback, weekly check-in…"><input id="purpose" name="purpose" className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={120} /></Field>
      </div>
      <div className="row gap-2 wrap">
        <button type="button" className="btn ghost sm" disabled={!employeeId || busy} onClick={() => start(async () => { const r = await busySlotsAction({ employeeId, date }); setSlots(r.ok ? r.slots ?? [] : null); setNote(r.ok ? null : r.message ?? null); })}>Check availability</button>
        {templates.length ? (
          <select className="select" style={{ width: 220 }} defaultValue="" aria-label="Agenda template" onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) { setAgenda(t.items); if (!purpose && t.purpose) setPurpose(t.purpose); } }} name="templateId">
            <option value="">Start from a template…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        ) : null}
        {ai ? <button type="button" className="btn ghost sm" disabled={!employeeId || !purpose || busy} onClick={() => start(async () => { const r = await generateAgendaAction({ purpose, employeeId, recurrence }); if (r.ok && r.items) setAgenda(r.items.join("\n")); setNote(r.ok ? "Draft agenda added. Edit it before you schedule." : r.message ?? null); })}>Draft agenda with AI</button> : null}
        {note ? <span className="text-xs muted">{note}</span> : null}
      </div>
      {slots ? (
        <div className="text-sm">
          {slots.length === 0 ? <span className="pos">Both of you are free all day.</span> : <><span className="subtle">Busy on {date}:</span> {slots.map((s, i) => <span key={i} className="badge neutral" style={{ marginLeft: 6 }}>{s.who}: {s.from}{s.to ? `–${s.to}` : ""} {s.label}</span>)}</>}
        </div>
      ) : null}
      <Field label="Agenda" name="agenda" state={state} hint="One item per line">
        <textarea id="agenda" name="agenda" className="textarea" rows={5} value={agenda} onChange={(e) => setAgenda(e.target.value)} maxLength={4000} />
      </Field>
      <div className="row gap-2">
        <button className="btn primary" disabled={pending}>{pending ? "Scheduling…" : "Schedule 1:1"}</button>
        {agenda.trim() ? <SaveTemplate agenda={agenda} purpose={purpose} /> : null}
      </div>
    </form>
  );
}

function SaveTemplate({ agenda, purpose }: { agenda: string; purpose: string }) {
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  return (
    <span className="row gap-1">
      <input className="input sm" style={{ width: 180 }} placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Template name" />
      <button type="button" className="btn ghost sm" disabled={!name.trim() || busy} onClick={() => start(async () => { const r = await saveAgendaTemplateAction({ name, purpose, items: agenda }); setMsg(r.message); })}>Save agenda as template</button>
      {msg ? <span className="text-xs muted">{msg}</span> : null}
    </span>
  );
}

export function DeleteTemplate({ id }: { id: string }) {
  const [state, formAction, pending] = useForm(deleteAgendaTemplateAction);
  return (
    <form action={formAction} className="row gap-1">
      <input type="hidden" name="id" value={id} />
      <button className="btn ghost sm" disabled={pending}>Delete</button>
      {state.message && !state.ok ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function AgendaEditor({ meetingId, agenda, purpose }: { meetingId: string; agenda: string; purpose: string }) {
  const [state, formAction, pending] = useForm(saveAgendaAction);
  return (
    <form action={formAction} className="stack gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <input className="input" name="purpose" defaultValue={purpose} placeholder="Purpose" aria-label="Purpose" maxLength={120} />
      <TextArea name="agenda" defaultValue={agenda} rows={5} placeholder="One item per line" />
      <div className="row gap-2"><button className="btn sm" disabled={pending}>Save agenda</button>{state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}</div>
    </form>
  );
}

export function AddTalkingPoint({ meetingId }: { meetingId: string }) {
  const [state, formAction, pending] = useForm(addTalkingPointAction);
  return (
    <form action={formAction} className="row gap-2" key={state.ok ? state.message : "form"}>
      <input type="hidden" name="meetingId" value={meetingId} />
      <input className="input" name="text" placeholder="Something to talk about" maxLength={300} aria-label="Talking point" />
      <button className="btn sm" disabled={pending}>Add</button>
      {state.message && !state.ok ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function TalkingPointToggle({ id, done, mine }: { id: string; done: boolean; mine: boolean }) {
  const [, formAction, pending] = useForm(toggleTalkingPointAction);
  return (
    <form action={formAction} className="row gap-1">
      <input type="hidden" name="id" value={id} />
      <button className="btn ghost sm" name="op" value="toggle" disabled={pending}>{done ? "Reopen" : "Discussed"}</button>
      {mine ? <button className="btn ghost sm" name="op" value="delete" disabled={pending} title="Remove">×</button> : null}
    </form>
  );
}

export function NotesEditor({ meetingId, value, kind }: { meetingId: string; value: string; kind: "shared" | "private" }) {
  const [state, formAction, pending] = useForm(kind === "shared" ? saveSharedNotesAction : savePrivateNoteAction);
  return (
    <form action={formAction} className="stack gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <TextArea name={kind === "shared" ? "minutes" : "body"} defaultValue={value} rows={kind === "shared" ? 8 : 5} placeholder={kind === "shared" ? "Notes both of you can see" : "Only you can see this"} />
      <div className="row gap-2"><button className="btn sm" disabled={pending}>Save</button>{state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}</div>
    </form>
  );
}

export function AddActionItem({ meetingId, people }: { meetingId: string; people: Opt[] }) {
  const [state, formAction, pending] = useForm(addOneOnOneActionItemAction);
  return (
    <form action={formAction} className="row gap-2 wrap" key={state.ok ? state.message : "form"}>
      <input type="hidden" name="meetingId" value={meetingId} />
      <input className="input" name="description" placeholder="Action item" maxLength={300} aria-label="Action item" style={{ flex: "1 1 220px" }} />
      <select className="select" name="ownerId" aria-label="Owner" style={{ width: 160 }}>{people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
      <input className="input" type="date" name="dueDate" aria-label="Due" style={{ width: 150 }} />
      <button className="btn sm" disabled={pending}>Add</button>
      {state.message && !state.ok ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function ActionItemToggle({ id, done, viewing }: { id: string; done: boolean; viewing?: string }) {
  const [, formAction, pending] = useForm(toggleOneOnOneActionItemAction);
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      {viewing ? <input type="hidden" name="viewing" value={viewing} /> : null}
      <button className="btn ghost sm" disabled={pending}>{done ? "Reopen" : "Done"}</button>
    </form>
  );
}

export function MeetingOps({ meetingId, canComplete, canCancel, series }: { meetingId: string; canComplete: boolean; canCancel: boolean; series: boolean }) {
  const [cState, complete, completing] = useForm(completeOneOnOneAction);
  const [xState, cancel, cancelling] = useForm(cancelOneOnOneAction);
  const msg = cState.message || xState.message;
  return (
    <div className="row gap-2 wrap">
      {canComplete ? <form action={complete}><input type="hidden" name="meetingId" value={meetingId} /><button className="btn primary sm" disabled={completing}>Mark completed</button></form> : null}
      {canCancel ? (
        <form action={cancel} className="row gap-1">
          <input type="hidden" name="meetingId" value={meetingId} />
          <button className="btn ghost sm" name="scope" value="one" disabled={cancelling}>Cancel this meeting</button>
          {series ? <button className="btn ghost sm" name="scope" value="series" disabled={cancelling}>Cancel the rest of the series</button> : null}
        </form>
      ) : null}
      {msg ? <span className={`text-xs ${cState.ok || xState.ok ? "pos" : "neg"}`}>{msg}</span> : null}
    </div>
  );
}

type Summary = { summary: string; decisions: string[]; actionItems: Array<{ description: string; owner: "MANAGER" | "REPORT"; dueInDays: number | null }> };

export function AiSummary({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const [s, setS] = useState<Summary | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [added, setAdded] = useState<number[]>([]);
  const [busy, start] = useTransition();
  return (
    <div className="stack gap-2">
      <div className="row gap-2">
        <button type="button" className="btn sm" disabled={busy} onClick={() => start(async () => { const r = await summariseOneOnOneAction({ meetingId }); setS(r.ok ? r.summary ?? null : null); setMsg(r.ok ? null : r.message ?? null); })}>{busy ? "Working…" : "Summarise with AI"}</button>
        {msg ? <span className="text-xs muted">{msg}</span> : null}
      </div>
      {s ? (
        <div className="stack gap-2 text-sm">
          <p style={{ margin: 0 }}>{s.summary}</p>
          {s.decisions.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{s.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
          {s.actionItems.map((a, i) => (
            <div key={i} className="row gap-2">
              <span>{a.description} <span className="subtle">({a.owner === "MANAGER" ? "manager" : "report"}{a.dueInDays ? `, ${a.dueInDays} days` : ""})</span></span>
              <button type="button" className="btn ghost sm" disabled={added.includes(i) || busy} onClick={() => start(async () => { const r = await addSuggestedActionAction({ meetingId, ...a }); if (r.ok) { setAdded([...added, i]); router.refresh(); } setMsg(r.message); })}>{added.includes(i) ? "Added" : "Add"}</button>
            </div>
          ))}
          <div><button type="button" className="btn primary sm" disabled={busy} onClick={() => start(async () => { const r = await saveOneOnOneSummaryAction({ meetingId, summary: s }); setMsg(r.message); if (r.ok) router.refresh(); })}>Save summary to the meeting</button></div>
        </div>
      ) : null}
    </div>
  );
}
