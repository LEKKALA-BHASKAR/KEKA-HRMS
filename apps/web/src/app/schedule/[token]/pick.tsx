"use client";

import { useForm } from "@/components/form";
import { bookSlotAction } from "../actions";

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The offered times, shown in the candidate's own time zone; one click books. */
export function PickSlot({ token, slots }: { token: string; slots: string[] }) {
  const [state, run, pending] = useForm(bookSlotAction);
  if (state.ok) return <div className="callout success">{state.message}</div>;
  return (
    <form action={run} className="stack gap-3">
      <input type="hidden" name="token" value={token} />
      {state.message ? <div className="callout danger">{state.message}</div> : null}
      <div className="stack gap-2">
        {slots.map((s, i) => (
          <label key={s} className="card row gap-2" style={{ padding: 12, cursor: "pointer", alignItems: "center" }}>
            <input type="radio" name="slot" value={s} defaultChecked={i === 0} />
            <span className="strong">{fmt(s)}</span>
            <span className="text-xs subtle">({s.slice(0, 16).replace("T", " ")} UTC)</span>
          </label>
        ))}
      </div>
      <button className="btn primary" style={{ alignSelf: "flex-start" }} disabled={pending}>{pending ? "Booking…" : "Book this time"}</button>
    </form>
  );
}
