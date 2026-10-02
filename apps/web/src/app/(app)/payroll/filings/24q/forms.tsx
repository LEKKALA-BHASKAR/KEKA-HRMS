"use client";

import { ActionForm, Field, TextInput } from "@/components/form";
import { recordChallanAction } from "@/app/actions/payroll-payout";

export function ChallanForm({ months, payGroups, defaultMonth }: { months: Array<{ value: string; label: string }>; payGroups: Array<{ value: string; label: string }>; defaultMonth: string }) {
  return (
    <ActionForm action={recordChallanAction} submitLabel="Record challan">
      {(state) => (
        <div className="stack gap-3">
          <div className="grid grid-2">
            <Field label="Salary month" name="period" state={state} required>
              <select className="select" id="period" name="period" defaultValue={state.values?.period ?? defaultMonth}>
                {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
            <Field label="Pay group (deductor)" name="payGroupId" state={state}>
              <select className="select" id="payGroupId" name="payGroupId" defaultValue={state.values?.payGroupId ?? payGroups[0]?.value ?? ""}>
                {payGroups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
            </Field>
            <Field label="BSR code" name="bsrCode" state={state} required hint="7 digits, from the counterfoil"><TextInput name="bsrCode" state={state} maxLength={7} required /></Field>
            <Field label="Challan serial no." name="challanNumber" state={state} required hint="Up to 5 digits"><TextInput name="challanNumber" state={state} maxLength={5} required /></Field>
            <Field label="Date of deposit" name="paymentDate" state={state} required><TextInput name="paymentDate" type="date" state={state} required /></Field>
            <Field label="TDS (₹)" name="tdsAmount" state={state} required><TextInput name="tdsAmount" type="number" min={1} step="1" state={state} required /></Field>
            <Field label="Surcharge (₹)" name="surcharge" state={state}><TextInput name="surcharge" type="number" min={0} step="1" state={state} /></Field>
            <Field label="Health & education cess (₹)" name="cess" state={state}><TextInput name="cess" type="number" min={0} step="1" state={state} /></Field>
            <Field label="Interest (₹)" name="interest" state={state}><TextInput name="interest" type="number" min={0} step="1" state={state} /></Field>
            <Field label="Late fee (₹)" name="fee" state={state}><TextInput name="fee" type="number" min={0} step="1" state={state} /></Field>
          </div>
          <p className="text-xs subtle">Enter the figures as printed on the challan (ITNS 281). Reconciliation compares the TDS column with what payroll deducted.</p>
        </div>
      )}
    </ActionForm>
  );
}
