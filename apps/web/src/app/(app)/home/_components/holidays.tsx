"use client";

import { useState } from "react";
import type { HolidaySlide } from "../_lib/data";
import { IconChevronLeft, IconChevronRight } from "./icons";
import s from "../home.module.css";

/** One upcoming holiday at a time, with previous / next. */
export function HolidayCarousel({ holidays }: { holidays: HolidaySlide[] }) {
  const [i, setI] = useState(0);
  const n = holidays.length;
  const h = holidays[Math.min(i, n - 1)];
  if (!h) return null;
  const when = h.inDays === 0 ? "Today" : h.inDays === 1 ? "Tomorrow" : `In ${h.inDays} days`;
  return (
    <div
      className={s.carousel}
      role="group"
      aria-roledescription="carousel"
      aria-label="Upcoming holidays"
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
        if (e.key === "ArrowRight" && i < n - 1) setI(i + 1);
      }}
    >
      <button type="button" className={s.navBtn} onClick={() => setI(i - 1)} disabled={i === 0} aria-label="Previous holiday">
        <IconChevronLeft />
      </button>
      <div className={s.slide} aria-live="polite" aria-atomic="true" aria-roledescription="slide" aria-label={`${i + 1} of ${n}`}>
        <div className={s.holidayName}>{h.name}</div>
        <div className={s.holidayDate}>
          <span>{h.date}</span>
          {h.optional ? <span className={s.optional}>Optional</span> : null}
        </div>
        <div className={s.holidayMeta}>{when} · {i + 1} of {n}</div>
      </div>
      <button type="button" className={s.navBtn} onClick={() => setI(i + 1)} disabled={i >= n - 1} aria-label="Next holiday">
        <IconChevronRight />
      </button>
    </div>
  );
}
