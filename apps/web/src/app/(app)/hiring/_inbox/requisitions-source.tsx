import "server-only";
import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requisitionsToDecideWhere, jobTypeLabel } from "@keka/services";
import { canAny, type Viewer } from "@/lib/context";
import { IconBriefcase } from "@/components/icons";
import { DetailPane, Facts, Message, PersonStrip, type ListItem } from "../../inbox/_ui/panes";
import { resolvePeople, who } from "../../inbox/_ui/people";
import { approverActor, salaryRange, kDate } from "../_lib/data";
import { DecideButtons } from "../_parts/decide";

const P = PERMISSIONS;

/**
 * Inbox › Take Action › Requisitions: the requisitions waiting on this
 * viewer — the same `where` as the Pending Approvals tab and the nav badge,
 * so the three never disagree. Their own requisitions never appear.
 */
export async function requisitionsTakeSource(viewer: Viewer): Promise<{
  key: string; label: string; icon: React.ReactNode; always: boolean;
  count: () => Promise<number>; list: () => Promise<ListItem[]>; detail: (id: string) => Promise<React.ReactNode | null>;
} | null> {
  const holds = canAny(viewer, [P.REQUISITION_APPROVE]);
  const actor = await approverActor(viewer);
  const where = requisitionsToDecideWhere(viewer.tenantId, actor);
  // Shown for approvers; for anyone else only while something is pending on them.
  if (!holds && (await prisma.requisition.count({ where })) === 0) return null;
  const tenantId = viewer.tenantId;
  return {
    key: "requisitions", label: "Requisitions", icon: <IconBriefcase />, always: holds,
    count: () => prisma.requisition.count({ where }),
    list: async () => {
      const rows = await prisma.requisition.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
      const people = await resolvePeople(tenantId, rows.map((r) => r.raisedBy));
      return rows.map((r) => ({
        id: r.id, person: r.raisedBy ? who(people, r.raisedBy) : null, title: `${r.code ?? "Requisition"} · ${r.title} × ${r.positions}`, at: r.createdAt,
        tag: r.isPriority ? "Priority" : undefined, tagTone: r.isPriority ? "danger" as const : undefined,
      }));
    },
    detail: async (id) => {
      const r = await prisma.requisition.findFirst({ where: { AND: [where, { id }] }, include: { backfills: { include: { employee: { select: { displayName: true } } } } } });
      if (!r) return null;
      const [people, dept, loc] = await Promise.all([
        resolvePeople(tenantId, [r.raisedBy]),
        r.departmentId ? prisma.department.findFirst({ where: { tenantId, id: r.departmentId }, select: { name: true } }) : null,
        r.locationId ? prisma.location.findFirst({ where: { tenantId, id: r.locationId }, select: { name: true } }) : null,
      ]);
      const raiser = r.raisedBy ? who(people, r.raisedBy) : null;
      return (
        <DetailPane title={`${r.title} · ${r.code ?? ""}`} sub={`Raised on ${kDate(r.createdAt)}`} status={{ label: "Pending", tone: "pending" }}
          actions={(
            <div className="stack gap-2" style={{ width: "100%" }}>
              <div className="row gap-2"><DecideButtons id={r.id} closeHref="/inbox?cat=requisitions" /></div>
              <Link className="btn sm ghost" href={`/hiring/requisitions?view=pending&req=${r.id}`} style={{ alignSelf: "flex-start" }}>Open the requisition</Link>
            </div>
          )}
          activity={[{ who: raiser, text: "Created Requisition", at: r.createdAt }]}>
          {raiser ? <PersonStrip person={raiser} meta="Requested by" /> : null}
          <Facts items={[
            ["Department", dept?.name ?? "—"],
            ["Location", loc?.name ?? "—"],
            ["Positions", String(r.positions)],
            ["Salary range", salaryRange(r)],
            ["Job type", jobTypeLabel(r.jobType)],
            ["Priority", r.isPriority ? "Yes" : "No"],
            ["Target hiring date", r.targetStartDate ? kDate(r.targetStartDate) : "—"],
            r.backfills.length ? ["Backfill for", r.backfills.map((b) => b.employee.displayName).join(", ")] : null,
          ]} />
          {r.justification ? <Message label="Additional comments">{r.justification}</Message> : null}
        </DetailPane>
      );
    },
  };
}
