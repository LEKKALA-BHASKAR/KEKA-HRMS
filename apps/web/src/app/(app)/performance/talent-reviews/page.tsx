import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { ensureBoxLabels } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Badge } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { saveTalentReviewAction, saveBoxLabelsAction } from "@/app/actions/succession";

const P = PERMISSIONS;
const TONE: Record<string, "neutral" | "info" | "warning" | "success" | "danger"> = { DRAFT: "neutral", IN_PROGRESS: "info", SUBMITTED: "warning", APPROVED: "success", REJECTED: "danger" };

export default async function TalentReviewsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const [reviews, departments, labels] = await Promise.all([
    prisma.talentReview.findMany({
      where: { tenantId: viewer.tenantId, ...(sp.status && TONE[sp.status] ? { status: sp.status } : {}), ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) },
      include: { entries: { select: { box: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ensureBoxLabels(viewer.tenantId),
  ]);
  const dept = new Map(departments.map((d) => [d.id, d.name]));
  const byBox = [...labels].sort((a, b) => b.box - a.box);

  return (
    <>
      <PageHead title="Talent Reviews" subtitle="Calibrate performance and potential on the 9-box, then sign the review off" actions={<Link className="btn" href="/performance/succession?report=ninebox">9-box report</Link>} />
      <form className="row gap-2 wrap" style={{ marginBottom: 14 }}>
        <input className="input" name="q" defaultValue={q} placeholder="Search reviews" style={{ maxWidth: 280 }} />
        <select className="select" name="status" defaultValue={sp.status ?? ""} style={{ maxWidth: 180 }}>
          <option value="">Any status</option>{Object.keys(TONE).map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}
        </select>
        <button className="btn">Search</button>
      </form>
      <Reveal label="+ New talent review">
        <Panel title="New talent review">
          <GrowthForm action={saveTalentReviewAction} submitLabel="Create" fields={[
            { name: "name", label: "Name", required: true, placeholder: "Engineering — H2 2026" },
            { name: "departmentId", label: "Department", type: "select", options: departments.map((d) => ({ value: d.id, label: d.name })) },
            { name: "meetingAt", label: "Calibration meeting", type: "date" },
            { name: "description", label: "Description", type: "textarea" },
            { name: "agenda", label: "Agenda", type: "textarea" },
          ]} />
        </Panel>
      </Reveal>
      <Panel pad={false}>
        {reviews.length === 0 ? <EmptyState title="No talent reviews yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Review</th><th>Department</th><th>Meeting</th><th className="num">People</th><th className="num">Placed</th><th>Status</th></tr></thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={r.id}>
                    <td><Link className="strong" href={`/performance/talent-reviews/${r.id}`}>{r.name}</Link></td>
                    <td className="text-sm">{r.departmentId ? (dept.get(r.departmentId) ?? "—") : "Company-wide"}</td>
                    <td className="text-sm">{r.meetingAt ? formatDate(r.meetingAt) : "—"}</td>
                    <td className="num">{r.entries.length}</td>
                    <td className="num">{r.entries.filter((e) => e.box).length}</td>
                    <td><Badge tone={TONE[r.status] ?? "neutral"} dot>{r.status.replace("_", " ").toLowerCase()}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <div style={{ height: 14 }} />
      <Reveal label="Rename the 9-box">
        <Panel title="9-box labels" subtitle="Box 9 is high performance and high potential; box 1 is low on both">
          <GrowthForm action={saveBoxLabelsAction} submitLabel="Save labels" cols={2} fields={byBox.flatMap((l) => [
            { name: `label${l.box}`, label: `Box ${l.box} name`, required: true, defaultValue: l.label },
            { name: `description${l.box}`, label: `Box ${l.box} guidance`, defaultValue: l.description },
          ])} />
        </Panel>
      </Reveal>
    </>
  );
}
