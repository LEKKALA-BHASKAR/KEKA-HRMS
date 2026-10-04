import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { parsePanelRules, parseSkillWeights, pendingHireRequest, hireDepthConfig, LOCALE_NAMES } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Callout } from "@/components/ui";
import { GrowthForm, ActButton } from "@/components/growth-forms";
import { saveInterviewPlanAction, submitInterviewPlanAction } from "@/app/actions/hire-interviews";
import { requestJobPostingAction, unpublishJobAction, saveJobPostingMetaAction } from "@/app/actions/hire-ops";
import { pretty, when } from "../../../_parts/depth-tabs";

export const metadata = { title: "Interview plan & posting · Hire" };

type Round = { name: string; minutes: number; focus: string };

/**
 * A job's interview plan (rounds, panel rules, skill weights — signed off by
 * the hiring manager) and its careers posting (approval, SEO, translations).
 */
export default async function JobPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.JOB_MANAGE);
  const { id } = await params;
  const job = await prisma.job.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!job) notFound();
  const [plan, meta, cfg, postingPending, guides] = await Promise.all([
    prisma.interviewPlan.findUnique({ where: { jobId: job.id } }),
    prisma.jobPostingMeta.findUnique({ where: { jobId: job.id } }),
    hireDepthConfig(viewer.tenantId),
    pendingHireRequest(viewer.tenantId, "JOB_POSTING", job.id),
    prisma.interviewGuide.findMany({ where: { tenantId: viewer.tenantId, isActive: true } }),
  ]);
  const rules = parsePanelRules(plan?.panelRules ?? null);
  const weights = parseSkillWeights(plan?.skillWeights ?? null);
  const rounds = (Array.isArray(plan?.rounds) ? plan!.rounds : []) as Round[];
  const translations = (meta?.translations ?? {}) as Record<string, { title: string; description: string }>;
  const matchingGuides = guides.filter((g) => (!g.roleKeyword || job.title.toLowerCase().includes(g.roleKeyword.toLowerCase())) && (!g.departmentId || g.departmentId === job.departmentId));
  return (
    <>
      <PageHead title={`${job.title}: plan & posting`} subtitle={<Link href={`/hiring/jobs/${job.id}`}>‹ Back to the job</Link>} />
      <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
        <Card title={<>Interview plan {plan ? <Badge tone={plan.status === "APPROVED" ? "success" : plan.status === "PENDING_APPROVAL" ? "warning" : "neutral"}>{pretty(plan.status)}</Badge> : null}</>}
          description={plan?.approvedAt ? `Signed off ${when(plan.approvedAt)}.` : "The hiring manager signs the plan off before interviews start."}
          action={plan && ["DRAFT", "REJECTED"].includes(plan.status) ? <ActButton action={submitInterviewPlanAction} hidden={{ jobId: job.id }} label="Send for sign-off" variant="primary" /> : null}>
          {rounds.length ? <ol className="text-sm" data-testid="plan-rounds">{rounds.map((r, i) => <li key={i}>{r.name} — {r.minutes} min{r.focus ? ` · ${r.focus}` : ""}</li>)}</ol> : null}
          {plan?.status === "PENDING_APPROVAL" ? <Callout tone="warning">Waiting for sign-off; the plan cannot change until decided.</Callout> : (
            <GrowthForm action={saveInterviewPlanAction} hidden={{ jobId: job.id }} cols={2} submitLabel="Save plan" fields={[
              { name: "rounds", label: "Rounds, one per line: name | minutes | focus", type: "textarea", rows: 5, required: true, defaultValue: rounds.map((r) => `${r.name} | ${r.minutes} | ${r.focus}`).join("\n"), placeholder: "Screening | 30 | motivation\nTechnical | 60 | system design" },
              { name: "skillWeights", label: "Skill weights, one per line (Skill: weight)", type: "textarea", rows: 5, defaultValue: Object.entries(weights).map(([k, v]) => `${k}: ${v}`).join("\n"), placeholder: "Problem solving: 3\nCommunication: 1" },
              { name: "minPanel", label: "Minimum panel size", type: "number", defaultValue: rules.minPanel ?? null },
              { name: "maxPanel", label: "Maximum panel size", type: "number", defaultValue: rules.maxPanel ?? null },
              { name: "requireHiringManager", label: "The hiring manager sits on a panel", type: "checkbox", defaultChecked: rules.requireHiringManager ?? false },
              { name: "requireOtherDepartment", label: "Someone from another department on each panel", type: "checkbox", defaultChecked: rules.requireOtherDepartment ?? false },
            ]} />
          )}
          {matchingGuides.length ? <div className="text-sm" style={{ marginTop: 8 }}>Interview guides for this role: {matchingGuides.map((g) => g.title).join(", ")}</div> : null}
        </Card>
        <div className="stack gap-3">
          <Card title="Careers posting" description={cfg.requirePostingApproval ? "Postings need approval before they go live." : "Posting is immediate."}>
            <div className="row gap-2 wrap">
              {job.isPublished ? <><Badge tone="success">Live</Badge><a className="btn sm" href={`/careers/${job.id}`} target="_blank" rel="noreferrer">View</a><ActButton action={unpublishJobAction} hidden={{ jobId: job.id }} label="Take down" confirmText="Take this job off the careers site?" /></>
                : postingPending ? <Badge tone="warning">Awaiting posting approval</Badge>
                : job.status === "OPEN" ? <ActButton action={requestJobPostingAction} hidden={{ jobId: job.id }} label={cfg.requirePostingApproval ? "Request posting" : "Post on careers site"} variant="primary" /> : <span className="text-sm subtle">Open the job to post it.</span>}
            </div>
          </Card>
          <Card title="Search engines and translations">
            <GrowthForm action={saveJobPostingMetaAction} hidden={{ jobId: job.id }} cols={2} fields={[
              { name: "seoTitle", label: "Search title (≤ 70)", defaultValue: meta?.seoTitle },
              { name: "seoDescription", label: "Search description (≤ 170)", defaultValue: meta?.seoDescription },
              { name: "locale", label: "Add or update a translation", type: "select", options: Object.entries(LOCALE_NAMES).filter(([k]) => k !== "en").map(([k, v]) => ({ value: k, label: v })) },
              { name: "tTitle", label: "Translated title (blank removes it)" },
              { name: "tDescription", label: "Translated description", type: "textarea", rows: 5 },
            ]} />
            {Object.keys(translations).length ? <div className="text-sm" data-testid="translations">Translations: {Object.keys(translations).map((l) => <Link key={l} href={`/careers/${job.id}?lang=${l}`} target="_blank"> {LOCALE_NAMES[l] ?? l}</Link>)}</div> : null}
          </Card>
        </div>
      </div>
    </>
  );
}
