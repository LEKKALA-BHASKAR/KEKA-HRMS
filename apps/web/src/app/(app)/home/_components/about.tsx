"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { saveAboutMeAction } from "@/app/actions/profile";
import type { ActionState } from "@/lib/forms";
import s from "../home.module.css";

const MAX = 1000;
const EMPTY: ActionState = {};

/** The "About" response under "Introduce yourself": read, add or edit in place. */
export function AboutResponse({ about }: { about: string | null }) {
  const [state, action, pending] = useActionState(saveAboutMeAction, EMPTY);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(about ?? "");
  const id = useId();

  // Close the editor once the save lands; the page re-renders with the new text.
  useEffect(() => {
    if (state.ok) setEditing(false);
  }, [state]);

  const error = state.errors?.aboutMe;

  return (
    <div className={s.respRow}>
      <div className={s.respTop}>
        <span className={s.respLabel} id={`${id}-label`}>About</span>
        {!editing ? (
          <button
            type="button"
            className={s.textBtn}
            onClick={() => { setText(about ?? ""); setEditing(true); }}
            aria-describedby={`${id}-label`}
          >
            {about ? "Edit" : "Add Response"}
          </button>
        ) : null}
      </div>

      {!editing && about ? <p className={s.respText} style={{ marginBottom: 0 }}>{about}</p> : null}
      {!editing && state.ok && state.message ? (
        <div role="status" className={`${s.formMsg} ${s.ok}`} style={{ textAlign: "left", maxWidth: "none", marginTop: 8 }}>{state.message}</div>
      ) : null}

      {editing ? (
        <form action={action} className={s.aboutForm}>
          <label htmlFor={`${id}-text`} className="sr-only">About you</label>
          <textarea
            id={`${id}-text`}
            name="aboutMe"
            className="textarea"
            rows={5}
            maxLength={MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="A few lines about you — your work, what you enjoy, how colleagues can reach you best."
            aria-invalid={!!error}
            aria-describedby={`${id}-count${error ? ` ${id}-err` : ""}`}
            autoFocus
          />
          <div className={s.aboutFoot}>
            <span id={`${id}-count`} className={s.charCount}>{text.length} / {MAX}</span>
            <div className={s.composeActions}>
              <button type="button" className="btn" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
              <button type="submit" className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
            </div>
          </div>
          {error || (state.ok === false && state.message) ? (
            <div id={`${id}-err`} role="alert" className={`${s.formMsg} ${s.err}`} style={{ textAlign: "left", maxWidth: "none" }}>
              {error ?? state.message}
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
