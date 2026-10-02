"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, CheckboxInput, DangerButton, useForm } from "@/components/form";
import {
  saveNoticePolicyAction, deleteNoticePolicyAction, saveExitReasonAction, deleteExitReasonAction,
  saveDocumentFolderAction, deleteDocumentFolderAction, saveDocumentTypeAction, deleteDocumentTypeAction, requestDocumentTypeAction,
} from "@/app/actions/workplace-settings";

/** A table row that turns into its edit form in place. */
function EditableRow({ cols, span, form, actions }: { cols: React.ReactNode[]; span: number; form: (close: () => void) => React.ReactNode; actions?: React.ReactNode }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <tr><td colSpan={span}>{form(() => setEditing(false))}</td></tr>;
  return (
    <tr>
      {cols.map((c, i) => <td key={i}>{c}</td>)}
      <td>
        <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost sm" onClick={() => setEditing(true)}>Edit</button>
          {actions}
        </div>
      </td>
    </tr>
  );
}

const cancel = (close?: () => void) => (close ? <button type="button" className="btn" onClick={close}>Cancel</button> : undefined);

// ---------------------------------------------------------------------------
//  Notice periods
// ---------------------------------------------------------------------------

export interface NoticePolicy { id: string; name: string; resignationDays: number; terminationDays: number; probationDays: number; allowBuyout: boolean; buyoutBasis: string; isDefault: boolean; isActive: boolean; employees: number }

export function NoticePolicyForm({ p, onDone }: { p?: NoticePolicy; onDone?: () => void }) {
  return (
    <ActionForm action={saveNoticePolicyAction} submitLabel={p ? "Save policy" : "Add policy"} hidden={p ? { id: p.id } : undefined} onDone={cancel(onDone)}>
      {(state) => (
        <>
          <div className="grid grid-4">
            <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={p?.name} required maxLength={80} placeholder="Senior staff" /></Field>
            <Field label="Resignation (days)" name="resignationDays" state={state} required><TextInput name="resignationDays" type="number" state={state} defaultValue={p?.resignationDays ?? 60} min={0} max={365} required /></Field>
            <Field label="Termination (days)" name="terminationDays" state={state} required><TextInput name="terminationDays" type="number" state={state} defaultValue={p?.terminationDays ?? 30} min={0} max={365} required /></Field>
            <Field label="During probation (days)" name="probationDays" state={state} required><TextInput name="probationDays" type="number" state={state} defaultValue={p?.probationDays ?? 15} min={0} max={365} required /></Field>
          </div>
          <div className="row gap-4 wrap" style={{ alignItems: "center" }}>
            <CheckboxInput name="allowBuyout" label="Shortfall can be bought out" defaultChecked={p?.allowBuyout ?? true} />
            <Field label="Buyout on" name="buyoutBasis" state={state}>
              <SelectInput name="buyoutBasis" state={state} defaultValue={p?.buyoutBasis ?? "GROSS"} options={[{ value: "GROSS", label: "Gross pay" }, { value: "BASIC", label: "Basic pay" }]} />
            </Field>
            <CheckboxInput name="isDefault" label="Default" hint="Anyone without their own policy follows it" defaultChecked={p?.isDefault} />
            <CheckboxInput name="isActive" label="Active" defaultChecked={p?.isActive ?? true} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function NoticePolicyRow({ p }: { p: NoticePolicy }) {
  return (
    <EditableRow span={6}
      cols={[
        <><span className="strong">{p.name}</span>{p.isDefault ? <span className="badge brand" style={{ marginLeft: 6 }}>default</span> : null}{!p.isActive ? <span className="subtle"> · off</span> : null}</>,
        `${p.resignationDays} days`, `${p.terminationDays} days`, `${p.probationDays} days`,
        p.allowBuyout ? `On ${p.buyoutBasis.toLowerCase()} pay` : "Not allowed",
      ]}
      form={(close) => <NoticePolicyForm p={p} onDone={close} />}
      actions={<DangerButton action={deleteNoticePolicyAction} hidden={{ id: p.id }} label="Delete" confirmLabel={`Delete “${p.name}”?`} />}
    />
  );
}

// ---------------------------------------------------------------------------
//  Exit reasons
// ---------------------------------------------------------------------------

const KINDS = [{ value: "VOLUNTARY", label: "Voluntary" }, { value: "INVOLUNTARY", label: "Involuntary" }, { value: "OTHER", label: "Other" }];
export interface ExitReasonRowData { id: string; name: string; kind: string; displayOrder: number; isActive: boolean; exits: number }

export function ExitReasonForm({ r, onDone }: { r?: ExitReasonRowData; onDone?: () => void }) {
  return (
    <ActionForm action={saveExitReasonAction} submitLabel={r ? "Save reason" : "Add reason"} hidden={r ? { id: r.id } : undefined} onDone={cancel(onDone)} compact>
      {(state) => (
        <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
          <Field label="Reason" name="name" state={state} required><TextInput name="name" state={state} defaultValue={r?.name} required maxLength={80} placeholder="Higher studies" /></Field>
          <Field label="Kind" name="kind" state={state}><SelectInput name="kind" state={state} defaultValue={r?.kind ?? "VOLUNTARY"} options={KINDS} /></Field>
          <Field label="Order" name="displayOrder" state={state}><TextInput name="displayOrder" type="number" state={state} defaultValue={r?.displayOrder ?? 0} min={0} max={999} /></Field>
          <CheckboxInput name="isActive" label="Active" defaultChecked={r?.isActive ?? true} />
        </div>
      )}
    </ActionForm>
  );
}

export function ExitReasonRow({ r }: { r: ExitReasonRowData }) {
  return (
    <EditableRow span={4}
      cols={[<span key="n" className={r.isActive ? "strong" : "subtle"}>{r.name}{r.isActive ? "" : " · off"}</span>, KINDS.find((k) => k.value === r.kind)?.label ?? r.kind, <span key="c" className="num">{r.exits}</span>]}
      form={(close) => <ExitReasonForm r={r} onDone={close} />}
      actions={<DangerButton action={deleteExitReasonAction} hidden={{ id: r.id }} label="Delete"
        confirmLabel={r.exits ? `“${r.name}” is on ${r.exits} exit(s). It will be switched off and kept on those exits. Continue?` : `Delete “${r.name}”?`} />}
    />
  );
}

// ---------------------------------------------------------------------------
//  Document folders and types
// ---------------------------------------------------------------------------

export interface FolderData { id: string; name: string; description: string | null; scope: string; isConfidential: boolean }
export interface DocTypeData { id: string; folderId: string; name: string; allowMultiple: boolean; isMandatory: boolean; requireVerification: boolean; trackExpiry: boolean; allowNotApplicable: boolean; requested: number; provided: number }

export function FolderForm({ f, onDone }: { f?: FolderData; onDone?: () => void }) {
  return (
    <ActionForm action={saveDocumentFolderAction} submitLabel={f ? "Save folder" : "Add folder"} hidden={f ? { id: f.id } : undefined} onDone={cancel(onDone)}>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Folder name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={f?.name} required maxLength={80} placeholder="Identity documents" /></Field>
            <Field label="Holds" name="scope" state={state}>
              <SelectInput name="scope" state={state} defaultValue={f?.scope ?? "EMPLOYEE"} options={[{ value: "EMPLOYEE", label: "Each employee's documents" }, { value: "ORGANISATION", label: "Organisation policies" }]} />
            </Field>
            <Field label="Description" name="description" state={state}><TextInput name="description" state={state} defaultValue={f?.description} maxLength={300} /></Field>
          </div>
          <CheckboxInput name="isConfidential" label="Confidential" hint="Shown with a confidential marker; only document managers see others' files" defaultChecked={f?.isConfidential} />
        </>
      )}
    </ActionForm>
  );
}

export function DocTypeForm({ t, folders, onDone }: { t?: DocTypeData; folders: FolderData[]; onDone?: () => void }) {
  return (
    <ActionForm action={saveDocumentTypeAction} submitLabel={t ? "Save type" : "Add document type"} hidden={t ? { id: t.id } : undefined} onDone={cancel(onDone)}>
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Document" name="name" state={state} required><TextInput name="name" state={state} defaultValue={t?.name} required maxLength={80} placeholder="PAN card" /></Field>
            <Field label="Folder" name="folderId" state={state} required>
              <SelectInput name="folderId" state={state} defaultValue={t?.folderId} required options={folders.map((f) => ({ value: f.id, label: `${f.name}${f.scope === "ORGANISATION" ? " (organisation)" : ""}` }))} />
            </Field>
          </div>
          <div className="grid grid-3">
            <CheckboxInput name="isMandatory" label="Mandatory" hint="Requested from every employee, and from each new joiner" defaultChecked={t?.isMandatory} />
            <CheckboxInput name="requireVerification" label="HR verifies uploads" defaultChecked={t?.requireVerification ?? true} />
            <CheckboxInput name="trackExpiry" label="Ask for an expiry date" defaultChecked={t?.trackExpiry} />
            <CheckboxInput name="allowMultiple" label="Several files allowed" defaultChecked={t?.allowMultiple} />
            <CheckboxInput name="allowNotApplicable" label="Employee can mark not applicable" defaultChecked={t?.allowNotApplicable} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

function RequestButton({ id }: { id: string }) {
  const [state, action, pending] = useForm(requestDocumentTypeAction);
  return (
    <form action={action} className="row gap-2">
      <input type="hidden" name="id" value={id} />
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
      <button className="btn ghost sm" disabled={pending}>{pending ? "…" : "Request from all"}</button>
    </form>
  );
}

export function DocTypeRow({ t, folders, employeeFolder }: { t: DocTypeData; folders: FolderData[]; employeeFolder: boolean }) {
  const flags = [t.isMandatory && "mandatory", t.requireVerification && "verified by HR", t.trackExpiry && "expires", t.allowMultiple && "multiple files", t.allowNotApplicable && "can be N/A"].filter(Boolean).join(" · ");
  return (
    <EditableRow span={4}
      cols={[<span key="n" className="strong">{t.name}</span>, <span key="f" className="text-xs subtle">{flags || "—"}</span>, employeeFolder ? <span key="c" className="text-sm">{t.provided} provided · {t.requested} awaited</span> : "—"]}
      form={(close) => <DocTypeForm t={t} folders={folders} onDone={close} />}
      actions={<>
        {employeeFolder ? <RequestButton id={t.id} /> : null}
        <DangerButton action={deleteDocumentTypeAction} hidden={{ id: t.id }} label="Delete" confirmLabel={`Delete “${t.name}”? Open requests for it are withdrawn.`} />
      </>}
    />
  );
}

export function FolderHeader({ f }: { f: FolderData }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <FolderForm f={f} onDone={() => setEditing(false)} />;
  return (
    <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
      <button type="button" className="btn ghost sm" onClick={() => setEditing(true)}>Edit folder</button>
      <DangerButton action={deleteDocumentFolderAction} hidden={{ id: f.id }} label="Delete folder" confirmLabel={`Delete the folder “${f.name}” and its document types?`} />
    </div>
  );
}
