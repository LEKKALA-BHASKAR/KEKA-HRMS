"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/forms";
import { sendWishAction } from "@/app/actions/home-wall";
import { Avatar } from "@/components/avatar";
import { IconSmile } from "./icons";
import d from "../dash.module.css";

const EMPTY: ActionState = {};
const EMOJI = ["🎉", "🎂", "🥳", "🎈", "🎁", "👏", "😊", "❤️"];

/** The Wish box: prefilled, editable, posted to the wall. */
export function WishForm({ employeeId, occasion, initial, me, closeHref }: {
  employeeId: string; occasion: string; initial: string; me: { name: string; photoUrl: string | null }; closeHref: string;
}) {
  const [state, action, pending] = useActionState(sendWishAction, EMPTY);
  const [text, setText] = useState(initial);
  const [emoji, setEmoji] = useState(false);
  const router = useRouter();
  useEffect(() => { if (state.ok) router.refresh(); }, [state, router]);
  if (state.ok) {
    return (
      <div className={d.wishBox} role="status">
        <strong style={{ fontWeight: 500 }}>{state.message}</strong>
        <button type="button" className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => router.replace(closeHref, { scroll: false })}>Close</button>
      </div>
    );
  }
  return (
    <form action={action} className={d.wishBox}>
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="occasion" value={occasion} />
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <Avatar name={me.name} photoUrl={me.photoUrl} size={34} />
        <textarea name="message" aria-label="Your wish" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} style={{ flex: 1 }} />
      </div>
      {emoji ? <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{EMOJI.map((e) => <button key={e} type="button" className={d.roundBtn} aria-label={`Insert ${e}`} onClick={() => { setText((t) => `${t}${e}`); setEmoji(false); }}>{e}</button>)}</div> : null}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" className={d.roundBtn} aria-label="Add an emoji" onClick={() => setEmoji((x) => !x)}><IconSmile /></button>
        {state.ok === false && state.message ? <span className={d.err} role="alert">{state.message}</span> : null}
        <button type="submit" className="btn primary" style={{ marginLeft: "auto", background: "#6b4fa0", borderColor: "#6b4fa0" }} disabled={pending || !text.trim()}>{pending ? "Sending…" : "Wish"}</button>
      </div>
    </form>
  );
}
