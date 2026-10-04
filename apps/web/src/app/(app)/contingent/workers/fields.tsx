import { F, Select, type Opt } from "@/components/workforce-ui";

export interface WorkerDefaults {
  firstName?: string; lastName?: string; email?: string | null; phone?: string | null; workerKind?: string; engagementType?: string;
  vendorId?: string | null; pan?: string | null; skills?: string[]; departmentId?: string | null; managerEmployeeId?: string | null; notes?: string | null;
}

/** Contractor profile inputs, shared by add and edit. */
export function WorkerFields({ d = {}, opts, creating }: { d?: WorkerDefaults; creating?: boolean; opts: { vendors: Opt[]; departments: Opt[]; employees: Opt[] } }) {
  return (
    <div className="grid grid-3">
      <F label="First name *"><input className="input" name="firstName" required defaultValue={d.firstName} /></F>
      <F label="Last name *"><input className="input" name="lastName" required defaultValue={d.lastName} /></F>
      <F label="Email"><input className="input" type="email" name="email" defaultValue={d.email ?? undefined} /></F>
      <F label="Phone"><input className="input" name="phone" defaultValue={d.phone ?? undefined} /></F>
      <F label="Worker type"><Select name="workerKind" options={[{ value: "CONTRACTOR", label: "Independent contractor" }, { value: "VENDOR_WORKER", label: "Vendor (agency) worker" }]} defaultValue={d.workerKind ?? "CONTRACTOR"} /></F>
      <F label="Engagement type"><Select name="engagementType" options={[["FIXED_TERM", "Fixed term"], ["TIME_AND_MATERIAL", "Time & material"], ["SOW", "Statement of work"], ["RETAINER", "Retainer"], ["CONSULTANT", "Consultant"]].map(([value, label]) => ({ value, label }))} defaultValue={d.engagementType ?? "FIXED_TERM"} /></F>
      <F label="Vendor (for agency workers)"><Select name="vendorId" options={opts.vendors} defaultValue={d.vendorId} placeholder="—" /></F>
      <F label="PAN"><input className="input" name="pan" maxLength={10} defaultValue={d.pan ?? undefined} /></F>
      <F label="Skills" hint="Comma separated"><input className="input" name="skills" defaultValue={d.skills?.join(", ")} /></F>
      <F label="Department"><Select name="departmentId" options={opts.departments} defaultValue={d.departmentId} placeholder="—" /></F>
      <F label="Manager"><Select name="managerEmployeeId" options={opts.employees} defaultValue={d.managerEmployeeId} placeholder="—" /></F>
      {creating ? <F label="Justification"><input className="input" name="justification" maxLength={500} /></F> : null}
      <F label="Notes"><input className="input" name="notes" defaultValue={d.notes ?? undefined} /></F>
    </div>
  );
}
