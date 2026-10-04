import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requisitionApproverChain } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { HiringSettingsForm, JdTemplateForm, DeleteTemplate, FlowForm } from "../_parts/settings-forms";
import { userNames } from "../_lib/data";
import { HireSettingsTabs } from "../_parts/settings-tabs";
import s from "../hire.module.css";

export const metadata = { title: "Settings · Hire" };

/** Org › Hiring › Settings: requisition approval, hiring flows and job-description templates. */
export default async function HiringSettingsPage() {
  const viewer = await requireAuth(PERMISSIONS.JOB_MANAGE);
  const [setting, flows, templates, chain, bizHeads] = await Promise.all([
    prisma.hiringSetting.findUnique({ where: { tenantId: viewer.tenantId } }),
    prisma.hiringFlow.findMany({ where: { tenantId: viewer.tenantId }, include: { stages: { orderBy: { sequence: "asc" } }, _count: { select: { jobs: true } } }, orderBy: { name: "asc" } }),
    prisma.jobDescriptionTemplate.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { title: "asc" } }),
    requisitionApproverChain(viewer.tenantId, null),
    prisma.businessUnit.findMany({ where: { tenantId: viewer.tenantId, head: { userId: { not: null } } }, select: { head: { select: { userId: true } } } }),
  ]);
  const ids = [...new Set([...chain, ...bizHeads.map((b) => b.head?.userId).filter((x): x is string => !!x), setting?.defaultApproverUserId ?? null].filter((x): x is string => !!x))];
  const names = await userNames(viewer.tenantId, ids);
  const approvers = ids.map((id) => ({ value: id, label: names.get(id) ?? "Administrator" })).sort((a, b) => a.label.localeCompare(b.label));
  return (
    <>
      <HireSettingsTabs />
      <div className={s.head}><div><h1 className={s.h1}>Hiring Settings</h1><p className={s.sub}>How requisitions are approved, the stages candidates move through, and the templates recruiters start from.</p></div></div>
      <div className={s.settingsGrid}>
        <div className="stack gap-4">
          <section className={s.listCard}>
            <div className={s.listHead}><span className={s.listTitle}>Requisitions</span></div>
            <div style={{ padding: 18 }}>
              <HiringSettingsForm approvers={approvers} initial={{ instructions: setting?.requisitionInstructions ?? "", approver: setting?.defaultApproverUserId ?? "", attempts: setting?.aiQuestionAttempts ?? 2 }} />
            </div>
          </section>
          <section className={s.listCard}>
            <div className={s.listHead}><span className={s.listTitle}>Hiring flows</span><span className="text-xs subtle">{flows.length}</span></div>
            {flows.map((f) => (
              <div key={f.id} style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 14.5 }}>{f.name}{f.isDefault ? <span className={`${s.statusChip} ${s.info}`} style={{ marginLeft: 8 }}>default</span> : null} <span className="text-xs subtle">· {f._count.jobs} job{f._count.jobs === 1 ? "" : "s"}</span></div>
                <div className="text-sm muted" style={{ marginTop: 4 }}>{f.stages.map((st) => `${st.name}${st.requireScorecard ? " ★" : ""}`).join("  →  ")}</div>
              </div>
            ))}
            <div style={{ padding: 18 }}><FlowForm /></div>
          </section>
        </div>
        <section className={s.listCard}>
          <div className={s.listHead}><span className={s.listTitle}>Job description templates</span><span className="text-xs subtle">{templates.length}</span></div>
          {templates.map((t) => (
            <div key={t.id} style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14.5 }}>{t.title}</div>
                <div className="text-sm muted" style={{ marginTop: 4 }}>{t.body.replace(/[*#]/g, "").slice(0, 140)}…</div>
              </div>
              <DeleteTemplate id={t.id} title={t.title} />
            </div>
          ))}
          <div style={{ padding: 18 }}><JdTemplateForm /></div>
        </section>
      </div>
    </>
  );
}
