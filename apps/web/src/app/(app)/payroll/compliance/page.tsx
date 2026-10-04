import Link from "next/link";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod } from "@keka/shared";
import { complianceTable } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Empty, Callout } from "@/components/ui";
import { IconDownload } from "@/components/icons";

const P = PERMISSIONS;
const TABS = { "min-wage": "Minimum wage", coverage: "PF / ESI coverage", "pt-lwf": "PT / LWF applicability" } as const;
type Tab = keyof typeof TABS;
const CATEGORIES = [["UNSKILLED", "Unskilled"], ["SEMI_SKILLED", "Semi-skilled"], ["SKILLED", "Skilled"], ["HIGHLY_SKILLED", "Highly skilled"]] as const;

/**
 * Compliance checks on a month's payroll: pay against the state minimum
 * wage, PF and ESI coverage exceptions, and where PT and LWF apply.
 */
export default async function CompliancePage({ searchParams }: { searchParams: Promise<{ tab?: string; period?: string; category?: string }> }) {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const sp = await searchParams;
  const tab: Tab = (sp.tab && sp.tab in TABS ? sp.tab : "min-wage") as Tab;
  const now = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(sp.period ?? "");
  const year = m ? Number(m[1]) : now.getUTCFullYear(), month = m ? Number(m[2]) : now.getUTCMonth() + 1;
  const category = CATEGORIES.some(([k]) => k === sp.category) ? sp.category! : "UNSKILLED";
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const t = await complianceTable(viewer.tenantId, tab, year, month, category);
  const qs = (extra: Record<string, string>) => new URLSearchParams({ tab, period, category, ...extra }).toString();

  return (
    <>
      <PageHead title="Compliance reports" subtitle={`${formatPeriod(year, month)} payroll`}
        actions={<>
          <form className="row gap-2">
            <input type="hidden" name="tab" value={tab} />
            <input className="input" type="month" name="period" defaultValue={period} aria-label="Payroll month" />
            {tab === "min-wage" ? <select className="select" name="category" defaultValue={category} aria-label="Skill category">{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select> : null}
            <button className="btn" type="submit">Go</button>
          </form>
          <a className="btn primary" href={`/payroll/compliance/export?${qs({})}`}><IconDownload width={15} height={15} />CSV</a>
        </>} />
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((k) => <Link key={k} className={`tab${tab === k ? " active" : ""}`} href={`/payroll/compliance?${new URLSearchParams({ tab: k, period, category })}`}>{TABS[k]}</Link>)}
      </div>
      {tab === "min-wage" ? <Callout tone="info" title="Rates">Compared with the state rates under <Link href="/payroll/settings">Payroll settings</Link>, using full-month gross (before LOP).</Callout> : null}
      <div style={{ height: 12 }} />
      <Card tight title={TABS[tab]} description={t.summary}>
        {t.rows.length === 0 ? <Empty title={tab === "coverage" ? "No exceptions" : "Nothing to show"}>{t.summary}</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr>{t.columns.map((c) => <th key={c.key} className={c.numeric ? "num" : undefined}>{c.label}</th>)}</tr></thead>
              <tbody>
                {t.rows.map((r, i) => (
                  <tr key={i} style={r._flag ? { background: "var(--warning-bg)" } : undefined}>
                    {t.columns.map((c) => {
                      const v = r[c.key];
                      return <td key={c.key} className={c.numeric ? "num" : c.key === "issue" || c.key === "issues" ? "text-xs" : undefined}>{typeof v === "number" && c.numeric ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : String(v ?? "")}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
