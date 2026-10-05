import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import {
  getOpsSettings, latestValidation, varianceBreaches, closeChecklist, componentHierarchy, payrollTrace, payrollInputAudit, signoffBoard, OPS_SIGNOFF_TYPES,
  lwfReconciliation, validateStructureStatutory, type OpsIssue,
} from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { departmentOptions, locationOptions, userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Stat, Callout } from "@/components/ui";
import { Pill, Tabs, Table, SearchBar } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { OpsRequests, monthOptions } from "@/components/ops-ui";
import {
  validateRunAction, saveVarianceRuleAction, reviewVarianceAction, setCloseItemAction, saveComponentGroupAction, deleteComponentGroupAction, saveRecurringRuleAction,
  applyRecurringRulesAction, requestPayslipReleaseAction, requestStatutorySignoffAction, refreshStatutoryExceptionsAction, resolveStatutoryExceptionAction,
} from "@/app/actions/ops-payroll";
import { saveOpsSettingsAction } from "@/app/actions/ops-time-attend";

export const metadata = { title: "Payroll controls" };
const TABS = { validation: "Validation", variance: "Variance", close: "Close checklist", components: "Component hierarchy", recurring: "Recurring", trace: "Trace", signoff: "Sign-offs", exceptions: "Statutory exceptions", lwf: "LWF reconciliation", structure: "Structure check", audit: "Input audit", settings: "Settings" };
type Tab = keyof typeof TABS;
const RUN_TABS: Tab[] = ["validation", "variance", "close", "components", "recurring", "trace"];
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const period = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/**
 * Payroll › Controls: pre-run validation, variance tolerances and reviews,
 * the close checklist, the earnings/deductions hierarchy, recurring rules,
 * the per-employee calculation trace, payslip and statutory sign-offs, the
 * statutory exception queue, LWF reconciliation, structure checks, the input
 * audit and payroll control settings.
 */
export default async function PayrollControlsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireViewer();
  if (!canAny(v, [P.PAYROLL_RUN, P.PAYROLL_LOCK, P.PAYROLL_SETTINGS, P.PAYROLL_APPROVE, P.STATUTORY_MANAGE])) forbidden();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "validation";
  const t = v.tenantId;
  const runs = await prisma.payrollRun.findMany({ where: { tenantId: t, rolledBackAt: null }, include: { payGroup: { select: { name: true } } }, orderBy: [{ year: "desc" }, { month: "desc" }, { sequence: "asc" }], take: 24 });
  const run = runs.find((r) => r.id === sp.run) ?? runs[0] ?? null;
  const runPicker = RUN_TABS.includes(tab) ? (
    <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
      <input type="hidden" name="tab" value={tab} />
      <select name="run" className="select" defaultValue={run?.id ?? ""} style={{ width: 320 }}>{runs.map((r) => <option key={r.id} value={r.id}>{period(r.year, r.month)} · {r.payGroup.name} · {r.type.toLowerCase()} · {r.status.toLowerCase()}</option>)}</select>
      {tab === "trace" ? <select name="emp" className="select" defaultValue={sp.emp ?? ""} style={{ width: 280 }}>{run ? (await prisma.payrollRunEmployee.findMany({ where: { runId: run.id }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { employee: { firstName: "asc" } } })).map((l) => <option key={l.employeeId} value={l.employeeId}>{l.employee.displayName} ({l.employee.employeeNumber})</option>) : null}</select> : null}
      {tab === "components" ? <select name="kind" className="select" defaultValue={sp.kind ?? "EARNING"} style={{ width: 160 }}><option value="EARNING">Earnings</option><option value="DEDUCTION">Deductions</option></select> : null}
      <button className="btn sm" type="submit">Show</button>
    </form>
  ) : null;
  const qs = new URLSearchParams(Object.entries({ tab, run: run?.id, emp: sp.emp, kind: sp.kind, month: sp.month, q: sp.q }).filter((e): e is [string, string] => !!e[1])).toString();
  return (
    <>
      <PageHead title="Payroll controls" subtitle="Validation, variance, close, trace and statutory sign-off" actions={<a className="btn" href={`/payroll/controls/export?${qs}`}>Download CSV</a>} />
      <Tabs base="/payroll/controls" tabs={TABS} active={tab} />
      {runPicker}
      {RUN_TABS.includes(tab) && !run ? <Callout title="No payroll runs yet">Create a run under Payroll › Runs first.</Callout> : null}
      {tab === "validation" && run ? <Validation tenantId={t} runId={run.id} canRun={canAny(v, [P.PAYROLL_RUN, P.PAYROLL_LOCK])} /> : null}
      {tab === "variance" && run ? <Variance tenantId={t} runId={run.id} manage={can(v, P.PAYROLL_SETTINGS)} /> : null}
      {tab === "close" && run ? <Close tenantId={t} runId={run.id} /> : null}
      {tab === "components" ? <Components tenantId={t} kind={sp.kind === "DEDUCTION" ? "DEDUCTION" : "EARNING"} runId={run?.id ?? null} manage={can(v, P.SALARY_STRUCTURE_MANAGE)} /> : null}
      {tab === "recurring" ? <Recurring tenantId={t} runId={run?.id ?? null} runStatus={run?.status ?? null} manage={can(v, P.PAYROLL_SETTINGS)} /> : null}
      {tab === "trace" && run ? <Trace tenantId={t} runId={run.id} employeeId={sp.emp} /> : null}
      {tab === "signoff" ? <Signoff tenantId={t} runs={runs.filter((r) => r.status === "FINALIZED").map((r) => ({ value: r.id, label: `${period(r.year, r.month)} · ${r.payGroup.name}` }))} /> : null}
      {tab === "exceptions" ? <Exceptions tenantId={t} status={sp.status} /> : null}
      {tab === "lwf" ? <Lwf tenantId={t} month={sp.month} /> : null}
      {tab === "structure" ? <Structure tenantId={t} sp={sp} /> : null}
      {tab === "audit" ? <Audit tenantId={t} q={sp.q} from={sp.from} to={sp.to} /> : null}
      {tab === "settings" ? <Settings tenantId={t} manage={can(v, P.PAYROLL_SETTINGS)} /> : null}
    </>
  );
}

async function Validation({ tenantId, runId, canRun }: { tenantId: string; runId: string; canRun: boolean }) {
  const last = await latestValidation(tenantId, runId);
  const issues = ((last?.issues ?? []) as unknown as OpsIssue[]);
  const names = await userNames(tenantId, [last?.ranBy]);
  return (
    <div className="stack gap-4">
      <Card title="Validate inputs" description="Checks every employee in the run for missing salary, bank account, PAN, UAN or ESI number, work state, LOP beyond the period, exited employees and negative net pay. A clean run ticks the close checklist." action={canRun ? <ActButton action={validateRunAction} hidden={{ runId }} label="Validate now" /> : null}>
        {last ? <div className="grid grid-3"><Stat label="Errors" value={last.errors} tone={last.errors ? "neg" : undefined} /><Stat label="Warnings" value={last.warnings} /><Stat label="Last run" value={fmtWhen(last.ranAt)} meta={names.get(last.ranBy) ?? ""} /></div> : <div className="text-sm subtle">Not validated yet.</div>}
      </Card>
      <Card title="Issues" tight>
        <Table head={["Severity", "Employee", "Check", "Detail"]} empty={issues.length === 0}>
          {issues.map((i, k) => <tr key={k}><td><Pill s={i.severity} /></td><td className="text-sm">{i.employee}</td><td className="text-xs">{i.code}</td><td className="text-sm">{i.message}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Variance({ tenantId, runId, manage }: { tenantId: string; runId: string; manage: boolean }) {
  const [rules, comps, b] = await Promise.all([
    prisma.opsVarianceRule.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.salaryComponent.findMany({ where: { tenantId }, select: { code: true, name: true }, orderBy: { code: "asc" } }),
    varianceBreaches(tenantId, runId),
  ]);
  return (
    <div className="stack gap-4">
      {manage ? <Card title="Tolerance rules" description="Compare each employee with the previous finalised month. A blocking breach must be reviewed before the run can be locked.">
        <SpecForm action={saveVarianceRuleAction} columns={3} fields={[
          { name: "name", label: "Name", required: true }, { name: "metric", label: "Measure", type: "select", required: true, options: [{ value: "NET", label: "Net pay" }, { value: "GROSS", label: "Gross" }, { value: "DEDUCTIONS", label: "Deductions" }, { value: "COMPONENT", label: "One component" }] },
          { name: "componentCode", label: "Component", type: "select", options: comps.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` })) },
          { name: "thresholdPct", label: "Change over (%)", type: "number" }, { name: "thresholdAmount", label: "Change over (₹)", type: "number" },
          { name: "severity", label: "Severity", type: "select", required: true, options: [{ value: "WARN", label: "Warn" }, { value: "BLOCK", label: "Block the lock until reviewed" }] },
        ]} />
        <Table head={["Rule", "Measure", "Over %", "Over ₹", "Severity", "Active"]} empty={rules.length === 0}>
          {rules.map((r) => <tr key={r.id}><td className="text-sm">{r.name}</td><td className="text-sm">{r.metric === "COMPONENT" ? r.componentCode : r.metric.toLowerCase()}</td><td className="num">{r.thresholdPct === null ? "—" : Number(r.thresholdPct)}</td><td className="num">{r.thresholdAmount === null ? "—" : Number(r.thresholdAmount)}</td><td><Pill s={r.severity} /></td><td><Pill s={r.isActive ? "ACTIVE" : "INACTIVE"} /></td></tr>)}
        </Table>
      </Card> : null}
      {b ? <>
        <div className="grid grid-3"><Stat label="Compared with" value={b.previous ?? "No earlier finalised run"} /><Stat label="Breaches" value={b.rows.length} /><Stat label="Unreviewed blocking" value={b.unreviewedBlocks} tone={b.unreviewedBlocks ? "neg" : undefined} /></div>
        <Card title="Breaches" tight>
          <Table head={["Employee", "Rule", "Previous", "This run", "Change", "%", "Severity", "Review"]} empty={b.rows.length === 0}>
            {b.rows.map((r) => <tr key={`${r.employeeId}${r.ruleId}`}><td className="text-sm">{r.employee}</td><td className="text-sm">{r.rule}</td><td className="num">{inr(r.prev)}</td><td className="num">{inr(r.curr)}</td><td className={`num${r.change < 0 ? " neg" : ""}`}>{inr(r.change)}</td><td className="num">{r.pct ?? "—"}</td><td><Pill s={r.severity} /></td>
              <td>{r.review ? <span className="text-xs">{r.review.note}</span> : <ActButton action={reviewVarianceAction} hidden={{ runId, employeeId: r.employeeId, ruleId: r.ruleId }} label="Reviewed" input={{ name: "note", placeholder: "Explanation", required: true }} />}</td></tr>)}
          </Table>
        </Card>
      </> : null}
    </div>
  );
}

async function Close({ tenantId, runId }: { tenantId: string; runId: string }) {
  const [items, s] = await Promise.all([closeChecklist(tenantId, runId), getOpsSettings(tenantId)]);
  const names = await userNames(tenantId, items.map((i) => i.doneBy));
  return (
    <Card title="Close checklist" description={s.requireCloseChecklist ? "Every item must be done before the run can be finalised." : "Optional: turn on \"required before finalising\" under Settings."} tight>
      <Table head={["Step", "Done", "By", "Note", ""]}>
        {items.map((i) => <tr key={i.key}><td className="text-sm">{i.label}</td><td><Pill s={i.done ? "DONE" : "PENDING"} /></td><td className="text-sm">{i.doneBy ? `${names.get(i.doneBy) ?? ""} · ${fmtDate(i.doneAt)}` : ""}</td><td className="text-xs">{i.note ?? ""}</td>
          <td>{i.done ? <ActButton action={setCloseItemAction} hidden={{ runId, key: i.key, done: "false" }} label="Undo" variant="ghost" /> : <ActButton action={setCloseItemAction} hidden={{ runId, key: i.key, done: "true" }} label="Mark done" input={{ name: "note", placeholder: "Note (optional)" }} />}</td></tr>)}
      </Table>
    </Card>
  );
}

async function Components({ tenantId, kind, runId, manage }: { tenantId: string; kind: "EARNING" | "DEDUCTION"; runId: string | null; manage: boolean }) {
  const h = await componentHierarchy(tenantId, kind, runId);
  const allCodes = [...h.groups.flatMap((g) => g.components.map((c) => ({ code: c.code, name: c.name }))), ...h.ungrouped];
  return (
    <div className="stack gap-4">
      {manage ? <Card title={`Add a ${kind === "EARNING" ? "earnings" : "deductions"} group`} description="Group components for the register and reports; groups can nest.">
        <SpecForm action={saveComponentGroupAction} hidden={{ kind }} columns={3} fields={[
          { name: "name", label: "Group", required: true }, { name: "parentId", label: "Under", type: "select", options: h.groups.map((g) => ({ value: g.id, label: g.path })), placeholder: "Top level" },
          { name: "sortOrder", label: "Order", type: "number", defaultValue: 0 },
          { name: "componentCodes", label: "Components", type: "multiselect", wide: true, options: allCodes.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` })) },
        ]} />
      </Card> : null}
      <Card title="Hierarchy (amounts from the selected run)" tight>
        <Table head={["Group", "Components", "Total", ""]} empty={h.groups.length === 0}>
          {h.groups.map((g) => <tr key={g.id}><td className="text-sm" style={{ paddingLeft: 12 + g.depth * 20 }}>{g.name}</td><td className="text-xs">{g.components.map((c) => `${c.code} ${inr(c.amount)}`).join(", ")}</td><td className="num strong">{inr(g.total)}</td>
            <td>{manage ? <ActButton action={deleteComponentGroupAction} hidden={{ id: g.id }} label="Remove" variant="ghost" confirmText="Remove this group? Subgroups move to the top." /> : null}</td></tr>)}
        </Table>
        {h.ungrouped.length ? <div className="text-xs subtle" style={{ padding: 12 }}>Not in any group: {h.ungrouped.map((c) => c.code).join(", ")}</div> : null}
      </Card>
    </div>
  );
}

async function Recurring({ tenantId, runId, runStatus, manage }: { tenantId: string; runId: string | null; runStatus: string | null; manage: boolean }) {
  const [rules, groups, depts, locs] = await Promise.all([
    prisma.opsRecurringComponentRule.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.payGroup.findMany({ where: { tenantId }, select: { id: true, name: true } }), departmentOptions(tenantId), locationOptions(tenantId),
  ]);
  return (
    <div className="stack gap-4">
      {manage ? <Card title="Add a recurring payment or deduction" description="Applied to a run as one-time items for everyone in scope when due: monthly, quarterly, half-yearly or annual (optionally in named months).">
        <SpecForm action={saveRecurringRuleAction} columns={3} fields={[
          { name: "name", label: "Name", required: true }, { name: "type", label: "Type", type: "select", required: true, options: [{ value: "PAYMENT", label: "Payment" }, { value: "DEDUCTION", label: "Deduction" }] },
          { name: "amount", label: "Amount (₹)", type: "number", required: true },
          { name: "frequency", label: "Frequency", type: "select", required: true, options: [{ value: "MONTHLY", label: "Monthly" }, { value: "QUARTERLY", label: "Quarterly" }, { value: "HALF_YEARLY", label: "Half-yearly" }, { value: "ANNUAL", label: "Annual" }] },
          { name: "startDate", label: "From", type: "date", required: true }, { name: "endDate", label: "Until", type: "date" },
          { name: "payGroupId", label: "Pay group", type: "select", options: groups.map((g) => ({ value: g.id, label: g.name })), placeholder: "All" },
          { name: "departmentId", label: "Department", type: "select", options: depts, placeholder: "All" }, { name: "locationId", label: "Location", type: "select", options: locs, placeholder: "All" },
          { name: "months", label: "In months (optional)", type: "multiselect", wide: true, options: monthOptions() },
        ]} />
      </Card> : null}
      <Card title="Recurring rules" action={runId && runStatus && ["DRAFT", "CALCULATED", "IN_PROGRESS"].includes(runStatus) ? <ActButton action={applyRecurringRulesAction} hidden={{ runId }} label="Apply to selected run" confirmText="Add the due recurring items to this run?" /> : null} tight>
        <Table head={["Name", "Type", "Amount", "Frequency", "Months", "Scope", "Window", "Active"]} empty={rules.length === 0}>
          {rules.map((r) => <tr key={r.id}><td className="text-sm">{r.name}</td><td><Pill s={r.type} /></td><td className="num">{inr(Number(r.amount))}</td><td className="text-sm">{r.frequency.toLowerCase().replace("_", "-")}</td><td className="text-xs">{r.months.join(", ")}</td><td className="text-xs">{[r.payGroupId ? groups.find((g) => g.id === r.payGroupId)?.name : null, r.departmentId ? depts.find((d) => d.value === r.departmentId)?.label : null, r.locationId ? locs.find((d) => d.value === r.locationId)?.label : null].filter(Boolean).join(" · ") || "Everyone"}</td><td className="text-xs">{fmtDate(r.startDate)} – {r.endDate ? fmtDate(r.endDate) : "open"}</td><td><Pill s={r.isActive ? "ACTIVE" : "INACTIVE"} /></td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Trace({ tenantId, runId, employeeId }: { tenantId: string; runId: string; employeeId?: string }) {
  const first = employeeId ?? (await prisma.payrollRunEmployee.findFirst({ where: { runId, run: { tenantId } }, select: { employeeId: true } }))?.employeeId;
  const tr = first ? await payrollTrace(tenantId, runId, first) : null;
  if (!tr) return <Callout title="Nothing to trace">Pick an employee in the run.</Callout>;
  return (
    <div className="stack gap-4">
      <Card title={`${tr.employee}: ${tr.period}`} description={`Run ${tr.status.toLowerCase()}, pay action ${tr.payAction.toLowerCase().replace(/_/g, " ")}`} tight>
        <Table head={["Step", "How it was worked out"]}>{tr.steps.map((s, i) => <tr key={i}><td className="text-sm strong nowrap">{s.step}</td><td className="text-sm">{s.detail}</td></tr>)}</Table>
      </Card>
      <div className="grid grid-2">
        <Card title="One-time items" tight><Table head={["Item", "Type", "Amount", "Source"]} empty={tr.inputs.adhoc.length === 0}>{tr.inputs.adhoc.map((a, i) => <tr key={i}><td className="text-sm">{a.name}</td><td className="text-sm">{String(a.type).toLowerCase()}</td><td className="num">{inr(a.amount)}</td><td className="text-xs">{a.source}</td></tr>)}</Table></Card>
        <Card title="Other inputs" tight>
          <Table head={["Input", "Detail"]} empty={!tr.inputs.lop.length && !tr.inputs.overrides.length && !tr.inputs.loans.length && !tr.inputs.arrears.length}>
            {tr.inputs.lop.map((l, i) => <tr key={`l${i}`}><td className="text-sm">LOP adjustment</td><td className="text-sm">{l.days} day(s){l.note ? ` · ${l.note}` : ""}</td></tr>)}
            {tr.inputs.overrides.map((o, i) => <tr key={`o${i}`}><td className="text-sm">Override {o.component}</td><td className="text-sm">{inr(o.amount)} from {fmtDate(o.from)}{o.to ? ` to ${fmtDate(o.to)}` : ""}</td></tr>)}
            {tr.inputs.loans.map((l, i) => <tr key={`n${i}`}><td className="text-sm">Loan instalment</td><td className="text-sm">{inr(l.amount)} · {String(l.status).toLowerCase()}</td></tr>)}
            {tr.inputs.arrears.map((a) => <tr key={a.id}><td className="text-sm">Arrear</td><td className="text-sm">{inr(a.amount)}{a.processed ? " · paid" : ""}</td></tr>)}
          </Table>
        </Card>
      </div>
      {tr.errors.length ? <Callout tone="danger" title="Calculation errors">{tr.errors.join(" ")}</Callout> : null}
    </div>
  );
}

async function Signoff({ tenantId, runs }: { tenantId: string; runs: Array<{ value: string; label: string }> }) {
  const [board, s] = await Promise.all([signoffBoard(tenantId), getOpsSettings(tenantId)]);
  const names = await userNames(tenantId, board.requests.map((r) => r.requestedBy));
  const now = new Date();
  return (
    <div className="stack gap-4">
      <Callout title="Sign-off rules">{s.requirePayslipApproval ? "Payslip release needs approval. " : "Payslips release directly. "}{s.requireFilingApproval ? "Statutory returns need sign-off before they are marked filed." : "Statutory returns can be marked filed without sign-off."} Change these under Settings.</Callout>
      <div className="grid grid-2">
        <Card title="Request payslip release">
          <SpecForm action={requestPayslipReleaseAction} columns={1} fields={[{ name: "runId", label: "Finalised run", type: "select", required: true, options: runs }, { name: "note", label: "Note" }]} />
        </Card>
        <Card title="Request statutory sign-off" description="Pick a generated filing, or a PT/LWF return month (the return record is created).">
          <SpecForm action={requestStatutorySignoffAction} columns={2} fields={[
            { name: "filingId", label: "Generated filing", type: "select", options: board.filings.map((f) => ({ value: f.id, label: `${OPS_SIGNOFF_TYPES[f.type] ?? f.type} · FY ${f.fyStartYear}${f.month ? ` · month ${f.month}` : f.quarter ? ` · Q${f.quarter}` : ""} · ${f.status.toLowerCase()}` })), wide: true },
            { name: "type", label: "Or return", type: "select", options: [{ value: "PT_RETURN", label: "Professional tax return" }, { value: "LWF_RETURN", label: "LWF return" }] },
            { name: "year", label: "Year", type: "number", defaultValue: now.getUTCFullYear() }, { name: "month", label: "Month", type: "select", options: monthOptions() }, { name: "note", label: "Note" },
          ]} />
        </Card>
      </div>
      <Card title="Filings" tight>
        <Table head={["Return", "Period", "Status", "Signed off", "Filed"]} empty={board.filings.length === 0}>
          {board.filings.map((f) => { const meta = (f.meta ?? {}) as Record<string, unknown>; return <tr key={f.id}><td className="text-sm">{OPS_SIGNOFF_TYPES[f.type] ?? f.type}</td><td className="text-sm">FY {f.fyStartYear}{f.month ? ` · month ${f.month}` : f.quarter ? ` · Q${f.quarter}` : ""}</td><td><Pill s={f.status} /></td><td className="text-sm">{meta.signedOffAt ? fmtDate(new Date(String(meta.signedOffAt))) : ""}</td><td className="text-sm">{fmtDate(f.filedAt)}</td></tr>; })}
        </Table>
      </Card>
      <Card title="Sign-off requests" tight><OpsRequests rows={board.requests} names={names} /></Card>
    </div>
  );
}

async function Exceptions({ tenantId, status }: { tenantId: string; status?: string }) {
  const st = status === "ALL" ? undefined : status || "OPEN";
  const rows = await prisma.opsStatutoryException.findMany({ where: { tenantId, ...(st ? { status: st } : {}) }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 300 });
  const now = new Date();
  return (
    <div className="stack gap-4">
      <Card title="Re-check a month" description="Rebuilds the queue from the PF/ESI coverage and PT/LWF checks. Items that are fixed close themselves.">
        <SpecForm action={refreshStatutoryExceptionsAction} columns={2} submitLabel="Re-check" fields={[{ name: "year", label: "Year", type: "number", required: true, defaultValue: now.getUTCFullYear() }, { name: "month", label: "Month", type: "select", required: true, options: monthOptions(), defaultValue: String(now.getUTCMonth() + 1) }]} />
      </Card>
      <div className="tabs">{["OPEN", "RESOLVED", "IGNORED", "ALL"].map((s) => <a key={s} className={`tab${(st ?? "ALL") === s ? " active" : ""}`} href={`/payroll/controls?tab=exceptions&status=${s}`}>{s.toLowerCase()}</a>)}</div>
      <Card title="Exceptions" tight>
        <Table head={["Kind", "Detail", "Severity", "Status", "Note", ""]} empty={rows.length === 0}>
          {rows.map((r) => <tr key={r.id}><td className="text-sm">{r.kind.replace(/_/g, " ")}</td><td className="text-sm">{r.detail}</td><td><Pill s={r.severity} /></td><td><Pill s={r.status} /></td><td className="text-xs">{r.note ?? ""}</td>
            <td>{r.status === "OPEN" ? <div className="row gap-1"><ActButton action={resolveStatutoryExceptionAction} hidden={{ id: r.id, status: "RESOLVED" }} label="Resolve" input={{ name: "note", placeholder: "What was done", required: true }} /><ActButton action={resolveStatutoryExceptionAction} hidden={{ id: r.id, status: "IGNORED", note: "Not applicable" }} label="Ignore" variant="ghost" /></div> : <ActButton action={resolveStatutoryExceptionAction} hidden={{ id: r.id, status: "OPEN", note: "" }} label="Reopen" variant="ghost" />}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Lwf({ tenantId, month }: { tenantId: string; month?: string }) {
  const now = new Date();
  const [y, m] = /^\d{4}-\d{2}$/.test(month ?? "") ? month!.split("-").map(Number) as [number, number] : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const r = await lwfReconciliation(tenantId, y, m);
  return (
    <div className="stack gap-4">
      <form method="get" className="row gap-2"><input type="hidden" name="tab" value="lwf" /><input className="input" type="month" name="month" defaultValue={period(y, m)} style={{ width: 160 }} /><button className="btn sm" type="submit">Show</button></form>
      <div className="grid grid-4"><Stat label="Matched" value={r.matched} /><Stat label="Mismatched" value={r.mismatched} tone={r.mismatched ? "neg" : undefined} /><Stat label="Deducted" value={inr(r.totalDeducted)} /><Stat label="Expected" value={inr(r.totalExpected)} /></div>
      <Card title={`LWF ${period(y, m)}: deducted vs state rule`} tight>
        <Table head={["Employee", "State", "Expected (employee)", "Deducted (employee)", "Expected (employer)", "Deducted (employer)", "Difference", "Status"]} empty={r.rows.length === 0}>
          {r.rows.map((x) => <tr key={x.employeeId}><td className="text-sm">{x.employee}</td><td className="text-sm">{x.stateCode ?? "—"}</td><td className="num">{x.expectedEmployee}</td><td className="num">{x.deductedEmployee}</td><td className="num">{x.expectedEmployer}</td><td className="num">{x.deductedEmployer}</td><td className={`num${x.difference ? " neg" : ""}`}>{x.difference}</td><td><Pill s={x.status} /></td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Structure({ tenantId, sp }: { tenantId: string; sp: Record<string, string | undefined> }) {
  const structures = await prisma.salaryStructure.findMany({ where: { payGroup: { tenantId } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const ctc = Number(sp.ctc ?? 0);
  const res = sp.structure && ctc > 0 ? await validateStructureStatutory(tenantId, sp.structure, ctc, sp.state || null) : null;
  return (
    <div className="stack gap-4">
      <Card title="Check a structure at a CTC" description="Works the structure out at the CTC and checks basic vs the 50% wage rule, the PF and ESI ceilings and the state minimum wage.">
        <form method="get" className="row gap-2 wrap">
          <input type="hidden" name="tab" value="structure" />
          <select name="structure" className="select" defaultValue={sp.structure ?? ""} style={{ width: 260 }}>{structures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <input className="input num" name="ctc" type="number" placeholder="Annual CTC" defaultValue={sp.ctc ?? ""} style={{ width: 160 }} />
          <input className="input" name="state" placeholder="State code (e.g. KA)" defaultValue={sp.state ?? ""} style={{ width: 160 }} />
          <button className="btn sm" type="submit">Check</button>
        </form>
      </Card>
      {res ? <>
        <div className="grid grid-3"><Stat label="Monthly basic" value={inr(res.monthlyBasic)} /><Stat label="Monthly gross" value={inr(res.monthlyGross)} /><Stat label="Issues" value={res.issues.length} tone={res.issues.some((i) => i.severity === "ERROR") ? "neg" : undefined} /></div>
        {res.issues.map((i, k) => <Callout key={k} tone={i.severity === "ERROR" ? "danger" : "warning"}>{i.message}</Callout>)}
        <Card title={res.structure} tight><Table head={["Code", "Component", "Type", "Monthly"]}>{res.components.map((c) => <tr key={c.code}><td className="text-sm">{c.code}</td><td className="text-sm">{c.name}</td><td className="text-sm">{String(c.type).toLowerCase()}</td><td className="num">{inr(c.monthly)}</td></tr>)}</Table></Card>
      </> : null}
    </div>
  );
}

async function Audit({ tenantId, q, from, to }: { tenantId: string; q?: string; from?: string; to?: string }) {
  const rows = await payrollInputAudit(tenantId, { q: q || undefined, from: from ? new Date(`${from}T00:00:00Z`) : undefined, to: to ? new Date(`${to}T23:59:59Z`) : undefined });
  return (
    <div className="stack gap-4">
      <SearchBar action="/payroll/controls" tab="audit" q={q}><input className="input" type="date" name="from" defaultValue={from ?? ""} style={{ width: 150 }} /><input className="input" type="date" name="to" defaultValue={to ?? ""} style={{ width: 150 }} /></SearchBar>
      <Card title="Payroll input audit" tight>
        <Table head={["When", "Who", "Action", "Record", "Summary"]} empty={rows.length === 0}>
          {rows.map((r) => <tr key={r.id}><td className="text-sm nowrap">{fmtWhen(r.createdAt)}</td><td className="text-sm">{r.actorLabel ?? ""}</td><td><Pill s={r.action} /></td><td className="text-xs">{r.entityType}</td><td className="text-xs">{r.summary}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Settings({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const s = await getOpsSettings(tenantId);
  if (!manage) return <Callout title="Read only">Net pay rounding: {s.netPayRoundTo === 1 ? "off" : `to ₹${s.netPayRoundTo} (${s.netPayRoundingMode.toLowerCase()})`}; negative net pay: {s.negativeNetPayAction.toLowerCase()}.</Callout>;
  return (
    <Card title="Payroll controls" description={`Attendance for payroll is taken up to day ${s.attendanceCutoffDay} of the month (set under Time controls).`}>
      <SpecForm action={saveOpsSettingsAction} hidden={{ section: "payroll" }} fields={[
        { name: "netPayRoundTo", label: "Round net pay to (₹)", type: "number", defaultValue: s.netPayRoundTo, hint: "1 leaves pay as calculated" },
        { name: "netPayRoundingMode", label: "Rounding", type: "select", required: true, defaultValue: s.netPayRoundingMode, options: [{ value: "NEAREST", label: "Nearest" }, { value: "UP", label: "Up" }, { value: "DOWN", label: "Down" }] },
        { name: "negativeNetPayAction", label: "Negative net pay", type: "select", required: true, defaultValue: s.negativeNetPayAction, options: [{ value: "WARN", label: "Warn" }, { value: "BLOCK", label: "Block the lock" }] },
        { name: "requirePayslipApproval", label: "Payslips", type: "checkbox", defaultValue: s.requirePayslipApproval, placeholder: "Release needs approval" },
        { name: "requireFilingApproval", label: "Statutory returns", type: "checkbox", defaultValue: s.requireFilingApproval, placeholder: "Sign-off before marking filed" },
        { name: "requireCloseChecklist", label: "Close checklist", type: "checkbox", defaultValue: s.requireCloseChecklist, placeholder: "Required before finalising" },
      ]} />
    </Card>
  );
}
