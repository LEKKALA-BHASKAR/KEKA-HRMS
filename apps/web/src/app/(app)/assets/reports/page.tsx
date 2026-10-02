import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatINR } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { scheduleAssetReportAction, deleteScheduledAssetReportAction } from "@/app/actions/assets";
import { ModalButton, ActButton } from "../_ui";
import { Pager, pageOf, PAGE_SIZE, Toolbar, dateTime, qs } from "../_parts";
import { ASSET_REPORTS } from "../_reports";
import s from "../assets.module.css";

/**
 * Asset reports: pick one on the left, read it on the right, download it as
 * CSV, or schedule it to be emailed daily, weekly or monthly.
 */

const P = PERMISSIONS;
const DAYS = [["1", "Monday"], ["2", "Tuesday"], ["3", "Wednesday"], ["4", "Thursday"], ["5", "Friday"], ["6", "Saturday"], ["0", "Sunday"]] as const;
const DAY_NAME = Object.fromEntries(DAYS) as Record<string, string>;

function cadence(r: { frequency: string; dayOfWeek: number | null; dayOfMonth: number | null }): string {
  if (r.frequency === "DAILY") return "Every day";
  if (r.frequency === "WEEKLY") return `Every ${DAY_NAME[String(r.dayOfWeek ?? 1)] ?? "Monday"}`;
  return `Monthly on day ${r.dayOfMonth ?? 1}`;
}

export default async function AssetReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) redirect("/assets");
  const report = ASSET_REPORTS.find((r) => r.key === sp.report) ?? ASSET_REPORTS[0];
  const [data, schedules] = await Promise.all([
    report.run(viewer.tenantId, new Date()),
    prisma.scheduledReport.findMany({ where: { tenantId: viewer.tenantId, reportKey: { startsWith: "asset-" } }, orderBy: { createdAt: "desc" } }),
  ]);
  const page = pageOf(sp.page, data.rows.length);
  const rows = data.rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const mine = schedules.filter((x) => x.reportKey === report.key);
  const titleOf = new Map(ASSET_REPORTS.map((r) => [r.key, r.title]));

  return (
    <div className={s.split}>
      <nav className={s.rail} aria-label="Asset reports">
        <div className={s.railGroup}>Reports</div>
        {ASSET_REPORTS.map((r) => (
          <Link key={r.key} href={`/assets/reports?report=${r.key}`} className={`${s.railItem}${r.key === report.key ? ` ${s.on}` : ""}`}>
            <span>{r.title}{schedules.some((x) => x.reportKey === r.key) ? <span className={s.count}>Scheduled</span> : null}</span>
          </Link>
        ))}
        {schedules.length ? (
          <>
            <div className={s.railGroup}>All schedules</div>
            {schedules.map((x) => (
              <Link key={x.id} href={`/assets/reports?report=${x.reportKey}`} className={s.railItem}>
                <span className="text-sm">{x.name}<span className={s.count}>{titleOf.get(x.reportKey) ?? x.reportKey} · {cadence(x)}</span></span>
              </Link>
            ))}
          </>
        ) : null}
      </nav>

      <div style={{ minWidth: 0 }}>
        <div className={s.detailHead}>
          <div className={s.detailHeadTop}>
            <div>
              <h1 className={s.detailTitle}>{report.title}</h1>
              <p className={s.detailSub}>{report.description}</p>
            </div>
            <div className="row gap-2">
              <a className={s.btnOutline} href={`/assets/export${qs({ report: report.key })}`}>Download CSV</a>
              <ModalButton label="Schedule" className="btn primary" title={`Schedule ${report.title}`} action={scheduleAssetReportAction} hidden={{ reportKey: report.key }} submitLabel="Schedule">
                <div className="field">
                  <label className="label" htmlFor="sch-name">Schedule name</label>
                  <input id="sch-name" name="name" className="input" required maxLength={80} defaultValue={`${report.title} — weekly`} />
                </div>
                <div className="field">
                  <label className="label" htmlFor="sch-to">Email to</label>
                  <input id="sch-to" name="recipients" className="input" required defaultValue={viewer.user.email} placeholder="name@company.com, another@company.com" />
                  <div className="hint">Up to 10 addresses, separated by commas. The report is attached as CSV.</div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="sch-freq">How often</label>
                  <select id="sch-freq" name="frequency" className="select" defaultValue="WEEKLY">
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                  </select>
                </div>
                <div className="row gap-3">
                  <div className="field" style={{ flex: 1 }}>
                    <label className="label" htmlFor="sch-dow">Day of the week (weekly)</label>
                    <select id="sch-dow" name="dayOfWeek" className="select" defaultValue="1">
                      {DAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="label" htmlFor="sch-dom">Day of the month (monthly)</label>
                    <input id="sch-dom" name="dayOfMonth" type="number" min={1} max={28} className="input num" defaultValue={1} />
                  </div>
                </div>
                <p className="text-xs muted">Sent at 9:00 am IST.</p>
              </ModalButton>
            </div>
          </div>
          {mine.length ? (
            <div className={s.actionsRow} style={{ borderTop: "1px solid var(--border)", borderBottom: 0, flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              {mine.map((x) => {
                const to = Array.isArray(x.recipients) ? (x.recipients as string[]) : [];
                return (
                  <div key={x.id} className="row gap-3 text-sm" style={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                    <span><strong>{x.name}</strong> · {cadence(x)} · to {to.join(", ")}<span className="muted"> · next {dateTime(x.nextRunAt)}{x.lastRunAt ? ` · last ${dateTime(x.lastRunAt)}` : ""}</span></span>
                    <ActButton action={deleteScheduledAssetReportAction} hidden={{ id: x.id }} className={s.linkish} confirm={`Stop sending ${x.name}?`}>Delete schedule</ActButton>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className={`${s.tableCard} ${s.alone}`}>
          <Toolbar total={data.rows.length} exportHref={`/assets/export${qs({ report: report.key })}`} />
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr>{data.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.length === 0 ? <tr><td colSpan={data.columns.length} className="muted" style={{ textAlign: "center", padding: 30 }}>Nothing to report.</td></tr> : rows.map((r, i) => (
                  <tr key={i}>
                    {data.columns.map((c) => {
                      const v = r[c.key];
                      return <td key={c.key} className={c.money ? "num nowrap" : undefined}>{v === null || v === undefined || v === "" ? "—" : c.money ? formatINR(Number(v)).replace(/\.00$/, "") : String(v)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager total={data.rows.length} page={page} href={(p) => `/assets/reports${qs({ report: report.key, page: String(p) })}`} />
        </div>
      </div>
    </div>
  );
}
