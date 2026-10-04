import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { hireStringList } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { addProspectAction, prospectStageAction, removeProspectAction, addProjectMemberAction } from "@/app/actions/hire-sourcing";
import { userOptions } from "@/lib/hire-depth";
import { SourcingTabs, day, pretty } from "../../../_parts/depth-tabs";

export const metadata = { title: "Sourcing project · Hire" };

const STAGES = ["IDENTIFIED", "CONTACTED", "RESPONDED", "INTERESTED", "NOT_INTERESTED", "APPLIED"];

/** One sourcing project: its prospects by stage, collaborators, and saved searches. */
export default async function SourcingProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.CANDIDATE_MANAGE);
  const { id } = await params;
  const p = await prisma.sourcingProject.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { prospects: { include: { candidate: { include: { sourcingProfile: { select: { engagementStatus: true, consentStatus: true } } } } }, orderBy: { addedAt: "desc" } }, searches: true } });
  if (!p) notFound();
  const users = await userOptions(viewer);
  const name = new Map(users.map((u) => [u.value, u.label]));
  const members = [p.ownerUserId, ...hireStringList(p.memberUserIds)].filter((x): x is string => !!x);
  return (
    <>
      <SourcingTabs />
      <PageHead title={p.name} subtitle={p.description ?? undefined} />
      <div className="row gap-2 wrap" style={{ marginBottom: 10 }}>
        {STAGES.map((s) => <Badge key={s} tone="info">{pretty(s)}: {p.prospects.filter((x) => x.stage === s).length}</Badge>)}
      </div>
      <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
        <Card title="Prospects" tight>
          {p.prospects.length === 0 ? <Empty title="No prospects yet" /> : (
            <table className="data" data-testid="prospect-table"><tbody>
              {p.prospects.map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/hiring/candidates/${e.candidateId}`}>{e.candidate.firstName} {e.candidate.lastName}</Link><div className="text-xs muted">{[e.candidate.currentTitle, e.candidate.currentEmployer].filter(Boolean).join(" at ")} · added {day(e.addedAt)}{e.note ? ` · ${e.note}` : ""}</div></td>
                  <td><Badge>{pretty(e.stage)}</Badge></td>
                  <td className="right">
                    <div className="row gap-1 wrap" style={{ justifyContent: "flex-end" }}>
                      {STAGES.filter((s) => s !== e.stage).slice(0, 3).map((s) => <ActButton key={s} action={prospectStageAction} hidden={{ id: e.id, stage: s }} label={pretty(s)} />)}
                      <ActButton action={removeProspectAction} hidden={{ id: e.id }} label="Remove" variant="ghost" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Card>
        <div className="stack gap-3">
          <Card title="Add a prospect">
            <GrowthForm action={addProspectAction} hidden={{ projectId: p.id }} cols={2} submitLabel="Add" fields={[
              { name: "firstName", label: "First name", required: true }, { name: "lastName", label: "Last name" },
              { name: "email", label: "Email", required: true }, { name: "currentTitle", label: "Title" }, { name: "currentEmployer", label: "Employer" },
              { name: "linkedinUrl", label: "Profile URL", type: "url" }, { name: "note", label: "Note", wide: true },
            ]} />
          </Card>
          <Card title="Team">
            <div className="text-sm">{members.map((m) => name.get(m) ?? m).join(", ")}</div>
            <Reveal label="Add a collaborator">
              <GrowthForm action={addProjectMemberAction} hidden={{ projectId: p.id }} cols={1} submitLabel="Add" fields={[{ name: "userId", label: "Colleague", type: "select", required: true, options: users }]} />
            </Reveal>
          </Card>
          {p.searches.length ? <Card title="Searches for this project">{p.searches.map((s) => <div key={s.id} className="text-sm"><Link href={`/hiring/candidates?q=${encodeURIComponent(s.query)}`}>{s.name}</Link> <code>{s.query}</code></div>)}</Card> : null}
        </div>
      </div>
    </>
  );
}
