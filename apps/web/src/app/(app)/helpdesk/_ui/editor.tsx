"use client";

import { forwardRef, useImperativeHandle, useRef, type ReactNode } from "react";
import s from "./hd.module.css";

/**
 * Keka's editor toolbar (Normal, B, I, U, numbered, bulleted, quote, link)
 * over a plain textarea. Buttons write the Markdown subset `Rich` renders,
 * so what is stored is text and what is shown is never raw HTML.
 */

export interface EditorHandle { insert: (text: string) => void; set: (text: string) => void; value: () => string; focus: () => void }

const Icon = ({ d, children }: { d?: string; children?: ReactNode }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d ? <path d={d} /> : children}</svg>
);

export const Editor = forwardRef<EditorHandle, {
  name: string; placeholder?: string; rows?: number; defaultValue?: string; maxLength?: number; required?: boolean;
  onChange?: (v: string) => void; extraTools?: ReactNode; invalid?: boolean;
}>(function Editor({ name, placeholder, rows = 8, defaultValue, maxLength = 5000, required, onChange, extraTools, invalid }, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  const emit = () => onChange?.(area.current?.value ?? "");

  const replace = (fn: (sel: string) => { text: string; cursor?: number }) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const { text, cursor } = fn(value.slice(a, b));
    el.setRangeText(text, a, b, "end");
    if (cursor !== undefined) el.setSelectionRange(a + cursor, a + cursor);
    el.focus();
    emit();
  };
  const wrap = (mark: string, ph: string) => replace((sel) => {
    const body = sel || ph;
    return { text: `${mark}${body}${mark}`, cursor: sel ? undefined : mark.length + body.length };
  });
  const lines = (prefix: (i: number) => string) => replace((sel) => {
    const body = (sel || "item").split("\n").map((l, i) => `${prefix(i)}${l.replace(/^(\s*[-*•]\s+|\s*\d+[.)]\s+|>\s?)/, "")}`).join("\n");
    const el = area.current!;
    const atLineStart = el.selectionStart === 0 || el.value[el.selectionStart - 1] === "\n";
    return { text: `${atLineStart ? "" : "\n"}${body}` };
  });
  const link = () => {
    const url = window.prompt("Link address (https://…)");
    if (!url) return;
    if (!/^(https?:\/\/|mailto:)/i.test(url)) { window.alert("Links must start with https:// or mailto:"); return; }
    replace((sel) => ({ text: `[${sel || "link"}](${url})` }));
  };
  const heading = (v: string) => {
    if (v === "normal") return;
    lines(() => (v === "h1" ? "# " : "## "));
  };

  useImperativeHandle(ref, () => ({
    insert: (text) => replace(() => ({ text })),
    set: (text) => { if (area.current) { area.current.value = text; emit(); area.current.focus(); } },
    value: () => area.current?.value ?? "",
    focus: () => area.current?.focus(),
  }));

  return (
    <div className={s.editorBox} style={invalid ? { borderColor: "var(--danger)" } : undefined}>
      <div className={s.editorBar} role="toolbar" aria-label="Formatting">
        <select aria-label="Text style" defaultValue="normal" onChange={(e) => { heading(e.target.value); e.target.value = "normal"; }}>
          <option value="normal">Normal</option><option value="h1">Heading</option><option value="h2">Subheading</option>
        </select>
        <span className={s.toolSep} />
        <button type="button" className={s.tool} title="Bold" onClick={() => wrap("**", "bold")}><Icon d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" /></button>
        <button type="button" className={s.tool} title="Italic" onClick={() => wrap("*", "italic")}><Icon d="M14 5h-4M14 19h-4M14 5l-4 14" /></button>
        <button type="button" className={s.tool} title="Underline" onClick={() => wrap("++", "underlined")}><Icon d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14" /></button>
        <span className={s.toolSep} />
        <button type="button" className={s.tool} title="Numbered list" onClick={() => lines((i) => `${i + 1}. `)}><Icon d="M10 6h10M10 12h10M10 18h10M4 5h1.5v3M4 8h3M4 12.5c0-.8.6-1.2 1.3-1.2s1.2.4 1.2 1-.4 1-2.5 2.7h2.6" /></button>
        <button type="button" className={s.tool} title="Bulleted list" onClick={() => lines(() => "- ")}><Icon d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></button>
        <span className={s.toolSep} />
        <button type="button" className={s.tool} title="Quote" onClick={() => lines(() => "> ")}><Icon><path d="M7 8h3v4c0 2-1 3-3 4" /><path d="M14 8h3v4c0 2-1 3-3 4" /></Icon></button>
        <button type="button" className={s.tool} title="Link" onClick={link}><Icon d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></button>
        {extraTools}
      </div>
      <textarea
        ref={area} id={name} name={name} rows={rows} className={s.editorArea} placeholder={placeholder}
        defaultValue={defaultValue} maxLength={maxLength} required={required} onChange={emit}
      />
    </div>
  );
});
