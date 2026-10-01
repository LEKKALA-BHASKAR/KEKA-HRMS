"use client";

import { useForm } from "@/components/form";
import { setEmployeeNoticePolicyAction } from "@/app/actions/workplace-settings";

/** Pick this person's notice policy; blank follows the organisation default. */
export function NoticePolicyPicker({ employeeId, current, options, defaultName }: {
  employeeId: string; current: string | null; options: Array<{ value: string; label: string }>; defaultName: string;
}) {
  const [state, action, pending] = useForm(setEmployeeNoticePolicyAction);
  return (
    <form action={action} className="row gap-2 wrap" style={{ alignItems: "center" }}>
      <input type="hidden" name="employeeId" value={employeeId} />
      <select name="noticePeriodPolicyId" className="select" defaultValue={current ?? ""} style={{ maxWidth: 320 }} aria-label="Notice policy">
        <option value="">Organisation default ({defaultName})</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button className="btn sm" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}
