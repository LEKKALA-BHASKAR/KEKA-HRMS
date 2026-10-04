import { F, Select, type Opt } from "@/components/workforce-ui";

/** Inputs of the position form, shared by create and edit (server-rendered into SimpleForm). */

export interface PositionDefaults {
  title?: string; jobId?: string | null; departmentId?: string | null; locationId?: string | null; costCenterId?: string | null;
  payGradeId?: string | null; reportsToId?: string | null; budgetedAnnualSalary?: number | null; budgetStatus?: string; fte?: number;
  isHeadcount?: boolean; criticality?: string; workMode?: string; allowedLocationIds?: string[]; skills?: string[]; competencies?: string[];
  effectiveFrom?: string; effectiveTo?: string | null; vacancyReason?: string | null;
}

export function PositionFields({ d = {}, opts, creating }: {
  d?: PositionDefaults; creating?: boolean;
  opts: { jobs: Opt[]; departments: Opt[]; locations: Opt[]; costCenters: Opt[]; payGrades: Opt[]; positions: Opt[] };
}) {
  return (
    <div className="grid grid-3">
      <F label="Position title *"><input className="input" name="title" required maxLength={120} defaultValue={d.title} /></F>
      <F label="Job"><Select name="jobId" options={opts.jobs} defaultValue={d.jobId} placeholder="— None —" /></F>
      <F label="Department *"><Select name="departmentId" options={opts.departments} defaultValue={d.departmentId} placeholder="Choose" required /></F>
      <F label="Location"><Select name="locationId" options={opts.locations} defaultValue={d.locationId} placeholder="— Any —" /></F>
      <F label="Cost centre"><Select name="costCenterId" options={opts.costCenters} defaultValue={d.costCenterId} placeholder="—" /></F>
      <F label="Pay grade (compensation range)"><Select name="payGradeId" options={opts.payGrades} defaultValue={d.payGradeId} placeholder="—" /></F>
      <F label="Reports to position"><Select name="reportsToId" options={opts.positions} defaultValue={d.reportsToId} placeholder="—" /></F>
      <F label="Budgeted annual salary (₹)"><input className="input" name="budgetedAnnualSalary" type="number" min={0} defaultValue={d.budgetedAnnualSalary ?? undefined} /></F>
      <F label="Budget status"><Select name="budgetStatus" options={[{ value: "BUDGETED", label: "Budgeted" }, { value: "UNBUDGETED", label: "Unbudgeted" }]} defaultValue={d.budgetStatus ?? "BUDGETED"} /></F>
      <F label="FTE"><input className="input" name="fte" type="number" step="0.05" min={0.1} max={1} defaultValue={d.fte ?? 1} /></F>
      <F label="Criticality"><Select name="criticality" options={["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((v) => ({ value: v, label: v[0] + v.slice(1).toLowerCase() }))} defaultValue={d.criticality ?? "MEDIUM"} /></F>
      <F label="Remote work eligibility"><Select name="workMode" options={[{ value: "ONSITE", label: "On-site" }, { value: "HYBRID", label: "Hybrid" }, { value: "REMOTE", label: "Remote" }]} defaultValue={d.workMode ?? "ONSITE"} /></F>
      <F label="May also be filled from (locations)" hint="Location constraint; leave empty for the position's own location only"><Select name="allowedLocationIds" options={opts.locations} defaultValue={d.allowedLocationIds ?? []} multiple /></F>
      <F label="Skill requirements" hint="Comma separated"><input className="input" name="skills" defaultValue={d.skills?.join(", ")} /></F>
      <F label="Competency profile" hint="Comma separated"><input className="input" name="competencies" defaultValue={d.competencies?.join(", ")} /></F>
      <F label="Effective from *"><input className="input" name="effectiveFrom" type="date" required defaultValue={d.effectiveFrom ?? new Date().toISOString().slice(0, 10)} /></F>
      <F label="Effective to"><input className="input" name="effectiveTo" type="date" defaultValue={d.effectiveTo ?? undefined} /></F>
      {creating ? (
        <>
          <F label="Vacancy reason"><Select name="vacancyReason" options={["NEW", "RESIGNATION", "TERMINATION", "TRANSFER", "PROMOTION", "RETIREMENT"].map((v) => ({ value: v, label: v[0] + v.slice(1).toLowerCase() }))} defaultValue={d.vacancyReason ?? "NEW"} /></F>
          <F label="Justification"><input className="input" name="justification" maxLength={500} /></F>
        </>
      ) : <input type="hidden" name="vacancyReason" value={d.vacancyReason ?? "NEW"} />}
      <label className="checkbox-row"><input type="checkbox" name="isHeadcount" defaultChecked={d.isHeadcount ?? true} /> <span className="text-sm">Counts toward approved headcount</span></label>
    </div>
  );
}
