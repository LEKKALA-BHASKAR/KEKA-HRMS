import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { directoryWhere } from "@/lib/directory";
import { feedbackRules } from "@/lib/talent";
import { SubTabs } from "@/components/subtabs";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { RequestFeedbackForm, AnswerRequestForm } from "../../../performance/_parts/talent-forms";

const TONE: Record<string, "warning" | "success" | "neutral"> = { PENDING: "warning", GIVEN: "success", DECLINED: "neutral" };

/**
 * Me › Performance › Feedback requests: ask colleagues for feedback (about
 * yourself, or as a manager about a report), and answer what you were asked.
 */
export default async function FeedbackRequestsPage() {
  const viewer = await requireViewer();
  const me = viewer.employee?.id;
  const tabs = <SubTabs items={[
    { label: "Feedback", href: "/me/performance" }, { label: "Goals", href: "/me/performance?view=goals" }, { label: "Reviews", href: "/me/performance?view=reviews" },
    { label: "Feedback Requests", href: "/me/performance/requests" }, { label: "Growth Plans", href: "/me/performance/growth" },
  ]} />;
  if (!me) return <>{tabs}<Card><Empty title="No employee record" /></Card></>;
  const rules = await feedbackRules(viewer.tenantId);
  const [toAnswer, asked, colleagues, reports] = await Promise.all([
    prisma.feedbackRequest.findMany({ where: { tenantId: viewer.tenantId, askedId: me }, include: { requester: { select: { displayName: true } } }, orderBy: [{ status: "desc" }, { createdAt: "desc" }], take: 100 }),
    prisma.feedbackRequest.findMany({ where: { tenantId: viewer.tenantId, requesterId: me }, include: { asked: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.employee.findMany({ where: { ...directoryWhere(viewer.tenantId), NOT: { id: me } }, select: { id: true, displayName: true, jobTitleName: true }, orderBy: { displayName: "asc" } }),
    viewer.allReportIds.size ? prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: [...viewer.allReportIds] }, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }) : [],
  ]);
  const aboutIds = [...new Set([...toAnswer, ...asked].map((r) => r.aboutEmployeeId))];
  const names = new Map((await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: aboutIds } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  const pending = toAnswer.filter((r) => r.status === "PENDING");

  return (
    <>
      {tabs}
      <PageHead title="Feedback requests" subtitle="Ask for feedback when you want it, and answer when colleagues ask you" />
      <div className="stack gap-4">
        <Card title={`Waiting on you (${pending.length})`}>
          {pending.length === 0 ? <Empty title="No one is waiting on your feedback" /> : (
            <div className="stack gap-4">
              {pending.map((r) => (
                <div key={r.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                  <div className="text-sm"><strong>{r.requester.displayName}</strong> asked for your feedback{r.aboutEmployeeId !== r.requesterId ? <> about <strong>{names.get(r.aboutEmployeeId)}</strong></> : null}{r.dueDate ? <span className="subtle"> · by {formatDate(r.dueDate)}</span> : null}</div>
                  {r.message ? <div className="text-sm muted" style={{ margin: "4px 0 8px" }}>“{r.message}”</div> : null}
                  <AnswerRequestForm id={r.id} allowAnonymous={rules.allowAnonymous} />
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Ask for feedback">
          {rules.allowRequests
            ? <RequestFeedbackForm colleagues={colleagues.map((c) => ({ value: c.id, label: `${c.displayName}${c.jobTitleName ? ` · ${c.jobTitleName}` : ""}` }))} reports={reports.map((r) => ({ value: r.id, label: r.displayName ?? "" }))} />
            : <Callout tone="info">Your company has turned feedback requests off.</Callout>}
        </Card>
        <Card tight title="Requests you sent">
          {asked.length === 0 ? <Empty title="You have not asked anyone yet" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Asked</th><th>About</th><th>Sent</th><th>Status</th></tr></thead>
              <tbody>{asked.map((r) => <tr key={r.id}><td className="text-sm">{r.asked.displayName}</td><td className="text-sm">{r.aboutEmployeeId === me ? "Me" : names.get(r.aboutEmployeeId)}</td><td className="text-sm">{formatDate(r.createdAt)}</td><td><Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge></td></tr>)}</tbody>
            </table></div>
          )}
        </Card>
        {toAnswer.length > pending.length ? (
          <Card tight title="Requests you answered">
            <div className="table-wrap"><table className="data"><tbody>
              {toAnswer.filter((r) => r.status !== "PENDING").map((r) => <tr key={r.id}><td className="text-sm">{r.requester.displayName}</td><td className="text-sm">{r.respondedAt ? formatDate(r.respondedAt) : ""}</td><td><Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge></td></tr>)}
            </tbody></table></div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
