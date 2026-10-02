"use client";

import { useEffect, useRef, useState } from "react";
import { useForm, ActionForm, Field, TextInput, SelectInput, CheckboxInput } from "@/components/form";
import {
  generateLetterAction, decideLetterAction, voidLetterAction, acknowledgeLetterAction, signLetterAction, saveLetterTemplateAction,
} from "@/app/actions/letters";

export function GenerateLetter({ templateId, employees }: { templateId: string; employees: { value: string; label: string }[] }) {
  const [state, formAction, pending] = useForm(generateLetterAction);
  return (
    <form action={formAction} className="stack gap-1">
      <div className="row gap-1">
        <input type="hidden" name="templateId" value={templateId} />
        <select className="select" name="employeeId" required style={{ width: 180, padding: "3px 6px", fontSize: 12 }} aria-label="Employee">
          <option value="">For…</option>
          {employees.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
        </select>
        <button className="btn sm" disabled={pending}>Generate</button>
      </div>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

/** Renders letter HTML in a sandbox: no scripts, no access to the page. */
export function LetterFrame({ html, height = 520 }: { html: string; height?: number }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px/1.6 Georgia,serif;color:#1b1b1b;margin:28px 36px;max-width:720px}p{margin:0 0 12px}</style></head><body>${html}</body></html>`;
  return <iframe title="Letter" sandbox="" srcDoc={doc} style={{ width: "100%", height, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />;
}

export function DecideLetter({ id }: { id: string }) {
  const [state, formAction, pending] = useForm(decideLetterAction);
  if (state.ok) return <span className="text-sm pos">{state.message}</span>;
  return (
    <form action={formAction} className="stack gap-2">
      <input type="hidden" name="id" value={id} />
      <input className="input" name="note" placeholder="Note (needed to reject)" aria-label="Note" />
      <div className="row gap-2">
        <button className="btn primary" name="decision" value="approve" disabled={pending}>Approve</button>
        <button className="btn danger" name="decision" value="reject" disabled={pending}>Reject</button>
      </div>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function VoidLetter({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useForm(voidLetterAction);
  if (state.ok) return <span className="text-sm pos">{state.message}</span>;
  if (!open) return <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>Withdraw letter</button>;
  return (
    <form action={formAction} className="row gap-2">
      <input type="hidden" name="id" value={id} />
      <input className="input sm" name="reason" placeholder="Why it is withdrawn" required aria-label="Reason" />
      <button className="btn danger sm" disabled={pending}>Withdraw</button>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function AcknowledgeLetter({ id }: { id: string }) {
  const [state, formAction, pending] = useForm(acknowledgeLetterAction);
  if (state.ok) return <span className="text-sm pos">{state.message}</span>;
  return (
    <form action={formAction} className="row gap-2">
      <input type="hidden" name="id" value={id} />
      <button className="btn primary" disabled={pending}>I have read and acknowledge this letter</button>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

function SignaturePad({ onChange }: { onChange: (dataUrl: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#14213d";
  }, []);
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * e.currentTarget.width, y: ((e.clientY - r.top) / r.height) * e.currentTarget.height };
  };
  const clear = () => {
    const c = ref.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    inked.current = false;
    onChange("");
  };
  return (
    <div className="stack gap-1">
      <canvas
        ref={ref} width={520} height={160} aria-label="Signature pad"
        style={{ width: "100%", maxWidth: 520, height: 160, border: "1px dashed var(--border-strong, #999)", borderRadius: 8, background: "#fff", touchAction: "none", cursor: "crosshair" }}
        onPointerDown={(e) => { drawing.current = true; e.currentTarget.setPointerCapture(e.pointerId); const p = pos(e); const ctx = e.currentTarget.getContext("2d")!; ctx.beginPath(); ctx.moveTo(p.x, p.y); }}
        onPointerMove={(e) => { if (!drawing.current) return; const p = pos(e); const ctx = e.currentTarget.getContext("2d")!; ctx.lineTo(p.x, p.y); ctx.stroke(); inked.current = true; }}
        onPointerUp={(e) => { drawing.current = false; if (inked.current) onChange(e.currentTarget.toDataURL("image/png")); }}
      />
      <div><button type="button" className="btn ghost sm" onClick={clear}>Clear</button></div>
    </div>
  );
}

export function SignLetter({ id, name }: { id: string; name: string }) {
  const [state, formAction, pending] = useForm(signLetterAction);
  const [sig, setSig] = useState("");
  if (state.ok) return <span className="text-sm pos">{state.message}</span>;
  return (
    <form action={formAction} className="stack gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="signature" value={sig} />
      <Field label="Draw your signature" name="signature" required><SignaturePad onChange={setSig} /></Field>
      <Field label="Type your full name" name="typedName" required hint={`As it appears on the letter: ${name}`}>
        <TextInput name="typedName" state={state} required />
      </Field>
      <CheckboxInput name="consent" label="I agree to sign this letter electronically, and that my electronic signature is as valid as one on paper." />
      <div className="row gap-2">
        <button className="btn primary" disabled={pending || !sig}>Sign letter</button>
        {state.message ? <span className="text-xs neg">{state.message}</span> : null}
      </div>
    </form>
  );
}

export function TemplateEditor({
  template, categories, workflows, placeholders, sample,
}: {
  template: { id: string; name: string; category: string; body: string; workflow: string; isArchived: boolean } | null;
  categories: string[]; workflows: Record<string, string>; placeholders: Record<string, string>; sample: Record<string, string> | null;
}) {
  const [body, setBody] = useState(template?.body ?? "<p>Dear {{employee_name}},</p>\n<p></p>\n<p>{{signatory_name}}<br/>{{signatory_designation}}</p>");
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (key: string) => {
    const el = area.current;
    const token = `{{${key}}}`;
    if (!el) return setBody((b) => b + token);
    const [a, b] = [el.selectionStart, el.selectionEnd];
    const next = body.slice(0, a) + token + body.slice(b);
    setBody(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  };
  const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const preview = body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => (sample?.[k] ? esc(sample[k]) : `<mark>[${k.toUpperCase()}]</mark>`));
  return (
    <ActionForm action={saveLetterTemplateAction} submitLabel={template ? "Save template" : "Create template"} hidden={template ? { id: template.id } : undefined}>
      {(state) => (
        <div className="stack gap-4">
          <div className="grid grid-3">
            <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={template?.name} required /></Field>
            <Field label="Category" name="category" state={state}><SelectInput name="category" state={state} defaultValue={template?.category ?? "CUSTOM"} options={categories.map((c) => ({ value: c, label: c.charAt(0) + c.slice(1).toLowerCase().replace(/_/g, " ") }))} /></Field>
            <Field label="Workflow" name="workflow" state={state} hint="What happens after the letter is generated"><SelectInput name="workflow" state={state} defaultValue={template?.workflow ?? ""} options={Object.entries(workflows).map(([value, label]) => ({ value, label }))} /></Field>
          </div>
          <div className="grid grid-2" style={{ alignItems: "start" }}>
            <div className="stack gap-2">
              <Field label="Letter body" name="body" required hint="HTML is allowed (paragraphs, bold, lists, tables). Scripts are not.">
                <textarea ref={area} id="body" name="body" className="textarea mono" rows={18} value={body} onChange={(e) => setBody(e.target.value)} required />
              </Field>
              <div className="text-xs subtle">Insert a placeholder:</div>
              <div className="row gap-1" style={{ flexWrap: "wrap" }}>
                {Object.entries(placeholders).map(([k, label]) => (
                  <button key={k} type="button" className="btn ghost sm" title={label} onClick={() => insert(k)}>{k}</button>
                ))}
              </div>
            </div>
            <div className="stack gap-2">
              <div className="label">Preview{sample ? ` for ${sample.employee_name}` : ""}</div>
              <LetterFrame html={preview} height={460} />
            </div>
          </div>
          {template ? <CheckboxInput name="archived" label="Archived" defaultChecked={template.isArchived} hint="Archived templates cannot be used to generate new letters." /> : null}
        </div>
      )}
    </ActionForm>
  );
}
