"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, TextArea, CheckboxInput, DangerButton } from "@/components/form";
import { saveCustomFieldAction, deleteCustomFieldAction } from "@/app/actions/custom-fields";

const TYPES = [
  { value: "TEXT", label: "Short text" }, { value: "MULTILINE", label: "Long text" },
  { value: "NUMBER", label: "Number" }, { value: "DATE", label: "Date" },
  { value: "DROPDOWN", label: "Dropdown" }, { value: "CHECKBOX", label: "Yes / no" },
  { value: "EMAIL", label: "Email" }, { value: "PHONE", label: "Phone" },
];

export interface FieldDef {
  id: string; label: string; section: string | null; type: string; options: string[];
  isMandatory: boolean; isActive: boolean; displayOrder: number;
}

export function CustomFieldForm({ def, onDone }: { def?: FieldDef; onDone?: () => void }) {
  const [type, setType] = useState(def?.type ?? "TEXT");
  return (
    <ActionForm action={saveCustomFieldAction} submitLabel={def ? "Save field" : "Add field"} hidden={def ? { id: def.id } : undefined}
      onDone={onDone ? <button type="button" className="btn" onClick={onDone}>Cancel</button> : undefined}>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Label" name="label" state={state} required><TextInput name="label" state={state} defaultValue={def?.label} required maxLength={80} /></Field>
            <Field label="Type" name="type" state={state}>
              <select id="type" name="type" className="select" value={type} onChange={(e) => setType(e.target.value)}>
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Profile card" name="section" state={state} hint="Groups fields on the profile; blank shows under Additional details">
              <TextInput name="section" state={state} defaultValue={def?.section} maxLength={60} placeholder="Additional details" />
            </Field>
          </div>
          {type === "DROPDOWN" ? (
            <Field label="Options" name="options" state={state} hint="One per line or separated by commas" required>
              <TextArea name="options" state={state} defaultValue={def?.options.join("\n")} rows={3} />
            </Field>
          ) : null}
          <div className="row gap-4 wrap" style={{ alignItems: "center" }}>
            <Field label="Order" name="displayOrder" state={state}><TextInput name="displayOrder" type="number" state={state} defaultValue={def?.displayOrder ?? 0} min={0} max={999} /></Field>
            <CheckboxInput name="isMandatory" label="Mandatory" hint="Profiles cannot be saved without it" defaultChecked={def?.isMandatory} />
            <CheckboxInput name="isActive" label="Active" hint="Inactive fields are hidden but keep their values" defaultChecked={def?.isActive ?? true} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function CustomFieldRow({ def, used }: { def: FieldDef; used: number }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <tr><td colSpan={6}><CustomFieldForm def={def} onDone={() => setEditing(false)} /></td></tr>;
  return (
    <tr style={def.isActive ? undefined : { opacity: 0.55 }}>
      <td><span className="strong">{def.label}</span>{def.isMandatory ? <span style={{ color: "var(--danger)" }}> *</span> : null}</td>
      <td>{TYPES.find((t) => t.value === def.type)?.label ?? def.type}{def.type === "DROPDOWN" ? <div className="text-xs subtle">{def.options.join(", ")}</div> : null}</td>
      <td>{def.section ?? <span className="subtle">Additional details</span>}</td>
      <td className="num">{used}</td>
      <td>{def.isActive ? "Active" : "Off"}</td>
      <td>
        <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost sm" onClick={() => setEditing(true)}>Edit</button>
          <DangerButton action={deleteCustomFieldAction} hidden={{ id: def.id }} label="Delete"
            confirmLabel={used ? `“${def.label}” has ${used} recorded value(s). It will be switched off and its values kept. Continue?` : `Delete “${def.label}”?`} />
        </div>
      </td>
    </tr>
  );
}
