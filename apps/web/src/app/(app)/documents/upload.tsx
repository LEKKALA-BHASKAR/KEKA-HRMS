"use client";

import { useState } from "react";
import { useForm } from "@/components/form";
import { uploadDocumentAction } from "@/app/actions/documents";

export function UploadDocument({ documentId, trackExpiry, label = "Upload" }: { documentId: string; trackExpiry?: boolean; label?: string }) {
  const [state, action, pending] = useForm(uploadDocumentAction);
  const [open, setOpen] = useState(false);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  if (!open) return <button type="button" className="btn sm" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form action={action} className="stack gap-2" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="documentId" value={documentId} />
      <input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required className="text-xs" />
      {trackExpiry ? <label className="text-xs muted">Expires <input type="date" name="expiresOn" className="input" style={{ width: 150, padding: "3px 6px" }} /></label> : null}
      <div className="row gap-2">
        <button className="btn sm primary" disabled={pending}>{pending ? "Uploading…" : "Upload"}</button>
        <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
      <div className="text-xs subtle">PDF, PNG or JPEG, up to 10 MB</div>
    </form>
  );
}
