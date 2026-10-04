import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { asStringList } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { RemoveFromPool, PoolToJobForm } from "../../_parts/talent-forms";
import { kDate } from "../../_lib/data";
import s from "../../hire.module.css";

export const metadata = { title: "Talent pool · Hire" };

/** One talent pool: its candidates, where they last applied, and a way to put them forward for an open job. */
export default async function PoolPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const { id } = await params;
  const tenantId = viewer.tenantId;
  const pool = await prisma.talentPool.findFirst({
    where: { id, tenantId },
    include: { members: { orderBy: { addedAt: "desc" }, include: { candidate: { include: { applications: { orderBy: { appliedAt: "desc" }, take: 1, include: { job: { select: { title: true } } } } } } } } },
  });
  if (!pool) notFound();
  const jobs = await prisma.job.findMany({ where: { tenantId, status: "OPEN" }, select: { id: true, title: true, code: true }, orderBy: { title: "asc" } });
  const jobOptions = jobs.map((j) => ({ value: j.id, label: `${j.title}${j.code ? ` (${j.code})` : ""}` }));
  return (
    <>
      <div className={s.head}>
        <div><div className="text-sm"><Link href="/hiring/pools">Talent pools</Link> /</div><h1 className={s.h1}>{pool.name}</h1>{pool.description ? <p className={s.sub}>{pool.description}</p> : null}</div>
      </div>
      <section className={s.listCard}>
        <div className={s.listHead}><span className={s.listTitle}>Candidates</span><span className="text-xs subtle">{pool.members.length}</span></div>
        {pool.members.length === 0 ? <div className={s.empty}>Nobody in this pool yet. Save candidates to it from their candidate page.</div> : (
          <table className={s.table}><tbody>
            {pool.members.map((m) => {
              const c = m.candidate, last = c.applications[0];
              return (
                <tr key={m.id}>
                  <td>
                    {last ? <Link href={`/hiring/applications/${last.id}`} className="strong">{c.firstName} {c.lastName}</Link> : <span className="strong">{c.firstName} {c.lastName}</span>}
                    <div className={s.metaLine}>{[c.currentTitle, c.currentEmployer, c.totalExperienceYears !== null ? `${Number(c.totalExperienceYears)} yrs` : null].filter(Boolean).join(" · ")}</div>
                    {m.note ? <div className="text-xs muted">{m.note}</div> : null}
                  </td>
                  <td className="text-sm muted">{asStringList(c.skills).slice(0, 6).join(", ") || "—"}</td>
                  <td className="text-xs subtle">{last ? `${last.job.title} · ${last.status.toLowerCase().replace(/_/g, " ")}` : "No applications"}<div>added {kDate(m.addedAt)}</div></td>
                  <td style={{ minWidth: 280 }}><div className="stack gap-1" style={{ alignItems: "flex-end" }}><PoolToJobForm candidateId={c.id} jobs={jobOptions} /><RemoveFromPool id={m.id} /></div></td>
                </tr>
              );
            })}
          </tbody></table>
        )}
      </section>
    </>
  );
}
