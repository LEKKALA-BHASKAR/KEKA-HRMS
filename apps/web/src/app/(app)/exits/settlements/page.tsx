import Link from "next/link";
import { redirect } from "next/navigation";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR, fyLabel, fyStartYear } from "@keka/shared";
import { fnfReport, fnfReportTotals } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat } from "@/components/ui";

const P = PERMISSIONS;
const STATUSES = ["IN_REVIEW", "APPROVED", "FINALIZED", "PAID", "VOIDED"] as const;
const TONE: Record<string, "warning" | "info" | "success" | "neutral" | "danger"> = {
  PENDING: "neutral", IN_REVIEW: "warning", APPROVED: "info", FINALIZED: "success", PAID: "success", ALREADY_PAID: "success", VOIDED: "danger",
};

/** Every settlement in the viewer's scope, with status and amounts, by settlement-month year. */
export default async function SettlementsReportPage({ searchParams }: { searchParams: Promise<{ status?: string; fy?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.FNF_MANAGE, P.FNF_APPROVE])) redirect("/exits");
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status as never) ? sp.status! : null;
  const fy = sp.fy === "all" ? null : Number(sp.fy) || fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const perm = can(viewer, P.FNF_MANAGE) ? P.FNF_MANAGE : P.FNF_APPROVE;
  const rows = await fnfReport(viewer.tenantId, { employeeWhere: scopedEmployeeWhere(viewer, perm) as never, status, fy });
  const t = fnfReportTotals(rows);
  const qs = (o: { status?: string | null; fy?: number | string | null }) => {
    const p = new URLSearchParams();
    const st = o.status === undefined ? status : o.status;
    const y = o.fy === undefined ? fy ?? "all" : o.fy ?? "all";
    if (st) p.set("status", st);
    p.set("fy", String(y));
    return p.toString();
  };

  return (
    <>
      <PageHead title="Settlements report" subtitle={`Full and final settlements${fy ? ` booked in ${fyLabel(fy)}` : ""} — status, amounts and adjustments since`}
        actions={<div className="row gap-2">
          <a className="btn" href={`/exits/settlements/export?${qs({})}`}>Export CSV</a>
          <Link className="btn" href="/exits">All exits</Link>
        </div>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Settlements" value={String(t.count)} meta={Object.entries(t.byStatus).map(([k, v]) => `${v.count} ${k.replace(/_/g, " ").toLowerCase()}`).join(" · ") || "none"} />
        <Stat label="Total payable" value={formatINR(t.payable)} meta="excluding voided" />
        <Stat label="Total recovered" value={formatINR(t.recovery)} meta="excluding voided" />
        <Stat label="Net settled" value={formatINR(t.net)} meta={t.adjustments ? `${formatINR(t.adjustments)} in adjustments since` : "no adjustments since"} tone={t.net >= 0 ? undefined : "neg"} />
      </div>
      <div className="row gap-2 wrap" style={{ marginBottom: 12 }}>
        <div className="tabs">
          <Link href={`/exits/settlements?${qs({ status: null })}`} className={`tab${!status ? " active" : ""}`}>All</Link>
          {STATUSES.map((s) => <Link key={s} href={`/exits/settlements?${qs({ status: s })}`} className={`tab${status === s ? " active" : ""}`}>{s.replace(/_/g, " ").toLowerCase()}</Link>)}
        </div>
        <div className="row gap-2" style={{ marginLeft: "auto" }}>
          {fy ? <Link className="btn sm" href={`/exits/settlements?${qs({ fy: fy - 1 })}`}>‹ {fyLabel(fy - 1)}</Link> : null}
          <Link className={`btn sm${fy ? "" : " primary"}`} href={`/exits/settlements?${qs({ fy: null })}`}>All years</Link>
          {fy ? <Link className="btn sm" href={`/exits/settlements?${qs({ fy: fy + 1 })}`}>{fyLabel(fy + 1)} ›</Link> : null}
        </div>
      </div>
      <Card tight>
        {rows.length === 0 ? <Empty title="No settlements match" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Last day</th><th>Booked in</th><th>Status</th><th className="num">Payable</th><th className="num">Recovered</th><th className="num">Net</th><th className="num">Adjustments</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.settlementId} style={r.status === "VOIDED" ? { opacity: 0.65 } : undefined}>
                    <td><Person name={r.name} meta={`${r.employeeNumber}${r.department ? ` · ${r.department}` : ""}`} /></td>
                    <td className="nowrap text-sm">{r.lastWorkingDay ? formatDate(r.lastWorkingDay) : "—"}<div className="text-xs subtle">{r.exitType?.replace(/_/g, " ").toLowerCase()}</div></td>
                    <td className="nowrap text-sm">{r.settlementPeriod ?? "—"}</td>
                    <td>
                      <Badge tone={TONE[r.status] ?? "neutral"}>{r.status.replace(/_/g, " ").toLowerCase()}</Badge>
                      {r.status === "VOIDED" && r.voidReason ? <div className="text-xs subtle" style={{ marginTop: 3, maxWidth: 220 }}>{r.voidReason}</div> : r.finalizedAt ? <div className="text-xs subtle" style={{ marginTop: 3 }}>{formatDate(r.finalizedAt)}</div> : null}
                    </td>
                    <td className="num">{formatINR(r.totalPayable)}</td>
                    <td className="num">{formatINR(r.totalRecovery)}</td>
                    <td className={`num strong ${r.net >= 0 ? "" : "neg"}`}>{formatINR(r.net)}</td>
                    <td className="num text-sm">{r.adjustmentsCount ? <>{formatINR(r.adjustmentsNet)}<div className="text-xs subtle">{r.adjustmentsCount} item(s)</div></> : <span className="subtle">—</span>}</td>
                    <td className="right">{r.exitId ? <Link className="btn sm" href={`/exits/${r.exitId}`}>Open</Link> : null}</td>
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
