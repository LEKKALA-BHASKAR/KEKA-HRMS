import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { compPlanSummary, compPoolStatus, compBlockers, type CompStatementContent } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat, Callout, Progress } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { compPlanSettingsAction, compPlanOpAction, poolAction, calibrationSessionAction } from "@/app/actions/compensation";
import { CompWorksheet } from "../_worksheet";
import { PLAN_TONE, settingsFields } from "../_shared";

/** One compensation plan: worksheet, budget pools, calibration, approval, apply and statements. */
export default async function CompPlanPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ manager?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.SALARY_REVISE);
  const { id } = await params;
  const sp = await searchParams;
  const t = viewer.tenantId;
  const plan = await prisma.compPlan.findFirst({ where: { id, tenantId: t } });
  if (!plan) notFound();
  const [summary, pools, blockers, items, sessions, log, statements, grades, departments] = await Promise.all([
    compPlanSummary(t, id),
    compPoolStatus(t, id),
    compBlockers(t, id),
    prisma.compPlanItem.findMany({ where: { planId: id, tenantId: t, ...(sp.manager ? { ownerEmployeeId: sp.manager } : {}) }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { employee: { displayName: "asc" } } }),
    prisma.compCalibrationSession.findMany({ where: { planId: id, tenantId: t }, orderBy: { scheduledAt: "desc" } }),
    prisma.compDecisionLog.findMany({ where: { planId: id, tenantId: t }, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.compStatement.findMany({ where: { planId: id, tenantId: t }, include: { employee: { select: { displayName: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.payGrade.findMany({ where: { tenantId: t, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.department.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const s = summary!;
  const open = ["PLANNING", "CALIBRATION"].includes(plan.status);
  const breaches = new Map(blockers.map((b) => [b.item.id, b.breaches]));
  const names = new Map(items.map((i) => [i.id, i.employee.displayName]));
  const openSessions = sessions.filter((x) => x.status === "OPEN").map((x) => ({ value: x.id, label: x.name }));
  const unpublished = statements.filter((x) => !x.publishedAt).length;
  const preview = statements[0]?.content as unknown as CompStatementContent | undefined;
  return (
    <>
      <PageHead title={plan.name} subtitle={<>Effective {formatDate(plan.effectiveDate)} · <Badge tone={PLAN_TONE[plan.status] ?? "neutral"}>{plan.status.toLowerCase().replace("_", " ")}</Badge></>}
        actions={<><a className="btn" href={`/payroll/compensation/${id}/export`}>Download worksheet CSV</a><Link className="btn" href="/payroll/compensation">All plans</Link></>} />
      <div className="grid grid-4" style={{ marginBottom: 12 }}>
        <Stat label="Eligible" value={`${s.eligible} / ${s.lines}`} />
        <Stat label="Increase cost" value={formatINR(s.cost)} meta={`${s.costPct}% of payroll · avg ${s.avgPct}%`} tone={s.overBudget ? "neg" : undefined} />
        <Stat label="Budget" value={formatINR(s.budget)} meta={`${Number(plan.budgetPct)}% of ${formatINR(s.payroll)}`} />
        <Stat label="Exceptions pending" value={s.exceptionsPending} meta={`${blockers.length} line(s) blocking`} />
      </div>
      <Card title="Next step">
        <div className="row gap-2 wrap">
          {plan.status === "DRAFT" ? <ActButton action={compPlanOpAction} hidden={{ planId: id, op: "build" }} label="Build worksheet" variant="primary" /> : null}
          {plan.status === "PLANNING" ? <><ActButton action={compPlanOpAction} hidden={{ planId: id, op: "build" }} label="Rebuild worksheet" confirmText="Rebuild from current salaries and ratings? Edited lines are kept." /><ActButton action={compPlanOpAction} hidden={{ planId: id, op: "calibrate" }} label="Start calibration" /></> : null}
          {open ? <ActButton action={compPlanOpAction} hidden={{ planId: id, op: "submit" }} label="Submit for approval" variant="primary" /> : null}
          {plan.status === "PENDING_APPROVAL" ? <span className="text-sm">Waiting for approval in the inbox.</span> : null}
          {plan.status === "APPROVED" ? <ActButton action={compPlanOpAction} hidden={{ planId: id, op: "apply" }} label="Apply salary revisions" variant="primary" confirmText="Create and apply the salary revisions for everyone on this plan?" /> : null}
          {plan.status === "APPLIED" ? <><ActButton action={compPlanOpAction} hidden={{ planId: id, op: "statements" }} label="Regenerate statements" />{unpublished ? <ActButton action={compPlanOpAction} hidden={{ planId: id, op: "publish" }} label={`Publish ${unpublished} statement(s)`} variant="primary" /> : null}</> : null}
        </div>
        {blockers.length && open ? <Callout tone="warning" title="Outside the guardrails">{blockers.map((b) => `${b.item.employee.displayName}: ${b.breaches.join(" ")}`).join(" · ")} — each needs an approved exception before the plan can be submitted.</Callout> : null}
      </Card>

      <Card tight title={`Worksheet${sp.manager ? " — one manager" : ""}`} action={sp.manager ? <Link className="btn sm" href={`/payroll/compensation/${id}`}>Everyone</Link> : undefined}>
        <CompWorksheet items={items} editable={open} admin grades={grades.map((g) => ({ value: g.id, label: g.name }))} sessions={openSessions} breaches={breaches} viewerEmployeeId={viewer.employee?.id ?? null} />
      </Card>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Manager budget pools" description="Each manager's share of the budget; managers cannot go over it.">
          {pools.length === 0 ? <div className="text-sm subtle">Pools are created when the worksheet is built.</div> : (
            <div className="stack gap-2">{pools.map((p) => (
              <div key={p.poolId}>
                <div className="row gap-2" style={{ justifyContent: "space-between" }}>
                  <Link className="text-sm strong" href={`/payroll/compensation/${id}?manager=${p.ownerEmployeeId}`}>{p.ownerName}</Link>
                  <span className={`text-xs ${p.over ? "neg" : ""}`}>{formatINR(p.used)} of {formatINR(p.amount)}</span>
                </div>
                <Progress value={p.used} max={Math.max(1, p.amount)} tone={p.over ? "warning" : "success"} />
                {open ? <ActButton action={poolAction} hidden={{ planId: id, poolId: p.poolId, op: "set" }} label="Set" input={{ name: "amount", placeholder: "₹", type: "number", required: true }} /> : null}
              </div>
            ))}</div>
          )}
          {open && pools.length > 1 ? (
            <div style={{ marginTop: 10 }}><Reveal label="Move budget between managers">
              <GrowthForm action={poolAction} hidden={{ planId: id, op: "transfer" }} cols={2} submitLabel="Move" fields={[
                { name: "fromPoolId", label: "From", type: "select", required: true, options: pools.map((p) => ({ value: p.poolId, label: `${p.ownerName} (${formatINR(p.left)} left)` })) },
                { name: "toPoolId", label: "To", type: "select", required: true, options: pools.map((p) => ({ value: p.poolId, label: p.ownerName })) },
                { name: "amount", label: "Amount (₹)", type: "number", required: true },
                { name: "reason", label: "Reason", required: true },
              ]} />
            </Reveal></div>
          ) : null}
        </Card>
        <Card title="Calibration sessions" description="Changes made in a session are logged against it.">
          {sessions.length === 0 ? <div className="text-sm subtle">None yet.</div> : (
            <div className="stack gap-2">{sessions.map((x) => (
              <div key={x.id} className="row gap-2" style={{ justifyContent: "space-between" }}>
                <span className="text-sm">{x.name} · {formatDate(x.scheduledAt)}{x.departmentId ? ` · ${departments.find((d) => d.id === x.departmentId)?.name ?? ""}` : ""}{x.notes ? <span className="text-xs subtle"> — {x.notes}</span> : null}</span>
                {x.status === "OPEN" ? <ActButton action={calibrationSessionAction} hidden={{ op: "close", sessionId: x.id }} label="Close" input={{ name: "notes", placeholder: "Outcome notes" }} /> : <Badge>closed</Badge>}
              </div>
            ))}</div>
          )}
          {open ? <div style={{ marginTop: 10 }}><Reveal label="Schedule a session"><GrowthForm action={calibrationSessionAction} hidden={{ planId: id }} cols={2} submitLabel="Schedule" fields={[
            { name: "name", label: "Name", required: true }, { name: "scheduledAt", label: "Date", type: "date", required: true },
            { name: "departmentId", label: "Department", type: "select", options: departments.map((d) => ({ value: d.id, label: d.name })) }, { name: "notes", label: "Agenda" },
          ]} /></Reveal></div> : null}
        </Card>
      </div>

      {["DRAFT", "PLANNING"].includes(plan.status) ? (
        <Card title="Plan settings">
          <GrowthForm action={compPlanSettingsAction} hidden={{ planId: id }} submitLabel="Save settings" fields={settingsFields(plan)} />
        </Card>
      ) : null}

      {statements.length ? (
        <Card title={`Statements (${statements.length})`} description={`${statements.filter((x) => x.publishedAt).length} published · ${statements.filter((x) => x.acknowledgedAt).length} acknowledged`}>
          {preview ? (
            <div className="text-sm" style={{ marginBottom: 8 }}>
              <div className="strong">Preview — {statements[0]!.employee.displayName}</div>
              <div>{formatINR(preview.currentCtc)} → {formatINR(preview.newCtc)} ({preview.totalPct}%: merit {preview.meritPct}%, promotion {preview.promotionPct}%, market {preview.marketPct}%) · total rewards {formatINR(preview.totalRewards)}</div>
              <div className="text-xs subtle">{preview.components.map((c) => `${c.name} ${formatINR(c.annual)}`).join(" · ")}</div>
            </div>
          ) : null}
          <div className="text-xs">{statements.map((x) => `${x.employee.displayName}${x.acknowledgedAt ? " ✓" : x.publishedAt ? " (sent)" : " (draft)"}`).join(", ")}</div>
        </Card>
      ) : null}

      <Card tight title="Decision log">
        {log.length === 0 ? <Empty title="No decisions yet" /> : (
          <div className="table-wrap"><table className="data"><tbody>{log.map((l) => {
            const a = l.after as Record<string, unknown> | null;
            return <tr key={l.id}><td className="text-xs nowrap">{l.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td className="text-xs">{l.action.toLowerCase().replace(/_/g, " ")}</td><td className="text-sm">{l.itemId ? names.get(l.itemId) ?? "" : ""}{a && "totalPct" in a ? ` → ${String(a.totalPct)}%` : ""}</td><td className="text-xs subtle">{l.reason ?? ""}{l.sessionId ? ` (session ${sessions.find((x) => x.id === l.sessionId)?.name ?? ""})` : ""}</td></tr>;
          })}</tbody></table></div>
        )}
      </Card>
    </>
  );
}
