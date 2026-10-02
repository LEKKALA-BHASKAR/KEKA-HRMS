import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { participation } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { surveyAudience } from "@/lib/engage";
import { PageHead, Badge, Progress } from "@/components/ui";
import { Panel, EmptyState, SectionTitle } from "@/components/keka";
import { CreateSurveyForm } from "./forms";

const P = PERMISSIONS;

const KIND_LABEL: Record<string, string> = { PULSE: "Pulse", ENGAGEMENT: "Engagement", ENPS: "eNPS", POLL: "Poll" };
const STATUS_TONE: Record<string, "neutral" | "success" | "info"> = { DRAFT: "neutral", ACTIVE: "success", CLOSED: "info" };

export default async function SurveysPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const canManage = can(viewer, P.SURVEY_MANAGE);
  const canResults = canManage || can(viewer, P.SURVEY_RESULTS);
  const me = viewer.employee
    ? await prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { id: true, departmentId: true } })
    : null;

  const [open, answered, all, departments] = await Promise.all([
    me
      ? prisma.survey.findMany({
          where: {
            tenantId: viewer.tenantId, status: "ACTIVE", kind: { not: "EXIT" },
            participants: { none: { employeeId: me.id } },
            OR: [{ departmentIds: { isEmpty: true } }, { departmentIds: { has: me.departmentId ?? "-" } }],
          },
          orderBy: { launchedAt: "desc" },
          include: { _count: { select: { questions: true } } },
        })
      : Promise.resolve([]),
    me
      ? prisma.surveyParticipant.findMany({
          where: { employeeId: me.id, survey: { tenantId: viewer.tenantId, kind: { not: "EXIT" } } },
          orderBy: { submittedAt: "desc" }, take: 12,
          include: { survey: { select: { id: true, title: true, kind: true, status: true } } },
        })
      : Promise.resolve([]),
    canResults
      ? prisma.survey.findMany({
          where: { tenantId: viewer.tenantId, kind: { not: "EXIT" }, ...(canManage ? {} : { status: { not: "DRAFT" } }) },
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
          include: { _count: { select: { participants: true, questions: true } } },
        })
      : Promise.resolve([]),
    canManage ? prisma.department.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);

  const invitedCounts = new Map<string, number>();
  for (const s of all) invitedCounts.set(s.id, (await surveyAudience(viewer.tenantId, s.departmentIds)).length);

  return (
    <>
      <PageHead
        title="Surveys & Polls"
        subtitle="Pulse checks, engagement surveys, eNPS and quick polls"
        actions={canManage ? <Link className="btn primary" href={sp.new ? "/engage/surveys" : "/engage/surveys?new=1"}>{sp.new ? "Cancel" : "+ New survey or poll"}</Link> : null}
      />

      {canManage && sp.new ? (
        <div style={{ marginBottom: 18 }}>
          <Panel title="Create a survey or poll" subtitle="Surveys start from a tested template you can edit before launch.">
            <CreateSurveyForm departments={departments.map((d) => ({ value: d.id, label: d.name }))} />
          </Panel>
        </div>
      ) : null}

      {me ? (
        <>
          <SectionTitle sub="Surveys and polls waiting for your response">Pending for you</SectionTitle>
          {open.length === 0 ? (
            <Panel><EmptyState title="You are all caught up">There are no surveys or polls waiting for you.</EmptyState></Panel>
          ) : (
            <div className="grid grid-3" style={{ marginBottom: 18 }}>
              {open.map((s) => (
                <div key={s.id} className="k-panel" style={{ padding: 16 }}>
                  <div className="row gap-2" style={{ marginBottom: 6 }}>
                    <Badge tone="brand">{KIND_LABEL[s.kind]}</Badge>
                    {s.isAnonymous && s.kind !== "POLL" ? <Badge>Anonymous</Badge> : null}
                  </div>
                  <div className="strong" style={{ marginBottom: 4 }}>{s.title}</div>
                  {s.description ? <div className="text-sm muted" style={{ marginBottom: 8 }}>{s.description}</div> : null}
                  <div className="text-xs subtle" style={{ marginBottom: 12 }}>
                    {s._count.questions} question{s._count.questions === 1 ? "" : "s"}{s.closesAt ? ` · closes ${formatDate(s.closesAt)}` : ""}
                  </div>
                  <Link className="btn primary sm" href={`/engage/surveys/${s.id}`}>{s.kind === "POLL" ? "Vote" : "Take survey"}</Link>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}

      {canResults ? (
        <>
          <SectionTitle sub={canManage ? "Everything your organisation has run" : "Launched surveys you can see results for"}>All surveys</SectionTitle>
          <Panel pad={false}>
            {all.length === 0 ? <EmptyState title="No surveys yet">Create a pulse survey to hear how people are doing.</EmptyState> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Survey</th><th>Type</th><th>Status</th><th>Launched</th><th>Closes</th><th style={{ minWidth: 160 }}>Participation</th></tr></thead>
                  <tbody>
                    {all.map((s) => {
                      const invited = Math.max(invitedCounts.get(s.id) ?? 0, s._count.participants);
                      const pct = participation(s._count.participants, invited);
                      return (
                        <tr key={s.id}>
                          <td><Link href={`/engage/surveys/${s.id}`} className="strong">{s.title}</Link><div className="text-xs subtle">{s._count.questions} questions{s.isAnonymous && s.kind !== "POLL" ? " · anonymous" : ""}</div></td>
                          <td className="text-sm">{KIND_LABEL[s.kind]}</td>
                          <td><Badge tone={STATUS_TONE[s.status]} dot>{s.status.toLowerCase()}</Badge></td>
                          <td className="text-sm nowrap">{s.launchedAt ? formatDate(s.launchedAt) : <span className="subtle">—</span>}</td>
                          <td className="text-sm nowrap">{s.closesAt ? formatDate(s.closesAt) : <span className="subtle">—</span>}</td>
                          <td>
                            {s.status === "DRAFT" ? <span className="text-xs subtle">{invited} to invite</span> : (
                              <>
                                <div className="row text-xs subtle" style={{ justifyContent: "space-between", marginBottom: 3 }}><span>{s._count.participants} / {invited}</span><span>{pct}%</span></div>
                                <Progress value={s._count.participants} max={Math.max(1, invited)} tone={pct >= 70 ? "success" : "warning"} />
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : null}

      {me && answered.length > 0 ? (
        <>
          <SectionTitle>Your past responses</SectionTitle>
          <Panel pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Survey</th><th>Type</th><th>Responded</th><th /></tr></thead>
                <tbody>
                  {answered.map((a) => (
                    <tr key={a.id}>
                      <td className="strong">{a.survey.title}</td>
                      <td className="text-sm">{KIND_LABEL[a.survey.kind]}</td>
                      <td className="text-sm">{formatDate(a.submittedAt)}</td>
                      <td className="right">{a.survey.kind === "POLL" ? <Link className="btn sm" href={`/engage/surveys/${a.survey.id}`}>See results</Link> : <Badge tone="success">Submitted</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      ) : null}
    </>
  );
}
