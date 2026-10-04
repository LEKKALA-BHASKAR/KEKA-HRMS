import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatINR } from "@keka/shared";
import { ruleShape } from "@keka/services";
import { requireViewer, canAny } from "@/lib/context";
import { forbidden } from "next/navigation";
import { ApprovalRuleForm, ToggleApprovalRule } from "../../_parts/talent-forms";
import { HireSettingsTabs } from "../../_parts/settings-tabs";
import { userNames } from "../../_lib/data";
import s from "../../hire.module.css";

export const metadata = { title: "Approval chains · Hire" };

/**
 * Hire › Settings › Approval chains: multi-level approval for requisitions
 * and offers. The first active rule (by order) whose department and amount
 * match decides the approvers, who then approve one after another. With no
 * matching rule, the single-approver flow from General settings applies.
 */
export default async function ApprovalChainsPage() {
  const viewer = await requireViewer();
  if (!canAny(viewer, [PERMISSIONS.JOB_MANAGE, PERMISSIONS.REQUISITION_MANAGE])) forbidden();
  const tenantId = viewer.tenantId;
  const [rules, users, depts] = await Promise.all([
    prisma.hireApprovalRule.findMany({ where: { tenantId }, orderBy: [{ kind: "asc" }, { priority: "asc" }, { createdAt: "asc" }] }),
    prisma.user.findMany({ where: { tenantId, loginDisabled: false, isDeactivated: false }, select: { id: true, email: true, employee: { select: { displayName: true } } }, orderBy: { email: "asc" }, take: 1000 }),
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const names = await userNames(tenantId, rules.flatMap((r) => ruleShape(r).approverUserIds));
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const userOptions = users.map((u) => ({ value: u.id, label: u.employee?.displayName ? `${u.employee.displayName} (${u.email})` : u.email })).sort((a, b) => a.label.localeCompare(b.label));

  const block = (kind: "REQUISITION" | "OFFER", title: string) => {
    const list = rules.filter((r) => r.kind === kind);
    return (
      <section className={s.listCard}>
        <div className={s.listHead}><span className={s.listTitle}>{title}</span><span className="text-xs subtle">{list.length}</span></div>
        {list.length === 0 ? <div className={s.empty}>No chains — {kind === "REQUISITION" ? "requisitions go to the single approver from General settings" : "offers within the job's budget are approved as soon as they are drafted"}.</div> : list.map((r) => (
          <div key={r.id} style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 12, opacity: r.isActive ? 1 : 0.6 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14.5 }}>{r.name} <span className="text-xs subtle">· order {r.priority}{r.isActive ? "" : " · paused"}</span></div>
              <div className="text-xs muted" style={{ marginTop: 2 }}>{[r.departmentId ? deptName.get(r.departmentId) ?? "A department" : "Any department", r.minAmount !== null ? `from ${formatINR(Number(r.minAmount))}` : "any amount"].join(" · ")}</div>
              <div className="text-sm" style={{ marginTop: 4 }}>{ruleShape(r).approverUserIds.map((id) => names.get(id) ?? "Administrator").join("  →  ")}</div>
            </div>
            <ToggleApprovalRule id={r.id} active={r.isActive} />
          </div>
        ))}
      </section>
    );
  };

  return (
    <>
      <HireSettingsTabs />
      <div className={s.head}><div><h1 className={s.h1}>Approval chains</h1><p className={s.sub}>Send requisitions and offers through several approvers in turn — by department, or only above an amount. Each approver decides from their Inbox.</p></div></div>
      <div className={s.settingsGrid}>
        <div className="stack gap-4">
          {block("REQUISITION", "Requisition chains")}
          {block("OFFER", "Offer chains")}
        </div>
        <section className={s.listCard}>
          <div className={s.listHead}><span className={s.listTitle}>Add a chain</span></div>
          <div style={{ padding: 18 }}><ApprovalRuleForm users={userOptions} departments={depts.map((d) => ({ value: d.id, label: d.name }))} /></div>
        </section>
      </div>
    </>
  );
}
