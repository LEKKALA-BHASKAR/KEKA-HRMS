"use client";

/** Selects that submit their GET form as soon as they change. */

export function AutoSelect({ name, value, all, options }: { name: string; value?: string; all: string; options: Array<{ id: string; name: string }> }) {
  return (
    <select name={name} className="select" defaultValue={value ?? ""} aria-label={all} onChange={(e) => e.currentTarget.form?.requestSubmit()} style={{ minWidth: 176 }}>
      <option value="">{all}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

export function CategorySelect({ value, options }: { value?: string; options: Array<{ id: string; name: string }> }) {
  return <AutoSelect name="category" value={value} all="All Asset Category" options={options} />;
}
