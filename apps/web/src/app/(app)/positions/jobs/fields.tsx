import { F, Select, type Opt } from "@/components/workforce-ui";

export interface JobDefaults {
  title?: string; familyId?: string | null; levelId?: string | null; jobTitleId?: string | null;
  summary?: string | null; responsibilities?: string | null; qualifications?: string | null; competencies?: string[]; skills?: string[];
}

/** Inputs of the job form (header + the working description). */
export function JobFields({ d = {}, opts }: { d?: JobDefaults; opts: { families: Opt[]; levels: Opt[]; titles: Opt[] } }) {
  return (
    <>
      <div className="grid grid-2">
        <F label="Job title *"><input className="input" name="title" required maxLength={120} defaultValue={d.title} /></F>
        <F label="Org job title (on employee records)"><Select name="jobTitleId" options={opts.titles} defaultValue={d.jobTitleId} placeholder="—" /></F>
        <F label="Job family"><Select name="familyId" options={opts.families} defaultValue={d.familyId} placeholder="—" /></F>
        <F label="Job level"><Select name="levelId" options={opts.levels} defaultValue={d.levelId} placeholder="—" /></F>
      </div>
      <F label="Summary"><textarea className="textarea" name="summary" rows={3} defaultValue={d.summary ?? undefined} /></F>
      <F label="Responsibilities"><textarea className="textarea" name="responsibilities" rows={5} defaultValue={d.responsibilities ?? undefined} /></F>
      <F label="Qualifications"><textarea className="textarea" name="qualifications" rows={3} defaultValue={d.qualifications ?? undefined} /></F>
      <div className="grid grid-2">
        <F label="Competency tags" hint="Comma separated"><input className="input" name="competencies" defaultValue={d.competencies?.join(", ")} /></F>
        <F label="Skills" hint="Comma separated"><input className="input" name="skills" defaultValue={d.skills?.join(", ")} /></F>
      </div>
    </>
  );
}
