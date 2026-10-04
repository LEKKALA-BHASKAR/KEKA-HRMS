import Link from "next/link";
import { notFound, forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { ENGAGEMENT_DRIVERS, engageSettings, heatmap, heatBand, seededOrder, actionPlanState } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { surveyResults } from "@/lib/survey-results";
import { PageHead, Badge, Progress, Stat, Callout } from "@/components/ui";
import { Panel, SectionTitle, Donut, EmptyState } from "@/components/keka";
import { RespondForm, AddQuestionForm, RemoveQuestion, SurveyOp, EditQuestionForm } from "../forms";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Pill } from "@/components/gov-ui";
import { createActionPlanAction, updateActionPlanAction, saveTemplateFromSurveyAction, moderateSurveyCommentAction } from "@/app/actions/engage-surveys";
import { employeeOptions } from "@/lib/governance";
import { employeeNames, fmtDay } from "@/lib/engage-depth";

const HEAT_BG: Record<string, string> = { none: "transparent", low: "rgba(229,83,75,.18)", mid: "rgba(240,160,60,.18)", high: "rgba(63,157,90,.2)" };

const P = PERMISSIONS;
const TYPE_LABEL: Record<string, string> = { RATING: "Agreement 1–5", NPS: "Likelihood 0–10", SINGLE_CHOICE: "Single choice", MULTI_CHOICE: "Multiple choice", TEXT: "Free text" };
const KIND_LABEL: Record<string, string> = { PULSE: "Pulse survey", ENGAGEMENT: "Engagement survey", ENPS: "eNPS survey", POLL: "Poll" };
const RATING_COLOURS = ["#e5534b", "#f0a07a", "#c9ced6", "#7fc28a", "#3f9d5a"];

function npsTone(score: number) { return score >= 30 ? "pos" : score < 0 ? "neg" : undefined; }

export default async function SurveyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ by?: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const by = (await searchParams)?.by === "location" ? "location" : "department";
  const canManage = can(viewer, P.SURVEY_MANAGE);
  const canResults = canManage || can(viewer, P.SURVEY_RESULTS);

  // Exit surveys live on the exit pages, not here.
  const survey = await prisma.survey.findFirst({
    where: { id, tenantId: viewer.tenantId, kind: { not: "EXIT" } },
    include: { questions: { orderBy: { sequence: "asc" } } },
  });
  if (!survey) notFound();
  if (survey.status === "DRAFT" && !canManage) notFound();

  const me = viewer.employee
    ? await prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { id: true, departmentId: true } })
    : null;
  const addressed = !!me && (survey.departmentIds.length === 0 || survey.departmentIds.includes(me.departmentId ?? ""));
  const responded = me ? !!(await prisma.surveyParticipant.findUnique({ where: { surveyId_employeeId: { surveyId: survey.id, employeeId: me.id } } })) : false;
  const isPoll = survey.kind === "POLL";
  const mayRespond = addressed && !responded && survey.status === "ACTIVE";
  // Voters see a poll's results; survey results are for those who run them.
  const showResults = survey.status !== "DRAFT" && (canResults || (isPoll && (responded || survey.status === "CLOSED") && addressed));
  if (!mayRespond && !showResults && !(canManage && survey.status === "DRAFT")) forbidden();

  const results = showResults ? await surveyResults(viewer.tenantId, survey.id) : null;
  const settings = await engageSettings(viewer.tenantId);
  const canLaunch = !settings.surveyApproval || survey.approvalStatus === "APPROVED";

  // Heat map: favourable % by group × driver, each group held to the anonymity minimum.
  let heat: ReturnType<typeof heatmap> | null = null;
  if (results?.revealed && canResults && !isPoll) {
    const responses = await prisma.surveyResponse.findMany({ where: { surveyId: survey.id }, include: { answers: true } });
    const groupNames = new Map((by === "location"
      ? await prisma.location.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } })
      : await prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } })).map((g) => [g.id, g.name]));
    const driverOf = new Map(survey.questions.filter((q) => q.type === "RATING").map((q) => [q.id, q.driver]));
    heat = heatmap(responses.map((r) => ({
      group: groupNames.get((by === "location" ? r.locationId : r.departmentId) ?? "") ?? "Unassigned",
      answers: r.answers.filter((a) => driverOf.has(a.questionId)).map((a) => ({ driver: driverOf.get(a.questionId) ?? null, score: a.score })),
    })), survey.minGroupSize);
  }
  const plans = survey.status !== "DRAFT" ? await prisma.surveyActionPlan.findMany({ where: { tenantId: viewer.tenantId, surveyId: survey.id }, orderBy: { dueOn: "asc" } }) : [];
  const planOwners = await employeeNames(viewer.tenantId, plans.map((p) => p.ownerEmployeeId));
  const showPlans = survey.status !== "DRAFT" && (canResults || plans.some((p) => p.ownerEmployeeId === viewer.employee?.id));
  const owners = canManage && survey.status !== "DRAFT" ? await employeeOptions(viewer.tenantId) : [];
  const qLabel = new Map(survey.questions.map((q) => [q.id, `Q${q.sequence}`]));
  // Comment moderation (survey managers, once results are revealed).
  const textIds = survey.questions.filter((q) => q.type === "TEXT").map((q) => q.id);
  const moderation = canManage && results?.revealed && textIds.length
    ? await prisma.surveyAnswer.findMany({ where: { questionId: { in: textIds }, text: { not: null }, response: { surveyId: survey.id } }, select: { id: true, questionId: true, text: true, textHiddenAt: true, textHiddenReason: true }, orderBy: { text: "asc" } })
    : [];
  const respondOrder = survey.randomize && me ? seededOrder(survey.questions, `${me.id}:${survey.id}`) : survey.questions;
  return (
    <>
      <PageHead
        title={survey.title}
        subtitle={
          <span className="row gap-2 wrap">
            <Badge tone="brand">{KIND_LABEL[survey.kind]}</Badge>
            <Badge tone={survey.status === "ACTIVE" ? "success" : survey.status === "CLOSED" ? "info" : "neutral"} dot>{survey.status.toLowerCase()}</Badge>
            {survey.isAnonymous && !isPoll ? <Badge>Anonymous · results need {survey.minGroupSize}+ responses</Badge> : null}
            {survey.closesAt ? <span className="text-sm subtle">Closes {formatDate(survey.closesAt)}</span> : null}
            {survey.approvalStatus ? <Badge tone={survey.approvalStatus === "APPROVED" ? "success" : survey.approvalStatus === "REJECTED" ? "danger" : "warning"}>Approval: {survey.approvalStatus.toLowerCase()}</Badge> : null}
            {survey.archivedAt ? <Badge>Archived</Badge> : null}
          </span>
        }
        actions={
          <>
            <Link className="btn" href="/engage/surveys">Back</Link>
            {canManage && survey.status === "DRAFT" ? <SurveyOp surveyId={survey.id} op="delete" label="Delete draft" confirmText="Delete this draft?" /> : null}
            {canManage && survey.status === "DRAFT" && survey.approvalStatus !== "PENDING" && survey.approvalStatus !== "APPROVED" ? <SurveyOp surveyId={survey.id} op="submit" label="Submit for approval" variant={canLaunch ? "default" : "primary"} /> : null}
            {canManage && survey.status === "DRAFT" && canLaunch ? <SurveyOp surveyId={survey.id} op="launch" label="Launch" variant="primary" confirmText="Launch now? Questions cannot be changed afterwards." /> : null}
            {canManage && survey.status === "ACTIVE" ? <SurveyOp surveyId={survey.id} op="remind" label="Send reminder" /> : null}
            {canManage && survey.status === "ACTIVE" ? <SurveyOp surveyId={survey.id} op="close" label="Close survey" confirmText="Close the survey? No more responses will be accepted." /> : null}
            {canManage && survey.status === "CLOSED" ? <SurveyOp surveyId={survey.id} op={survey.archivedAt ? "unarchive" : "archive"} label={survey.archivedAt ? "Restore" : "Archive"} /> : null}
            {canResults && survey.status !== "DRAFT" ? <a className="btn" href={`/engage/export?report=survey-results&id=${survey.id}`}>Export results</a> : null}
          </>
        }
      />
      {survey.description ? <p className="muted" style={{ marginTop: -6, marginBottom: 16, maxWidth: 760 }}>{survey.description}</p> : null}

      {mayRespond ? (
        <div style={{ maxWidth: 820, marginBottom: 24 }}>
          <Panel title={isPoll ? "Cast your vote" : "Your response"}>
            <RespondForm
              surveyId={survey.id} anonymous={survey.isAnonymous} isPoll={isPoll}
              questions={respondOrder.map((q) => ({ id: q.id, prompt: q.prompt, type: q.type, options: q.options, required: q.required, showIfQuestionId: q.showIfQuestionId, showIfValues: q.showIfValues }))}
            />
          </Panel>
        </div>
      ) : null}

      {canManage && survey.status === "DRAFT" ? (
        <div className="stack gap-4">
          <Panel title={`Questions (${survey.questions.length})`} subtitle="Edit freely until launch; after that the questions are fixed so every response answers the same survey." pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th style={{ width: 40 }}>#</th><th>Question</th><th>Answer</th><th>Driver</th><th>Required</th><th /></tr></thead>
                <tbody>
                  {survey.questions.map((q) => (
                    <tr key={q.id}>
                      <td className="num subtle">{q.sequence}</td>
                      <td>{q.prompt}{q.options.length ? <div className="text-xs subtle">{q.options.join(" · ")}</div> : null}
                        {q.showIfQuestionId ? <div className="text-xs"><Badge tone="info">Only if {qLabel.get(q.showIfQuestionId) ?? "an earlier question"} = {q.showIfValues.map((v) => {
                          const parent = survey.questions.find((p) => p.id === q.showIfQuestionId);
                          return parent && (parent.type === "SINGLE_CHOICE" || parent.type === "MULTI_CHOICE") ? parent.options[v] ?? v : v;
                        }).join(" or ")}</Badge></div> : null}
                        <EditQuestionForm q={q} drivers={[...ENGAGEMENT_DRIVERS]} />
                      </td>
                      <td className="text-sm">{TYPE_LABEL[q.type]}</td>
                      <td className="text-sm">{q.driver ?? <span className="subtle">—</span>}</td>
                      <td className="text-sm">{q.required ? "Yes" : "No"}</td>
                      <td className="right"><RemoveQuestion questionId={q.id} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="Add a question"><AddQuestionForm surveyId={survey.id} drivers={[...ENGAGEMENT_DRIVERS]} earlier={survey.questions.filter((q) => q.type !== "TEXT").map((q) => ({ id: q.id, type: q.type, label: `Q${q.sequence}. ${q.prompt.slice(0, 60)}` }))} /></Panel>
        </div>
      ) : null}

      {results ? (
        <>
          {!isPoll ? (
            <div className="grid grid-4" style={{ marginBottom: 18 }}>
              <Stat label="Participation" value={`${results.participationPct}%`} meta={`${results.respondents} of ${results.invited} invited`} />
              <Stat label="Favourable" value={results.favourable === null ? "—" : `${results.favourable}%`} meta="Agree or strongly agree, across rating questions" />
              <Stat label="eNPS" value={results.headlineNps ? (results.headlineNps.score > 0 ? `+${results.headlineNps.score}` : results.headlineNps.score) : "—"}
                tone={results.headlineNps ? npsTone(results.headlineNps.score) : undefined}
                meta={results.headlineNps ? `${results.headlineNps.promoters} promoters · ${results.headlineNps.detractors} detractors` : "No eNPS question"} />
              <Stat label="Questions" value={survey.questions.length} meta={survey.status === "ACTIVE" ? "Live — results update as people respond" : `Closed ${formatDate(survey.closedAt)}`} />
            </div>
          ) : null}

          {!results.revealed ? (
            <Callout tone="warning" title="Not enough responses to show results yet">
              Results appear once {results.minGroupSize} people have responded, so no answer can be traced to a person.
              {" "}{results.respondents} so far.
            </Callout>
          ) : (
            <div className="stack gap-4">
              {results.drivers.length > 0 ? (
                <Panel title="Engagement drivers" subtitle="Share of favourable answers across the questions measuring each driver">
                  <div className="stack gap-2">
                    {results.drivers.map((d) => (
                      <div key={d.driver} className="row gap-3">
                        <div className="text-sm" style={{ width: 130 }}>{d.driver}</div>
                        <div style={{ flex: 1 }}><Progress value={d.favourable} max={100} tone={d.favourable >= 70 ? "success" : d.favourable < 50 ? "warning" : undefined} /></div>
                        <div className="num text-sm strong" style={{ width: 48, textAlign: "right" }}>{d.favourable}%</div>
                        <div className="num text-xs subtle" style={{ width: 70, textAlign: "right" }}>avg {d.mean.toFixed(1)}</div>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}

              <SectionTitle>{isPoll ? "Results" : "Question by question"}</SectionTitle>
              {results.perQuestion.map((q, i) => (
                <Panel key={q.id} title={`${isPoll ? "" : `${i + 1}. `}${q.prompt}`} subtitle={`${q.answered} answer${q.answered === 1 ? "" : "s"}${q.driver ? ` · ${q.driver}` : ""}`}>
                  {q.rating ? (
                    <div className="row gap-4 wrap" style={{ alignItems: "center" }}>
                      <Donut size={110} stroke={16} parts={q.rating.distribution.map((v, k) => ({ value: v, colour: RATING_COLOURS[k], label: `${k + 1}` }))}>
                        <div className="strong">{q.rating.favourable}%</div><div className="text-xs subtle">favourable</div>
                      </Donut>
                      <div className="stack gap-1" style={{ flex: 1, minWidth: 240 }}>
                        {["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"].map((l, k) => (
                          <div key={l} className="row gap-2 text-sm">
                            <span style={{ width: 10, height: 10, borderRadius: 2, background: RATING_COLOURS[k], display: "inline-block" }} />
                            <span style={{ width: 130 }}>{l}</span>
                            <span className="num subtle">{q.rating!.distribution[k]}</span>
                          </div>
                        ))}
                        <div className="text-xs subtle">Average {q.rating.mean.toFixed(1)} of 5</div>
                      </div>
                    </div>
                  ) : q.nps ? (
                    <div className="row gap-4 wrap" style={{ alignItems: "center" }}>
                      <Donut size={110} stroke={16} parts={[
                        { value: q.nps.detractors, colour: "#e5534b", label: "Detractors" },
                        { value: q.nps.passives, colour: "#c9ced6", label: "Passives" },
                        { value: q.nps.promoters, colour: "#3f9d5a", label: "Promoters" },
                      ]}>
                        <div className={`strong ${npsTone(q.nps.score) ?? ""}`}>{q.nps.score > 0 ? `+${q.nps.score}` : q.nps.score}</div><div className="text-xs subtle">eNPS</div>
                      </Donut>
                      <div className="text-sm stack gap-1">
                        <div><strong>{q.nps.promoters}</strong> promoters (9–10)</div>
                        <div><strong>{q.nps.passives}</strong> passives (7–8)</div>
                        <div><strong>{q.nps.detractors}</strong> detractors (0–6)</div>
                      </div>
                    </div>
                  ) : q.choices ? (
                    <div className="stack gap-2">
                      {q.choices.map((c) => (
                        <div key={c.label} className="row gap-3">
                          <div className="text-sm" style={{ width: 200 }}>{c.label}</div>
                          <div style={{ flex: 1 }}><Progress value={c.percent} max={100} /></div>
                          <div className="num text-sm" style={{ width: 90, textAlign: "right" }}>{c.count} · {c.percent}%</div>
                        </div>
                      ))}
                    </div>
                  ) : q.comments ? (
                    q.comments.length === 0 ? <div className="text-sm subtle">No comments.</div> : (
                      <ul className="stack gap-2" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                        {q.comments.map((c, k) => <li key={k} className="text-sm" style={{ borderLeft: "3px solid var(--border)", paddingLeft: 10 }}>{c}</li>)}
                      </ul>
                    )
                  ) : null}
                </Panel>
              ))}

              {moderation.length ? (
                <Panel title="Comment moderation" subtitle="Hide a comment that identifies someone or breaks the conduct policy; it is left out of results and exports.">
                  <div className="stack gap-2">
                    {moderation.map((m) => (
                      <div key={m.id} className="row gap-3 wrap" style={{ justifyContent: "space-between", borderLeft: "3px solid var(--border)", paddingLeft: 10, opacity: m.textHiddenAt ? 0.55 : 1 }}>
                        <div className="text-sm" style={{ flex: 1, minWidth: 200 }}><span className="text-xs subtle">{qLabel.get(m.questionId)} · </span>{m.text}{m.textHiddenAt ? <div className="text-xs"><Badge tone="danger">Hidden</Badge> {m.textHiddenReason}</div> : null}</div>
                        {m.textHiddenAt
                          ? <ActButton action={moderateSurveyCommentAction} hidden={{ answerId: m.id, op: "restore" }} label="Restore" variant="ghost" />
                          : <ActButton action={moderateSurveyCommentAction} hidden={{ answerId: m.id, op: "hide" }} label="Hide" variant="danger" input={{ name: "reason", placeholder: "Reason", required: true }} />}
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}

              {!isPoll && canResults ? (
                <Panel title="By department" subtitle={`Departments with fewer than ${results.minGroupSize} responses are not scored`} pad={false}>
                  {results.breakdown.length === 0 ? <EmptyState title="No responses yet" /> : (
                    <div className="table-wrap">
                      <table className="data">
                        <thead><tr><th>Department</th><th className="num">Responses</th><th className="num">Favourable</th><th className="num">eNPS</th></tr></thead>
                        <tbody>
                          {results.breakdown.map((b) => (
                            <tr key={b.department}>
                              <td>{b.department}</td>
                              <td className="num">{b.responses}{b.invited ? <span className="subtle"> / {b.invited}</span> : null}</td>
                              <td className="num">{b.favourable === null ? <span className="subtle" title="Too few responses to show">hidden</span> : `${b.favourable}%`}</td>
                              <td className="num">{b.enps === null ? <span className="subtle">—</span> : b.enps}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              ) : null}

              {heat ? (
                <Panel title="Engagement heat map" subtitle={`Favourable % by ${by} and driver. Groups under ${survey.minGroupSize} responses are withheld.`}
                  action={<span className="row gap-2"><a className={`btn sm${by === "department" ? " primary" : ""}`} href={`?by=department`}>By department</a><a className={`btn sm${by === "location" ? " primary" : ""}`} href={`?by=location`}>By location</a><a className="btn sm" href={`/engage/export?report=survey-heatmap&id=${survey.id}&by=${by}`}>CSV</a></span>} pad={false}>
                  {heat.rows.length === 0 || heat.drivers.length === 0 ? <EmptyState title="No rating answers with drivers yet" /> : (
                    <div className="table-wrap">
                      <table className="data" aria-label="Heat map">
                        <thead><tr><th>{by === "location" ? "Location" : "Department"}</th><th className="num">Responses</th><th className="num">Overall</th>{heat.drivers.map((d) => <th key={d} className="num">{d}</th>)}</tr></thead>
                        <tbody>
                          {heat.rows.map((r) => (
                            <tr key={r.group}>
                              <td>{r.group}</td><td className="num">{r.respondents}</td>
                              <td className="num" style={{ background: HEAT_BG[heatBand(r.overall)] }}>{r.hidden ? <span className="subtle">withheld</span> : r.overall === null ? "—" : `${r.overall}%`}</td>
                              {r.cells.map((c, i) => <td key={i} className="num" style={{ background: HEAT_BG[heatBand(c)] }}>{r.hidden ? <span className="subtle">—</span> : c === null ? "—" : `${c}%`}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              ) : null}
            </div>
          )}
        </>
      ) : null}

      {showPlans ? (
        <div className="stack gap-4" style={{ marginTop: 18 }}>
          <Panel title="Action plans" subtitle="What will change because of these results, who owns it and by when" pad={false}>
            {plans.length === 0 ? <EmptyState title="No action plans yet">Turn the weakest drivers into commitments.</EmptyState> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Action</th><th>Driver</th><th>Owner</th><th>Due</th><th>Status</th><th>Progress</th><th /></tr></thead>
                  <tbody>
                    {plans.map((p) => {
                      const st = actionPlanState(p.status, p.dueOn, new Date());
                      const mayUpdate = canManage || p.ownerEmployeeId === viewer.employee?.id;
                      return (
                        <tr key={p.id}>
                          <td className="strong">{p.title}{p.description ? <div className="text-xs subtle">{p.description}</div> : null}</td>
                          <td className="text-sm">{p.driver ?? "—"}</td>
                          <td className="text-sm">{planOwners.get(p.ownerEmployeeId) ?? "—"}</td>
                          <td className="text-sm nowrap">{fmtDay(p.dueOn)}</td>
                          <td><Pill s={st} /></td>
                          <td className="text-xs">{p.progressNote ?? ""}</td>
                          <td>{mayUpdate && st !== "DONE" && st !== "CANCELLED" ? (
                            <SpecForm action={updateActionPlanAction} hidden={{ id: p.id }} submitLabel="Update" columns={1} fields={[
                              { name: "status", label: "Status", type: "select", required: true, defaultValue: p.status, options: [{ value: "OPEN", label: "Open" }, { value: "IN_PROGRESS", label: "In progress" }, { value: "DONE", label: "Done" }, ...(canManage ? [{ value: "CANCELLED", label: "Cancelled" }] : [])] },
                              { name: "progressNote", label: "Progress note", defaultValue: p.progressNote },
                            ]} />
                          ) : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {canManage ? (
            <Panel title="New action plan">
              <SpecForm action={createActionPlanAction} hidden={{ surveyId: survey.id }} submitLabel="Create action plan" fields={[
                { name: "title", label: "Action", required: true, placeholder: "Monthly growth conversations in Engineering" },
                { name: "driver", label: "Driver", type: "select", options: ENGAGEMENT_DRIVERS.map((d) => ({ value: d, label: d })) },
                { name: "ownerEmployeeId", label: "Owner", type: "select", required: true, options: owners },
                { name: "dueOn", label: "Due", type: "date", required: true },
                { name: "description", label: "Details", type: "textarea", wide: true },
              ]} />
            </Panel>
          ) : null}
        </div>
      ) : null}

      {canManage && survey.kind !== "POLL" ? (
        <div style={{ marginTop: 18 }}>
          <Panel title="Save as a template" subtitle="Reuse these questions for a future survey or a recurring pulse">
            <SpecForm action={saveTemplateFromSurveyAction} hidden={{ surveyId: survey.id }} submitLabel="Save to library" fields={[
              { name: "name", label: "Template name", placeholder: survey.title },
              { name: "description", label: "Description" },
            ]} />
          </Panel>
        </div>
      ) : null}
    </>
  );
}
