"use client";

import { useEffect, useRef, useState } from "react";
import s from "./analytics.module.css";

/** Draw the card's SVG onto a canvas at 2× and download it as a PNG. */
async function exportPng(chartKey: string) {
  const card = document.querySelector(`[data-chart-card="${CSS.escape(chartKey)}"]`);
  const svg = card?.querySelector("svg[role='img']") as SVGSVGElement | null;
  if (!svg) return;
  const vb = svg.viewBox.baseVal;
  const w = vb?.width || svg.clientWidth, h = vb?.height || svg.clientHeight;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("render")); img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(2, 2);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${chartKey}.png`;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The ≡ menu on a chart: Export as PNG, PDF or Excel. */
export function ChartMenu({ chartKey, exportQs }: { chartKey: string; exportQs: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const href = (format: string) => `/analytics/export?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(exportQs)), key: chartKey, format }).toString()}`;
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button type="button" className={s.menuBtn} aria-label="Download chart" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" strokeLinecap="round" /></svg>
      </button>
      {open ? (
        <div className={s.menu} role="menu" style={{ left: "auto", right: 0 }}>
          <button type="button" role="menuitem" className={s.menuItem} onClick={() => { setOpen(false); void exportPng(chartKey); }}>Export as PNG</button>
          <a role="menuitem" className={s.menuItem} href={href("pdf")} onClick={() => setOpen(false)}>Export as PDF</a>
          <a role="menuitem" className={s.menuItem} href={href("csv")} onClick={() => setOpen(false)}>Export as Excel</a>
        </div>
      ) : null}
    </div>
  );
}
