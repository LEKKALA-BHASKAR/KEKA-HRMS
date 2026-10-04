import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { duplicateGroups, pendingHireRequests } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { ActButton } from "@/components/growth-forms";
import { requestMergeAction } from "@/app/actions/hire-ops";
import { CandidateTabs, day } from "../../_parts/depth-tabs";

export const metadata = { title: "Duplicate candidates · Hire" };

/**
 * Candidates who look like the same person (same phone, same name and
 * employer, same email name at another provider). Merging keeps the first
 * record and moves everything from the other onto it, after approval.
 */
export default async function DuplicatesPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const { focus } = await searchParams;
  const cands = await prisma.candidate.findMany({ where: { tenantId: viewer.tenantId, convertedEmployeeId: null }, select: { id: true, firstName: true, lastName: true, email: true, phone: true, currentEmployer: true, createdAt: true, _count: { select: { applications: true } } }, take: 5000 });
  let groups = duplicateGroups(cands);
  if (focus) groups = groups.filter((g) => g.members.some((m) => m.id === focus));
  const pending = await pendingHireRequests(viewer.tenantId, "CANDIDATE_MERGE", groups.flatMap((g) => g.members.map((m) => m.id)));
  const merges = await prisma.candidateMergeLog.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { createdAt: "desc" }, take: 20 });
  return (
    <>
      <CandidateTabs />
      <PageHead title="Duplicate candidates" subtitle="Merge records that belong to one person, so their history is in one place." />
      {groups.length === 0 ? <Card><Empty title="No likely duplicates">{focus ? "Nothing looks like this candidate." : "The candidate database looks clean."}</Empty></Card> : groups.map((g, i) => {
        const [keep, ...rest] = [...g.members].sort((a, b) => b._count.applications - a._count.applications || a.createdAt.getTime() - b.createdAt.getTime());
        return (
          <Card key={i} title={g.reason} tight>
            <table className="data"><tbody>
              {[keep!, ...rest].map((m, j) => (
                <tr key={m.id}>
                  <td><Link href={`/hiring/candidates/${m.id}`}>{m.firstName} {m.lastName}</Link> {j === 0 ? <Badge tone="success">Keep</Badge> : null}<div className="text-xs muted">{m.email} · {m.phone ?? "no phone"} · {m.currentEmployer ?? ""}</div></td>
                  <td className="text-sm">{m._count.applications} application(s) · added {day(m.createdAt)}</td>
                  <td className="right">{j === 0 ? null : pending.has(keep!.id) ? <Badge tone="warning">Merge awaiting approval</Badge> : <ActButton action={requestMergeAction} hidden={{ survivorId: keep!.id, duplicateId: m.id }} label={`Merge into ${keep!.firstName}`} confirmText="Merge these two records after approval?" />}</td>
                </tr>
              ))}
            </tbody></table>
          </Card>
        );
      })}
      {merges.length ? (
        <Card title="Recent merges" tight>
          <table className="data"><tbody>
            {merges.map((m) => <tr key={m.id}><td>{m.mergedName} &lt;{m.mergedEmail}&gt; → <Link href={`/hiring/candidates/${m.survivorId}`}>kept record</Link></td><td className="text-xs">{Object.entries(m.moved as Record<string, number>).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ")}</td><td className="text-xs">{day(m.createdAt)}</td></tr>)}
          </tbody></table>
        </Card>
      ) : null}
    </>
  );
}
