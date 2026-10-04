import "server-only";
import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { asStringList, hireChain } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { profileScoreFor } from "@/lib/talent-hire";
import { AddToPoolForm, CandidateProfileForm, OfferSlotsForm, CancelSlotOffer, ResumeUploadForm, type CustomFieldView } from "./talent-forms";
import s from "../hire.module.css";

const P = PERMISSIONS;
const utc = (d: Date | string) => `${new Date(d).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * The talent side of a candidate's profile tab: the résumé with an in-page
 * preview, the configurable profile score, education, skills and candidate
 * custom fields, talent pools, self-scheduling links and the offer's
 * approval chain.
 */
export async function TalentPanel({ viewer, applicationId }: { viewer: Viewer; applicationId: string }) {
  const tenantId = viewer.tenantId;
  const app = await prisma.application.findFirst({
    where: { id: applicationId, tenantId },
    include: {
      candidate: { include: { talentPools: { include: { pool: { select: { id: true, name: true } } } } } },
      job: { select: { id: true, title: true, skills: true, minExperienceYears: true } },
      slotOffers: { orderBy: { createdAt: "desc" }, take: 3 },
      internal: { include: { employee: { select: { id: true, displayName: true, jobTitleName: true } } } },
    },
  });
  if (!app) return null;
  const c = app.candidate;
  const [score, defs, values, pools, employees, chain] = await Promise.all([
    profileScoreFor(tenantId, c, app.job),
    prisma.customFieldDefinition.findMany({ where: { tenantId, entity: "CANDIDATE", isActive: true }, orderBy: { displayOrder: "asc" } }),
    prisma.customFieldValue.findMany({ where: { ownerId: c.id, definition: { tenantId, entity: "CANDIDATE" } } }),
    prisma.talentPool.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    can(viewer, P.INTERVIEW_MANAGE) ? prisma.employee.findMany({ where: { tenantId, status: { in: ["CONFIRMED", "PROBATION", "NOTICE_PERIOD"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 500 }) : Promise.resolve([]),
    hireChain(tenantId, "OFFER", app.id),
  ]);
  const valueOf = new Map(values.map((v) => [v.definitionId, v.value]));
  const fields: CustomFieldView[] = defs.map((d) => ({ id: d.id, label: d.label, type: d.type, options: (d.options as string[] | null) ?? null, isMandatory: d.isMandatory, value: valueOf.get(d.id) ?? null }));
  const approvers = chain.steps.length ? await prisma.user.findMany({ where: { tenantId, id: { in: chain.steps.map((x) => x.approverUserId) } }, select: { id: true, email: true, employee: { select: { displayName: true } } } }) : [];
  const nameOf = new Map(approvers.map((u) => [u.id, u.employee?.displayName ?? u.email]));
  const resumeId = c.resumeUrl?.startsWith("/files/") ? c.resumeUrl.slice("/files/".length) : null;
  const inPools = new Set(c.talentPools.map((m) => m.poolId));
  const openSlot = app.slotOffers.find((o) => o.status === "OPEN");

  return (
    <>
      {app.internal ? (
        <div className={s.box} style={{ padding: 20 }}>
          <div className={s.fbTitle} style={{ marginBottom: 8 }}>Internal applicant</div>
          <div className="text-sm"><Link href={`/employees/${app.internal.employee.id}`}>{app.internal.employee.displayName}</Link>{app.internal.employee.jobTitleName ? ` · ${app.internal.employee.jobTitleName}` : ""}</div>
          {app.internal.note ? <p className="text-sm muted" style={{ marginBottom: 0 }}>{app.internal.note}</p> : null}
        </div>
      ) : null}

      <div className={s.box} style={{ padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span className={s.fbTitle}>Profile score</span>
          <span className="strong" style={{ fontSize: 22 }} data-testid="profile-score">{score.score}<span className="text-sm muted"> / 100</span></span>
        </div>
        <div className="text-sm muted">Skills {score.skills}% · Experience {score.experience}% · Education {score.education}%{score.matched.length ? ` · matched ${score.matched.join(", ")}` : ""}</div>
        {can(viewer, P.JOB_MANAGE) ? <div className="text-xs" style={{ marginTop: 6 }}><Link href="/hiring/settings/talent">Change how the score is weighted</Link></div> : null}
      </div>

      <div className={s.box} style={{ padding: 20 }}>
        <div className={s.fbTitle} style={{ marginBottom: 10 }}>Résumé</div>
        {resumeId ? (
          <div className="stack gap-2" style={{ marginBottom: 12 }}>
            <iframe title={`Résumé of ${c.firstName} ${c.lastName}`} src={`/files/${resumeId}?inline=1`} style={{ width: "100%", height: 520, border: "1px solid var(--border)", borderRadius: 8 }} />
            <a className="text-sm" href={`/files/${resumeId}`}>Download</a>
          </div>
        ) : c.resumeUrl ? <p className="text-sm"><a href={c.resumeUrl} rel="noreferrer noopener" target="_blank">Open the résumé link</a></p> : <p className="muted text-sm">No résumé yet.</p>}
        <ResumeUploadForm candidateId={c.id} applicationId={app.id} has={!!c.resumeUrl} />
      </div>

      <div className={s.box} style={{ padding: 20 }}>
        <div className={s.fbTitle} style={{ marginBottom: 10 }}>Education, skills and more</div>
        <CandidateProfileForm candidateId={c.id} applicationId={app.id} education={c.education ?? ""} skills={asStringList(c.skills).join(", ")} experience={c.totalExperienceYears === null ? "" : String(Number(c.totalExperienceYears))} fields={fields} />
      </div>

      <div className={s.box} style={{ padding: 20 }}>
        <div className={s.fbTitle} style={{ marginBottom: 10 }}>Talent pools</div>
        {c.talentPools.length ? <div className="row gap-1 wrap" style={{ marginBottom: 10 }}>{c.talentPools.map((m) => <Link key={m.id} className="badge" href={`/hiring/pools/${m.pool.id}`}>{m.pool.name}</Link>)}</div> : null}
        {pools.filter((p) => !inPools.has(p.id)).length
          ? <AddToPoolForm candidateId={c.id} pools={pools.filter((p) => !inPools.has(p.id)).map((p) => ({ value: p.id, label: p.name }))} />
          : <p className="muted text-sm">{pools.length ? "In every pool." : <>No pools yet — <Link href="/hiring/pools">create one</Link>.</>}</p>}
      </div>

      {can(viewer, P.INTERVIEW_MANAGE) && app.status === "ACTIVE" ? (
        <div className={s.box} style={{ padding: 20 }}>
          <div className={s.fbTitle} style={{ marginBottom: 10 }}>Let the candidate pick a time</div>
          {app.slotOffers.length ? (
            <div className="stack gap-1" style={{ marginBottom: 12 }}>
              {app.slotOffers.map((o) => (
                <div key={o.id} className="row gap-2 text-sm" style={{ justifyContent: "space-between" }}>
                  <span>{o.title} · {o.status === "BOOKED" && o.chosenSlot ? `booked for ${utc(o.chosenSlot)}` : o.status.toLowerCase()} · sent {utc(o.createdAt)}</span>
                  {o.status === "OPEN" ? <CancelSlotOffer id={o.id} applicationId={app.id} /> : null}
                </div>
              ))}
            </div>
          ) : null}
          {openSlot ? <p className="text-xs muted">Sending new slots cancels the open link.</p> : null}
          <OfferSlotsForm applicationId={app.id} employees={employees.map((e) => ({ value: e.id, label: e.displayName ?? e.id }))} />
        </div>
      ) : null}

      {chain.steps.length ? (
        <div className={s.box} style={{ padding: 20 }}>
          <div className={s.fbTitle} style={{ marginBottom: 10 }}>Offer approval chain</div>
          <ol className="stack gap-1 text-sm" style={{ margin: 0, paddingLeft: 18 }}>
            {chain.steps.map((x) => <li key={x.id}>{nameOf.get(x.approverUserId) ?? "Approver"} — <span className={x.status === "APPROVED" ? "pos" : x.status === "REJECTED" ? "neg" : "muted"}>{x.status.toLowerCase()}</span>{x.comment ? ` · ${x.comment}` : ""}</li>)}
          </ol>
        </div>
      ) : null}
    </>
  );
}
