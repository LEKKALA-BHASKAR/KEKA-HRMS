import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { asStringList } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { CreatePoolForm } from "../_parts/talent-forms";
import { kDate } from "../_lib/data";
import s from "../hire.module.css";

export const metadata = { title: "Talent pools · Hire" };

/**
 * Hire › Talent pools: groups of candidates worth keeping in touch with —
 * silver medallists, future openings — searchable by name, skill or title,
 * and put forward for a new job in one step.
 */
export default async function PoolsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const q = ((await searchParams).q ?? "").trim().slice(0, 80);
  const tenantId = viewer.tenantId;
  const pools = await prisma.talentPool.findMany({ where: { tenantId }, include: { _count: { select: { members: true } } }, orderBy: { name: "asc" } });
  const hits = q
    ? await prisma.talentPoolMember.findMany({
        where: {
          pool: { tenantId },
          candidate: { tenantId, OR: [{ firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { currentTitle: { contains: q, mode: "insensitive" } }, { skills: { array_contains: [q.toLowerCase()] } }] },
        },
        include: { pool: { select: { id: true, name: true } }, candidate: { select: { id: true, firstName: true, lastName: true, currentTitle: true, currentEmployer: true, skills: true } } },
        take: 100,
      })
    : [];
  return (
    <>
      <div className={s.head}><div><h1 className={s.h1}>Talent pools</h1><p className={s.sub}>Keep strong candidates close for the next opening. Save anyone to a pool from their candidate page.</p></div></div>
      <form className="row gap-2" style={{ marginBottom: 16 }}>
        <input className="input" name="q" defaultValue={q} placeholder="Search pooled candidates by name, title or skill" aria-label="Search pooled candidates" style={{ flex: 1, maxWidth: 420 }} />
        <button className="btn">Search</button>
      </form>
      {q ? (
        <section className={s.listCard} style={{ marginBottom: 16 }}>
          <div className={s.listHead}><span className={s.listTitle}>Matches for “{q}”</span><span className="text-xs subtle">{hits.length}</span></div>
          {hits.length === 0 ? <div className={s.empty}>No pooled candidate matches.</div> : (
            <table className={s.table}><tbody>
              {hits.map((h) => (
                <tr key={h.id}>
                  <td>{h.candidate.firstName} {h.candidate.lastName}<div className={s.metaLine}>{[h.candidate.currentTitle, h.candidate.currentEmployer].filter(Boolean).join(" at ")}</div></td>
                  <td className="text-sm muted">{asStringList(h.candidate.skills).slice(0, 6).join(", ")}</td>
                  <td><Link href={`/hiring/pools/${h.pool.id}`}>{h.pool.name}</Link></td>
                </tr>
              ))}
            </tbody></table>
          )}
        </section>
      ) : null}
      <div className={s.settingsGrid}>
        <section className={s.listCard}>
          <div className={s.listHead}><span className={s.listTitle}>Pools</span><span className="text-xs subtle">{pools.length}</span></div>
          {pools.length === 0 ? <div className={s.empty}>No pools yet.</div> : (
            <table className={s.table}><tbody>
              {pools.map((p) => (
                <tr key={p.id}>
                  <td><Link href={`/hiring/pools/${p.id}`} className="strong">{p.name}</Link>{p.description ? <div className={s.metaLine}>{p.description}</div> : null}</td>
                  <td className="nowrap">{p._count.members} candidate{p._count.members === 1 ? "" : "s"}</td>
                  <td className="text-xs subtle nowrap">since {kDate(p.createdAt)}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </section>
        <section className={s.listCard}>
          <div className={s.listHead}><span className={s.listTitle}>New pool</span></div>
          <div style={{ padding: 18 }}><CreatePoolForm /></div>
        </section>
      </div>
    </>
  );
}
