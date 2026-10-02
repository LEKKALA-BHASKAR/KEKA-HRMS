"use client";

import { useState } from "react";
import { useForm, FormBanner } from "@/components/form";
import { raiseCompOffAction, raiseEncashmentAction, withdrawTimeRequestAction } from "@/app/actions/time-requests";

/** Claim one worked off-day, with a note; the credit (half or full) comes from the hours worked. */
export function CompOffClaim({ date, maxDays }: { date: string; maxDays: 1 | 0.5 }) {
  const [state, action, pending] = useForm(raiseCompOffAction);
  const [open, setOpen] = useState(false);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  if (!open) return <button type="button" className="btn sm" onClick={() => setOpen(true)}>Claim</button>;
  return (
    <form action={action} className="stack gap-1" style={{ minWidth: 220 }}>
      <input type="hidden" name="fromDate" value={date} />
      <input type="hidden" name="toDate" value={date} />
      <div className="row gap-1" style={{ alignItems: "center" }}>
        <span className="text-xs muted" style={{ whiteSpace: "nowrap" }}>{maxDays === 1 ? "Full day" : "Half day"}</span>
        <input className="input" name="note" placeholder="What did you work on?" required maxLength={500} />
      </div>
      <div className="row gap-1">
        <button className="btn primary sm" disabled={pending}>{pending ? "…" : "Request"}</button>
        <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

export function WithdrawButton({ kind, requestId }: { kind: "compoff" | "encash"; requestId: string }) {
  const [state, action, pending] = useForm(withdrawTimeRequestAction);
  return (
    <form action={action}>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="entity" value={kind === "compoff" ? "CompOffRequest" : "LeaveEncashmentRequest"} />
      <button className="btn ghost sm" disabled={pending}>{pending ? "…" : "Withdraw"}</button>
      {state.message && !state.ok ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

export function EncashForm({ types }: { types: Array<{ id: string; name: string; encashable: number; perDay: number }> }) {
  const [state, action, pending] = useForm(raiseEncashmentAction);
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [days, setDays] = useState("");
  const t = types.find((x) => x.id === typeId);
  const amount = t && Number(days) > 0 ? Math.round(Number(days) * t.perDay) : 0;
  return (
    <form action={action} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="mode" value="custom" />
      <div className="grid grid-2">
        <div className="field">
          <label className="label" htmlFor="leaveTypeId">Leave type</label>
          <select id="leaveTypeId" name="leaveTypeId" className="select" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.encashable} day(s) available</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="days">Days to encash</label>
          <input id="days" name="days" type="number" step="0.5" min="0.5" max={t?.encashable} className="input num" value={days} onChange={(e) => setDays(e.target.value)} required
            style={state.errors?.days ? { borderColor: "var(--danger)" } : undefined} />
          {state.errors?.days ? <div className="text-xs neg" style={{ marginTop: 4 }}>{state.errors.days}</div> : null}
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="note">Reason (optional)</label>
        <input id="note" name="note" className="input" maxLength={500} />
      </div>
      <div className="row gap-3" style={{ alignItems: "center" }}>
        <button className="btn primary" disabled={pending || !t || t.encashable <= 0}>{pending ? "Requesting…" : "Request encashment"}</button>
        {t ? <span className="text-sm muted">≈ ₹{amount.toLocaleString("en-IN")} at ₹{t.perDay.toLocaleString("en-IN")}/day, before tax</span> : null}
      </div>
    </form>
  );
}
