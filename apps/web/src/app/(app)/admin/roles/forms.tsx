"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, TextArea, SelectInput, DangerButton, FormBanner, SubmitButton, useForm } from "@/components/form";
import { saveCustomRoleAction, duplicateRoleAction, deleteCustomRoleAction, assignRoleAction, removeAssignmentAction } from "@/app/actions/roles";

type Group = { module: string; label: string; permissions: Array<{ key: string; label: string }> };

/** Name, description and the permission catalogue as ticks, grouped by module. */
export function RoleEditor({ role, groups, readOnly }: {
  role: { id?: string; name: string; description: string | null; permissions: string[] };
  groups: Group[];
  readOnly?: boolean;
}) {
  const [picked, setPicked] = useState(() => new Set(role.permissions));
  const toggle = (keys: string[], on: boolean) => setPicked((prev) => {
    const next = new Set(prev);
    for (const k of keys) if (on) next.add(k); else next.delete(k);
    return next;
  });

  const body = (
    <div className="stack gap-3">
      <div className="text-sm muted">{picked.size} permission{picked.size === 1 ? "" : "s"} selected</div>
      {groups.map((g) => {
        const keys = g.permissions.map((p) => p.key);
        const all = keys.every((k) => picked.has(k));
        return (
          <fieldset key={g.module} className="card" style={{ padding: 12, margin: 0 }} disabled={readOnly}>
            <div className="row gap-2" style={{ justifyContent: "space-between", marginBottom: 6 }}>
              <span className="strong text-sm">{g.label}</span>
              {readOnly ? null : (
                <button type="button" className="btn ghost sm" onClick={() => toggle(keys, !all)}>{all ? "Clear all" : "Select all"}</button>
              )}
            </div>
            <div className="grid grid-2">
              {g.permissions.map((p) => (
                <label key={p.key} className="checkbox-row">
                  <input type="checkbox" name="permission" value={p.key} checked={picked.has(p.key)} onChange={(e) => toggle([p.key], e.target.checked)} />
                  <span>
                    <span className="text-sm">{p.label}</span>
                    <div className="mono text-xs subtle">{p.key}</div>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );

  if (readOnly) return body;
  return (
    <ActionForm action={saveCustomRoleAction} submitLabel={role.id ? "Save role" : "Create role"} hidden={role.id ? { id: role.id } : undefined}>
      {(state) => (
        <div className="stack gap-3">
          <div className="grid grid-2">
            <Field label="Role name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={role.name} required maxLength={80} /></Field>
            <Field label="Description" name="description" state={state}><TextArea name="description" state={state} defaultValue={role.description} rows={2} /></Field>
          </div>
          {body}
        </div>
      )}
    </ActionForm>
  );
}

export function DuplicateRoleButton({ id }: { id: string }) {
  const [state, formAction, pending] = useForm(duplicateRoleAction);
  return (
    <form action={formAction} className="row gap-2">
      <input type="hidden" name="id" value={id} />
      <button className="btn sm" type="submit" disabled={pending}>{pending ? "…" : "Duplicate"}</button>
      {state.message ? <span className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.message}</span> : null}
    </form>
  );
}

export function DeleteRoleButton({ id, name }: { id: string; name: string }) {
  return <DangerButton action={deleteCustomRoleAction} hidden={{ id }} label="Delete role" confirmLabel={`Delete ${name}? This cannot be undone.`} />;
}

export function RemoveAssignmentButton({ id, label }: { id: string; label: string }) {
  return <DangerButton action={removeAssignmentAction} hidden={{ id }} label="Remove" confirmLabel={`Remove ${label}?`} />;
}

/**
 * Grant a role to a person, or re-scope a grant they already hold. Leaving
 * every scope box empty makes the grant unscoped.
 */
export function AssignRoleForm({ roles, people, departments, locations }: {
  roles: Array<{ id: string; name: string }>;
  people: Array<{ id: string; label: string }>;
  departments: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
}) {
  const [state, formAction, pending] = useForm(assignRoleAction);
  return (
    <form action={formAction} style={{ padding: 14 }}>
      <FormBanner state={state} />
      <div className="grid grid-2">
        <Field label="Person" name="employeeId" state={state} required>
          <SelectInput name="employeeId" state={state} options={people.map((p) => ({ value: p.id, label: p.label }))} placeholder="Choose a person" required />
        </Field>
        <Field label="Role" name="roleId" state={state} required>
          <SelectInput name="roleId" state={state} options={roles.map((r) => ({ value: r.id, label: r.name }))} placeholder="Choose a role" required />
        </Field>
      </div>
      <div className="text-xs strong subtle" style={{ margin: "8px 0" }}>SCOPE — LEAVE EMPTY FOR EVERY EMPLOYEE</div>
      <div className="grid grid-2">
        <div>
          <div className="text-sm strong" style={{ marginBottom: 4 }}>Departments</div>
          {departments.map((d) => (
            <label key={d.id} className="checkbox-row"><input type="checkbox" name="departmentId" value={d.id} /><span className="text-sm">{d.name}</span></label>
          ))}
        </div>
        <div>
          <div className="text-sm strong" style={{ marginBottom: 4 }}>Locations</div>
          {locations.map((l) => (
            <label key={l.id} className="checkbox-row"><input type="checkbox" name="locationId" value={l.id} /><span className="text-sm">{l.name}</span></label>
          ))}
        </div>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>Granting a role someone already holds replaces its scope.</div>
      <div style={{ marginTop: 10 }}><SubmitButton pending={pending}>Save assignment</SubmitButton></div>
    </form>
  );
}
