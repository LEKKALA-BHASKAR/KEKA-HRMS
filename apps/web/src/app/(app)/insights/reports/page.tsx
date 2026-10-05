import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { compareSnapshots, EXCEPTION_OPS, grantLive } from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { REPORTS } from "@/lib/reports";
import { runDataset, canOpenReport, WORKFORCE_COLUMNS } from "@/lib/insight/datasets";
import { userNames, fmtDate } from "@/lib/governance";
import { PageHead, Card, Badge } from "@/components/ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Tabs, SearchBar, Table, Pill } from "@/components/gov-ui";
import { InsightTableView } from "@/components/insight-table";
import {
  saveFilterPresetAction, deleteFilterPresetAction, takeSnapshotAction, deleteSnapshotAction, requestReportAccessAction, revokeReportGrantAction,
  saveExportProfileAction, requestExportAction, updateScheduleAction, requestPublishReportAction,
} from "@/app/actions/insight-analytics";
import { InsightsNav } from "../_nav";

export const metadata = { title: "Report operations" };
const TABS = { builder: "Report builder", snapshots: "Snapshots", history: "Execution history", access: "Access", exports: "Exports", schedules: "Schedules", publishing: "Publishing" };
type Tab = keyof typeof TABS;
type SP = Record<string, string | undefined>;

/**
 * Insights › Report operations: cross-module and effective-dated reports
 * with calculated fields, exception-only rules and saved filter presets;
 * historical snapshots and comparison; the execution history; time-boxed
 * report access; export profiles with approval for sensitive data; schedule
 * maintenance (outside recipients approved); custom-report publishing.
 */
export default async function ReportOpsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  if (!can(viewer, P.REPORT_VIEW)) forbidden();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "builder";
  return (
    <>
      <PageHead title="Report operations" subtitle="Build, snapshot, schedule, export and govern reports" actions={<Link className="btn" href="/reports">Standard reports</Link>} />
      <InsightsNav />
      <Tabs base="/insights/reports" tabs={TABS} active={tab} />
      {tab === "builder" ? <Builder viewer={viewer} sp={sp} /> : null}
      {tab === "snapshots" ? <Snapshots viewer={viewer} sp={sp} /> : null}
      {tab === "history" ? <History viewer={viewer} sp={sp} /> : null}
      {tab === "access" ? <Access viewer={viewer} /> : null}
      {tab === "exports" ? <Exports viewer={viewer} /> : null}
      {tab === "schedules" ? <Schedules viewer={viewer} /> : null}
      {tab === "publishing" ? <Publishing viewer={viewer} /> : null}
    </>
  );
}

const SOURCES = [{ value: "workforce", label: "Workforce across modules" }, { value: "effective", label: "Workforce as of a date" }, { value: "exceptions", label: "Exceptions only" }];

async function Builder({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const ds = sp.ds && (SOURCES.some((s) => s.value === sp.ds) || sp.ds.startsWith("report:")) ? sp.ds : "workforce";
  const params: SP = { asOf: sp.asOf, mode: sp.mode, calc: sp.calc, calcName: sp.calcName, c1: sp.c1, o1: sp.o1, v1: sp.v1, c2: sp.c2, o2: sp.o2, v2: sp.v2, c3: sp.c3, o3: sp.o3, v3: sp.v3 };
  const [table, presets] = await Promise.all([
    runDataset(viewer, ds, sp),
    prisma.insightFilterPreset.findMany({ where: { tenantId: viewer.tenantId, dataset: ds, OR: [{ createdBy: viewer.user.id }, { shared: true }] }, orderBy: { name: "asc" } }),
  ]);
  const reports = [];
  for (const r of REPORTS) if (await canOpenReport(viewer, r.key)) reports.push({ value: `report:${r.key}`, label: `Report: ${r.title}` });
  const cols = table?.columns ?? WORKFORCE_COLUMNS;
  const qs = new URLSearchParams(Object.entries({ ds, ...params }).filter((e): e is [string, string] => !!e[1])).toString();
  const rule = (i: number) => (
    <span className="row gap-2" key={i}>
      <select className="select" name={`c${i}`} defaultValue={sp[`c${i}`] ?? ""}><option value="">Column…</option>{cols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
      <select className="select" name={`o${i}`} defaultValue={sp[`o${i}`] ?? ""}><option value="">—</option>{Object.entries(EXCEPTION_OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <input className="input" name={`v${i}`} defaultValue={sp[`v${i}`] ?? ""} placeholder="value" style={{ width: 110 }} />
    </span>
  );
  return (
    <>
      <Card title="Build" description="Pick a source; add a calculated column from [column] references, e.g. [leaveDays] / 12; for exceptions, add the rules a row must break.">
        <form method="get" action="/insights/reports" className="stack gap-2">
          <input type="hidden" name="tab" value="builder" />
          <div className="row gap-2 wrap">
            <select className="select" name="ds" defaultValue={ds}>{[...SOURCES, ...reports].map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
            <label className="row gap-2 text-sm">As of <input className="input" type="date" name="asOf" defaultValue={sp.asOf ?? ""} /></label>
            <input className="input" name="calcName" defaultValue={sp.calcName ?? ""} placeholder="Calculated column name" style={{ width: 200 }} />
            <input className="input mono" name="calc" defaultValue={sp.calc ?? ""} placeholder="[goalsAtRisk] / [goals] * 100" style={{ width: 260 }} />
          </div>
          <div className="row gap-2 wrap">{[1, 2, 3].map(rule)}<select className="select" name="mode" defaultValue={sp.mode ?? "ANY"}><option value="ANY">Any rule</option><option value="ALL">All rules</option></select></div>
          <div><button className="btn primary" type="submit">Run</button></div>
        </form>
        {presets.length ? (
          <div className="row gap-2 wrap" style={{ marginTop: 10 }}>
            <span className="text-sm muted">Presets:</span>
            {presets.map((p) => (
              <span key={p.id} className="row gap-1">
                <Link className="btn sm" href={`/insights/reports?tab=builder&ds=${encodeURIComponent(ds)}&${new URLSearchParams(p.filters as Record<string, string>).toString()}`}>{p.name}{p.shared ? " (shared)" : ""}</Link>
                {p.createdBy === viewer.user.id ? <ActButton action={deleteFilterPresetAction} hidden={{ id: p.id }} label="×" variant="ghost" /> : null}
              </span>
            ))}
          </div>
        ) : null}
      </Card>
      <Card title="Result">
        <InsightTableView table={table} ds={ds} params={params} />
      </Card>
      <div className="grid grid-2">
        <Card title="Save these filters as a preset">
          <SpecForm action={saveFilterPresetAction} hidden={{ dataset: ds, qs }} columns={1} submitLabel="Save preset" fields={[
            { name: "name", label: "Preset name", required: true },
            ...(can(viewer, P.REPORT_BUILD) ? [{ name: "shared", label: "Share with everyone who can run it", type: "checkbox" as const }] : []),
          ]} />
        </Card>
        <Card title="Snapshot this report" description="Freeze today's rows to compare later.">
          <SpecForm action={takeSnapshotAction} hidden={{ reportKey: ds }} columns={1} submitLabel="Take snapshot" fields={[{ name: "note", label: "Note" }]} />
        </Card>
      </div>
    </>
  );
}

async function Snapshots({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const snaps = await prisma.insightReportSnapshot.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, reportKey: true, title: true, rowCount: true, note: true, takenBy: true, createdAt: true } });
  const names = await userNames(viewer.tenantId, snaps.map((s) => s.takenBy));
  const view = sp.view ? await runDataset(viewer, `snapshot:${sp.view}`) : null;
  let diff: ReturnType<typeof compareSnapshots> | null = null;
  if (sp.view) {
    const s = await prisma.insightReportSnapshot.findFirst({ where: { id: sp.view, tenantId: viewer.tenantId } });
    const now = s ? await runDataset(viewer, s.reportKey) : null;
    if (s && now) {
      const cols = s.columns as Array<{ key: string }>;
      const key = cols.some((c) => c.key === "number") ? "number" : cols[0]?.key ?? "id";
      const strip = (rows: Array<Record<string, unknown>>) => rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, r[c.key] instanceof Date ? (r[c.key] as Date).toISOString() : r[c.key] ?? null])));
      diff = compareSnapshots(strip(s.rows as Array<Record<string, unknown>>), strip(JSON.parse(JSON.stringify(now.rows))), key);
    }
  }
  return (
    <>
      <Card title="Historical snapshots">
        <Table head={["Taken", "Report", "Rows", "By", "Note", ""]} empty={!snaps.length}>
          {snaps.map((s) => (
            <tr key={s.id}>
              <td>{fmtDate(s.createdAt)}</td><td>{s.title}</td><td className="num">{s.rowCount}</td><td className="text-sm">{names.get(s.takenBy) ?? ""}</td><td className="text-sm">{s.note}</td>
              <td className="row gap-2"><Link className="btn sm" href={`/insights/reports?tab=snapshots&view=${s.id}`}>Open · compare</Link><ActButton action={deleteSnapshotAction} hidden={{ id: s.id }} label="Delete" variant="ghost" confirmText="Delete this snapshot?" /></td>
            </tr>
          ))}
        </Table>
      </Card>
      {view ? (
        <Card title="Snapshot" description={diff ? `Compared with today: ${diff.added} added, ${diff.removed} removed, ${diff.changed} changed, ${diff.unchanged} unchanged.` : undefined}>
          <InsightTableView table={view} ds={`snapshot:${sp.view}`} />
        </Card>
      ) : null}
    </>
  );
}

async function History({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const table = await runDataset(viewer, "report-runs", sp);
  return (
    <Card title="Report execution history" description="Every on-screen snapshot, download and scheduled run, with rows, time taken and the outcome.">
      <SearchBar action="/insights/reports" tab="history" q={sp.q}>
        <select className="select" name="trigger" defaultValue={sp.trigger ?? ""}><option value="">Any trigger</option>{["EXPORT", "SCHEDULE", "SNAPSHOT"].map((t) => <option key={t} value={t}>{t.toLowerCase()}</option>)}</select>
      </SearchBar>
      <InsightTableView table={table} ds="report-runs" params={{ q: sp.q, trigger: sp.trigger }} />
    </Card>
  );
}

async function Access({ viewer }: { viewer: Viewer }) {
  const admin = can(viewer, P.REPORT_BUILD);
  const grants = await prisma.insightReportGrant.findMany({ where: { tenantId: viewer.tenantId, ...(admin ? {} : { userId: viewer.user.id }) }, orderBy: { createdAt: "desc" }, take: 200 });
  const names = await userNames(viewer.tenantId, grants.map((g) => g.userId));
  const closed = REPORTS.filter((r) => !can(viewer, r.permission));
  return (
    <>
      <Card title="Report access" description="Time-boxed access to a report your role does not open. It ends on its own on the expiry date.">
        <Table head={["Report", "Who", "Days", "Status", "Expires", "Reason", ""]} empty={!grants.length}>
          {grants.map((g) => (
            <tr key={g.id}>
              <td>{g.title}</td><td className="text-sm">{names.get(g.userId) ?? ""}</td><td className="num">{g.days}</td>
              <td><Pill s={g.status === "APPROVED" && !grantLive(g) ? "EXPIRED" : g.status} /></td><td>{fmtDate(g.expiresAt)}</td><td className="text-sm">{g.reason}</td>
              <td>{admin && grantLive(g) ? <ActButton action={revokeReportGrantAction} hidden={{ id: g.id }} label="Revoke" variant="ghost" /> : grantLive(g) && g.userId === viewer.user.id ? <Link className="btn sm" href={`/insights/reports?tab=builder&ds=report:${g.reportKey}`}>Open</Link> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {closed.length ? (
        <Card title="Ask for access">
          <SpecForm action={requestReportAccessAction} columns={3} submitLabel="Request" fields={[
            { name: "reportKey", label: "Report", type: "select", options: closed.map((r) => ({ value: r.key, label: r.title })), required: true },
            { name: "days", label: "For (days)", type: "number", defaultValue: 30 },
            { name: "reason", label: "Why", required: true, wide: true },
          ]} />
        </Card>
      ) : null}
    </>
  );
}

async function Exports({ viewer }: { viewer: Viewer }) {
  const admin = can(viewer, P.REPORT_BUILD);
  const [profiles, requests] = await Promise.all([
    prisma.insightExportProfile.findMany({ where: { tenantId: viewer.tenantId, ...(admin ? {} : { isActive: true }) }, orderBy: { name: "asc" } }),
    prisma.insightExportRequest.findMany({ where: { tenantId: viewer.tenantId, ...(admin ? {} : { requesterUserId: viewer.user.id }) }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const names = await userNames(viewer.tenantId, requests.map((r) => r.requesterUserId));
  const mine = (pid: string) => requests.find((r) => r.profileId === pid && r.requesterUserId === viewer.user.id && r.status === "APPROVED" && r.expiresAt && r.expiresAt > new Date());
  const reports = REPORTS.filter((r) => can(viewer, r.permission)).map((r) => ({ value: `report:${r.key}`, label: r.title }));
  return (
    <>
      <Card title="Configured exports" description="A saved download: which report, which columns, which format. Sensitive ones need approval before each download window.">
        <Table head={["Export", "Report", "Format", "Columns", "Sensitive", ""]} empty={!profiles.length}>
          {profiles.map((p) => (
            <tr key={p.id}>
              <td><strong>{p.name}</strong>{p.isActive ? null : <> <Badge>inactive</Badge></>}</td><td className="text-sm mono">{p.reportKey}</td><td>{p.format}</td><td className="text-xs">{p.columns.join(", ") || "all"}</td>
              <td>{p.sensitive ? <Badge tone="warning">approval</Badge> : "—"}</td>
              <td className="row gap-2 wrap">
                {!p.sensitive || mine(p.id) ? <a className="btn sm primary" href={`/insights/export?profile=${p.id}`}>Download</a> : <ActButton action={requestExportAction} hidden={{ profileId: p.id }} label="Request" input={{ name: "reason", placeholder: "Why you need it", required: true }} />}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Export requests">
        <Table head={["Asked", "Export", "By", "Status", "Valid until", "Downloaded"]} empty={!requests.length}>
          {requests.map((r) => <tr key={r.id}><td>{fmtDate(r.createdAt)}</td><td>{profiles.find((p) => p.id === r.profileId)?.name ?? "—"}</td><td className="text-sm">{names.get(r.requesterUserId) ?? ""}</td><td><Pill s={r.status} /></td><td>{fmtDate(r.expiresAt)}</td><td>{fmtDate(r.downloadedAt)}</td></tr>)}
        </Table>
      </Card>
      {admin ? (
        <Card title="Configure an export">
          <SpecForm action={saveExportProfileAction} columns={3} submitLabel="Save export" fields={[
            { name: "name", label: "Name", required: true },
            { name: "reportKey", label: "Report", type: "select", options: [...reports, { value: "workforce", label: "Workforce across modules" }, { value: "feedback", label: "Feedback" }, { value: "okr", label: "OKRs" }, { value: "pip-register", label: "Improvement plans" }, { value: "talent-risk", label: "Talent risk" }], required: true },
            { name: "format", label: "Format", type: "select", options: [{ value: "CSV", label: "CSV" }, { value: "XLSX", label: "Excel" }, { value: "PDF", label: "PDF" }], required: true },
            { name: "columns", label: "Columns (keys, comma-separated)", hint: "Blank for all", wide: true },
            { name: "sensitive", label: "Sensitive — needs approval", type: "checkbox" },
          ]} />
        </Card>
      ) : null}
    </>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function Schedules({ viewer }: { viewer: Viewer }) {
  const admin = can(viewer, P.ORG_SETTINGS_MANAGE);
  const rows = await prisma.scheduledReport.findMany({ where: { tenantId: viewer.tenantId, NOT: { reportKey: { startsWith: "asset-" } }, ...(admin ? {} : { createdBy: viewer.user.id }) }, orderBy: { createdAt: "asc" } });
  const names = await userNames(viewer.tenantId, rows.map((r) => r.createdBy));
  return (
    <Card title="Scheduled reports" description="Change the cadence or recipients, or pause. Recipients outside the company need a report administrator's approval; the schedule waits until then. Schedule new ones from a report's page.">
      {rows.length ? rows.map((r) => (
        <details key={r.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <summary className="row gap-2" style={{ cursor: "pointer" }}>
            <strong>{r.name}</strong>
            <span className="text-xs muted">{r.reportKey} · {r.frequency === "WEEKLY" ? `weekly on ${DAYS[r.dayOfWeek ?? 1]}` : r.frequency === "MONTHLY" ? `monthly on day ${r.dayOfMonth}` : "daily"} · next {fmtDate(r.nextRunAt)} · by {names.get(r.createdBy ?? "") ?? "—"}</span>
            {r.isActive ? <Badge tone="success">active</Badge> : <Badge>paused</Badge>}
            {r.approvalStatus ? <Pill s={r.approvalStatus} /> : null}
            {r.lastStatus ? <span className="text-xs muted">last: {r.lastStatus}</span> : null}
          </summary>
          <SpecForm action={updateScheduleAction} hidden={{ id: r.id }} columns={3} fields={[
            { name: "name", label: "Name", required: true, defaultValue: r.name },
            { name: "recipients", label: "Recipients", required: true, defaultValue: (Array.isArray(r.recipients) ? r.recipients : []).join(", "), wide: true },
            { name: "frequency", label: "Frequency", type: "select", options: [{ value: "DAILY", label: "Daily" }, { value: "WEEKLY", label: "Weekly" }, { value: "MONTHLY", label: "Monthly" }], defaultValue: r.frequency, required: true },
            { name: "dayOfWeek", label: "Weekday (1 = Mon)", type: "number", defaultValue: r.dayOfWeek ?? "" },
            { name: "dayOfMonth", label: "Day of month", type: "number", defaultValue: r.dayOfMonth ?? "" },
            { name: "isActive", label: "Active", type: "checkbox", defaultValue: r.isActive },
          ]} />
        </details>
      )) : <div className="muted">No schedules. Use “Email this report” on a report.</div>}
    </Card>
  );
}

async function Publishing({ viewer }: { viewer: Viewer }) {
  const mine = await prisma.savedReport.findMany({ where: { tenantId: viewer.tenantId, OR: [{ createdBy: viewer.user.id }, ...(can(viewer, P.REPORT_BUILD) ? [{ publishStatus: { not: null } }] : [])] }, orderBy: { updatedAt: "desc" } });
  const names = await userNames(viewer.tenantId, mine.map((r) => r.createdBy));
  return (
    <Card title="Custom report publishing" description="Publishing puts a custom report in front of everyone who can read its data, after a report administrator approves it.">
      <Table head={["Report", "Author", "Dataset", "Shared", "Publishing", ""]} empty={!mine.length}>
        {mine.map((r) => (
          <tr key={r.id}>
            <td><Link href={`/reports/builder?id=${r.id}`}>{r.name}</Link></td><td className="text-sm">{names.get(r.createdBy) ?? ""}</td><td>{r.dataset}</td><td>{r.shared ? "yes" : "no"}</td><td>{r.publishStatus ? <Pill s={r.publishStatus} /> : "—"}</td>
            <td>{r.createdBy === viewer.user.id && !r.shared && r.publishStatus !== "PENDING" && can(viewer, P.REPORT_BUILD) ? <ActButton action={requestPublishReportAction} hidden={{ id: r.id }} label="Publish" variant="primary" /> : null}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
