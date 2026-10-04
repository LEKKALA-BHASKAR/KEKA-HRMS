"use client";

import { useActionState, useEffect, useState } from "react";
import { Sheet } from "@/components/sheet";
import { FormBanner } from "@/components/form";
import { saveCategoryAction, setCategoryActiveAction, deleteCategoryAction, addPredefinedCategoriesAction } from "@/app/actions/helpdesk";
import type { ActionState } from "@/lib/forms";
import { MultiSelect, Dropdown, type MultiOption } from "./controls";
import s from "./hd.module.css";

export interface CategoryValue {
  id: string; name: string; description: string | null; isActive: boolean; tickets: number;
  audienceType: "ALL" | "EMPLOYEES" | "GROUPS";
  audience: { employeeIds: string[]; departmentIds: string[]; locationIds: string[]; businessUnitIds: string[] };
  defaultAssigneeUserId: string | null; agentUserIds: string[]; assignMode: "HEAD" | "ROUND_ROBIN" | "LEAST_LOADED" | "UNASSIGNED";
  businessHoursId: string | null; enableOnHold: boolean; firstResponseHours: number; slaHours: number; defaultPriority: string | null;
  subcategories: Array<{ id: string; name: string; description: string | null; head: string | null; isActive: boolean }>;
}

export interface CategoryOptions {
  users: MultiOption[]; employees: MultiOption[]; departments: MultiOption[]; locations: MultiOption[]; businessUnits: MultiOption[];
  businessHours: MultiOption[]; predefined: Array<{ name: string; description: string; subcategories: number; exists: boolean }>;
}

/** A multi-select that posts each picked value as a hidden `name` field. */
function MultiField({ name, label, options, initial }: { name: string; label: string; options: MultiOption[]; initial: string[] }) {
  const [value, setValue] = useState(initial);
  const labels = options.filter((o) => value.includes(o.value)).map((o) => o.label);
  return (
    <>
      {value.map((v) => <input key={v} type="hidden" name={name} value={v} />)}
      <MultiSelect boxed label={label} options={options} value={value} onApply={setValue} summary={labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`} />
    </>
  );
}

/**
 * Settings › Ticket Categories: a card per category with its description and
 * subcategory count, a menu to edit, (de)activate or delete it, and the
 * add / predefined sheets.
 */
export function CategoryBoard({ categories, options }: { categories: CategoryValue[]; options: CategoryOptions }) {
  const [editing, setEditing] = useState<CategoryValue | "new" | null>(null);
  const [predefined, setPredefined] = useState(false);
  const [show, setShow] = useState<"active" | "inactive">("active");
  const shown = categories.filter((c) => (show === "active" ? c.isActive : !c.isActive));
  const current = editing && editing !== "new" ? editing : null;
  return (
    <>
      <div className={s.sectionRow}>
        <div className={s.controls}>
          <select className={`select ${s.selectBox}`} value={show} onChange={(e) => setShow(e.target.value as "active" | "inactive")} aria-label="Show">
            <option value="active">Active categories ({categories.filter((c) => c.isActive).length})</option>
            <option value="inactive">Inactive categories ({categories.filter((c) => !c.isActive).length})</option>
          </select>
        </div>
        <div className={s.controls}>
          <button type="button" className="btn" onClick={() => setPredefined(true)}>Choose from predefined</button>
          <button type="button" className="btn primary" onClick={() => setEditing("new")}>+ Add Category</button>
        </div>
      </div>
      {shown.length === 0 ? <div className={`${s.panel} ${s.empty}`}>{show === "active" ? "No categories yet. Add one or start from the predefined set." : "No inactive categories."}</div> : (
        <div className={s.catGrid}>
          {shown.map((c) => (
            <div key={c.id} className={s.catCard}>
              <div className={s.cardMenu}><CardMenu category={c} onEdit={() => setEditing(c)} /></div>
              <button type="button" className={s.catCardTitle} onClick={() => setEditing(c)} style={{ background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer" }}>{c.name}</button>
              <div className={s.catCardDesc}>{c.description ?? <span className={s.subtle}>No description</span>}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {c.subcategories.filter((x) => x.isActive).length ? <span className={s.subChip}>{c.subcategories.filter((x) => x.isActive).length} subcategories</span> : null}
                {!c.isActive ? <span className={`${s.subChip} ${s.inactive}`}>Inactive</span> : null}
                <span className={`${s.subChip} ${s.inactive}`}>{c.firstResponseHours}h / {c.slaHours}h SLA</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={current ? `Edit ${current.name}` : "Add ticket category"} side>
        <CategoryForm value={current} options={options} onDone={() => setEditing(null)} />
      </Sheet>
      <Sheet open={predefined} onClose={() => setPredefined(false)} title="Choose from predefined categories" side>
        <PredefinedForm options={options.predefined} onDone={() => setPredefined(false)} />
      </Sheet>
    </>
  );
}

function CardMenu({ category, onEdit }: { category: CategoryValue; onEdit: () => void }) {
  const [toggle, runToggle] = useActionState<ActionState, FormData>(setCategoryActiveAction, {});
  const [del, runDelete] = useActionState<ActionState, FormData>(deleteCategoryAction, {});
  const failed = [toggle, del].find((x) => x.message && !x.ok);
  return (
    <>
      <Dropdown right button={<span aria-label={`Actions for ${category.name}`}>⋯</span>}>
        {(close) => (
          <div style={{ minWidth: 170 }}>
            <button type="button" className={s.ddOption} onClick={() => { close(); onEdit(); }}>Edit</button>
            <form action={runToggle}>
              <input type="hidden" name="id" value={category.id} />
              <input type="hidden" name="active" value={String(!category.isActive)} />
              <button type="submit" className={s.ddOption}>{category.isActive ? "Deactivate" : "Activate"}</button>
            </form>
            {category.tickets === 0 ? (
              <form action={runDelete} onSubmit={(e) => { if (!confirm(`Delete ${category.name} and its subcategories?`)) e.preventDefault(); }}>
                <input type="hidden" name="id" value={category.id} />
                <button type="submit" className={`${s.ddOption} ${s.menuDanger}`}>Delete</button>
              </form>
            ) : null}
          </div>
        )}
      </Dropdown>
      {failed ? <div className="text-xs" style={{ color: "var(--danger)", position: "absolute", right: 0, top: 36, width: 200 }}>{failed.message}</div> : null}
    </>
  );
}

function CategoryForm({ value, options, onDone }: { value: CategoryValue | null; options: CategoryOptions; onDone: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveCategoryAction, {});
  useEffect(() => { if (state.ok) onDone(); }, [state, onDone]);
  const [audience, setAudience] = useState(value?.audienceType ?? "ALL");
  const [mode, setMode] = useState(value?.assignMode ?? "HEAD");
  const [split, setSplit] = useState((value?.subcategories.filter((x) => x.isActive).length ?? 0) > 0);
  const [subs, setSubs] = useState(() => {
    const active = value?.subcategories.filter((x) => x.isActive) ?? [];
    return active.length ? active.map((x, i) => ({ key: i, ...x })) : [{ key: 0, id: "", name: "", description: null, head: null, isActive: true }];
  });
  const err = (k: string) => (state.errors?.[k] ? <div className={s.err}>{state.errors[k]}</div> : null);
  const userOpts = options.users;

  return (
    <form action={action}>
      {value ? <input type="hidden" name="id" value={value.id} /> : null}
      <FormBanner state={state.ok ? {} : state} />

      <div className={s.formField}>
        <label className={s.formLabel} htmlFor="cat-name">Category name</label>
        <input id="cat-name" name="name" className={s.input} maxLength={80} defaultValue={value?.name} />
        {err("name")}
      </div>
      <div className={s.formField}>
        <label className={s.formLabel} htmlFor="cat-desc">Description</label>
        <textarea id="cat-desc" name="description" className="textarea" rows={3} maxLength={500} defaultValue={value?.description ?? ""} />
        <div className={s.hint}>Employees see this when they pick a category.</div>
      </div>

      <div className={s.formField}>
        <div className={s.formLabel}>Who can raise tickets in this category</div>
        <div className={s.radioCol}>
          {([["ALL", "All employees"], ["GROUPS", "Employees in selected departments, locations or business units"], ["EMPLOYEES", "Selected employees"]] as const).map(([v, l]) => (
            <label key={v}><input type="radio" name="audienceType" value={v} checked={audience === v} onChange={() => setAudience(v)} /> {l}</label>
          ))}
        </div>
        {err("audienceType")}
        {audience === "GROUPS" ? (
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            <MultiField name="departmentIds" label="Departments" options={options.departments} initial={value?.audience.departmentIds ?? []} />
            <MultiField name="locationIds" label="Locations" options={options.locations} initial={value?.audience.locationIds ?? []} />
            <MultiField name="businessUnitIds" label="Business units" options={options.businessUnits} initial={value?.audience.businessUnitIds ?? []} />
          </div>
        ) : null}
        {audience === "EMPLOYEES" ? (
          <div style={{ marginTop: 12 }}><MultiField name="audienceEmployeeIds" label="Employees" options={options.employees} initial={value?.audience.employeeIds ?? []} /></div>
        ) : null}
      </div>

      <div className={s.twoCol}>
        <div className={s.formField}>
          <label className={s.formLabel} htmlFor="cat-head">Category head</label>
          <select id="cat-head" name="defaultAssigneeUserId" className="select" defaultValue={value?.defaultAssigneeUserId ?? ""} style={{ width: "100%" }}>
            <option value="">No head</option>
            {userOpts.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
        </div>
        <div className={s.formField}>
          <div className={s.formLabel}>Agents</div>
          <MultiField name="agentUserIds" label="Agents" options={userOpts} initial={value?.agentUserIds ?? []} />
          {err("agentUserIds")}
        </div>
      </div>

      <div className={s.formField}>
        <div className={s.formLabel}>Assign new tickets to</div>
        <div className={s.radioCol}>
          {([["HEAD", "The category head"], ["ROUND_ROBIN", "Agents in turn (round robin)"], ["LEAST_LOADED", "The agent with the fewest open tickets"], ["UNASSIGNED", "Nobody — agents pick them up"]] as const).map(([v, l]) => (
            <label key={v}><input type="radio" name="assignMode" value={v} checked={mode === v} onChange={() => setMode(v)} /> {l}</label>
          ))}
        </div>
      </div>

      <div className={s.twoCol}>
        <div className={s.formField}>
          <label className={s.formLabel} htmlFor="cat-fr">First response within (hours)</label>
          <input id="cat-fr" name="firstResponseHours" type="number" min={1} max={720} className={s.input} defaultValue={value?.firstResponseHours ?? 8} />
          {err("firstResponseHours")}
        </div>
        <div className={s.formField}>
          <label className={s.formLabel} htmlFor="cat-sla">Resolve within (hours)</label>
          <input id="cat-sla" name="slaHours" type="number" min={1} max={720} className={s.input} defaultValue={value?.slaHours ?? 48} />
          {err("slaHours")}
        </div>
      </div>
      <div className={s.twoCol}>
        <div className={s.formField}>
          <label className={s.formLabel} htmlFor="cat-bh">Business hours</label>
          <select id="cat-bh" name="businessHoursId" className="select" defaultValue={value?.businessHoursId ?? ""} style={{ width: "100%" }}>
            <option value="">Default business hours</option>
            {options.businessHours.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </div>
        <div className={s.formField}>
          <label className={s.formLabel} htmlFor="cat-prio">Default priority</label>
          <select id="cat-prio" name="defaultPriority" className="select" defaultValue={value?.defaultPriority ?? ""} style={{ width: "100%" }}>
            <option value="">NA</option>
            <option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option>
          </select>
        </div>
      </div>
      <div className={s.formField}>
        <label className={s.toggle}><input type="checkbox" name="enableOnHold" defaultChecked={value?.enableOnHold ?? false} /> Agents can put tickets On Hold (pauses the SLA)</label>
      </div>

      <div className={s.formField}>
        <div className={s.formLabel}>Split into subcategories?</div>
        <div className={s.radioCol}>
          <label><input type="radio" name="split" value="no" checked={!split} onChange={() => setSplit(false)} /> No, raise tickets against this category</label>
          <label><input type="radio" name="split" value="yes" checked={split} onChange={() => setSplit(true)} /> Yes, employees pick a subcategory</label>
        </div>
        {err("split")}
        {split ? (
          <div style={{ marginTop: 14 }}>
            {subs.map((sub, i) => (
              <div key={sub.key} className={s.subRow}>
                {sub.id ? <input type="hidden" name={`sub_${i}_id`} value={sub.id} /> : null}
                <input name={`sub_${i}_name`} className="input" placeholder="Subcategory name" maxLength={80} defaultValue={sub.name} aria-label="Subcategory name" />
                <input name={`sub_${i}_description`} className="input" placeholder="Description" maxLength={500} defaultValue={sub.description ?? ""} aria-label="Subcategory description" />
                <select name={`sub_${i}_head`} className="select" defaultValue={sub.head ?? ""} aria-label="Subcategory head">
                  <option value="">Category head</option>
                  {userOpts.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                </select>
                <button type="button" className={s.iconBtn} aria-label="Remove subcategory" onClick={() => setSubs((xs) => xs.filter((x) => x.key !== sub.key))} disabled={subs.length === 1}>×</button>
              </div>
            ))}
            {subs.length < 40 ? <button type="button" className={s.addLink} onClick={() => setSubs((xs) => [...xs, { key: Math.max(0, ...xs.map((x) => x.key)) + 1, id: "", name: "", description: null, head: null, isActive: true }])}>+ Add subcategory</button> : null}
            <div className={s.hint}>Subcategories share this category&apos;s audience, targets and hours; each may have its own head.</div>
          </div>
        ) : null}
      </div>

      <div className={s.drawerFoot}>
        <button type="button" className="btn lg" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary lg" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

function PredefinedForm({ options, onDone }: { options: CategoryOptions["predefined"]; onDone: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addPredefinedCategoriesAction, {});
  useEffect(() => { if (state.ok) onDone(); }, [state, onDone]);
  return (
    <form action={action}>
      <div className={s.band}>Start from the common categories. You can rename them and set heads afterwards.</div>
      <FormBanner state={state.ok ? {} : state} />
      <div className={s.radioCol}>
        {options.map((o) => (
          <label key={o.name} className={s.inlineCheck} style={{ alignItems: "flex-start", opacity: o.exists ? 0.55 : 1 }}>
            <input type="checkbox" name="names" value={o.name} disabled={o.exists} style={{ marginTop: 3 }} />
            <span>
              <span style={{ display: "block" }}>{o.name}{o.exists ? " (added)" : ""}</span>
              <span className={s.hint} style={{ display: "block", marginTop: 2 }}>{o.description}{o.subcategories ? ` · ${o.subcategories} subcategories` : ""}</span>
            </span>
          </label>
        ))}
      </div>
      <div className={s.drawerFoot}>
        <button type="button" className="btn lg" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary lg" disabled={pending}>{pending ? "Adding…" : "Add selected"}</button>
      </div>
    </form>
  );
}
