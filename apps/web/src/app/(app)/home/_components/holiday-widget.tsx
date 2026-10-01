"use client";

import { useState } from "react";
import type { HolidaySlide } from "../_lib/data";
import { IconChevronLeft, IconChevronRight } from "./icons";
import d from "../dash.module.css";

/** One upcoming holiday at a time with ‹ ›, as in Keka's Holidays widget. */
export function HolidaySlides({ holidays }: { holidays: HolidaySlide[] }) {
  const [i, setI] = useState(0);
  const n = holidays.length;
  const h = holidays[Math.min(i, n - 1)];
  if (!h) return null;
  return (
    <div
      className={d.hCarousel}
      role="group"
      aria-roledescription="carousel"
      aria-label="Upcoming holidays"
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
        if (e.key === "ArrowRight" && i < n - 1) setI(i + 1);
      }}
    >
      <button type="button" className={d.hNav} onClick={() => setI(i - 1)} disabled={i === 0} aria-label="Previous holiday"><IconChevronLeft /></button>
      <div className={d.hSlide} aria-live="polite" aria-atomic="true" aria-roledescription="slide" aria-label={`${i + 1} of ${n}`}>
        <div className={d.hName}>{h.name}</div>
        <div className={d.hDate}>
          <span>{h.date}</span>
          {h.optional ? <span className={d.floater}>Floater leave</span> : null}
        </div>
      </div>
      <button type="button" className={d.hNav} onClick={() => setI(i + 1)} disabled={i >= n - 1} aria-label="Next holiday"><IconChevronRight /></button>
    </div>
  );
}
