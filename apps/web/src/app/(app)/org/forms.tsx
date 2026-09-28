"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import {
  ActionForm, InlineForm, DangerButton, Field, TextInput, SelectInput, TextArea, CheckboxInput,
} from "@/components/form";
import {
  saveLegalEntity, deleteLegalEntity, addSignatory, deleteSignatory, addEntityBankAccount,
  saveBusinessUnit, deleteBusinessUnit, saveDepartment, deleteDepartment,
  saveLocation, deleteLocation,
  saveCostCentre, saveBand, savePayGrade, saveWorkerType, saveJobTitle, deleteLookup,
  saveNumberSeries, deleteNumberSeries, setOrgHead,
} from "@/app/actions/org";

export interface Option { value: string; label: string }

/** A collapsible panel, so a page can carry many forms without a wall of inputs. */
export function Disclosure({
  label, children, defaultOpen, variant = "primary",
}: { label: string; children: ReactNode; defaultOpen?: boolean; variant?: "primary" | "default" }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <>
      <button
        type="button"
        className={`btn${variant === "primary" ? " primary" : ""} sm`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Cancel" : label}
      </button>
      {open ? <div style={{ marginTop: 14 }}>{children}</div> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
//  LEGAL ENTITY
// ---------------------------------------------------------------------------

export interface LegalEntityValues {
  id?: string; name?: string; legalName?: string; cin?: string | null;
  dateOfIncorporation?: string | null; businessType?: string | null;
  sector?: string | null; natureOfBusiness?: string | null;
  addressLine1?: string | null; addressLine2?: string | null;
  city?: string | null; state?: string | null; postalCode?: string | null;
  countryCode?: string; currency?: string;
}

export function LegalEntityForm({ entity }: { entity?: LegalEntityValues }) {
  return (
    <ActionForm
      action={saveLegalEntity}
      submitLabel={entity?.id ? "Save entity" : "Create entity"}
      hidden={entity?.id ? { id: entity.id } : undefined}
    >
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Internal name" name="name" state={state} required
              hint="Short name used across the UI">
              <TextInput name="name" state={state} defaultValue={entity?.name} required maxLength={80} />
            </Field>
            <Field label="Legal name" name="legalName" state={state} required
              hint="Exactly as incorporated — this appears on payslips and letters">
              <TextInput name="legalName" state={state} defaultValue={entity?.legalName} required maxLength={200} />
            </Field>
            <Field label="CIN" name="cin" state={state}>
              <TextInput name="cin" state={state} defaultValue={entity?.cin} placeholder="U72200KA2014PTC094953" />
            </Field>
            <Field label="Date of incorporation" name="dateOfIncorporation" state={state}>
              <TextInput name="dateOfIncorporation" state={state} type="date"
                defaultValue={entity?.dateOfIncorporation?.slice(0, 10)} />
            </Field>
            <Field label="Country" name="countryCode" state={state} required
              hint="Sets the entity's currency">
              <SelectInput name="countryCode" state={state} defaultValue={entity?.countryCode ?? "IN"}
                options={[{ value: "IN", label: "India" }]} />
            </Field>
            <Field label="Currency" name="currency" state={state} required>
              <SelectInput name="currency" state={state} defaultValue={entity?.currency ?? "INR"}
                options={[{ value: "INR", label: "INR — Indian Rupee" }]} />
            </Field>
            <Field label="Business type" name="businessType" state={state}>
              <TextInput name="businessType" state={state} defaultValue={entity?.businessType}
                placeholder="Private Limited Company" />
            </Field>
            <Field label="Sector" name="sector" state={state}>
              <TextInput name="sector" state={state} defaultValue={entity?.sector} placeholder="Information Technology" />
            </Field>
          </div>
          <Field label="Nature of business" name="natureOfBusiness" state={state}>
            <TextInput name="natureOfBusiness" state={state} defaultValue={entity?.natureOfBusiness} />
          </Field>
          <div className="grid grid-2">
            <Field label="Registered address" name="addressLine1" state={state}>
              <TextInput name="addressLine1" state={state} defaultValue={entity?.addressLine1} />
            </Field>
            <Field label="Address line 2" name="addressLine2" state={state}>
              <TextInput name="addressLine2" state={state} defaultValue={entity?.addressLine2} />
            </Field>
            <Field label="City" name="city" state={state}>
              <TextInput name="city" state={state} defaultValue={entity?.city} />
            </Field>
            <Field label="State" name="state" state={state}>
              <TextInput name="state" state={state} defaultValue={entity?.state} />
            </Field>
            <Field label="Postal code" name="postalCode" state={state}>
              <TextInput name="postalCode" state={state} defaultValue={entity?.postalCode} />
            </Field>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function DeleteEntityButton({ id, name }: { id: string; name: string }) {
  return (
    <DangerButton
      action={deleteLegalEntity} hidden={{ id }} label="Delete"
      confirmLabel={`Delete ${name}? This is refused if any employee, pay group or business unit still belongs to it.`}
    />
  );
}

export function SignatoryForm({ legalEntityId }: { legalEntityId: string }) {
  return (
    <InlineForm action={addSignatory} hidden={{ legalEntityId }} submitLabel="Add signatory">
      {(state) => (
        <>
          <TextInput name="name" state={state} placeholder="Name" required className="" />
          <TextInput name="designation" state={state} placeholder="Designation" required />
          <TextInput name="email" state={state} type="email" placeholder="Email" />
          <TextInput name="pan" state={state} placeholder="PAN or PANNOTAVBL" maxLength={10} />
        </>
      )}
    </InlineForm>
  );
}

export function DeleteSignatoryButton({ id, name }: { id: string; name: string }) {
  return <DangerButton action={deleteSignatory} hidden={{ id }} label="Remove"
    confirmLabel={`Remove ${name} as a signatory?`} />;
}

export function EntityBankForm({ legalEntityId }: { legalEntityId: string }) {
  return (
    <InlineForm action={addEntityBankAccount} hidden={{ legalEntityId }} submitLabel="Add account">
      {(state) => (
        <>
          <TextInput name="bankName" state={state} placeholder="Bank name" required />
          <TextInput name="accountNumber" state={state} placeholder="Account number" required />
          <TextInput name="ifsc" state={state} placeholder="IFSC" required maxLength={11} />
          <TextInput name="branch" state={state} placeholder="Branch" required />
          <label className="row gap-1 text-sm nowrap">
            <input type="checkbox" name="isPrimary" /> Primary
          </label>
        </>
      )}
    </InlineForm>
  );
}

// ---------------------------------------------------------------------------
//  BUSINESS UNIT / DEPARTMENT
// ---------------------------------------------------------------------------

export function BusinessUnitForm({
  entities, employees, unit,
}: {
  entities: Option[]; employees: Option[];
  unit?: { id: string; name: string; code: string | null; description: string | null; legalEntityId: string; headId: string | null };
}) {
  return (
    <ActionForm
      action={saveBusinessUnit}
      submitLabel={unit ? "Save" : "Create business unit"}
      hidden={unit ? { id: unit.id } : undefined}
    >
      {(state) => (
        <div className="grid grid-2">
          <Field label="Name" name="name" state={state} required>
            <TextInput name="name" state={state} defaultValue={unit?.name} required maxLength={80} />
          </Field>
          <Field label="Code" name="code" state={state}>
            <TextInput name="code" state={state} defaultValue={unit?.code} maxLength={20} />
          </Field>
          <Field label="Legal entity" name="legalEntityId" state={state} required>
            <SelectInput name="legalEntityId" state={state} options={entities}
              defaultValue={unit?.legalEntityId} placeholder="Select…" required />
          </Field>
          <Field label="Business head" name="headId" state={state}
            hint="Grants the implicit Business Head role over this unit">
            <SelectInput name="headId" state={state} options={employees}
              defaultValue={unit?.headId} placeholder="Unassigned" />
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Description" name="description" state={state}>
              <TextInput name="description" state={state} defaultValue={unit?.description} />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

export function DepartmentForm({
  units, employees, dept,
}: {
  units: Option[]; employees: Option[];
  dept?: { id: string; name: string; code: string | null; description: string | null; businessUnitId: string | null; headId: string | null };
}) {
  return (
    <ActionForm
      action={saveDepartment}
      submitLabel={dept ? "Save" : "Create department"}
      hidden={dept ? { id: dept.id } : undefined}
    >
      {(state) => (
        <div className="grid grid-2">
          <Field label="Name" name="name" state={state} required>
            <TextInput name="name" state={state} defaultValue={dept?.name} required maxLength={80} />
          </Field>
          <Field label="Code" name="code" state={state}>
            <TextInput name="code" state={state} defaultValue={dept?.code} maxLength={20} />
          </Field>
          <Field label="Business unit" name="businessUnitId" state={state}>
            <SelectInput name="businessUnitId" state={state} options={units}
              defaultValue={dept?.businessUnitId} placeholder="None" />
          </Field>
          <Field label="Department head" name="headId" state={state}
            hint="Grants the implicit Department Head role">
            <SelectInput name="headId" state={state} options={employees}
              defaultValue={dept?.headId} placeholder="Unassigned" />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function DeleteBusinessUnitButton({ id, name }: { id: string; name: string }) {
  return <DangerButton action={deleteBusinessUnit} hidden={{ id }} label="Delete"
    confirmLabel={`Delete ${name}?`} />;
}
export function DeleteDepartmentButton({ id, name }: { id: string; name: string }) {
  return <DangerButton action={deleteDepartment} hidden={{ id }} label="Delete"
    confirmLabel={`Delete ${name}? Any role scopes pointing at it will be cleared.`} />;
}

export function HeadPicker({
  kind, id, employees, current,
}: { kind: "department" | "businessUnit"; id: string; employees: Option[]; current: string | null }) {
  return (
    <InlineForm action={setOrgHead} hidden={{ kind, id }} submitLabel="Set">
      {(state) => (
        <SelectInput name="headId" state={state} options={employees}
          defaultValue={current} placeholder="Unassigned"
          className="" />
      )}
    </InlineForm>
  );
}

// ---------------------------------------------------------------------------
//  LOCATION
// ---------------------------------------------------------------------------

const IN_STATES: Option[] = [
  ["AN", "Andaman & Nicobar"], ["AP", "Andhra Pradesh"], ["AR", "Arunachal Pradesh"],
  ["AS", "Assam"], ["BR", "Bihar"], ["CH", "Chandigarh"], ["CG", "Chhattisgarh"],
  ["DH", "Dadra & Nagar Haveli and Daman & Diu"], ["DL", "Delhi"], ["GA", "Goa"],
  ["GJ", "Gujarat"], ["HR", "Haryana"], ["HP", "Himachal Pradesh"], ["JK", "Jammu & Kashmir"],
  ["JH", "Jharkhand"], ["KA", "Karnataka"], ["KL", "Kerala"], ["LA", "Ladakh"],
  ["MP", "Madhya Pradesh"], ["MH", "Maharashtra"], ["MN", "Manipur"], ["ML", "Meghalaya"],
  ["MZ", "Mizoram"], ["NL", "Nagaland"], ["OR", "Odisha"], ["PY", "Puducherry"],
  ["PB", "Punjab"], ["RJ", "Rajasthan"], ["SK", "Sikkim"], ["TN", "Tamil Nadu"],
  ["TS", "Telangana"], ["TR", "Tripura"], ["UP", "Uttar Pradesh"], ["UK", "Uttarakhand"],
  ["WB", "West Bengal"],
].map(([value, label]) => ({ value, label: `${label} (${value})` }));

export function LocationForm({
  location,
}: {
  location?: {
    id: string; name: string; code: string | null; addressLine1: string | null;
    addressLine2: string | null; city: string | null; state: string | null;
    stateCode: string | null; postalCode: string | null;
  };
}) {
  return (
    <ActionForm
      action={saveLocation}
      submitLabel={location ? "Save location" : "Create location"}
      hidden={location ? { id: location.id } : undefined}
    >
      {(state) => (
        <>
          <div className="callout info" style={{ marginBottom: 14 }}>
            <div>
              The state you pick here decides which Professional Tax and Labour Welfare Fund
              rules apply to everyone based at this location. After saving, map it to a PT and
              LWF registration on the pay group.
            </div>
          </div>
          <div className="grid grid-2">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} defaultValue={location?.name} required maxLength={80} />
            </Field>
            <Field label="Code" name="code" state={state}>
              <TextInput name="code" state={state} defaultValue={location?.code} maxLength={20} placeholder="BLR" />
            </Field>
            <Field label="State" name="stateCode" state={state} required
              hint="Drives PT and LWF">
              <SelectInput name="stateCode" state={state} options={IN_STATES}
                defaultValue={location?.stateCode} placeholder="Select a state…" required />
            </Field>
            <Field label="State name" name="state" state={state}>
              <TextInput name="state" state={state} defaultValue={location?.state} />
            </Field>
            <Field label="City" name="city" state={state}>
              <TextInput name="city" state={state} defaultValue={location?.city} />
            </Field>
            <Field label="Postal code" name="postalCode" state={state}>
              <TextInput name="postalCode" state={state} defaultValue={location?.postalCode} maxLength={12} />
            </Field>
            <Field label="Address" name="addressLine1" state={state}>
              <TextInput name="addressLine1" state={state} defaultValue={location?.addressLine1} />
            </Field>
            <Field label="Address line 2" name="addressLine2" state={state}>
              <TextInput name="addressLine2" state={state} defaultValue={location?.addressLine2} />
            </Field>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function DeleteLocationButton({ id, name }: { id: string; name: string }) {
  return <DangerButton action={deleteLocation} hidden={{ id }} label="Delete"
    confirmLabel={`Delete ${name}? Its PT and LWF mappings and any role scopes will be cleared.`} />;
}

// ---------------------------------------------------------------------------
//  SIMPLE LOOKUPS
// ---------------------------------------------------------------------------

export function CostCentreForm() {
  return (
    <InlineForm action={saveCostCentre} submitLabel="Add cost centre">
      {(state) => (
        <>
          <TextInput name="name" state={state} placeholder="Name" required />
          <TextInput name="code" state={state} placeholder="Code" maxLength={20} />
        </>
      )}
    </InlineForm>
  );
}

export function BandForm() {
  return (
    <InlineForm action={saveBand} submitLabel="Add band">
      {(state) => (
        <>
          <TextInput name="name" state={state} placeholder="Name, e.g. B3 — Senior" required />
          <TextInput name="rank" state={state} type="number" placeholder="Rank" min={0} max={99} />
        </>
      )}
    </InlineForm>
  );
}

export function PayGradeForm() {
  return (
    <InlineForm action={savePayGrade} submitLabel="Add pay grade">
      {(state) => (
        <>
          <TextInput name="name" state={state} placeholder="Name, e.g. G3" required />
          <TextInput name="minAnnual" state={state} type="number" placeholder="Min annual" min={0} step={1000} />
          <TextInput name="maxAnnual" state={state} type="number" placeholder="Max annual" min={0} step={1000} />
        </>
      )}
    </InlineForm>
  );
}

export function WorkerTypeForm() {
  return (
    <InlineForm action={saveWorkerType} submitLabel="Add worker type">
      {(state) => (
        <>
          <TextInput name="name" state={state} placeholder="Name, e.g. Contract" required />
          <label className="row gap-1 text-sm nowrap">
            <input type="checkbox" name="isContingent" /> Contingent (26Q TDS)
          </label>
        </>
      )}
    </InlineForm>
  );
}

export function JobTitleForm({ bands }: { bands: Option[] }) {
  return (
    <InlineForm action={saveJobTitle} submitLabel="Add job title">
      {(state) => (
        <>
          <TextInput name="name" state={state} placeholder="Title" required />
          <SelectInput name="bandId" state={state} options={bands} placeholder="No band" />
        </>
      )}
    </InlineForm>
  );
}

export function DeleteLookupButton({
  kind, id, name,
}: { kind: "costCentre" | "band" | "payGrade" | "workerType" | "jobTitle"; id: string; name: string }) {
  return <DangerButton action={deleteLookup} hidden={{ kind, id }} label="Delete"
    confirmLabel={`Delete ${name}?`} />;
}

// ---------------------------------------------------------------------------
//  EMPLOYEE NUMBER SERIES
// ---------------------------------------------------------------------------

export function NumberSeriesForm({
  series,
}: {
  series?: {
    id: string; name: string; description: string | null; prefix: string;
    digits: number; suffix: string; nextNumber: number; isDefault: boolean; isActive: boolean;
  };
}) {
  return (
    <ActionForm
      action={saveNumberSeries}
      submitLabel={series ? "Save series" : "Create series"}
      hidden={series ? { id: series.id } : undefined}
    >
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} defaultValue={series?.name} required maxLength={60} />
            </Field>
            <Field label="Prefix" name="prefix" state={state}>
              <TextInput name="prefix" state={state} defaultValue={series?.prefix} maxLength={12} placeholder="ACM" />
            </Field>
            <Field label="Suffix" name="suffix" state={state}>
              <TextInput name="suffix" state={state} defaultValue={series?.suffix} maxLength={12} />
            </Field>
            <Field label="Digits" name="digits" state={state} required
              hint="Zero-padded width of the number">
              <TextInput name="digits" state={state} type="number" min={1} max={10}
                defaultValue={series?.digits ?? 4} required />
            </Field>
            <Field label="Next number" name="nextNumber" state={state} required>
              <TextInput name="nextNumber" state={state} type="number" min={1}
                defaultValue={series?.nextNumber ?? 1} required />
            </Field>
          </div>
          <Field label="Description" name="description" state={state}>
            <TextInput name="description" state={state} defaultValue={series?.description} />
          </Field>
          <CheckboxInput name="isDefault" label="Use as the default series"
            defaultChecked={series?.isDefault}
            hint="New employees get their number from the default series" />
          <CheckboxInput name="isActive" label="Active"
            defaultChecked={series?.isActive ?? true} />
        </>
      )}
    </ActionForm>
  );
}

export function DeleteSeriesButton({ id, name }: { id: string; name: string }) {
  return <DangerButton action={deleteNumberSeries} hidden={{ id }} label="Delete"
    confirmLabel={`Delete the ${name} series?`} />;
}
