"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DangerButton, FormBanner } from "@/components/form";
import { saveBusinessHoursAction, duplicateBusinessHoursAction, deleteBusinessHoursAction } from "@/app/actions/helpdesk";
import type { ActionState } from "@/lib/forms";
import s from "./hd.module.css";

export const TIMEZONES = ["Asia/Kolkata", "UTC", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "America/Phoenix", "Australia/Sydney"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface HoursValue {
  id: string | null; name: string; description: string | null; timezone: string; observeHolidays: boolean; isDefault: boolean;
  schedule: Array<{ day: number; from: string; to: string }>;
}

/**
 * One set of business hours: its name, time zone, holidays and a row per
 * weekday (ticked = working, with from/to); 00:00 to 23:59 is the whole day.
 */
export function BusinessHoursForm({ value }: { value: HoursValue }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(saveBusinessHoursAction, {});
  // A saved empty schedule is round the clock: show it as every day, all day.
  const allDay = !!value.id && value.schedule.length === 0;
  const byDay = new Map(value.schedule.map((w) => [w.day, w]));
  const [on, setOn] = useState<boolean[]>(() => DAYS.map((_, i) => (value.schedule.length ? byDay.has(i + 1) : allDay || i < 5)));
  useEffect(() => {
    if (state.ok && !value.id && state.values?.id) router.push(`/helpdesk/settings/business-hours?id=${state.values.id}`);
  }, [state, value.id, router]);
  const err = (k: string) => state.errors?.[k];
  return (
    <div className={s.formPage}>
      <div className={s.formBand}>
        <span>{value.id ? value.name : "New business hours"}{value.isDefault ? <span className="badge info" style={{ marginLeft: 10 }}>Default</span> : null}</span>
        {value.id ? (
          <span style={{ display: "inline-flex", gap: 8 }}>
            <DuplicateButton id={value.id} />
            {!value.isDefault ? <DangerButton action={deleteBusinessHoursAction} hidden={{ id: value.id }} label="Delete" confirmLabel={`Delete ${value.name}?`} /> : null}
          </span>
        ) : null}
      </div>
      <form action={action} className={s.formBody} key={value.id ?? "new"}>
        {value.id ? <input type="hidden" name="id" value={value.id} /> : null}
        <FormBanner state={state} />
        <div className={s.formField}>
          <label className={s.formLabel} htmlFor="bh-name">Name</label>
          <input id="bh-name" name="name" className={s.input} maxLength={80} defaultValue={value.name} />
          {err("name") ? <div className={s.err}>{err("name")}</div> : null}
        </div>
        <div className={s.formField}>
          <label className={s.formLabel} htmlFor="bh-desc">Description</label>
          <textarea id="bh-desc" name="description" className="textarea" rows={2} maxLength={500} defaultValue={value.description ?? ""} />
        </div>
        <div className={s.twoCol}>
          <div className={s.formField}>
            <label className={s.formLabel} htmlFor="bh-tz">Time zone</label>
            <select id="bh-tz" name="timezone" className="select" defaultValue={value.timezone} style={{ width: "100%" }}>
              {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </div>
          <div className={s.formField} style={{ display: "flex", alignItems: "flex-end" }}>
            <label className={s.toggle}><input type="checkbox" name="observeHolidays" defaultChecked={value.observeHolidays} /> Pause on company holidays</label>
          </div>
        </div>
        <div className={s.formLabel}>Working hours</div>
        {err("days") ? <div className={s.err} style={{ marginBottom: 8 }}>{err("days")}</div> : null}
        {DAYS.map((d, i) => {
          const n = i + 1, w = byDay.get(n);
          return (
            <div key={d} className={s.dayRow}>
              <label className={s.inlineCheck}>
                <input type="checkbox" name={`day_${n}`} checked={on[i]} onChange={() => setOn((xs) => xs.map((x, j) => (j === i ? !x : x)))} /> {d}
              </label>
              <input type="time" name={`from_${n}`} className="input" defaultValue={w?.from ?? (allDay ? "00:00" : "09:00")} disabled={!on[i]} aria-label={`${d} from`} />
              <span className={s.muted} style={{ textAlign: "center" }}>to</span>
              <div>
                <input type="time" name={`to_${n}`} className="input" defaultValue={w?.to ?? (allDay ? "23:59" : "18:00")} disabled={!on[i]} aria-label={`${d} to`} style={{ width: "100%" }} />
                {err(`to_${n}`) ? <div className={s.err}>{err(`to_${n}`)}</div> : null}
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 10 }}>
          <button type="submit" className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </div>
  );
}

function DuplicateButton({ id }: { id: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(duplicateBusinessHoursAction, {});
  useEffect(() => { if (state.ok && state.values?.id) router.push(`/helpdesk/settings/business-hours?id=${state.values.id}`); }, [state, router]);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn ghost sm" disabled={pending}>{pending ? "…" : "Duplicate"}</button>
      {state.message && !state.ok ? <div className="text-xs" style={{ color: "var(--danger)" }}>{state.message}</div> : null}
    </form>
  );
}
