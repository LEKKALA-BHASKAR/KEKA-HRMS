import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { exitSurveyAggregate, EXIT_SURVEY_STATUSES } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Empty, Stat, Progress } from "@/components/ui";
import { SetupExitSurveyButton } from "../../_lifecycle/core-hr-forms";

const P = PERMISSIONS;

/**
 * Exit survey results across every exit the viewer manages: averages for
 * the rating questions, the eNPS of leavers, the spread of reasons, and the
 * comments, each linked back to its exit.
 */
export default async function ExitSurveyPage() {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.EXIT_MANAGE, P.EXIT_APPROVE])) forbidden();
  const perm = can(viewer, P.EXIT_MANAGE) ? P.EXIT_MANAGE : P.EXIT_APPROVE;

  const survey = await prisma.survey.findFirst({ where: { tenantId: viewer.tenantId, kind: "EXIT", status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  const exits = await prisma.exitRecord.findMany({
    where: { employee: { ...scopedEmployeeWhere(viewer, perm), NOT: viewer.employee ? { id: viewer.employee.id } : undefined }, status: { in: [...EXIT_SURVEY_STATUSES] } },
    select: { id: true, lastWorkingDay: true, employee: { select: { displayName: true, employeeNumber: true } } },
  });
  const agg = survey ? await exitSurveyAggregate(survey.id, exits.map((e) => e.id)) : null;
  const responses = survey
    ? await prisma.surveyResponse.findMany({ where: { surveyId: survey.id, exitRecordId: { in: exits.map((e) => e.id) } }, select: { exitRecordId: true, submittedAt: true }, orderBy: { submittedAt: "desc" } })
    : [];
  const exitOf = new Map(exits.map((e) => [e.id, e]));
  const nps = agg?.questions.find((q) => q.type === "NPS");
  const ratings = agg?.questions.filter((q) => q.type === "RATING") ?? [];

  return (
    <>
      <PageHead title="Exit survey" subtitle="What leavers tell us, across the exits you manage" actions={<Link className="btn" href="/exits">All exits</Link>} />
      {!survey ? (
        <Card>
          <Empty title="No exit survey yet">
            Set up the standard exit survey — the main reason for leaving, how people rated their manager, growth and pay, and whether they would recommend working here. Everyone leaving is then asked to complete it on their My exit page.
            {can(viewer, P.EXIT_MANAGE) ? <div style={{ marginTop: 12 }}><SetupExitSurveyButton /></div> : null}
          </Empty>
        </Card>
      ) : (
        <div className="stack gap-4">
          <div className="grid grid-3">
            <Stat label="Responses" value={String(agg!.responses)} meta={`of ${exits.length} exit(s) asked`} />
            <Stat label="Response rate" value={exits.length ? `${Math.round((agg!.responses / exits.length) * 100)}%` : "—"} meta="of resignations accepted or in progress" />
            <Stat label="Leaver eNPS" value={nps && nps.type === "NPS" && nps.nps !== null ? String(nps.nps) : "—"} meta="promoters minus detractors" />
          </div>
          {agg!.responses === 0 ? <Card><Empty title="No responses yet">Answers appear here as people leaving complete the survey.</Empty></Card> : (
            <>
              {ratings.length ? (
                <Card title="Ratings" description="Average agreement, 1 (strongly disagree) to 5 (strongly agree).">
                  <div className="stack gap-3">
                    {ratings.map((q) => q.type === "RATING" ? (
                      <div key={q.id}>
                        <div className="row" style={{ justifyContent: "space-between" }}><span className="text-sm">{q.prompt}</span><span className="strong">{q.average ?? "—"}</span></div>
                        <Progress value={q.average ? (q.average / 5) * 100 : 0} />
                      </div>
                    ) : null)}
                  </div>
                </Card>
              ) : null}
              {agg!.questions.map((q) => (q.type === "SINGLE_CHOICE" || q.type === "MULTI_CHOICE") ? (
                <Card key={q.id} title={q.prompt} description={`${q.responses} answer(s)`}>
                  <div className="stack gap-2">
                    {[...q.counts].sort((a, b) => b.count - a.count).map((c) => (
                      <div key={c.option}>
                        <div className="row" style={{ justifyContent: "space-between" }}><span className="text-sm">{c.option}</span><span className="text-sm strong">{c.count}</span></div>
                        <Progress value={q.responses ? (c.count / q.responses) * 100 : 0} />
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null)}
              {agg!.questions.map((q) => q.type === "TEXT" && q.texts.length ? (
                <Card key={q.id} title={q.prompt} description={`${q.texts.length} comment(s)`}>
                  <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
                    {q.texts.map((t, i) => <li key={i} style={{ marginBottom: 6 }}>“{t}”</li>)}
                  </ul>
                </Card>
              ) : null)}
              <Card tight title="Who has answered">
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Employee</th><th>Last working day</th><th>Answered</th></tr></thead>
                    <tbody>
                      {responses.map((r) => {
                        const e = r.exitRecordId ? exitOf.get(r.exitRecordId) : undefined;
                        return e ? (
                          <tr key={e.id}>
                            <td><Link href={`/exits/${e.id}`}>{e.employee.displayName}</Link> <span className="text-xs subtle">{e.employee.employeeNumber}</span></td>
                            <td className="text-sm">{formatDate(e.lastWorkingDay)}</td>
                            <td className="text-sm">{formatDate(r.submittedAt)}</td>
                          </tr>
                        ) : null;
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      )}
    </>
  );
}
