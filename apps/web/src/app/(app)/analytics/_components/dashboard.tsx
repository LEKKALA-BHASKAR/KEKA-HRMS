import Link from "next/link";
import type { ReactNode } from "react";
import { PERMISSIONS } from "@keka/rbac";
import { can, type Viewer } from "@/lib/context";
import { SubTabs } from "@/components/subtabs";
import { ChartMenu } from "./chart-menu";
import s from "./analytics.module.css";

const P = PERMISSIONS;

export type DashboardTab = "summary" | "analytics" | "attendance" | "hiring" | "expenses" | "reports" | "audit";

/** Org › Dashboard's third row: Summary · Analytics · Employee Reports · Audit Logs. */
export function DashboardTabs({ viewer, active }: { viewer: Viewer; active: DashboardTab }) {
  const items = [
    can(viewer, P.ANALYTICS_VIEW) && { key: "summary", label: "Summary", href: "/analytics/summary" },
    can(viewer, P.ANALYTICS_VIEW) && { key: "analytics", label: "Analytics", href: "/analytics/headcount" },
    can(viewer, P.ANALYTICS_VIEW) && can(viewer, P.ATTENDANCE_VIEW) && { key: "attendance", label: "Attendance", href: "/analytics/attendance" },
    can(viewer, P.ANALYTICS_VIEW) && (can(viewer, P.JOB_MANAGE) || can(viewer, P.CANDIDATE_MANAGE)) && { key: "hiring", label: "Hiring", href: "/analytics/hiring" },
    can(viewer, P.ANALYTICS_VIEW) && can(viewer, P.EXPENSE_VIEW) && { key: "expenses", label: "Expenses", href: "/analytics/expenses" },
    can(viewer, P.REPORT_VIEW) && { key: "reports", label: "Employee Reports", href: "/reports" },
    can(viewer, P.AUDIT_LOG_VIEW) && { key: "audit", label: "Audit Logs", href: "/admin/audit" },
  ].filter((x): x is { key: string; label: string; href: string } => !!x);
  if (items.length < 2) return null;
  return <SubTabs items={items.map(({ label, href }) => ({ label, href }))} active={items.find((i) => i.key === active)?.href} />;
}

/** Headcount by Demographics · Growth & Retention · Attrition Analysis. */
export function AnalyticsPills({ active, qs }: { active: "headcount" | "growth" | "attrition"; qs?: string }) {
  const pills: Array<[typeof active, string]> = [["headcount", "Headcount by Demographics"], ["growth", "Growth & Retention"], ["attrition", "Attrition Analysis"]];
  return (
    <nav className={s.pills} aria-label="Analytics">
      {pills.map(([k, label]) => (
        <Link key={k} href={`/analytics/${k}${qs ? `?${qs}` : ""}`} className={`${s.pill}${k === active ? ` ${s.pillActive}` : ""}`} aria-current={k === active ? "page" : undefined}>{label}</Link>
      ))}
    </nav>
  );
}

export const InfoIcon = ({ text }: { text: string }) => (
  <span className={s.info} title={text} aria-label={text}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" strokeLinecap="round" /></svg>
  </span>
);

export const EyeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
);

/** A chart card: title and ⓘ, "View Raw Data", and the export menu. */
export function ChartCard({ chartKey, title, info, rawHref, exportQs, children, insights, headExtra }: {
  chartKey: string; title: string; info: string; rawHref?: string; exportQs: string; children: ReactNode;
  insights?: Array<{ label: string; value: string }>; headExtra?: ReactNode;
}) {
  return (
    <section className={s.card} data-chart-card={chartKey}>
      <header className={s.cardHead}>
        <h2 className={s.cardTitle}>{title} <InfoIcon text={info} /></h2>
        <div className={s.cardActions}>
          {headExtra}
          {rawHref ? <Link className={s.rawLink} href={rawHref} scroll={false}><EyeIcon /> View Raw Data</Link> : null}
          <ChartMenu chartKey={chartKey} exportQs={exportQs} />
        </div>
      </header>
      <div className={s.cardBody}>{children}</div>
      {insights && insights.length ? (
        <div className={s.insights}>
          <h3 className={s.insTitle}>Insights</h3>
          <div className={s.insRow}>
            {insights.map((i) => (
              <div key={i.label}><div className={s.insLabel}>{i.label}</div><div className={s.insValue}>{i.value}</div></div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** The KPI row over Growth & Retention and Attrition Analysis; a card's link opens its raw data (`rawBase` ends in "?" or "&"). */
export function KpiCards({ kpis, rawBase }: { kpis: Array<{ key: string; label: string; value: string; meta: string; info: string; color: string; rawKey?: string; rawText?: string }>; rawBase: string }) {
  return (
    <div className={s.kpis}>
      {kpis.map((k) => (
        <div key={k.key} className={s.kpi} data-kpi={k.key}>
          <span className={s.kpiRule} style={{ background: k.color }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className={s.kpiLabel}>{k.label} <InfoIcon text={k.info} /></div>
            <div className={s.kpiValue}>{k.value}</div>
            <div className={s.kpiFoot}>
              <span className="text-sm muted">{k.meta}</span>
              {k.rawKey ? <Link className={s.kpiLink} href={`${rawBase}raw=${k.rawKey}`} scroll={false}>{k.rawText ?? "View"}</Link> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function NoData({ children }: { children?: ReactNode }) {
  return <div className={s.empty}>{children ?? "No data for these filters."}</div>;
}

/** "18 Sep 2024 - 18 Aug 2025" */
export function rangeLabel(from: Date, to: Date): string {
  const f = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  return `${f(from)} - ${f(to)}`;
}
