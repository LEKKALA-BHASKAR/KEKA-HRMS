import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { saveStageAction, addStageAction, reorderStageAction, deleteStageAction, setDefaultFlowAction } from "@/app/actions/hire-ops";
import { HireSettingsTabs } from "../../_parts/settings-tabs";
import { pretty } from "../../_parts/depth-tabs";

export const metadata = { title: "Hiring stages · Hire" };

const KINDS = ["SOURCED", "SCREENING", "ASSESSMENT", "INTERVIEW", "OFFER", "PREBOARDING", "HIRED", "REJECTED"];

/**
 * Hire › Settings › Stages: each hiring flow's stages in order, what a
 * candidate needs before entering a stage (a résumé, a minimum score, an
 * approval), whether leaving it needs feedback, and when it counts as stale.
 */
export default async function StagesSettingsPage() {
  const viewer = await requireAuth(PERMISSIONS.JOB_MANAGE);
  const flows = await prisma.hiringFlow.findMany({ where: { tenantId: viewer.tenantId }, include: { stages: { orderBy: { sequence: "asc" }, include: { _count: { select: { applications: true } } } }, _count: { select: { jobs: true } } }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  return (
    <>
      <HireSettingsTabs />
      <PageHead title="Stages and entry criteria" subtitle="Change the order, rename, and gate stages. A stage that has been used cannot be deleted." />
      {flows.map((f) => (
        <Card key={f.id} title={<>{f.name} {f.isDefault ? <Badge tone="brand">Default</Badge> : null}</>} description={`${f._count.jobs} job(s) use this flow.`} action={f.isDefault ? null : <ActButton action={setDefaultFlowAction} hidden={{ flowId: f.id }} label="Make default" />} tight>
          <table className="data" data-testid="stage-editor"><tbody>
            {f.stages.map((s, i) => (
              <tr key={s.id}>
                <td style={{ width: 30 }}>{i + 1}</td>
                <td>
                  <div className="strong">{s.name}</div>
                  <div className="text-xs muted">{pretty(s.stageKind)}{s.requireScorecard ? " · feedback to leave" : ""}{s.staleAfterDays ? ` · stale after ${s.staleAfterDays}d` : ""}{s.entryRequiresResume ? " · résumé to enter" : ""}{s.entryMinScore ? ` · score ≥ ${Number(s.entryMinScore)} to enter` : ""}{s.entryRequiresApproval ? " · approval to enter" : ""} · {s._count.applications} move(s)</div>
                  <Reveal label="Edit">
                    <GrowthForm action={saveStageAction} hidden={{ stageId: s.id }} cols={3} fields={[
                      { name: "name", label: "Name", required: true, defaultValue: s.name },
                      { name: "stageKind", label: "Kind", type: "select", options: KINDS.map((k) => ({ value: k, label: pretty(k) })), defaultValue: s.stageKind },
                      { name: "staleAfterDays", label: "Stale after (days)", type: "number", defaultValue: s.staleAfterDays },
                      { name: "entryMinScore", label: "Minimum average score to enter (1–5)", type: "number", defaultValue: s.entryMinScore === null ? null : Number(s.entryMinScore) },
                      { name: "requireScorecard", label: "Feedback needed to leave", type: "checkbox", defaultChecked: s.requireScorecard },
                      { name: "entryRequiresResume", label: "Résumé needed to enter", type: "checkbox", defaultChecked: s.entryRequiresResume },
                      { name: "entryRequiresApproval", label: "Approval needed to enter", type: "checkbox", defaultChecked: s.entryRequiresApproval },
                    ]} />
                  </Reveal>
                </td>
                <td className="right nowrap">
                  {i > 0 ? <ActButton action={reorderStageAction} hidden={{ stageId: s.id, dir: "up" }} label="↑" /> : null}
                  {i < f.stages.length - 1 ? <ActButton action={reorderStageAction} hidden={{ stageId: s.id, dir: "down" }} label="↓" /> : null}
                  {s._count.applications === 0 ? <ActButton action={deleteStageAction} hidden={{ stageId: s.id }} label="Delete" variant="ghost" confirmText={`Delete ${s.name}?`} /> : null}
                </td>
              </tr>
            ))}
          </tbody></table>
          <div style={{ padding: 12 }}>
            <Reveal label="Add a stage">
              <GrowthForm action={addStageAction} hidden={{ flowId: f.id }} cols={3} submitLabel="Add" fields={[
                { name: "name", label: "Name", required: true },
                { name: "stageKind", label: "Kind", type: "select", options: KINDS.map((k) => ({ value: k, label: pretty(k) })), defaultValue: "INTERVIEW" },
                { name: "afterSequence", label: "After", type: "select", options: f.stages.map((s) => ({ value: String(s.sequence), label: s.name })), defaultValue: String(f.stages.at(-1)?.sequence ?? 0) },
              ]} />
            </Reveal>
          </div>
        </Card>
      ))}
    </>
  );
}
