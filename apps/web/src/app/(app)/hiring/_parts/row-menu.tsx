"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { archiveRequisitionAction, openJobAction } from "@/app/actions/hiring";
import type { ActionState } from "@/lib/forms";
import { Toast } from "./toast";
import s from "../hire.module.css";

/** The "⋯" on a requisition row: View, Edit, Open job, Archive / Unarchive. */
export function RowMenu({ viewHref, editHref, canEdit, canArchive, archived, canOpenJob, id }: {
  viewHref: string; editHref: string; canEdit: boolean; canArchive: boolean; archived: boolean; canOpenJob: boolean; id: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [archState, archive, archPending] = useActionState(archiveRequisitionAction, {} as ActionState);
  const [jobState, openJob, jobPending] = useActionState(openJobAction, {} as ActionState);
  const [toast, setToast] = useState<ActionState | null>(null);
  useEffect(() => { if (archState.message) setToast(archState); }, [archState]);
  useEffect(() => { if (jobState.message) setToast(jobState); }, [jobState]);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);
  return (
    <>
      <details ref={ref} className={s.menu}>
        <summary aria-label="Actions">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="5.5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="18.5" cy="12" r="1.5" /></svg>
        </summary>
        <div className={s.menuList}>
          <Link href={viewHref} scroll={false}>View</Link>
          {canEdit ? <Link href={editHref} scroll={false}>Edit</Link> : null}
          {canOpenJob ? (
            <form action={openJob}>
              <input type="hidden" name="requisitionId" value={id} />
              <button type="submit" disabled={jobPending}>{jobPending ? "Opening…" : "Open job"}</button>
            </form>
          ) : null}
          {canArchive ? (
            <form action={archive}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="archive" value={archived ? "0" : "1"} />
              <button type="submit" disabled={archPending}>{archived ? "Unarchive" : "Archive"}</button>
            </form>
          ) : null}
        </div>
      </details>
      {toast?.message ? <Toast message={toast.message} ok={!!toast.ok} onClose={() => setToast(null)} /> : null}
    </>
  );
}
