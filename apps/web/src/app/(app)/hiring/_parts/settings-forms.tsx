"use client";

import { ActionForm, Field, TextInput, SelectInput, TextArea, DangerButton } from "@/components/form";
import { saveHiringSettingsAction, saveJdTemplateAction, deleteJdTemplateAction, addHiringFlowAction } from "@/app/actions/hiring";

export function HiringSettingsForm({ initial, approvers }: { initial: { instructions: string; approver: string; attempts: number }; approvers: Array<{ value: string; label: string }> }) {
  return (
    <ActionForm action={saveHiringSettingsAction} submitLabel="Save settings">
      {(state) => (
        <>
          <Field label="Requisition instructions" name="requisitionInstructions" state={state} hint="Shown at the top of every requisition.">
            <TextArea name="requisitionInstructions" state={state} rows={3} defaultValue={initial.instructions} />
          </Field>
          <Field label="Default approver" name="defaultApproverUserId" state={state} hint="Requisitions go to this person first; if they raised it, it routes to the next approver.">
            <SelectInput name="defaultApproverUserId" state={state} options={approvers} defaultValue={initial.approver} placeholder="The business unit head, then any approver" />
          </Field>
          <Field label="AI question generations per scorecard section" name="aiQuestionAttempts" state={state}>
            <TextInput name="aiQuestionAttempts" type="number" min={1} max={5} state={state} defaultValue={initial.attempts} />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

export function JdTemplateForm() {
  return (
    <ActionForm action={saveJdTemplateAction} submitLabel="Add template">
      {(state) => (
        <>
          <Field label="Title" name="title" state={state} required><TextInput name="title" state={state} required placeholder="Software Engineer" /></Field>
          <Field label="Job description" name="body" state={state} required hint="Markdown: **bold**, - bullets, 1. numbered."><TextArea name="body" state={state} rows={6} required /></Field>
        </>
      )}
    </ActionForm>
  );
}

export function DeleteTemplate({ id, title }: { id: string; title: string }) {
  return <DangerButton action={deleteJdTemplateAction} hidden={{ id }} label="Delete" confirmLabel={`Delete the "${title}" template?`} />;
}

export function FlowForm() {
  return (
    <ActionForm action={addHiringFlowAction} submitLabel="Add flow">
      {(state) => (
        <>
          <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} required placeholder="Leadership hiring" /></Field>
          <Field label="Stages" name="stages" state={state} required hint="Comma separated, in order. Interview rounds need feedback before a candidate moves on.">
            <TextInput name="stages" state={state} required placeholder="Applied, Screening, Technical interview, Manager round, Offer" />
          </Field>
        </>
      )}
    </ActionForm>
  );
}
