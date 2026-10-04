import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { ONBOARDING_PHASES, onboardingPhase, templateRevisionDiff, type TemplateSnapshot } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { Table } from "@/components/gov-ui";
import { ActButton, SpecForm } from "@/components/gov-forms";
import { fmtTime, pretty } from "@/lib/engage-depth";
import { OnboardingNav } from "../../_join/nav";
import { designerTaskAction, restoreTemplateRevisionAction } from "@/app/actions/join-onboarding";

const P = PERMISSIONS;

/** The journey designer: a template's tasks laid out by phase (before joining → day 90+), with reordering, phase moves, sign-off flags and the revision history. */
export default async function JourneyDesignerPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const { id } = await params;
  const t = await prisma.journeyTemplate.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { tasks: { orderBy: [{ offsetDays: "asc" }, { sortOrder: "asc" }] } } });
  if (!t) notFound();
  const revisions = await prisma.journeyTemplateRevision.findMany({ where: { tenantId: viewer.tenantId, templateId: t.id }, orderBy: { version: "desc" }, take: 30 });
  const authors = new Map((await prisma.user.findMany({ where: { tenantId: viewer.tenantId, id: { in: revisions.map((r) => r.changedBy).filter((x): x is string => !!x) } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]));
  const phases = Object.entries(ONBOARDING_PHASES) as Array<[keyof typeof ONBOARDING_PHASES, string]>;
  return (
    <>
      <PageHead title={`Designer: ${t.name}`} subtitle={`${pretty(t.trigger)} · version ${t.version}${t.jobTitle ? ` · role ${t.jobTitle}` : ""}`} actions={<Link className="btn" href={`/onboarding?tab=templates&template=${t.id}`}>Edit tasks</Link>} />
      <OnboardingNav viewer={viewer} active="journeys" />
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 360px", alignItems: "start" }}>
        <div className="stack gap-3">
          {phases.map(([key, label]) => {
            const tasks = t.tasks.filter((k) => onboardingPhase(k.offsetDays) === key);
            return (
              <Card key={key} tight title={label} description={`${tasks.length} task(s)`}>
                {tasks.length === 0 ? <div className="text-xs subtle" style={{ padding: 12 }}>Nothing in this phase.</div> : (
                  <Table head={["Day", "Task", "Owner", "Sign-off", ""]}>
                    {tasks.map((k) => (
                      <tr key={k.id}>
                        <td className="num">{k.offsetDays >= 0 ? `+${k.offsetDays}` : k.offsetDays}</td>
                        <td className="text-sm">{k.title}<div className="text-xs subtle">{k.category.toLowerCase()}{k.isRequired ? "" : " · optional"}</div></td>
                        <td><Badge>{k.owner.toLowerCase()}</Badge></td>
                        <td className="text-xs">{k.needsApproval ? <Badge tone="warning">HR sign-off</Badge> : "—"}</td>
                        <td className="right">
                          <div className="row gap-1 wrap" style={{ justifyContent: "flex-end" }}>
                            <ActButton action={designerTaskAction} hidden={{ id: k.id, op: "up" }} label="↑" variant="ghost" />
                            <ActButton action={designerTaskAction} hidden={{ id: k.id, op: "down" }} label="↓" variant="ghost" />
                            <ActButton action={designerTaskAction} hidden={{ id: k.id, op: "approval" }} label={k.needsApproval ? "No sign-off" : "Needs sign-off"} />
                            <div style={{ width: 220 }}>
                              <SpecForm action={designerTaskAction} hidden={{ id: k.id, op: "phase" }} columns={1} submitLabel="Move" fields={[
                                { name: "phase", label: "Phase", type: "select", required: true, defaultValue: key, options: phases.map(([pk, pl]) => ({ value: pk, label: pl })) },
                                { name: "offsetDays", label: "Day (optional)", type: "number" },
                              ]} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            );
          })}
        </div>
        <Card tight title="Revision history">
          {revisions.length === 0 ? <Empty title="No revisions yet">Each change to this template is recorded here.</Empty> : (
            <div className="stack">
              {revisions.map((r, i) => {
                const prev = revisions[i + 1];
                const diff = prev ? templateRevisionDiff(prev.snapshot as unknown as TemplateSnapshot, r.snapshot as unknown as TemplateSnapshot) : ["First recorded version"];
                return (
                  <div key={r.id} style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                    <div className="row" style={{ justifyContent: "space-between" }}><strong className="text-sm">v{r.version}</strong><span className="text-xs subtle">{fmtTime(r.createdAt)}</span></div>
                    <div className="text-xs">{r.summary}{r.changedBy ? ` · ${authors.get(r.changedBy) ?? ""}` : ""}</div>
                    <div className="text-xs muted">{diff.slice(0, 6).map((d) => <div key={d}>• {d}</div>)}</div>
                    {i > 0 ? <ActButton action={restoreTemplateRevisionAction} hidden={{ id: r.id }} label={`Restore v${r.version}`} variant="ghost" confirmText="Replace the current tasks with this version?" /> : null}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
