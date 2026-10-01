"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import s from "../hire.module.css";

/** Keka's corner toast: a green (or red) band, "Success!" and the message. */
export function Toast({ message, ok = true, onClose }: { message: string; ok?: boolean; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  return (
    <div className={s.toast} role="status" aria-live="polite">
      <div className={`${s.toastBand}${ok ? "" : ` ${s.bad}`}`}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" />{ok ? <path d="m8 12.5 2.6 2.6L16.4 9" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M12 7.5v5.5M12 16.4h.01" strokeLinecap="round" />}
        </svg>
      </div>
      <div className={s.toastBody}>
        <div className={`${s.toastTitle}${ok ? "" : ` ${s.bad}`}`}>{ok ? "Success!" : "Not done"}</div>
        <div className={s.toastMsg}>{message}</div>
      </div>
      <button type="button" className={s.toastX} aria-label="Dismiss" onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}

/** A toast carried in the URL (`?flash=…`) across a redirect, then dropped from it. */
export function FlashToast({ messages }: { messages: Record<string, string> }) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const key = search.get("flash");
  const [shown, setShown] = useState<string | null>(key && messages[key] ? messages[key] : null);
  useEffect(() => {
    if (!key) return;
    if (messages[key]) setShown(messages[key]);
    const next = new URLSearchParams(search.toString());
    next.delete("flash");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [key, messages, pathname, router, search]);
  return shown ? <Toast message={shown} onClose={() => setShown(null)} /> : null;
}
