"use client";

import { ActionForm, Field, TextInput, SelectInput, TextArea } from "@/components/form";
import { saveEmployeeCustomFieldsAction } from "@/app/actions/custom-fields";

export interface CustomInput { id: string; label: string; type: string; options: string[]; isMandatory: boolean; value: string | null }

/** Every active custom field in one form, so mandatory ones are checked together. */
export function CustomFieldsForm({ employeeId, fields }: { employeeId: string; fields: CustomInput[] }) {
  return (
    <ActionForm action={saveEmployeeCustomFieldsAction} hidden={{ employeeId }} submitLabel="Save details">
      {(state) => (
        <div className="grid grid-2">
          {fields.map((f) => {
            const name = `f_${f.id}`;
            const input =
              f.type === "DROPDOWN" ? <SelectInput name={name} state={state} defaultValue={f.value} placeholder="—" options={f.options.map((o) => ({ value: o, label: o }))} />
              : f.type === "MULTILINE" ? <TextArea name={name} state={state} defaultValue={f.value} rows={2} />
              : f.type === "CHECKBOX" ? (
                <label className="checkbox-row"><input type="checkbox" id={name} name={name} defaultChecked={(state.values?.[name] ?? f.value) === "true" || state.values?.[name] === "on"} /><span className="text-sm">Yes</span></label>
              )
              : <TextInput name={name} state={state} defaultValue={f.value}
                  type={f.type === "NUMBER" ? "number" : f.type === "DATE" ? "date" : f.type === "EMAIL" ? "email" : f.type === "PHONE" ? "tel" : "text"}
                  step={f.type === "NUMBER" ? "any" : undefined} />;
            return <Field key={f.id} label={f.label} name={name} state={state} required={f.isMandatory && f.type !== "CHECKBOX"}>{input}</Field>;
          })}
        </div>
      )}
    </ActionForm>
  );
}
