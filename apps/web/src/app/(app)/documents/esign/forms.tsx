"use client";

import { useState } from "react";
import { useForm, Field, TextInput, CheckboxInput } from "@/components/form";
import { SignaturePad } from "../letters/forms";
import { signEnvelopeAction, createEnvelopeAction } from "@/app/actions/doc-ops";

/** Sign (or approve) an envelope: drawn signature, typed name, consent. */
export function SignEnvelope({ id, name, role }: { id: string; name: string; role: string }) {
  const [state, formAction, pending] = useForm(signEnvelopeAction);
  const [sig, setSig] = useState("");
  if (state.ok) return <span className="text-sm pos">{state.message}</span>;
  const approver = role === "APPROVER";
  return (
    <form action={formAction} className="stack gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="signature" value={sig} />
      {!approver ? <Field label="Draw your signature" name="signature" required><SignaturePad onChange={setSig} /></Field> : null}
      {!approver ? (
        <Field label="Type your full name" name="typedName" required hint={`As it appears on the envelope: ${name}`}>
          <TextInput name="typedName" state={state} required />
        </Field>
      ) : null}
      <CheckboxInput name="consent" label={approver ? "I approve this document." : "I agree to sign electronically, and that my electronic signature is as valid as one on paper."} />
      <div className="row gap-2">
        <button className="btn primary" disabled={pending || (!approver && !sig)}>{approver ? "Approve" : "Sign"}</button>
        {state.message ? <span className="text-xs neg">{state.message}</span> : null}
      </div>
    </form>
  );
}

interface Opt { value: string; label: string }
interface Row { userId: string; role: string; order: number }

/** New envelope: a PDF (or a generated letter) and an ordered list of recipients. */
export function NewEnvelope({ users, letters }: { users: Opt[]; letters: Opt[] }) {
  const [state, formAction, pending] = useForm(createEnvelopeAction);
  const [rows, setRows] = useState<Row[]>([{ userId: "", role: "SIGNER", order: 1 }]);
  const [source, setSource] = useState<"file" | "letter">("file");
  const set = (i: number, p: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <form action={formAction} className="stack gap-3">
      {state.message ? <div className={`callout ${state.ok ? "success" : "danger"}`}><div>{state.message}{state.ok && state.values?.id ? <> · <a href={`/documents/esign/${state.values.id}`}>Open the envelope</a></> : null}</div></div> : null}
      <div className="grid grid-2">
        <div className="field"><label className="label" htmlFor="es-title">Title *</label><input id="es-title" className="input" name="title" required placeholder="e.g. Employment contract — Meera Krishnan" /></div>
        <div className="field"><label className="label">Document</label>
          <div className="row gap-2">
            <label className="row gap-1 text-sm"><input type="radio" checked={source === "file"} onChange={() => setSource("file")} /> Upload a PDF</label>
            <label className="row gap-1 text-sm"><input type="radio" checked={source === "letter"} onChange={() => setSource("letter")} /> A generated letter</label>
          </div>
          {source === "file" ? <input className="input" type="file" name="file" accept="application/pdf" /> : (
            <select className="select" name="letterId" defaultValue=""><option value="">Pick a letter…</option>{letters.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</select>
          )}
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}><label className="label" htmlFor="es-msg">Message to recipients</label><textarea id="es-msg" className="textarea" name="message" rows={2} /></div>
        <div className="field"><label className="label" htmlFor="es-seq">Signing order</label>
          <select id="es-seq" className="select" name="sequential" defaultValue="true"><option value="true">In order (by step number; equal steps sign together)</option><option value="false">Everyone at once</option></select></div>
        <div className="field"><label className="label" htmlFor="es-rem">Remind every (days)</label><input id="es-rem" className="input num" name="reminderEveryDays" defaultValue="3" /></div>
        <div className="field"><label className="label" htmlFor="es-exp">Expires on</label><input id="es-exp" className="input" type="date" name="expiresOn" /></div>
      </div>
      <div className="stack gap-2">
        <strong className="text-sm">Recipients</strong>
        {rows.map((r, i) => (
          <div key={i} className="row gap-2 wrap" style={{ alignItems: "center" }}>
            <input className="input num" name="recipientOrder" value={r.order} onChange={(e) => set(i, { order: Number(e.target.value) || 1 })} style={{ width: 60 }} aria-label="Step" />
            <select className="select" name="recipientUserId" value={r.userId} onChange={(e) => set(i, { userId: e.target.value })} style={{ minWidth: 260 }}>
              <option value="">Pick a person…</option>{users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
            <select className="select" name="recipientRole" value={r.role} onChange={(e) => set(i, { role: e.target.value })}>
              <option value="SIGNER">Signs</option><option value="APPROVER">Approves</option><option value="CC">Gets a copy</option>
            </select>
            <button type="button" className="btn sm ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} disabled={rows.length === 1}>Remove</button>
          </div>
        ))}
        <div><button type="button" className="btn sm" onClick={() => setRows((x) => [...x, { userId: "", role: "SIGNER", order: x.length + 1 }])} disabled={rows.length >= 10}>+ Add recipient</button></div>
      </div>
      <label className="row gap-2 text-sm"><input type="checkbox" name="sendNow" defaultChecked /> Send now (otherwise it is saved as a draft)</label>
      <div><button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Create envelope"}</button></div>
    </form>
  );
}
