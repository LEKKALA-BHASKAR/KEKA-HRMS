import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { sectionName } from "@keka/services";
import { fyStartYear, formatDate, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat } from "@/components/ui";
import { ProofReview } from "../_forms/tax-proofs";

const P = PERMISSIONS;
const TABS = { pending: "To review", approved: "Accepted", rejected: "Rejected" } as const;
type Tab = keyof typeof TABS;
const STATUS: Record<Tab, "SUBMITTED" | "APPROVED" | "REJECTED"> = { pending: "SUBMITTED", approved: "APPROVED", rejected: "REJECTED" };

export default async function TaxProofsPage({ searchParams }: { searchParams: Promise<{ tab?: string; fy?: string; q?: string }> }) {
  const viewer = await requireAuth(P.TAX_DECLARATION_APPROVE);
  const sp = await searchParams;
  const tab: Tab = (sp.tab && sp.tab in TABS ? sp.tab : "pending") as Tab;
  const currentFy = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const fy = Number(sp.fy) || currentFy;
  const q = sp.q?.trim() ?? "";
  const scope = scopedEmployeeWhere(viewer, P.TAX_DECLARATION_APPROVE);
  const employeeWhere = {
    ...scope,
    ...(q ? { OR: [{ displayName: { contains: q, mode: "insensitive" as const } }, { employeeNumber: { contains: q, mode: "insensitive" as const } }] } : {}),
  };
  const base = { declaration: { fyStartYear: fy, employee: employeeWhere } };

  const [items, counts, fys] = await Promise.all([
    prisma.declarationItem.findMany({
      where: { ...base, proofStatus: STATUS[tab] },
      include: { declaration: { select: { employeeId: true, regime: true, employee: { select: { displayName: true, employeeNumber: true } } } } },
      orderBy: tab === "pending" ? [{ declaration: { submittedAt: "asc" } }, { id: "asc" }] : [{ reviewedAt: "desc" }],
      take: 300,
    }),
    prisma.declarationItem.groupBy({ by: ["proofStatus"], where: base, _count: true, _sum: { declaredAmount: true, approvedAmount: true } }),
    prisma.investmentDeclaration.findMany({ where: { employee: scope }, distinct: ["fyStartYear"], select: { fyStartYear: true }, orderBy: { fyStartYear: "desc" } }),
  ]);
  const reviewers = await prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.reviewedBy).filter((x): x is string => !!x))] } }, select: { id: true, email: true, employee: { select: { displayName: true } } } });
  const reviewerName = new Map(reviewers.map((u) => [u.id, u.employee?.displayName ?? u.email]));
  const c = (s: string) => counts.find((x) => x.proofStatus === s);
  const fyOptions = [...new Set([currentFy, ...fys.map((f) => f.fyStartYear)])].sort((a, b) => b - a);
  const link = (over: Record<string, string>) => `/payroll/tax-proofs?${new URLSearchParams({ tab, fy: String(fy), ...(q ? { q } : {}), ...over })}`;

  return (
    <>
      <PageHead title="Tax proofs" subtitle="Check the evidence behind investment declarations. What you accept is what TDS counts for the rest of the year." />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="To review" value={String(c("SUBMITTED")?._count ?? 0)} meta={formatINR(Number(c("SUBMITTED")?._sum.declaredAmount ?? 0))} />
        <Stat label="Accepted" value={String(c("APPROVED")?._count ?? 0)} meta={`${formatINR(Number(c("APPROVED")?._sum.approvedAmount ?? 0))} counted`} />
        <Stat label="Rejected" value={String(c("REJECTED")?._count ?? 0)} meta="employee asked to re-upload" />
        <Stat label="No proof yet" value={String(c("NOT_SUBMITTED")?._count ?? 0)} meta={formatINR(Number(c("NOT_SUBMITTED")?._sum.declaredAmount ?? 0))} />
      </div>
      <div className="row gap-2" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <Link key={t} href={link({ tab: t })} className={`tab${tab === t ? " active" : ""}`}>
              {TABS[t]}{t === "pending" && c("SUBMITTED")?._count ? ` (${c("SUBMITTED")?._count})` : ""}
            </Link>
          ))}
        </div>
        <form className="row gap-2" style={{ marginLeft: "auto" }}>
          <input type="hidden" name="tab" value={tab} />
          <select className="input" name="fy" defaultValue={String(fy)} aria-label="Financial year">
            {fyOptions.map((y) => <option key={y} value={y}>FY {y}–{String(y + 1).slice(2)}</option>)}
          </select>
          <input className="input" name="q" defaultValue={q} placeholder="Name or employee number" />
          <button className="btn">Filter</button>
        </form>
      </div>
      <Card tight>
        {items.length === 0 ? <Empty title={tab === "pending" ? "No proofs waiting" : `Nothing ${TABS[tab].toLowerCase()} yet`} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Employee</th><th>Section</th><th>Investment</th><th className="num">Declared</th>
                  {tab === "pending" ? null : <th className="num">Accepted</th>}
                  <th>Proof</th>
                  {tab === "pending" ? null : <th>Reviewed</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td><Person name={i.declaration.employee.displayName ?? ""} meta={i.declaration.employee.employeeNumber} /></td>
                    <td className="nowrap">{i.section}<div className="text-xs subtle">{sectionName(i.section)}</div></td>
                    <td className="text-sm" style={{ maxWidth: 260 }}>{i.category}{i.description ? <div className="text-xs muted">{i.description}</div> : null}</td>
                    <td className="num">{formatINR(Number(i.declaredAmount))}</td>
                    {tab === "pending" ? null : <td className="num">{formatINR(Number(i.approvedAmount))}</td>}
                    <td>{i.proofFileUrl ? <a href={i.proofFileUrl} target="_blank" rel="noreferrer">View proof</a> : <span className="subtle">—</span>}</td>
                    {tab === "pending" ? null : (
                      <td className="text-sm">
                        {i.reviewedAt ? formatDate(i.reviewedAt) : "—"}{i.reviewedBy ? <div className="text-xs subtle">{reviewerName.get(i.reviewedBy) ?? ""}</div> : null}
                        {i.proofRemark ? <div className="text-xs muted">{i.proofRemark}</div> : null}
                      </td>
                    )}
                    <td className="right">
                      {tab === "pending"
                        ? (i.declaration.employeeId === viewer.employee?.id ? <Badge tone="neutral">Your own</Badge> : <ProofReview itemId={i.id} declared={Number(i.declaredAmount)} />)
                        : <Badge tone={tab === "approved" ? "success" : "danger"}>{TABS[tab]}</Badge>}
                    </td>
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
