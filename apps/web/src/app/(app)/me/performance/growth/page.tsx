import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { SubTabs } from "@/components/subtabs";
import { PageHead, Card, Badge, Empty, Progress } from "@/components/ui";
import { GrowthItemToggle } from "../../../performance/_parts/talent-forms";

/** Me › Performance › Growth plans: the development plans started for me, to tick off as I go. */
export default async function MyGrowthPage() {
  const viewer = await requireViewer();
  const me = viewer.employee?.id;
  const plans = me ? await prisma.growthPlan.findMany({ where: { tenantId: viewer.tenantId, employeeId: me }, include: { items: { orderBy: { displayOrder: "asc" } } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] }) : [];
  return (
    <>
      <SubTabs items={[
        { label: "Feedback", href: "/me/performance" }, { label: "Goals", href: "/me/performance?view=goals" }, { label: "Reviews", href: "/me/performance?view=reviews" },
        { label: "Feedback Requests", href: "/me/performance/requests" }, { label: "Growth Plans", href: "/me/performance/growth" },
      ]} />
      <PageHead title="My growth plans" subtitle="Skills, courses, milestones and mentoring your manager or HR set up with you" />
      {plans.length === 0 ? <Card><Empty title="No growth plans yet">When your manager starts one with you, it appears here.</Empty></Card> : (
        <div className="stack gap-4">
          {plans.map((p) => {
            const done = p.items.filter((i) => i.doneAt).length;
            return (
              <Card key={p.id} title={<>{p.title} <Badge tone={p.status === "COMPLETED" ? "success" : "info"}>{p.status.toLowerCase()}</Badge></>} description={`Started ${formatDate(p.startDate)} · ${done} of ${p.items.length} done`}>
                <Progress value={done} max={p.items.length || 1} />
                <div className="table-wrap" style={{ marginTop: 10 }}><table className="data"><tbody>
                  {p.items.map((i) => (
                    <tr key={i.id}>
                      <td className="text-sm" style={{ textDecoration: i.doneAt ? "line-through" : undefined }}>{i.title}</td>
                      <td><Badge>{i.kind.toLowerCase()}</Badge></td>
                      <td className={`text-sm ${i.dueDate && !i.doneAt && i.dueDate < new Date() ? "neg" : ""}`}>{i.dueDate ? `due ${formatDate(i.dueDate)}` : ""}</td>
                      <td className="right">{p.status === "ACTIVE" ? <GrowthItemToggle id={i.id} done={!!i.doneAt} /> : null}</td>
                    </tr>
                  ))}
                </tbody></table></div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
