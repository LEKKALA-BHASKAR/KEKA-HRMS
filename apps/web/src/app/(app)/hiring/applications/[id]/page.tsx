import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, KeyValue, Empty, Person } from "@/components/ui";
import { MoveStage, RejectApplication, InterviewForm, ScorecardForm, OfferForm, OfferOps, HireButton } from "../../forms";
import { Disclosure } from "../../../org/forms";

const P = PERMISSIONS;
const when = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const REC: Record<string, "success" | "danger" | "info" | "warning"> = { STRONG_YES: "success", YES: "info", NO: "warning", STRONG_NO: "danger" };

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const app = await prisma.application.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      candidate: { include: { referredBy: { select: { displayName: true } } } },
      job: { include: { flow: { include: { stages: { orderBy: { sequence: "asc" } } } } } },
      stageHistory: { include: { stage: true }, orderBy: { enteredAt: "desc" } },
      interviews: { include: { panel: { include: { employee: { select: { id: true, displayName: true } } } }, scorecards: true }, orderBy: { scheduledAt: "asc" } },
      offer: true,
    },
  });
  if (!app) notFound();
  const me = viewer.employee?.id;
  const recruiter = can(viewer, P.CANDIDATE_MANAGE);
  const panelist = app.interviews.some((i) => i.panel.some((p) => p.employeeId === me));
  if (!recruiter && !panelist) notFound();
  const employees = recruiter ? await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }) : [];
  const opt = employees.map((e) => ({ value: e.id, label: e.displayName ?? "" }));
  const c = app.candidate;
  const current = app.job.flow?.stages.find((s) => s.id === app.currentStageId);
  const nameById = new Map(app.interviews.flatMap((i) => i.panel.map((p) => [p.employeeId, p.employee.displayName])));

  return (
    <>
      <PageHead title={`${c.firstName} ${c.lastName}`} subtitle={`${app.job.title} · ${current?.name ?? "—"} · ${app.status.toLowerCase().replace(/_/g, " ")}`}
        actions={recruiter ? <Link className="btn" href={`/hiring/jobs/${app.jobId}`}>Pipeline</Link> : <Link className="btn" href="/hiring?tab=interviews">My interviews</Link>} />
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }}>
        <div className="stack gap-4">
          {recruiter && app.status === "ACTIVE" ? (
            <Card title="Move">
              <div className="row gap-3 wrap" style={{ justifyContent: "space-between", gap: 12 }}>
                <MoveStage applicationId={app.id} current={app.currentStageId} stages={(app.job.flow?.stages ?? []).map((s) => ({ value: s.id, label: s.name }))} />
                <RejectApplication applicationId={app.id} />
              </div>
            </Card>
          ) : null}

          <Card tight title="Interviews" action={recruiter && app.status === "ACTIVE" ? <span /> : null}>
            {app.interviews.length === 0 ? <Empty title="No interviews yet" /> : app.interviews.map((iv) => {
              const mineOpen = iv.panel.some((p) => p.employeeId === me) && !iv.scorecards.some((s) => s.panelistId === me) && iv.scheduledAt.getTime() <= Date.now() && iv.status !== "CANCELLED";
              // Interviewers see others' feedback only after giving their own, so it cannot anchor them.
              const canSeeAll = recruiter || iv.scorecards.some((s) => s.panelistId === me);
              return (
                <div key={iv.id} style={{ padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="strong text-sm">Round {iv.round}: {iv.title}</span>
                    <span className="text-xs subtle">{when(iv.scheduledAt)} · {iv.durationMinutes} min · {iv.mode.toLowerCase()}</span>
                  </div>
                  <div className="text-xs subtle" style={{ marginTop: 2 }}>Panel: {iv.panel.map((p) => `${p.employee.displayName}${p.isLead ? " (lead)" : ""}`).join(", ")}</div>
                  {canSeeAll ? iv.scorecards.map((s) => (
                    <div key={s.id} className="row gap-2" style={{ marginTop: 8, alignItems: "flex-start" }}>
                      <Badge tone={REC[s.recommendation ?? ""] ?? "neutral"}>{(s.recommendation ?? "").toLowerCase().replace("_", " ")} · {Number(s.overallScore)}</Badge>
                      <div className="text-sm"><span className="strong">{nameById.get(s.panelistId)}</span>{s.strengths ? <div className="muted">+ {s.strengths}</div> : null}{s.concerns ? <div className="muted">− {s.concerns}</div> : null}</div>
                    </div>
                  )) : <div className="text-xs subtle" style={{ marginTop: 6 }}>Other interviewers' feedback appears after you give yours.</div>}
                  {mineOpen ? <div style={{ marginTop: 10 }}><ScorecardForm interviewId={iv.id} /></div> : null}
                </div>
              );
            })}
            {recruiter && app.status === "ACTIVE" && can(viewer, P.INTERVIEW_MANAGE) ? <div style={{ padding: 18, borderTop: "1px solid var(--border)" }}><Disclosure label="Schedule an interview" variant="default"><InterviewForm applicationId={app.id} employees={opt} round={app.interviews.length + 1} /></Disclosure></div> : null}
          </Card>

          {recruiter ? (
            <Card title="Offer" action={app.offer ? <Badge tone={app.offer.status === "ACCEPTED" ? "success" : app.offer.status === "PENDING_APPROVAL" ? "warning" : "info"}>{app.offer.status.toLowerCase().replace(/_/g, " ")}</Badge> : null}>
              {app.offer && !["DECLINED", "WITHDRAWN", "EXPIRED"].includes(app.offer.status) ? (
                <div className="stack gap-3">
                  <KeyValue items={[
                    ["Annual CTC", formatINR(Number(app.offer.annualCtc))],
                    ["Joining", app.offer.proposedJoiningDate ? formatDate(app.offer.proposedJoiningDate) : "—"],
                    ["Expires", app.offer.expiresOn ? formatDate(app.offer.expiresOn) : "—"],
                    ...(app.offer.letterUrl ? [["Letter", <a key="l" href={app.offer.letterUrl}>Download PDF</a>] as [string, React.ReactNode]] : []),
                  ]} />
                  {can(viewer, P.OFFER_MANAGE) ? <OfferOps applicationId={app.id} status={app.offer.status} canApprove={can(viewer, P.OFFER_APPROVE)} /> : null}
                  {app.status === "OFFER_ACCEPTED" && can(viewer, P.EMPLOYEE_CREATE) ? <HireButton applicationId={app.id} suggestedEmail={`${c.firstName}.${c.lastName}`.toLowerCase().replace(/[^a-z.]/g, "") + "@" + viewer.user.email.split("@")[1]} /> : null}
                </div>
              ) : app.status === "ACTIVE" && can(viewer, P.OFFER_MANAGE) ? (
                <OfferForm applicationId={app.id} managers={opt} max={app.job.maxAnnualCtc ? Number(app.job.maxAnnualCtc) : null} />
              ) : <Empty title={app.status === "HIRED" ? "Hired" : "No offer"} />}
              {app.offer?.declineReason ? <div className="text-xs neg" style={{ marginTop: 6 }}>Declined: {app.offer.declineReason}</div> : null}
            </Card>
          ) : null}
        </div>

        <div className="stack gap-4">
          <Card title="Candidate">
            <Person name={`${c.firstName} ${c.lastName}`} meta={c.email} />
            <div className="divider" />
            <KeyValue items={[
              ["Current", `${c.currentTitle ?? "—"}${c.currentEmployer ? ` at ${c.currentEmployer}` : ""}`],
              ["Experience", c.totalExperienceYears ? `${Number(c.totalExperienceYears)} years` : "—"],
              ...(recruiter ? [["Current CTC", c.currentAnnualCtc ? formatINR(Number(c.currentAnnualCtc)) : "—"], ["Expects", c.expectedAnnualCtc ? formatINR(Number(c.expectedAnnualCtc)) : "—"]] as Array<[string, string]> : []),
              ["Notice", c.noticePeriodDays ? `${c.noticePeriodDays} days` : "—"],
              ["Source", `${c.source.toLowerCase().replace(/_/g, " ")}${c.referredBy ? ` — ${c.referredBy.displayName}` : ""}`],
              ["Average score", app.averageScore ? `${Number(app.averageScore).toFixed(1)} / 5` : "—"],
            ]} />
          </Card>
          {recruiter ? (
            <Card tight title="History">
              <div className="table-wrap"><table className="data"><tbody>
                {app.stageHistory.map((h) => <tr key={h.id}><td className="text-sm">{h.stage.name}</td><td className="text-xs subtle nowrap">{formatDate(h.enteredAt)}</td><td className="text-xs muted">{h.note ?? ""}</td></tr>)}
              </tbody></table></div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
