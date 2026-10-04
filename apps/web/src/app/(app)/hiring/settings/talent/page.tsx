import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { parseKit } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scoreWeights } from "@/lib/talent-hire";
import { ScoreConfigForm, ScorecardLibraryForm, DeleteScorecard, CandidateFieldForm, ToggleCandidateField } from "../../_parts/talent-forms";
import { HireSettingsTabs } from "../../_parts/settings-tabs";
import s from "../../hire.module.css";

export const metadata = { title: "Scoring & fields · Hire" };

/**
 * Hire › Settings › Scoring & fields: how the candidate profile score is
 * weighted, the company's library of interview scorecards, and the custom
 * fields recruiters fill in on a candidate.
 */
export default async function TalentSettingsPage() {
  const viewer = await requireAuth(PERMISSIONS.JOB_MANAGE);
  const tenantId = viewer.tenantId;
  const [weights, library, fields] = await Promise.all([
    scoreWeights(tenantId),
    prisma.scorecardTemplate.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.customFieldDefinition.findMany({ where: { tenantId, entity: "CANDIDATE" }, orderBy: { displayOrder: "asc" } }),
  ]);
  return (
    <>
      <HireSettingsTabs />
      <div className={s.head}><div><h1 className={s.h1}>Scoring &amp; fields</h1><p className={s.sub}>The profile score ranks candidates by how well their skills, experience and education fit the job.</p></div></div>
      <div className={s.settingsGrid}>
        <div className="stack gap-4">
          <section className={s.listCard}>
            <div className={s.listHead}><span className={s.listTitle}>Profile score</span><span className="text-xs subtle">{weights.skillsWeight} / {weights.experienceWeight} / {weights.educationWeight}</span></div>
            <div style={{ padding: 18 }}>
              <p className="text-sm muted" style={{ marginTop: 0 }}>Skills: the share of the job&apos;s skills (plus the keywords below) the candidate has. Experience: their years against the job&apos;s minimum, capped at 100%. Education: full marks when it mentions a keyword. Weights add up to 100.</p>
              <ScoreConfigForm v={weights} />
            </div>
          </section>
          <section className={s.listCard}>
            <div className={s.listHead}><span className={s.listTitle}>Candidate fields</span><span className="text-xs subtle">{fields.length}</span></div>
            {fields.map((f) => (
              <div key={f.id} style={{ padding: "10px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 12, opacity: f.isActive ? 1 : 0.6 }}>
                <div><span style={{ fontSize: 14.5 }}>{f.label}</span> <span className="text-xs subtle">· {f.type.toLowerCase()}{f.isMandatory ? " · required" : ""}{f.isActive ? "" : " · off"}</span></div>
                <ToggleCandidateField id={f.id} active={f.isActive} />
              </div>
            ))}
            <div style={{ padding: 18 }}><CandidateFieldForm /></div>
          </section>
        </div>
        <section className={s.listCard}>
          <div className={s.listHead}><span className={s.listTitle}>Scorecard library</span><span className="text-xs subtle">{library.length}</span></div>
          {library.length === 0 ? <div className={s.empty}>No scorecards yet. Add one and apply it to any job from the job&apos;s page.</div> : library.map((t) => (
            <div key={t.id} style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14.5 }}>{t.name}</div>
                {(parseKit(t.kit) ?? []).map((k) => <div key={k.section} className="text-xs muted" style={{ marginTop: 2 }}><strong>{k.section}:</strong> {k.skills.map((x) => x.name).join(", ")}</div>)}
              </div>
              <DeleteScorecard id={t.id} />
            </div>
          ))}
          <div style={{ padding: 18 }}><ScorecardLibraryForm /></div>
        </section>
      </div>
    </>
  );
}
