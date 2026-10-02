"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { requestAssetAction, suggestAssetTypeAction } from "@/app/actions/assets";
import { useAct, Banner } from "../../assets/_ui";

/**
 * Request an asset: a new one, a replacement for one you hold, or returning
 * one. "Suggest" asks the assistant which category and type fit what you
 * wrote; you can always pick them yourself or leave them blank.
 */

export function RequestAssetForm({ categories, held, initialType, initialHeld, aiEnabled, closeHref }: {
  categories: Array<{ id: string; name: string; types: Array<{ id: string; name: string }> }>;
  held: Array<{ id: string; label: string }>;
  initialType?: string;
  initialHeld?: string;
  aiEnabled: boolean;
  closeHref: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const { state, submit, pending } = useAct(requestAssetAction, () => router.push("/me/assets?view=requests", { scroll: false }));
  const [requestType, setRequestType] = useState(initialType === "REPLACEMENT" || initialType === "RETURN" ? initialType : "NEW_ASSET");
  const [categoryId, setCategoryId] = useState("");
  const [assetTypeId, setAssetTypeId] = useState("");
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
  const [suggesting, startSuggest] = useTransition();
  const types = categories.find((c) => c.id === categoryId)?.types ?? [];
  const err = (k: string) => (state.errors?.[k] ? <div className="text-xs" role="alert" style={{ color: "var(--danger)", marginTop: 4 }}>{state.errors[k]}</div> : null);

  const suggest = () => {
    const f = formRef.current;
    if (!f) return;
    const fd = new FormData();
    fd.set("title", String(new FormData(f).get("title") ?? ""));
    fd.set("reason", String(new FormData(f).get("reason") ?? ""));
    startSuggest(async () => {
      const r = await suggestAssetTypeAction({}, fd);
      setHint({ ok: !!r.ok, text: r.message ?? "" });
      if (r.ok && r.values?.categoryId) { setCategoryId(r.values.categoryId); setAssetTypeId(r.values.assetTypeId ?? ""); }
    });
  };

  return (
    <form ref={formRef} onSubmit={submit}>
      <Banner state={state.ok ? {} : state} />
      <div className="stack gap-3">
        <div className="field">
          <label className="label" htmlFor="rq-type">Request type</label>
          <select id="rq-type" name="requestType" className="select" value={requestType} onChange={(e) => setRequestType(e.target.value)}>
            <option value="NEW_ASSET">New asset</option>
            <option value="REPLACEMENT" disabled={held.length === 0}>Replace an asset I have</option>
            <option value="RETURN" disabled={held.length === 0}>Return an asset I have</option>
          </select>
        </div>
        {requestType !== "NEW_ASSET" ? (
          <div className="field">
            <label className="label" htmlFor="rq-held">{requestType === "RETURN" ? "Asset to return" : "Asset to replace"}</label>
            <select id="rq-held" name="heldAssetId" className="select" required defaultValue={held.some((h) => h.id === initialHeld) ? initialHeld : ""}>
              <option value="" disabled>Select one of your assets…</option>
              {held.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
            </select>
            {err("heldAssetId")}
          </div>
        ) : null}
        <div className="field">
          <label className="label" htmlFor="rq-title">{requestType === "RETURN" ? "What are you returning?" : "Asset requested for"}</label>
          <input id="rq-title" name="title" className="input" required minLength={2} maxLength={120} placeholder="e.g. A second monitor for my desk" />
          {err("title")}
        </div>
        <div className="field">
          <label className="label" htmlFor="rq-reason">Reason for request</label>
          <textarea id="rq-reason" name="reason" className="textarea" rows={3} required minLength={3} maxLength={1000} />
          {err("reason")}
        </div>
        <div className="row gap-3" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="rq-cat">Asset category</label>
            <select id="rq-cat" name="categoryId" className="select" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setAssetTypeId(""); }}>
              <option value="">Not sure</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="rq-at">Asset type</label>
            <select id="rq-at" name="assetTypeId" className="select" value={assetTypeId} onChange={(e) => setAssetTypeId(e.target.value)} disabled={!categoryId}>
              <option value="">Not sure</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {err("assetTypeId")}
          </div>
          {aiEnabled ? <button type="button" className="btn" onClick={suggest} disabled={suggesting}>{suggesting ? "Thinking…" : "Suggest"}</button> : null}
        </div>
        {hint ? <div className="text-xs" role="status" style={{ color: hint.ok ? "var(--success)" : "var(--text-muted)" }}>{hint.text}</div> : null}
        {requestType !== "RETURN" ? (
          <div className="field">
            <label className="label" htmlFor="rq-by">Needed by</label>
            <input id="rq-by" name="neededBy" type="date" className="input" min={new Date().toISOString().slice(0, 10)} />
            {err("neededBy")}
          </div>
        ) : null}
      </div>
      <div className="row gap-2" style={{ justifyContent: "flex-end", marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
        <button type="button" className="btn" onClick={() => router.push(closeHref, { scroll: false })}>Cancel</button>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? "Sending…" : "Raise request"}</button>
      </div>
    </form>
  );
}
