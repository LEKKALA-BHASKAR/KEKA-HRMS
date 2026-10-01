"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { givePraise } from "@/app/actions/workplace";
import s from "../home.module.css";

const BADGES = ["Team Player", "Above and Beyond", "Great Mentor", "Sharp Thinking", "Unblocked Me", "Customer Hero"];

/**
 * "Give praise from here": a quiet prompt that opens into a small composer,
 * posting through the same action as the Awards wall.
 */
export function PraiseComposer({ colleagues }: { colleagues: Array<{ id: string; name: string }> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();

  if (!open) {
    return (
      <>
        <button
          type="button"
          className={s.composeTrigger}
          onClick={() => { setOpen(true); setNotice(null); }}
          aria-label="Give praise to a colleague"
        >
          Give praise from here
        </button>
        {notice ? <div role="status" className={`${s.formMsg} ${s.ok}`} style={{ textAlign: "left", maxWidth: "none" }}>{notice}</div> : null}
      </>
    );
  }

  return (
    <form
      ref={formRef}
      className={s.composeForm}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        if (!String(fd.get("toEmployeeId") ?? "")) { setError("Choose who you are praising."); return; }
        if (!String(fd.get("message") ?? "").trim()) { setError("Write a few words about what they did."); return; }
        setError(null);
        start(async () => {
          try {
            await givePraise(fd);
            formRef.current?.reset();
            setOpen(false);
            setNotice("Praise posted to the wall.");
            router.refresh();
          } catch (err) {
            setError(err instanceof Error && err.message ? err.message : "Could not post your praise. Try again.");
          }
        });
      }}
    >
      <div className={s.composeRow}>
        <div>
          <label className="label" htmlFor={`${id}-to`}>Who deserves it?</label>
          <select id={`${id}-to`} name="toEmployeeId" className="select" required defaultValue="" autoFocus>
            <option value="" disabled>Choose a colleague</option>
            {colleagues.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-badge`}>Badge</label>
          <select id={`${id}-badge`} name="badge" className="select" defaultValue="">
            <option value="">No badge</option>
            {BADGES.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`${id}-msg`}>Message</label>
        <textarea id={`${id}-msg`} name="message" className="textarea" rows={3} maxLength={1000} required placeholder="What did they do? Be specific — it means more." />
      </div>
      {error ? <div role="alert" className={`${s.formMsg} ${s.err}`} style={{ textAlign: "left", maxWidth: "none" }}>{error}</div> : null}
      <div className={s.composeActions}>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? "Posting…" : "Post praise"}</button>
        <button type="button" className="btn" onClick={() => { setOpen(false); setError(null); }} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}
