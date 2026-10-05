import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { scalePointsOf } from "@keka/services";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { runDataset } from "@/lib/insight/datasets";
import { userNames, fmtDate, employeeOptions, departmentOptions } from "@/lib/governance";
import { PageHead, Card, Badge } from "@/components/ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Tabs, Table, Pill, SearchBar } from "@/components/gov-ui";
import { InsightTableView } from "@/components/insight-table";
import {
  saveCycleTemplateAction, createCycleFromTemplateAction, toggleCycleTemplateAction, saveRatingScaleAction, applyRatingScaleAction, setQuestionWeightAction,
  setSectionConditionAction, addCalibrationNoteAction, deleteCalibrationNoteAction, refreshExceptionsAction, resolveExceptionAction, generateReviewSummaryAction,
  requestReviewReopenAction, runInsightJobAction,
} from "@/app/actions/insight-performance";

export const metadata = { title: "Review operations" };
const TABS = { templates: "Cycle templates", scales: "Rating scales", form: "Form weights & conditions", data: "Performance data", exceptions: "Exception queue", calibration: "Calibration notes", normalization: "Normalisation", trend: "Trend", summaries: "Summaries", reopen: "Reopening", audit: "Audit history" };
type Tab = keyof typeof TABS;
type SP = Record<string, string | undefined>;

/**
 * Performance › Review operations: everything around review cycles that is
 * not the review itself — templates, rating scales with their description
 * library, competency weights and conditional sections, the data export,
 * the exception queue, calibration notes, normalisation, the trend across
 * cycles, generated summaries, reopening requests, reminders and the audit.
 */
export default async function OperationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE])) forbidden();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "templates";
  const cycles = await prisma.reviewCycle.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { periodStart: "desc" }, select: { id: true, name: true, status: true } });
  const cycleId = sp.cycleId && cycles.some((c) => c.id === sp.cycleId) ? sp.cycleId : cycles.find((c) => c.status !== "DRAFT")?.id ?? cycles[0]?.id;
  const picker = (t: Tab, only?: (s: string) => boolean) => (
    <form method="get" action="/performance/operations" className="row gap-2" style={{ marginBottom: 10 }}>
      <input type="hidden" name="tab" value={t} />
      <select className="select" name="cycleId" defaultValue={cycleId}>{cycles.filter((c) => !only || only(c.status)).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.status.toLowerCase()})</option>)}</select>
      <button className="btn sm" type="submit">Show</button>
    </form>
  );
  const cycleOpts = cycles.map((c) => ({ value: c.id, label: `${c.name} (${c.status.toLowerCase()})` }));
  return (
    <>
      <PageHead title="Review operations" subtitle="Templates, scales, data, exceptions, calibration and reminders for review cycles"
        actions={can(viewer, P.PERFORMANCE_MANAGE) ? <ActButton action={runInsightJobAction} hidden={{ job: "reviews" }} label="Send completion reminders now" /> : null} />
      <Tabs base="/performance/operations" tabs={TABS} active={tab} />
      {tab === "templates" ? <Templates viewer={viewer} cycleOpts={cycleOpts} /> : null}
      {tab === "scales" ? <Scales viewer={viewer} cycleOpts={cycles.filter((c) => c.status === "DRAFT").map((c) => ({ value: c.id, label: c.name }))} /> : null}
      {tab === "form" ? <>{picker("form", (s) => s === "DRAFT")}<FormTab viewer={viewer} cycleId={cycles.find((c) => c.id === sp.cycleId && c.status === "DRAFT")?.id ?? cycles.find((c) => c.status === "DRAFT")?.id} /></> : null}
      {tab === "data" ? <>{picker("data")}<Card><InsightTableView table={cycleId ? await runDataset(viewer, `perf-data:${cycleId}`) : null} ds={`perf-data:${cycleId}`} /></Card></> : null}
      {tab === "exceptions" ? <>{picker("exceptions")}<Exceptions viewer={viewer} cycleId={cycleId} sp={sp} /></> : null}
      {tab === "calibration" ? <>{picker("calibration")}<Calibration viewer={viewer} cycleId={cycleId} /></> : null}
      {tab === "normalization" ? <>{picker("normalization")}<Card><InsightTableView table={cycleId ? await runDataset(viewer, `perf-normalized:${cycleId}`) : null} ds={`perf-normalized:${cycleId}`} /></Card></> : null}
      {tab === "trend" ? <Trend viewer={viewer} sp={sp} /> : null}
      {tab === "summaries" ? <Summaries viewer={viewer} sp={sp} cycleOpts={cycleOpts} /> : null}
      {tab === "reopen" ? <Reopen viewer={viewer} /> : null}
      {tab === "audit" ? <Card><InsightTableView table={await runDataset(viewer, "perf-audit")} ds="perf-audit" /></Card> : null}
    </>
  );
}

async function Templates({ viewer, cycleOpts }: { viewer: Viewer; cycleOpts: Array<{ value: string; label: string }> }) {
  const templates = await prisma.insightCycleTemplate.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } });
  const admin = can(viewer, P.PERFORMANCE_MANAGE);
  return (
    <>
      <Card title="Cycle templates" description="A cycle's reviewers and weights, rating scale, bands and form, reusable for the next cycle.">
        <Table head={["Template", "Reviewers", "Scale", "Sections", "Status", ""]} empty={!templates.length}>
          {templates.map((t) => {
            const c = t.config as { reviewerTypes?: Array<{ type: string; weight: number }>; ratingMax?: number; sections?: unknown[] };
            return (
              <tr key={t.id}>
                <td><strong>{t.name}</strong><div className="text-xs muted">{t.description}</div></td>
                <td className="text-sm">{(c.reviewerTypes ?? []).map((r) => `${r.type.toLowerCase()} ${r.weight}%`).join(", ")}</td>
                <td>1–{c.ratingMax ?? 5}</td><td className="num">{(c.sections ?? []).length}</td><td>{t.isActive ? <Badge tone="success">active</Badge> : <Badge>retired</Badge>}</td>
                <td>{admin ? <ActButton action={toggleCycleTemplateAction} hidden={{ id: t.id }} label={t.isActive ? "Retire" : "Reactivate"} variant="ghost" /> : null}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
      {admin ? (
        <div className="grid grid-2">
          <Card title="Save a cycle as a template">
            <SpecForm action={saveCycleTemplateAction} columns={1} fields={[
              { name: "cycleId", label: "Cycle", type: "select", options: cycleOpts, required: true },
              { name: "name", label: "Template name", required: true },
              { name: "description", label: "Description" },
            ]} />
          </Card>
          <Card title="New cycle from a template">
            <SpecForm action={createCycleFromTemplateAction} columns={1} submitLabel="Create draft cycle" fields={[
              { name: "templateId", label: "Template", type: "select", options: templates.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name })), required: true },
              { name: "name", label: "Cycle name", required: true },
              { name: "periodStart", label: "Period start", type: "date", required: true },
              { name: "periodEnd", label: "Period end", type: "date", required: true },
              { name: "reviewClosesAt", label: "Reviews close", type: "date" },
            ]} />
          </Card>
        </div>
      ) : null}
    </>
  );
}

async function Scales({ viewer, cycleOpts }: { viewer: Viewer; cycleOpts: Array<{ value: string; label: string }> }) {
  const scales = await prisma.insightRatingScale.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } });
  const admin = can(viewer, P.PERFORMANCE_MANAGE);
  return (
    <>
      <Card title="Rating scales and the description library" description="What each point on a scale means — shown to reviewers and used in generated summaries.">
        {scales.length ? scales.map((s) => (
          <details key={s.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
            <summary><strong>{s.name}</strong> <span className="muted text-sm">· {scalePointsOf(s.points).length} points</span> {s.isActive ? null : <Badge>inactive</Badge>}</summary>
            <Table head={["Point", "Label", "Description"]}>{scalePointsOf(s.points).map((p) => <tr key={p.value}><td className="num">{p.value}</td><td>{p.label}</td><td className="text-sm">{p.description}</td></tr>)}</Table>
            {admin ? <SpecForm action={saveRatingScaleAction} hidden={{ id: s.id }} columns={1} fields={[
              { name: "name", label: "Name", defaultValue: s.name, required: true },
              { name: "points", label: "Points (value | label | description, one per line)", type: "textarea", defaultValue: scalePointsOf(s.points).map((p) => `${p.value} | ${p.label} | ${p.description}`).join("\n"), required: true },
              { name: "isActive", label: "Active", type: "checkbox", defaultValue: s.isActive },
            ]} /> : null}
          </details>
        )) : <div className="muted">No scales yet; cycles use 1–5.</div>}
      </Card>
      {admin ? (
        <div className="grid grid-2">
          <Card title="New rating scale">
            <SpecForm action={saveRatingScaleAction} columns={1} fields={[
              { name: "name", label: "Name", required: true },
              { name: "points", label: "Points (value | label | description, one per line)", type: "textarea", required: true, placeholder: "1 | Needs improvement | Falls short of most expectations\n2 | Developing | …" },
            ]} />
          </Card>
          <Card title="Use a scale on a draft cycle" description="The cycle rates on the scale's points; its bands are stretched to fit.">
            <SpecForm action={applyRatingScaleAction} columns={1} submitLabel="Apply" fields={[
              { name: "cycleId", label: "Draft cycle", type: "select", options: cycleOpts, required: true },
              { name: "scaleId", label: "Scale", type: "select", options: scales.filter((s) => s.isActive).map((s) => ({ value: s.id, label: s.name })), required: true },
            ]} />
          </Card>
        </div>
      ) : null}
    </>
  );
}

async function FormTab({ viewer, cycleId }: { viewer: Viewer; cycleId?: string }) {
  if (!cycleId) return <Card><div className="muted">Weights and conditions are set on a draft cycle. Create one first.</div></Card>;
  const sections = await prisma.reviewFormSection.findMany({ where: { cycleId, cycle: { tenantId: viewer.tenantId } }, include: { questions: { orderBy: { displayOrder: "asc" } } }, orderBy: { displayOrder: "asc" } });
  const admin = can(viewer, P.PERFORMANCE_MANAGE);
  const rated = sections.flatMap((s) => s.questions.filter((q) => q.kind === "RATING" || q.kind === "COMPETENCY").map((q) => ({ value: q.id, label: `${s.title}: ${q.prompt.slice(0, 60)}`, sectionId: s.id })));
  if (!sections.length) return <Card><div className="muted">This cycle's form has no sections yet — add them on the cycle's form page.</div></Card>;
  return (
    <>
      {sections.map((s) => (
        <Card key={s.id} title={s.title} description={s.conditionQuestionId ? `Shown only when “${rated.find((q) => q.value === s.conditionQuestionId)?.label ?? "a question"}” is ${s.conditionOp === "LTE" ? "≤" : s.conditionOp === "GTE" ? "≥" : "="} ${Number(s.conditionValue)}` : "Always shown"}>
          <Table head={["Question", "Kind", "Weight", ""]}>
            {s.questions.map((q) => (
              <tr key={q.id}>
                <td className="text-sm">{q.prompt}{q.competency ? <div className="text-xs muted">{q.competency}</div> : null}</td><td>{q.kind.toLowerCase()}</td><td className="num">{q.weight === null ? "—" : Number(q.weight)}</td>
                <td>{admin && q.kind === "COMPETENCY" ? <ActButton action={setQuestionWeightAction} hidden={{ questionId: q.id }} label="Set weight" input={{ name: "weight", placeholder: "weight 0–100" }} /> : null}</td>
              </tr>
            ))}
          </Table>
          {admin ? (
            <SpecForm action={setSectionConditionAction} hidden={{ sectionId: s.id }} columns={3} submitLabel="Save condition" fields={[
              { name: "conditionQuestionId", label: "Show only when", type: "select", options: rated.filter((q) => q.sectionId !== s.id), defaultValue: s.conditionQuestionId ?? "", placeholder: "Always show" },
              { name: "conditionOp", label: "is", type: "select", options: [{ value: "LTE", label: "at most" }, { value: "GTE", label: "at least" }, { value: "EQ", label: "exactly" }], defaultValue: s.conditionOp ?? "LTE" },
              { name: "conditionValue", label: "Rating", type: "number", defaultValue: s.conditionValue === null ? "" : Number(s.conditionValue) },
            ]} />
          ) : null}
        </Card>
      ))}
    </>
  );
}

async function Exceptions({ viewer, cycleId, sp }: { viewer: Viewer; cycleId?: string; sp: SP }) {
  if (!cycleId) return <Card><div className="muted">No cycles yet.</div></Card>;
  const table = await runDataset(viewer, `perf-exceptions:${cycleId}`, { status: sp.status });
  return (
    <Card title="Exception queue" description="Overdue reviews, big self/manager gaps, unexplained calibration changes, missing goals or reviewers, ratings outside every band. Refreshed nightly." action={<ActButton action={refreshExceptionsAction} hidden={{ cycleId }} label="Refresh now" />}>
      <div className="row gap-2" style={{ marginBottom: 8 }}>{["OPEN", "RESOLVED", "DISMISSED"].map((s) => <Link key={s} className={`btn sm${(sp.status ?? "OPEN") === s ? " primary" : ""}`} href={`/performance/operations?tab=exceptions&cycleId=${cycleId}&status=${s}`}>{s.toLowerCase()}</Link>)}</div>
      <InsightTableView table={table} ds={`perf-exceptions:${cycleId}`} params={{ status: sp.status }} extraHead="" extra={(r) => r.status === "OPEN" ? (
        <div className="row gap-2"><Link className="btn sm" href={`/performance/reviews/${r.reviewId}`}>Review</Link><ActButton action={resolveExceptionAction} hidden={{ id: String(r.id), status: "RESOLVED" }} label="Resolve" input={{ name: "note", placeholder: "How it was handled", required: true }} /><ActButton action={resolveExceptionAction} hidden={{ id: String(r.id), status: "DISMISSED" }} label="Dismiss" variant="ghost" input={{ name: "note", placeholder: "Why", required: true }} /></div>
      ) : null} />
    </Card>
  );
}

async function Calibration({ viewer, cycleId }: { viewer: Viewer; cycleId?: string }) {
  if (!cycleId) return <Card><div className="muted">No cycles yet.</div></Card>;
  const [notes, emps] = await Promise.all([
    prisma.insightCalibrationNote.findMany({ where: { tenantId: viewer.tenantId, cycleId }, orderBy: { createdAt: "desc" } }),
    prisma.employeeReview.findMany({ where: { cycleId }, select: { employeeId: true, employee: { select: { displayName: true } } } }),
  ]);
  const names = await userNames(viewer.tenantId, notes.map((n) => n.authorUserId));
  const empName = new Map(emps.map((e) => [e.employeeId, e.employee.displayName ?? ""]));
  return (
    <>
      <Card title="Calibration notes" description="The calibration discussion on record: decisions, context and follow-ups, for the cycle or one person.">
        <Table head={["When", "About", "Note", "Tags", "By", ""]} empty={!notes.length}>
          {notes.map((n) => <tr key={n.id}><td>{fmtDate(n.createdAt)}</td><td>{n.employeeId ? empName.get(n.employeeId) ?? "" : "Whole cycle"}</td><td className="text-sm">{n.body}</td><td className="text-xs">{n.tags.join(", ")}</td><td className="text-sm">{names.get(n.authorUserId) ?? ""}</td><td>{n.authorUserId === viewer.user.id || can(viewer, P.PERFORMANCE_MANAGE) ? <ActButton action={deleteCalibrationNoteAction} hidden={{ id: n.id }} label="Delete" variant="ghost" /> : null}</td></tr>)}
        </Table>
      </Card>
      <Card title="Add a note">
        <SpecForm action={addCalibrationNoteAction} hidden={{ cycleId }} columns={2} fields={[
          { name: "employeeId", label: "About", type: "select", options: emps.map((e) => ({ value: e.employeeId, label: e.employee.displayName ?? "" })), placeholder: "The whole cycle" },
          { name: "tags", label: "Tags", placeholder: "promotion, bell-curve" },
          { name: "body", label: "Note", type: "textarea", required: true, wide: true },
        ]} />
      </Card>
    </>
  );
}

async function Trend({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const depts = await departmentOptions(viewer.tenantId);
  return (
    <Card title="Performance trend dashboard" description="Average final rating and the spread across cycles.">
      <form method="get" action="/performance/operations" className="row gap-2" style={{ marginBottom: 10 }}>
        <input type="hidden" name="tab" value="trend" />
        <select className="select" name="departmentId" defaultValue={sp.departmentId ?? ""}><option value="">All departments</option>{depts.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</select>
        <button className="btn sm" type="submit">Filter</button>
      </form>
      <InsightTableView table={await runDataset(viewer, "perf-trend", { departmentId: sp.departmentId })} ds="perf-trend" params={{ departmentId: sp.departmentId }} />
    </Card>
  );
}

async function Summaries({ viewer, sp, cycleOpts }: { viewer: Viewer; sp: SP; cycleOpts: Array<{ value: string; label: string }> }) {
  const table = await runDataset(viewer, "summaries", sp);
  return (
    <Card title="Feedback and performance summaries" description="Search every review's summary; generate one from the review's facts (ratings, goals, 360 feedback).">
      <SearchBar action="/performance/operations" tab="summaries" q={sp.q}>
        <select className="select" name="cycleId" defaultValue={sp.cycleId ?? ""}><option value="">All cycles</option>{cycleOpts.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
      </SearchBar>
      <InsightTableView table={table} ds="summaries" params={{ q: sp.q, cycleId: sp.cycleId }} extraHead="" extra={(r) => <ActButton action={generateReviewSummaryAction} hidden={{ reviewId: String(r.reviewId) }} label="Generate" />} />
    </Card>
  );
}

async function Reopen({ viewer }: { viewer: Viewer }) {
  const [rows, reviews] = await Promise.all([
    prisma.insightReviewReopen.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.employeeReview.findMany({ where: { cycle: { tenantId: viewer.tenantId }, status: { in: ["CALIBRATED", "SHARED", "ACKNOWLEDGED", "PENDING_CALIBRATION"] } }, include: { employee: { select: { displayName: true } }, cycle: { select: { name: true } } }, take: 300, orderBy: { updatedAt: "desc" } }),
  ]);
  const names = await userNames(viewer.tenantId, rows.map((r) => r.requestedBy));
  const emps = new Map((await employeeOptions(viewer.tenantId)).map((e) => [e.value, e.label]));
  return (
    <>
      <Card title="Review reopening requests" description="Reopening a submitted or calibrated review sends it back to the manager — after a performance administrator approves.">
        <Table head={["Asked", "Employee", "Reason", "Was", "Status", "By"]} empty={!rows.length}>
          {rows.map((r) => <tr key={r.id}><td>{fmtDate(r.createdAt)}</td><td><Link href={`/performance/reviews/${r.reviewId}`}>{emps.get(r.employeeId) ?? "—"}</Link></td><td className="text-sm">{r.reason}</td><td>{r.previousStatus.toLowerCase().replace(/_/g, " ")}</td><td><Pill s={r.status} /></td><td className="text-sm">{names.get(r.requestedBy) ?? ""}</td></tr>)}
        </Table>
      </Card>
      <Card title="Ask to reopen a review">
        <SpecForm action={requestReviewReopenAction} columns={1} submitLabel="Request" fields={[
          { name: "reviewId", label: "Review", type: "select", options: reviews.map((r) => ({ value: r.id, label: `${r.employee.displayName} — ${r.cycle.name} (${r.status.toLowerCase().replace(/_/g, " ")})` })), required: true },
          { name: "reason", label: "Why", type: "textarea", required: true },
        ]} />
      </Card>
    </>
  );
}
