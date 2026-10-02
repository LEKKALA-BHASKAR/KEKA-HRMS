"use client";

import { useState } from "react";
import { useForm, Field, TextInput, CheckboxInput, TextArea } from "@/components/form";
import { SignaturePad } from "../../(app)/documents/letters/forms";
import { acceptOfferAction, declineOfferAction } from "../actions";

/** Accept with an e-signature, or decline with a reason. Only one is open at a time. */
export function RespondToOffer({ token, name }: { token: string; name: string }) {
  const [mode, setMode] = useState<"accept" | "decline" | null>(null);
  const [accState, accept, accepting] = useForm(acceptOfferAction);
  const [decState, decline, declining] = useForm(declineOfferAction);
  const [sig, setSig] = useState("");
  const done = accState.ok ? accState : decState.ok ? decState : null;
  if (done) return <div className="callout success">{done.message}</div>;

  return (
    <div className="stack gap-3">
      {mode === null ? (
        <div className="row gap-2 wrap">
          <button type="button" className="btn primary" onClick={() => setMode("accept")}>Accept and sign</button>
          <button type="button" className="btn" onClick={() => setMode("decline")}>Decline</button>
        </div>
      ) : null}

      {mode === "accept" ? (
        <form action={accept} className="stack gap-3">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="signature" value={sig} />
          <Field label="Draw your signature" name="signature" required><SignaturePad onChange={setSig} /></Field>
          <Field label="Type your full name" name="typedName" required hint={`As it appears on the offer: ${name}`}>
            <TextInput name="typedName" state={accState} required />
          </Field>
          <CheckboxInput name="consent" label="I accept this offer and agree to sign it electronically; my electronic signature is as valid as one on paper." />
          <div className="row gap-2 wrap">
            <button className="btn primary" disabled={accepting || !sig}>{accepting ? "Signing…" : "Sign and accept"}</button>
            <button type="button" className="btn ghost" onClick={() => setMode(null)} disabled={accepting}>Back</button>
          </div>
          {accState.message && !accState.ok ? <div className="callout danger">{accState.message}</div> : null}
        </form>
      ) : null}

      {mode === "decline" ? (
        <form action={decline} className="stack gap-3">
          <input type="hidden" name="token" value={token} />
          <Field label="Why are you declining?" name="reason" required hint="It goes to the hiring team only.">
            <TextArea name="reason" state={decState} rows={3} required />
          </Field>
          <div className="row gap-2 wrap">
            <button className="btn danger" disabled={declining}>{declining ? "Sending…" : "Decline the offer"}</button>
            <button type="button" className="btn ghost" onClick={() => setMode(null)} disabled={declining}>Back</button>
          </div>
          {decState.message && !decState.ok ? <div className="callout danger">{decState.message}</div> : null}
        </form>
      ) : null}
    </div>
  );
}
