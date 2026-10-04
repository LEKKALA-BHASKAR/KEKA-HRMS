import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Badge } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { savePathAction, joinPathAction } from "@/app/actions/learn-growth";

const P = PERMISSIONS;
import { STATUS_TONE } from "@/components/growth-report";

export default async function PathsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const sp = await searchParams;
  const admin = can(viewer, P.COURSE_MANAGE);
  const q = (sp.q ?? "").trim().slice(0, 80);
  const status = admin && ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "ARCHIVED"].includes(sp.status ?? "") ? (sp.status as "DRAFT") : undefined;
  const paths = await prisma.learningPath.findMany({
    where: { tenantId: viewer.tenantId, ...(admin ? (status ? { status } : {}) : { status: "APPROVED" }), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { category: { contains: q, mode: "insensitive" } }, { jobTitle: { contains: q, mode: "insensitive" } }] } : {}) },
    include: { courses: { select: { id: true, isOptional: true } }, _count: { select: { assignments: true } }, assignments: viewer.employee ? { where: { employeeId: viewer.employee.id }, select: { status: true, progressPercent: true } } : false },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });

  return (
    <>
      <PageHead title="Learning Paths" subtitle="Sequences of courses towards a role or a skill" />
      <form className="row gap-2 wrap" style={{ marginBottom: 14 }}>
        <input className="input" name="q" defaultValue={q} placeholder="Search paths" style={{ maxWidth: 300 }} />
        {admin ? (
          <select className="select" name="status" defaultValue={status ?? ""} style={{ maxWidth: 180 }}>
            <option value="">Any status</option>{Object.keys(STATUS_TONE).map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </select>
        ) : null}
        <button className="btn">Search</button>
      </form>
      {admin ? (
        <Reveal label="+ New learning path">
          <Panel title="New learning path">
            <GrowthForm action={savePathAction} submitLabel="Create path" fields={[
              { name: "name", label: "Name", required: true },
              { name: "category", label: "Category" },
              { name: "jobTitle", label: "For job title", hint: "Optional — the role this path prepares for" },
              { name: "dueInDays", label: "Days to complete", type: "number", min: 1, max: 730 },
              { name: "description", label: "Description", type: "textarea" },
              { name: "isMandatory", label: "Mandatory for the people it is assigned to", type: "checkbox" },
            ]} />
          </Panel>
        </Reveal>
      ) : null}
      <Panel pad={false}>
        {paths.length === 0 ? <EmptyState title="No learning paths yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Path</th><th>Category</th><th className="num">Courses</th>{admin ? <><th>Status</th><th className="num">Assigned</th></> : null}<th>Updated</th><th /></tr></thead>
              <tbody>
                {paths.map((p) => {
                  const mine = Array.isArray(p.assignments) ? p.assignments[0] : undefined;
                  return (
                    <tr key={p.id}>
                      <td><Link className="strong" href={`/learn/paths/${p.id}`}>{p.name}</Link>{p.jobTitle ? <div className="text-xs subtle">For {p.jobTitle}</div> : null}</td>
                      <td className="text-sm">{p.category ?? "—"}</td>
                      <td className="num">{p.courses.length}</td>
                      {admin ? <><td><Badge tone={STATUS_TONE[p.status]} dot>{p.status.toLowerCase()}</Badge></td><td className="num">{p._count.assignments}</td></> : null}
                      <td className="text-sm nowrap">{formatDate(p.updatedAt)}</td>
                      <td className="right">{mine ? <Badge tone={mine.status === "COMPLETED" ? "success" : "info"} dot>{mine.progressPercent}% done</Badge> : p.status === "APPROVED" && viewer.employee ? <ActButton action={joinPathAction} hidden={{ pathId: p.id }} label="Join" /> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
