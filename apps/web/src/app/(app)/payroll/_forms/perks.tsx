"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, CheckboxInput, DangerButton } from "@/components/form";
import { savePerkAction, deletePerkAction, assignPerkAction, endPerkAction } from "@/app/actions/perks";

export interface Option { value: string; label: string }
const METHODS: Option[] = [
  { value: "FIXED_FOR_ALL", label: "Same value for everyone" },
  { value: "PER_EMPLOYEE", label: "Value set per employee" },
  { value: "FORMULA", label: "Formula on salary" },
];

export function PerkForm({ perk }: { perk?: { id: string; name: string; code: string; category: string; valuationMethod: string; fixedAmount: number | null; formula: string | null; isTaxable: boolean; taxBorneByEmployer: boolean } }) {
  const [method, setMethod] = useState(perk?.valuationMethod ?? "FIXED_FOR_ALL");
  return (
    <ActionForm action={savePerkAction} submitLabel={perk ? "Save" : "Add perk"} hidden={perk ? { id: perk.id } : undefined} compact>
      {(state) => (
        <div className="stack gap-2">
          <div className="grid grid-3">
            <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={perk?.name} maxLength={60} required /></Field>
            <Field label="Code" name="code" state={state} required hint="e.g. COMPANY_CAR"><TextInput name="code" state={state} defaultValue={perk?.code} maxLength={30} required /></Field>
            <Field label="Category" name="category" state={state} required hint="e.g. Vehicle, Meals, Club"><TextInput name="category" state={state} defaultValue={perk?.category} maxLength={40} required /></Field>
          </div>
          <div className="grid grid-3">
            <Field label="Valued as" name="valuationMethod" state={state}>
              <select className="select" name="valuationMethod" value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
            {method === "FIXED_FOR_ALL" ? (
              <Field label="Value a month (₹)" name="fixedAmount" state={state} required><TextInput name="fixedAmount" type="number" step="1" state={state} defaultValue={perk?.fixedAmount ?? ""} required /></Field>
            ) : method === "FORMULA" ? (
              <Field label="Monthly value formula" name="formula" state={state} required hint="Over monthly components, e.g. [BASIC] * 0.1"><TextInput name="formula" state={state} defaultValue={perk?.formula ?? ""} maxLength={300} required /></Field>
            ) : <div className="text-sm muted" style={{ paddingTop: 26 }}>Enter the value when you give it to someone.</div>}
          </div>
          <div className="row gap-4 wrap">
            <CheckboxInput name="isTaxable" label="Taxable perquisite" defaultChecked={perk?.isTaxable ?? true} />
            <CheckboxInput name="taxBorneByEmployer" label="Employer bears the tax" defaultChecked={perk?.taxBorneByEmployer} />
          </div>
        </div>
      )}
    </ActionForm>
  );
}

export function DeletePerk({ id, name }: { id: string; name: string }) {
  return <DangerButton action={deletePerkAction} hidden={{ id }} label="Delete" confirmLabel={`Delete ${name}?`} />;
}

export function AssignPerkForm({ employees, perks, today }: { employees: Option[]; perks: Array<Option & { perEmployee: boolean }>; today: string }) {
  const [perkId, setPerkId] = useState("");
  const perEmployee = perks.find((p) => p.value === perkId)?.perEmployee ?? false;
  return (
    <ActionForm action={assignPerkAction} submitLabel="Give perk" compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Employee" name="employeeId" state={state} required><SelectInput name="employeeId" state={state} options={employees} placeholder="Select…" required /></Field>
          <Field label="Perk" name="perkId" state={state} required>
            <select className="select" name="perkId" value={perkId} onChange={(e) => setPerkId(e.target.value)} required>
              <option value="">Select…</option>
              {perks.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="From" name="startDate" state={state} required><TextInput name="startDate" type="date" state={state} defaultValue={today} required /></Field>
          {perEmployee ? <Field label="Value a month (₹)" name="monthlyValue" state={state} required><TextInput name="monthlyValue" type="number" step="1" state={state} required /></Field> : null}
          <Field label="Note" name="note" state={state}><TextInput name="note" state={state} maxLength={200} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function EndPerkForm({ id, today }: { id: string; today: string }) {
  return (
    <ActionForm action={endPerkAction} submitLabel="End" hidden={{ id }} compact>
      {(state) => <Field label="Ends on" name="endDate" state={state} required><TextInput name="endDate" type="date" state={state} defaultValue={today} required /></Field>}
    </ActionForm>
  );
}
