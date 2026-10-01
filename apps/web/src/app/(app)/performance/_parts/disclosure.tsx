"use client";

import { useState, type ReactNode } from "react";

/** A button that reveals a form below it, and turns into "Cancel" while open. */
export function Disclosure({ label, children, defaultOpen }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <>
      <button type="button" className={`btn sm${open ? "" : " primary"}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Cancel" : label}</button>
      {open ? <div style={{ marginTop: 14 }}>{children}</div> : null}
    </>
  );
}
