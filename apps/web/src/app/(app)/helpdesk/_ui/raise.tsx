"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Sheet } from "@/components/sheet";
import { raiseTicketAction, aiSuggestCategoryAction } from "@/app/actions/helpdesk";
import type { ActionState } from "@/lib/forms";
import { CategoryPicker, type PickerCategory } from "./category-picker";
import { Editor, type EditorHandle } from "./editor";
import { AttachFiles } from "./attach";
import s from "./hd.module.css";

/** "+ New Ticket" → the "Raise a ticket" drawer. `?new=1` opens it on arrival. */
export function NewTicketButton({ categories }: { categories: PickerCategory[] }) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(() => search.get("new") === "1");
  const close = () => {
    setOpen(false);
    if (search.get("new")) {
      const next = new URLSearchParams(search.toString());
      next.delete("new");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  };
  return (
    <>
      <button type="button" className={`btn primary ${s.bigBtn}`} onClick={() => setOpen(true)} aria-haspopup="dialog">+ New Ticket</button>
      <Sheet open={open} onClose={close} title="Raise a ticket" side>
        <RaiseForm categories={categories} onCancel={close} />
      </Sheet>
    </>
  );
}

function RaiseForm({ categories, onCancel }: { categories: PickerCategory[]; onCancel: () => void }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(raiseTicketAction, {});
  const [categoryId, setCategoryId] = useState<string | null>(state.values?.categoryId || null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [suggesting, startSuggest] = useTransition();
  const [suggestion, setSuggestion] = useState<{ text: string; docs: Array<{ id: string; title: string }> } | null>(null);
  const title = useRef<HTMLInputElement>(null);
  const editor = useRef<EditorHandle>(null);

  useEffect(() => {
    if (state.ok && state.values?.ticketId) router.push(`/me/helpdesk/${state.values.ticketId}?raised=1`);
  }, [state, router]);

  const suggest = () => startSuggest(async () => {
    const res = await aiSuggestCategoryAction({ title: title.current?.value ?? "", description: editor.current?.value() ?? "" });
    if (!res.ok) { setSuggestion({ text: res.reason, docs: [] }); return; }
    if (res.value.categoryId) setCategoryId(res.value.categoryId);
    setSuggestion({ text: res.value.categoryId ? "We picked the category that fits best — change it if it's not right." : "No category stood out; pick the closest one.", docs: res.value.documents });
  });

  const err = (k: string) => state.errors?.[k];
  return (
    <form action={action}>
      <div className={s.band}>You can share any concern or seek help from your organization.</div>
      {state.message && !state.ok ? <div className="callout danger" style={{ marginBottom: 18 }}><div>{state.message}</div></div> : null}

      <div className={s.formField}>
        <label className={s.formLabel}>Need help regarding</label>
        <CategoryPicker categories={categories} value={categoryId} onChange={(id) => { setCategoryId(id); }} invalid={!!err("categoryId")} />
        {err("categoryId") ? <div className={s.err}>{err("categoryId")}</div> : null}
        {categories.length === 0 ? <div className={s.hint}>No helpdesk categories are open to you yet. Ask HR to set them up.</div> : null}
      </div>

      <div className={s.formField}>
        <label className={s.formLabel} htmlFor="subject">Title</label>
        <input ref={title} id="subject" name="subject" className={s.input} maxLength={160} defaultValue={state.values?.subject} style={err("subject") ? { borderColor: "var(--danger)" } : undefined} />
        {err("subject") ? <div className={s.err}>{err("subject")}</div> : null}
      </div>

      <div className={s.formField}>
        <label className={s.formLabel} htmlFor="description">Please share the assistance required</label>
        <Editor ref={editor} name="description" rows={9} defaultValue={state.values?.description} invalid={!!err("description")} />
        {err("description") ? <div className={s.err}>{err("description")}</div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" className={s.aiBtn} onClick={suggest} disabled={suggesting}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></svg>
            {suggesting ? "Thinking…" : "Suggest a category"}
          </button>
        </div>
      </div>
      {suggestion ? (
        <div className={s.suggest} role="status">
          <div>{suggestion.text}</div>
          {suggestion.docs.length ? (
            <div style={{ marginTop: 6 }}>Related policies that may already answer this: {suggestion.docs.map((d, i) => (
              <span key={d.id}>{i ? ", " : ""}<a className={s.link} href={`/documents?doc=${d.id}`} target="_blank" rel="noreferrer">{d.title}</a></span>
            ))}</div>
          ) : null}
        </div>
      ) : null}

      <AttachFiles onError={setFileError} />
      {fileError || err("files") ? <div className={s.err}>{fileError ?? err("files")}</div> : null}

      <div className={s.drawerFoot}>
        <button type="button" className="btn lg" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary lg" disabled={pending || !!fileError}>{pending ? "Raising…" : "Raise ticket"}</button>
      </div>
    </form>
  );
}
