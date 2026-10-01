"use client";

import { useEffect, useState, type SelectHTMLAttributes } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Keka's green "Success!" card in the top-right corner. Pages pass the message
 * (usually from a `?done=` parameter set after a redirect); the parameter is
 * dropped once it has been shown so a refresh does not repeat it.
 */
export function Toast({ message, param = "done", tone = "success" }: { message: string | null; param?: string; tone?: "success" | "danger" }) {
  const [open, setOpen] = useState(!!message);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  useEffect(() => {
    if (!message) return;
    setOpen(true);
    const t = setTimeout(() => setOpen(false), 5000);
    if (search.get(param)) {
      const next = new URLSearchParams(search.toString());
      next.delete(param);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);
  if (!open || !message) return null;
  const ok = tone === "success";
  return (
    <div role="status" aria-live="polite" style={{
      position: "fixed", top: 66, right: 18, zIndex: 80, display: "flex", width: "min(440px, calc(100vw - 36px))",
      background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, boxShadow: "var(--shadow-lg)", overflow: "hidden",
    }}>
      <div style={{ width: 58, display: "grid", placeItems: "center", background: ok ? "#7cbf5a" : "var(--danger)", color: "#fff", flexShrink: 0 }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.7 2.7L16.2 9.5" /></svg>
      </div>
      <div style={{ padding: "14px 16px", flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 18, color: ok ? "#6aa84f" : "var(--danger)" }}>{ok ? "Success!" : "Something went wrong"}</div>
        <div style={{ fontSize: 14, marginTop: 4 }}>{message}</div>
      </div>
      <button type="button" aria-label="Dismiss" onClick={() => setOpen(false)} style={{ alignSelf: "flex-start", margin: 10, border: 0, background: "none", cursor: "pointer", color: "var(--text-subtle)" }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}

/** A GET form that submits itself when a select changes — Keka's filter bars. */
export function AutoSubmitSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} onChange={(e) => { props.onChange?.(e); e.currentTarget.form?.requestSubmit(); }} />;
}
