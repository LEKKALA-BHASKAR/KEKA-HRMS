"use client";

import { useState } from "react";
import { useForm, ActionForm, Field, TextInput, SelectInput } from "@/components/form";
import { markJoinedAction, markNoShowAction, initiateBgvAction, updateBgvAction } from "@/app/actions/preboarding";

export function JoinActions({ employeeId, today }: { employeeId: string; today: string }) {
  const [joinState, join, joining] = useForm(markJoinedAction);
  const [noState, noShow, recording] = useForm(markNoShowAction);
  const [mode, setMode] = useState<"idle" | "join" | "no">("idle");
  const msg = joinState.message || noState.message;
  if (joinState.ok || noState.ok) return <span className="text-xs pos">{msg}</span>;
  return (
    <div className="stack gap-2" style={{ alignItems: "flex-end" }}>
      {mode === "idle" ? (
        <div className="row gap-2">
          <button type="button" className="btn sm primary" onClick={() => setMode("join")}>Mark joined</button>
          <button type="button" className="btn sm ghost" onClick={() => setMode("no")}>Did not join</button>
        </div>
      ) : mode === "join" ? (
        <form action={join} className="row gap-2">
          <input type="hidden" name="employeeId" value={employeeId} />
          <input className="input sm" type="date" name="joinedOn" defaultValue={today} max={today} required aria-label="Joined on" />
          <button className="btn sm primary" disabled={joining}>Confirm</button>
          <button type="button" className="btn sm ghost" onClick={() => setMode("idle")}>Back</button>
        </form>
      ) : (
        <form action={noShow} className="row gap-2">
          <input type="hidden" name="employeeId" value={employeeId} />
          <input className="input sm" name="reason" placeholder="Reason" required aria-label="Reason" />
          <button className="btn sm danger" disabled={recording}>Record</button>
          <button type="button" className="btn sm ghost" onClick={() => setMode("idle")}>Back</button>
        </form>
      )}
      {msg ? <span className="text-xs neg">{msg}</span> : null}
    </div>
  );
}

export function StartBgv({ employees, checks }: { employees: { value: string; label: string }[]; checks: string[] }) {
  return (
    <ActionForm action={initiateBgvAction} submitLabel="Start background check">
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Employee" name="employeeId" state={state} required><SelectInput name="employeeId" state={state} options={employees} required placeholder="Choose" /></Field>
            <Field label="Vendor" name="vendor" state={state} hint="Who runs the checks"><TextInput name="vendor" state={state} placeholder="e.g. AuthBridge" /></Field>
          </div>
          <Field label="Checks" name="checks" state={state} required>
            <div className="row gap-2" style={{ flexWrap: "wrap" }}>
              {checks.map((c) => (
                <label key={c} className="row gap-2 text-sm"><input type="checkbox" name="checks" value={c} defaultChecked={["IDENTITY", "EMPLOYMENT", "EDUCATION"].includes(c)} /> {c.charAt(0) + c.slice(1).toLowerCase()}</label>
              ))}
            </div>
          </Field>
        </>
      )}
    </ActionForm>
  );
}

export function UpdateBgv({ id }: { id: string }) {
  const [state, formAction, pending] = useForm(updateBgvAction);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={formAction} className="stack gap-2" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="id" value={id} />
      <div className="row gap-2">
        <select className="input sm" name="status" defaultValue="IN_PROGRESS" aria-label="Status">
          <option value="IN_PROGRESS">In progress</option>
          <option value="CLEAR">Clear</option>
          <option value="DISCREPANCY">Discrepancy</option>
          <option value="FAILED">Failed</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <input className="input sm" name="findings" placeholder="Findings" aria-label="Findings" />
      </div>
      <div className="row gap-2">
        <input className="input sm" type="file" name="report" accept="application/pdf,image/png,image/jpeg" aria-label="Report" />
        <button className="btn sm" disabled={pending}>Update</button>
      </div>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}
