"use client";

import { useRef, useState } from "react";
import { PaperclipIcon } from "./bits";
import s from "./hd.module.css";

const MAX_FILES = 5;
const MAX_TOTAL = 10 * 1024 * 1024;

/**
 * "Attach File ⓘ": a hidden multi-file input named `files` whose selection
 * shows as removable chips. Removing a chip rebuilds the input's FileList,
 * so the form posts exactly what is shown.
 */
export function AttachFiles({ compact, onError }: { compact?: boolean; onError?: (msg: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const sync = (next: File[]) => {
    const total = next.reduce((n, f) => n + f.size, 0);
    if (next.length > MAX_FILES) { onError?.(`Attach up to ${MAX_FILES} files.`); next = next.slice(0, MAX_FILES); }
    else if (total > MAX_TOTAL) { onError?.("Attachments can add up to 10 MB."); next = files; }
    else onError?.(null);
    const dt = new DataTransfer();
    next.forEach((f) => dt.items.add(f));
    if (input.current) input.current.files = dt.files;
    setFiles(next);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <input
        ref={input} type="file" name="files" multiple accept="application/pdf,image/png,image/jpeg" hidden
        onChange={(e) => sync([...files, ...Array.from(e.target.files ?? [])])}
      />
      {compact ? (
        <button type="button" className={s.attachBtn} title="Attach files" aria-label="Attach files" onClick={() => input.current?.click()} style={{ border: 0, background: "none" }}>
          <PaperclipIcon />
        </button>
      ) : (
        <>
          <button type="button" className={s.attachLink} onClick={() => input.current?.click()} style={{ border: 0, background: "none", padding: 0 }}>
            <PaperclipIcon /> Attach File
          </button>
          <i className={s.info} title="PDF, PNG or JPEG · up to 10 MB in all · up to 5 files">i</i>
        </>
      )}
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} className={s.fileChip}>
          {f.name}
          <button type="button" className={s.chipX} aria-label={`Remove ${f.name}`} onClick={() => sync(files.filter((_, j) => j !== i))}>×</button>
        </span>
      ))}
    </div>
  );
}
