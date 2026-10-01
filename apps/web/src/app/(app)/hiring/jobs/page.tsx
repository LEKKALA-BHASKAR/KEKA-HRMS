import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, canAny } from "@/lib/context";
import { forbidden } from "next/navigation";
import { rupees } from "../_lib/data";
import s from "../hire.module.css";

const P = PERMISSIONS;
export const metadata = { title: "Jobs · Hire" };

const TONE: Record<string, string> = { OPEN: "good", ON_HOLD: "warn", FILLED: "info", CLOSED: "", DRAFT: "" };

/** Every job opened from a requisition, with its pipeline at a glance. */
export default async function JobsPage() {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.JOB_MANAGE, P.CANDIDATE_MANAGE])) forbidden();
  const jobs = await prisma.job.findMany({
    where: { tenantId: viewer.tenantId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      applications: { select: { status: true, currentStageId: true } },
      flow: { include: { stages: { orderBy: { sequence: "asc" } } } },
      requisition: { select: { code: true } },
    },
  });
  const [depts, locs, managers] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: viewer.tenantId, id: { in: jobs.map((j) => j.departmentId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId, id: { in: jobs.map((j) => j.locationId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: jobs.map((j) => j.hiringManagerId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } }),
  ]);
  const dn = new Map(depts.map((d) => [d.id, d.name])), ln = new Map(locs.map((l) => [l.id, l.name])), mn = new Map(managers.map((m) => [m.id, m.displayName]));
  const all = jobs.flatMap((j) => j.applications);
  const stat = (label: string, value: number, meta: string) => (
    <div className={s.cardAlone} style={{ padding: "16px 18px" }}>
      <div className="text-xs muted" style={{ letterSpacing: ".06em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 400, marginTop: 6 }}>{value}</div>
      <div className="text-xs subtle">{meta}</div>
    </div>
  );
  return (
    <>
      <div className={s.head}>
        <div><h1 className={s.h1}>Jobs</h1><p className={s.sub}>Jobs open from approved requisitions, and where every candidate stands.</p></div>
        <div className={s.headActions}><Link className={s.outlineBtn} href="/hiring/requisitions?view=all&status=approved">Approved requisitions without a job</Link></div>
      </div>
      <div className="grid grid-4" style={{ marginBottom: 20 }}>
        {stat("Open jobs", jobs.filter((j) => j.status === "OPEN").length, `${jobs.filter((j) => j.status === "OPEN").reduce((n, j) => n + j.openings, 0)} positions`)}
        {stat("In the pipeline", all.filter((a) => a.status === "ACTIVE").length, "active candidates")}
        {stat("Offers out", all.filter((a) => a.status === "OFFER_EXTENDED").length, "awaiting a reply")}
        {stat("Hired", all.filter((a) => a.status === "HIRED").length, "converted to employees")}
      </div>
      <div className={s.cardAlone}>
        {jobs.length === 0 ? <div className={s.empty}>No jobs yet. Open one from an approved requisition.</div> : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>Job</th><th>Department</th><th>Location</th><th>Hiring Manager</th><th>Status</th><th>Pipeline</th><th>Openings</th><th>Budget</th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td><Link className={s.reqLink} href={`/hiring/jobs/${j.id}`}>{j.title}</Link><div className={s.code}>{j.code}{j.requisition?.code ? ` · ${j.requisition.code}` : ""}</div></td>
                    <td>{j.departmentId ? dn.get(j.departmentId) ?? "—" : "—"}</td>
                    <td>{j.locationId ? ln.get(j.locationId) ?? "—" : "—"}</td>
                    <td>{j.hiringManagerId ? mn.get(j.hiringManagerId) ?? "—" : "—"}</td>
                    <td><span className={`${s.statusChip} ${s[TONE[j.status]] ?? ""}`}>{j.status.charAt(0) + j.status.slice(1).toLowerCase().replace("_", " ")}</span></td>
                    <td className="text-xs">
                      <span className="row gap-2 wrap">
                        {(j.flow?.stages ?? []).map((st) => {
                          const n = j.applications.filter((a) => ["ACTIVE", "ON_HOLD", "OFFER_EXTENDED", "OFFER_ACCEPTED"].includes(a.status) && a.currentStageId === st.id).length;
                          return <span key={st.id} className={n ? "strong" : "subtle"}>{st.name} {n}</span>;
                        })}
                      </span>
                    </td>
                    <td>{j.openings}</td>
                    <td className="nowrap">{j.maxAnnualCtc ? `up to ${rupees(j.maxAnnualCtc)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
