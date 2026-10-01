import { prisma } from "@keka/db";
import { requireViewer } from "@/lib/context";
import { ReferForm } from "../forms";
import { EmployeeHireTabs } from "../_parts/employee-tabs";
import { kDate } from "../_lib/data";
import s from "../hire.module.css";

export const metadata = { title: "Refer & Apply · Hire" };

/** Org › Hiring › Refer & Apply: open jobs any employee can refer someone to, and their referrals. */
export default async function ReferPage() {
  const viewer = await requireViewer();
  const [jobs, mine] = await Promise.all([
    prisma.job.findMany({ where: { tenantId: viewer.tenantId, status: "OPEN", allowReferral: true }, orderBy: { title: "asc" }, select: { id: true, title: true, code: true, openings: true, description: true, locationId: true } }),
    viewer.employee ? prisma.candidate.findMany({ where: { tenantId: viewer.tenantId, referredById: viewer.employee.id }, include: { applications: { include: { job: { select: { title: true } } } } }, orderBy: { createdAt: "desc" } }) : [],
  ]);
  return (
    <>
      <EmployeeHireTabs viewer={viewer} />
      <div className={s.head}><div><h1 className={s.h1}>Refer &amp; Apply</h1><p className={s.sub}>Know someone great? Refer them to an open job — they go straight into the pipeline with you credited as the referrer.</p></div></div>
      <div className={s.settingsGrid}>
        <div className={s.listCard}>
          <div className={s.listHead}><span className={s.listTitle}>Open jobs</span><span className="text-xs subtle">{jobs.length}</span></div>
          {jobs.length === 0 ? <div className={s.empty}>No open jobs are taking referrals right now.</div> : (
            <div style={{ padding: "6px 18px 18px" }}>
              {jobs.map((j) => (
                <div key={j.id} style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 15 }}>{j.title} <span className="text-xs subtle">{j.code} · {j.openings} opening{j.openings === 1 ? "" : "s"}</span></div>
                  {j.description ? <div className="text-sm muted" style={{ marginTop: 4 }}>{j.description.replace(/[*#]/g, "").slice(0, 180)}{j.description.length > 180 ? "…" : ""}</div> : null}
                </div>
              ))}
              <div style={{ marginTop: 18 }}><ReferForm jobs={jobs.map((j) => ({ value: j.id, label: `${j.title} (${j.code})` }))} /></div>
            </div>
          )}
        </div>
        <div className={s.listCard}>
          <div className={s.listHead}><span className={s.listTitle}>Your referrals</span><span className="text-xs subtle">{mine.length}</span></div>
          {mine.length === 0 ? <div className={s.empty}>You have not referred anyone yet.</div> : (
            <table className={s.table}><tbody>
              {mine.flatMap((c) => c.applications.map((a) => (
                <tr key={a.id}>
                  <td>{c.firstName} {c.lastName}<div className={s.metaLine}>{a.job.title}</div></td>
                  <td><span className={`${s.statusChip} ${a.status === "HIRED" ? s.good : a.status === "REJECTED" ? "" : s.info}`}>{a.status.toLowerCase().replace(/_/g, " ")}</span></td>
                  <td className="text-xs subtle nowrap">{kDate(a.appliedAt)}</td>
                </tr>
              )))}
            </tbody></table>
          )}
        </div>
      </div>
    </>
  );
}
