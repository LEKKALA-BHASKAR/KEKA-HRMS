import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { endCoverageAction, runCoverageEndAction, verifyDependentAction, pushBenefitDeductionsAction, reconcileCarrierAction } from "@/app/actions/benefits";

const TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { PENDING_APPROVAL: "warning", ACTIVE: "success", REJECTED: "danger", WAIVED: "info", ENDED: "neutral", CANCELLED: "neutral", PENDING: "warning", APPROVED: "success", WITHDRAWN: "neutral" };
const STATUSES = ["ACTIVE", "PENDING_APPROVAL", "WAIVED", "ENDED", "REJECTED"];

type Recon = { matched: number; missingAtCarrier: Array<{ memberId: string; name: string }>; extraAtCarrier: Array<{ memberId: string; name: string }>; mismatches: Array<{ memberId: string; ours: number; theirs: number; tierOurs: string; tierTheirs: string }> };

/** Who is covered, dependents to verify, premiums to payroll and the insurer's files. */
export default async function BenefitEnrolmentPage({ searchParams }: { searchParams: Promise<{ status?: string; plan?: string; q?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.BENEFIT_MANAGE);
  const sp = await searchParams;
  const t = viewer.tenantId;
  const status = sp.status && STATUSES.includes(sp.status) ? sp.status : undefined;
  const q = sp.q?.trim();
  const [plans, enrolments, unverified, depRequests, lifeEvents, files, lastPush] = await Promise.all([
    prisma.benefitPlan.findMany({ where: { tenantId: t }, select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
    prisma.benefitEnrollment.findMany({
      where: { tenantId: t, ...(status ? { status } : {}), ...(sp.plan ? { planId: sp.plan } : {}), ...(q ? { employee: { OR: [{ displayName: { contains: q, mode: "insensitive" } }, { employeeNumber: { contains: q, mode: "insensitive" } }] } } : {}) },
      include: { plan: { select: { name: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" }, take: 200,
    }),
    prisma.dependent.findMany({ where: { employee: { tenantId: t, status: { not: "EXITED" } }, verifiedAt: null }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { name: "asc" }, take: 50 }),
    prisma.dependentRequest.findMany({ where: { tenantId: t }, include: { employee: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.benefitLifeEvent.findMany({ where: { tenantId: t }, include: { employee: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.benefitCarrierFile.findMany({ where: { tenantId: t }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.benefitDeduction.findFirst({ where: { tenantId: t }, orderBy: [{ year: "desc" }, { month: "desc" }] }),
  ]);
  const planName = new Map(plans.map((p) => [p.id, p.name]));
  const activePlans = plans.filter((p) => p.status === "ACTIVE");
  const now = new Date();
  const lastRecon = files.find((f) => f.kind === "RECONCILIATION");
  const recon = lastRecon?.result as Recon | null | undefined;
  return (
    <>
      <PageHead title="Benefit enrolments" subtitle="Coverage, dependents, payroll deductions and insurer files"
        actions={<><ActButton action={runCoverageEndAction} hidden={{}} label="End cover for leavers" /><Link className="btn" href="/payroll/benefits">Plans</Link><Link className="btn" href="/payroll/benefits/reports">Reports</Link></>} />
      <Card tight title={`Enrolments (${enrolments.length})`} description="New enrolments are approved in the inbox. End cover here when someone leaves a plan mid-year."
        action={
          <form className="row gap-2 wrap" method="get">
            <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search employee" style={{ width: 180 }} />
            <select className="input" name="plan" defaultValue={sp.plan ?? ""}><option value="">All plans</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select className="input" name="status" defaultValue={status ?? ""}><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase().replace("_", " ")}</option>)}</select>
            <button className="btn sm">Filter</button>
          </form>
        }>
        {enrolments.length === 0 ? <Empty title="No enrolments match" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Employee</th><th>Plan</th><th>Tier</th><th className="num">Employee / mo</th><th className="num">Employer / mo</th><th>Cover</th><th>Status</th><th /></tr></thead>
            <tbody>{enrolments.map((e) => (
              <tr key={e.id}>
                <td><div className="text-sm strong">{e.employee.displayName}</div><div className="text-xs subtle">{e.employee.employeeNumber}</div></td>
                <td className="text-sm">{e.plan.name}</td>
                <td className="text-xs">{e.tier.toLowerCase().replace("_", " + ")}{e.dependentIds.length ? ` · ${e.dependentIds.length} dep.` : ""}</td>
                <td className="num">{formatINR(Number(e.employeeMonthly))}</td>
                <td className="num">{formatINR(Number(e.employerMonthly))}</td>
                <td className="text-xs">{e.coverageStart ? formatDate(e.coverageStart) : "—"}{e.coverageEnd ? ` – ${formatDate(e.coverageEnd)}` : ""}{e.endReason ? <div className="subtle">{e.endReason}</div> : null}</td>
                <td><Badge tone={TONE[e.status] ?? "neutral"}>{e.status.toLowerCase().replace("_", " ")}</Badge></td>
                <td>{e.status === "ACTIVE" ? <Reveal label="End cover"><GrowthForm action={endCoverageAction} hidden={{ enrollmentId: e.id }} cols={1} compact submitLabel="End" fields={[{ name: "endOn", label: "Last day", type: "date", required: true, defaultValue: now.toISOString().slice(0, 10) }, { name: "reason", label: "Reason", required: true }]} /></Reveal> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card tight title={`Dependents to verify (${unverified.length})`} description="Check the proof of relationship; plans that need proof only cover verified dependents.">
          {unverified.length === 0 ? <Empty title="All verified" /> : (
            <div className="table-wrap"><table className="data"><tbody>{unverified.map((d) => (
              <tr key={d.id}>
                <td><div className="text-sm strong">{d.name}</div><div className="text-xs subtle">{d.relationship.toLowerCase()} of {d.employee.displayName}{d.dateOfBirth ? ` · born ${formatDate(d.dateOfBirth)}` : ""}</div></td>
                <td className="text-xs">{d.proofUrl ? <a href={d.proofUrl}>proof</a> : <span className="subtle">no proof</span>}</td>
                <td>{d.proofUrl ? <ActButton action={verifyDependentAction} hidden={{ dependentId: d.id }} label="Verify" /> : <Reveal label="Attach & verify"><GrowthForm action={verifyDependentAction} hidden={{ dependentId: d.id }} cols={1} compact submitLabel="Verify" fields={[{ name: "proof", label: "Proof", type: "file" }]} /></Reveal>}</td>
              </tr>
            ))}</tbody></table></div>
          )}
        </Card>
        <Card tight title="Dependent changes and life events" description="Employee requests; decided in the inbox.">
          {depRequests.length + lifeEvents.length === 0 ? <Empty title="None" /> : (
            <div className="table-wrap"><table className="data"><tbody>
              {depRequests.map((r) => <tr key={r.id}><td className="text-sm">{r.employee.displayName}</td><td className="text-xs">{r.action.toLowerCase()} {r.relationship.toLowerCase()} {r.name}{r.proofUrl ? <> · <a href={r.proofUrl}>proof</a></> : null}</td><td className="text-xs">{formatDate(r.createdAt)}</td><td><Badge tone={TONE[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge></td></tr>)}
              {lifeEvents.map((l) => <tr key={l.id}><td className="text-sm">{l.employee.displayName}</td><td className="text-xs">{l.kind.toLowerCase().replace(/_/g, " ")} on {formatDate(l.eventDate)}{l.proofUrl ? <> · <a href={l.proofUrl}>proof</a></> : null}</td><td className="text-xs">{formatDate(l.createdAt)}</td><td><Badge tone={TONE[l.status] ?? "neutral"}>{l.status.toLowerCase()}</Badge></td></tr>)}
            </tbody></table></div>
          )}
        </Card>
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Premiums to payroll" description={`Pushes each active enrolment's employee share as a payroll deduction, with arrears for months missed.${lastPush ? ` Last pushed for ${lastPush.month}/${lastPush.year}.` : ""}`}>
          <GrowthForm action={pushBenefitDeductionsAction} cols={2} submitLabel="Push deductions" fields={[
            { name: "year", label: "Year", type: "number", required: true, defaultValue: now.getUTCFullYear() },
            { name: "month", label: "Month", type: "number", required: true, defaultValue: now.getUTCMonth() + 1 },
          ]} />
        </Card>
        <Card title="Insurer files" description="Send the insurer a member census and reconcile the file they send back (CSV with member id, name, tier and premium).">
          <div className="stack gap-2">
            {activePlans.length === 0 ? <div className="text-sm subtle">No active plans.</div> : activePlans.map((p) => <div key={p.id} className="row gap-2" style={{ justifyContent: "space-between" }}><span className="text-sm">{p.name}</span><a className="btn sm" href={`/payroll/benefits/census?planId=${p.id}`}>Download census</a></div>)}
          </div>
          <div style={{ marginTop: 10 }}>
            <Reveal label="Reconcile an insurer file">
              <GrowthForm action={reconcileCarrierAction} cols={1} submitLabel="Reconcile" fields={[
                { name: "planId", label: "Plan", type: "select", required: true, options: activePlans.map((p) => ({ value: p.id, label: p.name })) },
                { name: "file", label: "Insurer member file (CSV)", type: "file" },
              ]} />
            </Reveal>
          </div>
          {recon && lastRecon ? (
            <div className="text-sm" style={{ marginTop: 8 }}>
              <div className="strong">Last reconciliation — {planName.get(lastRecon.planId)} · {formatDate(lastRecon.createdAt)}</div>
              <div>{recon.matched} matched · {recon.missingAtCarrier.length} missing at insurer · {recon.extraAtCarrier.length} extra at insurer · {recon.mismatches.length} mismatches</div>
              {recon.missingAtCarrier.slice(0, 5).map((m) => <div key={m.memberId} className="text-xs neg">Missing: {m.memberId} {m.name}</div>)}
              {recon.extraAtCarrier.slice(0, 5).map((m) => <div key={m.memberId} className="text-xs neg">Extra: {m.memberId} {m.name}</div>)}
              {recon.mismatches.slice(0, 5).map((m) => <div key={m.memberId} className="text-xs neg">{m.memberId}: ours {m.tierOurs} {formatINR(m.ours)}, insurer {m.tierTheirs} {formatINR(m.theirs)}</div>)}
            </div>
          ) : null}
          {files.length ? <div className="text-xs subtle" style={{ marginTop: 8 }}>{files.map((f) => `${f.kind.toLowerCase()} ${planName.get(f.planId) ?? ""} ${f.createdAt.toISOString().slice(0, 10)} (${f.rowCount} rows)`).join(" · ")}</div> : null}
        </Card>
      </div>
    </>
  );
}
