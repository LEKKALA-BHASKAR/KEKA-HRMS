"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import s from "../leave.module.css";

/** The leave-year switcher ("Apr 2026 - Mar 2027 ▾"). */
export function YearSelect({ options, value }: { options: Array<{ value: string; label: string; href: string }>; value: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <label className={s.yearSelect} data-pending={pending || undefined}>
      <span className="sr-only">Leave year</span>
      <select
        value={value}
        onChange={(e) => {
          const o = options.find((x) => x.value === e.target.value);
          if (o) start(() => router.push(o.href, { scroll: false }));
        }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 8h14l-7 9z" /></svg>
    </label>
  );
}
