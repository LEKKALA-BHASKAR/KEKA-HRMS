import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { computeSettlement, noticeDaysFor, settlementMonthOptions, periodLabel, fnfAdjustments, adjustmentTargets, adjustmentsNet, type SettlementLine } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { PageHead, Card, Badge, Callout, KeyValue, Person } from "@/components/ui";
import {
  ExitDecisionForm, WithdrawExitButton, DraftSettlementForm, FinalizeSettlementButton,
} from "../../_lifecycle/forms";
import { JourneyChecklist } from "../../_lifecycle/journey-view";
import { VoidSettlementForm, EmailStatementForm, AddAdjustmentForm, AttachAdjustment, RemoveAdjustment } from "./fnf-forms";

const P = PERMISSIONS;
const DAY = 86_400_000;

export default async function ExitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const exit = await prisma.exitRecord.findFirst({
    where: { id, employee: { tenantId: viewer.tenantId } },
    include: {
      exitReason: { select: { name: true, kind: true } },
      employee: {
        include: {
          department: { select: { name: true } },
          reportingManager: { select: { displayName: true } },
          fnfSettlement: true,
          journeys: { where: { trigger: "EXIT", status: { not: "CANCELLED" } }, select: { id: true } },
        },
      },
    },
  });
  if (!exit) notFound();
  const e = exit.employee;
  const target = { id: e.id, departmentId: e.departmentId, locationId: e.locationId, legalEntityId: e.legalEntityId, businessUnitId: e.businessUnitId, reportingManagerId: e.reportingManagerId };
  const may = (p: (typeof P)[keyof typeof P]) => can(viewer, p) && canAccessEmployee(viewer, target, p);
  if (!canAny(viewer, [P.EXIT_MANAGE, P.EXIT_APPROVE, P.FNF_MANAGE, P.EXIT_INITIATE]) ||
      ![P.EXIT_MANAGE, P.EXIT_APPROVE, P.FNF_MANAGE, P.EXIT_INITIATE].some(may)) notFound();

  const notice = await noticeDaysFor(e.id, exit.type);
  const served = Math.round((exit.lastWorkingDay.getTime() - exit.noticeDate.getTime()) / DAY);
  const pending = ["INITIATED", "PENDING_APPROVAL"].includes(exit.status);
  const decided = ["APPROVED", "IN_CLEARANCE", "SETTLED", "COMPLETED"].includes(exit.status);
  const s = e.fnfSettlement;
  const breakdown = (s?.breakdown ?? null) as { lines?: SettlementLine[]; notes?: string[]; waiveNoticeRecovery?: boolean; computedAt?: string } | null;
  // Before a draft exists, show a live preview so nobody drafts blind.
  const preview = !s && decided && may(P.FNF_MANAGE) ? await computeSettlement(e.id).catch(() => null) : null;
  const lines = breakdown?.lines ?? preview?.lines ?? [];
  const notes = breakdown?.notes ?? preview?.notes ?? [];
  const pay = lines.filter((l) => l.direction === "PAY");
  const rec = lines.filter((l) => l.direction === "RECOVER");
  const net = s ? Number(s.netSettlement) : preview?.net ?? 0;
  const lwdPassed = exit.lastWorkingDay.getTime() <= Date.now();
  const settled = !!s && ["FINALIZED", "PAID", "ALREADY_PAID"].includes(s.status);
  const months = settlementMonthOptions(exit.lastWorkingDay).map((m) => ({ value: m.value, label: m.label }));
  const period = s?.settlementYear && s.settlementMonth ? `${s.settlementYear}-${String(s.settlementMonth).padStart(2, "0")}` : undefined;
  const adjustments = s && may(P.FNF_MANAGE) ? await fnfAdjustments(s.id) : [];
  const openRuns = settled && may(P.FNF_MANAGE) ? await adjustmentTargets(e.id, viewer.tenantId) : [];
  const targets = [
    ...openRuns.map((r) => ({ value: `run:${r.id}`, label: r.label })),
    ...months.map((m) => ({ value: `month:${m.value}`, label: `Hold for ${m.label} (pay later in an off-cycle payroll)` })),
  ];

  return (
    <>
      <PageHead
        title={<span className="row gap-2">{e.displayName} <Badge tone={pending ? "warning" : decided ? "info" : "neutral"}>{exit.status.replace(/_/g, " ").toLowerCase()}</Badge></span>}
        subtitle={`${exit.type.replace(/_/g, " ").toLowerCase()} · last working day ${formatDate(exit.lastWorkingDay)}`}
        actions={<Link className="btn" href="/exits">All exits</Link>}
      />

      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 380px", alignItems: "start" }}>
        <div className="stack gap-4">
          {pending && may(P.EXIT_APPROVE) && e.id !== viewer.employee?.id ? (
            <Card title="Decide" description="Accepting starts the exit checklist and sets the last working day payroll prorates to.">
              <ExitDecisionForm exitId={exit.id} lastWorkingDay={exit.lastWorkingDay.toISOString().slice(0, 10)} />
            </Card>
          ) : null}

          {e.journeys[0] ? (
            <Card tight title="Exit checklist" description="Tasks the system can verify close themselves — asset returns, loans, the settlement.">
              <JourneyChecklist journeyId={e.journeys[0].id} viewer={viewer} anchorLabel="the last day" />
            </Card>
          ) : null}

          {decided && (may(P.FNF_MANAGE) || may(P.FNF_APPROVE)) ? (
            <Card title="Full and final settlement"
              description={s ? `${s.status.replace(/_/g, " ").toLowerCase()}${s.settlementYear && s.settlementMonth ? ` · booked in ${periodLabel(s.settlementYear, s.settlementMonth)}` : ""}${breakdown?.computedAt ? ` · computed ${formatDate(new Date(breakdown.computedAt))}` : ""}` : "Preview — not saved until you compute it"}
              action={<span className={`strong ${net >= 0 ? "pos" : "neg"}`}>{net >= 0 ? "Payable " : "Recoverable "}{formatINR(Math.abs(net))}</span>}>
              {lines.length === 0 ? <div className="text-sm muted">Nothing payable or recoverable beyond the final salary.</div> : (
                <div className="grid grid-2" style={{ alignItems: "start" }}>
                  {([["Payable to the employee", pay], ["Recovered from the employee", rec]] as const).map(([title, ls]) => (
                    <div key={title}>
                      <div className="text-xs strong subtle" style={{ marginBottom: 6 }}>{title.toUpperCase()}</div>
                      {ls.length === 0 ? <div className="text-sm subtle">None</div> : ls.map((l, i) => (
                        <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                          <div className="row" style={{ justifyContent: "space-between" }}>
                            <span className="text-sm strong">{l.label}</span>
                            <span className="num text-sm">{formatINR(l.amount)}</span>
                          </div>
                          <div className="text-xs subtle">{l.basis}{l.taxable > 0 ? ` · taxable ${formatINR(l.taxable)}` : ""}</div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {notes.length ? (
                <ul className="text-xs muted" style={{ margin: "12px 0 0", paddingLeft: 18 }}>
                  {notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              ) : null}
              <div className="divider" />
              {s?.status === "VOIDED" && s.voidedAt ? (
                <div style={{ marginBottom: 12 }}><Callout tone="danger" title="Voided">Voided {formatDate(s.voidedAt)}: {s.voidReason}. Its effects were reversed; recompute and finalise a fresh settlement.</Callout></div>
              ) : null}
              {settled && s ? (
                <div className="stack gap-3">
                  <Callout tone="success" title="Finalised">Finalised {s.finalizedAt ? formatDate(s.finalizedAt) : ""}. Recoveries are settled and access is revoked.</Callout>
                  <div className="row gap-3" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                    <div className="row gap-2">
                      <a className="btn" href={`/exits/${exit.id}/statement`}>Download statement (PDF)</a>
                      {s.statementUrl ? <a className="btn ghost" href={s.statementUrl}>Last emailed copy</a> : null}
                    </div>
                    {may(P.FNF_MANAGE) ? <EmailStatementForm employeeId={e.id} email={e.personalEmail ?? e.workEmail ?? null} /> : null}
                  </div>
                  {may(P.FNF_APPROVE) && e.id !== viewer.employee?.id ? <VoidSettlementForm employeeId={e.id} /> : null}
                </div>
              ) : (
                <div className="row gap-3" style={{ justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
                  {may(P.FNF_MANAGE) ? <DraftSettlementForm employeeId={e.id} drafted={!!s} waived={!!breakdown?.waiveNoticeRecovery} months={months} period={period} /> : <span />}
                  {s && s.status !== "VOIDED" ? <a className="btn ghost" href={`/exits/${exit.id}/statement`}>Draft statement (PDF)</a> : null}
                  {s && may(P.FNF_APPROVE) && e.id !== viewer.employee?.id ? (
                    lwdPassed ? <FinalizeSettlementButton employeeId={e.id} /> : <span className="text-xs muted">Can be finalised after {formatDate(exit.lastWorkingDay)}</span>
                  ) : null}
                </div>
              )}
            </Card>
          ) : null}

          {s && may(P.FNF_MANAGE) && (settled || adjustments.length > 0) ? (
            <Card tight title="Adjustments after settlement"
              description="A payment or recovery found after the settlement is final. It is paid through a payroll the employee is in — usually an off-cycle payroll against their last month."
              action={adjustments.length ? <span className={`strong ${adjustmentsNet(adjustments) >= 0 ? "pos" : "neg"}`}>Net {formatINR(adjustmentsNet(adjustments))}</span> : undefined}>
              {adjustments.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Adjustment</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {adjustments.map((a) => (
                        <tr key={a.id} style={{ verticalAlign: "top" }}>
                          <td className="strong">{a.name}<div className="text-xs subtle">{a.type === "PAYMENT" ? "Pay" : "Recover"}{a.taxable ? " · taxable" : ""}{a.comment ? ` · ${a.comment}` : ""}</div></td>
                          <td className={`num ${a.type === "PAYMENT" ? "" : "neg"}`}>{a.type === "PAYMENT" ? "" : "−"}{formatINR(a.amount)}</td>
                          <td className="text-sm">{a.isProcessed ? <Badge tone="success">paid</Badge> : <Badge tone="warning">pending</Badge>}<div className="text-xs muted" style={{ marginTop: 4 }}>{a.status}</div></td>
                          <td className="right">
                            {!a.isProcessed ? (
                              <div className="stack gap-2" style={{ alignItems: "flex-end" }}>
                                <AttachAdjustment adjustmentId={a.id} runs={openRuns.filter((r) => r.id !== a.runId).map((r) => ({ value: r.id, label: r.label }))} />
                                <RemoveAdjustment adjustmentId={a.id} />
                              </div>
                            ) : a.runId ? <Link className="btn sm ghost" href={`/payroll/runs/${a.runId}`}>Open payroll</Link> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {settled ? <div style={{ padding: 16, borderTop: adjustments.length ? "1px solid var(--border)" : undefined }}><AddAdjustmentForm employeeId={e.id} targets={targets} /></div> : null}
            </Card>
          ) : null}
        </div>

        <div className="stack gap-4">
          <Card title="Employee">
            <Person name={e.displayName ?? ""} meta={`${e.employeeNumber} · ${e.jobTitleName ?? ""}`} />
            <div className="divider" />
            <KeyValue items={[
              ["Department", e.department?.name ?? "—"],
              ["Manager", e.reportingManager?.displayName ?? "—"],
              ["Joined", formatDate(e.dateOfJoining)],
              ["Service", `${Math.floor((exit.lastWorkingDay.getTime() - e.dateOfJoining.getTime()) / (365.25 * DAY))} yr ${Math.floor(((exit.lastWorkingDay.getTime() - e.dateOfJoining.getTime()) / (30.44 * DAY)) % 12)} mo`],
            ]} />
          </Card>
          <Card title="Notice">
            <KeyValue items={[
              ["Policy", `${notice.policy} (${notice.days} days)`],
              ["Notice given", formatDate(exit.noticeDate)],
              ["Last working day", formatDate(exit.lastWorkingDay)],
              ["Served", `${served} of ${notice.days} days${served < notice.days ? ` — ${notice.days - served} short` : ""}`],
              ["Reason", exit.exitReason ? `${exit.exitReason.name} · ${exit.exitReason.kind.toLowerCase()}` : "—"],
              ["Rehire eligible", exit.isRehireEligible === null ? "—" : exit.isRehireEligible ? "Yes" : "No"],
            ]} />
            {exit.reason ? <div className="text-sm muted" style={{ marginTop: 12 }}>“{exit.reason}”</div> : null}
            {exit.discussionNote ? <div className="text-xs subtle" style={{ marginTop: 8 }}>Discussion: {exit.discussionNote}</div> : null}
            {!["SETTLED", "COMPLETED", "CANCELLED", "REJECTED", "RETAINED"].includes(exit.status) && may(P.EXIT_MANAGE) ? (
              <div style={{ marginTop: 12 }}><WithdrawExitButton exitId={exit.id} /></div>
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}
