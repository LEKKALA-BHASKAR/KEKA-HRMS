import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { journeyProgress, AUTO_CHECK_CODES } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat, Progress } from "@/components/ui";
import { StartJourneyForm, TemplateForm, AddTemplateTaskForm, DeleteTemplateTaskButton } from "../_lifecycle/forms";
import { Disclosure } from "../org/forms";
import { OnboardingNav } from "./_join/nav";

const P = PERMISSIONS;

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ tab?: string; template?: string }> }) {
  const viewer = await requireAuth(P.ONBOARDING_VIEW);
  const { tab, template } = await searchParams;
  const manage = can(viewer, P.ONBOARDING_MANAGE);
  const view = tab === "templates" && manage ? "templates" : tab === "done" ? "done" : "active";
  const scope = scopedEmployeeWhere(viewer, P.ONBOARDING_VIEW);

  return (
    <>
      <PageHead title="Journeys" subtitle="Onboarding, confirmation, promotion and transfer — every task an event sets in motion" />
      <OnboardingNav viewer={viewer} active="journeys" />
      <div className="tabs">
        <Link href="/onboarding" className={`tab${view === "active" ? " active" : ""}`}>In progress</Link>
        <Link href="/onboarding?tab=done" className={`tab${view === "done" ? " active" : ""}`}>Completed</Link>
        {manage ? <Link href="/onboarding?tab=templates" className={`tab${view === "templates" ? " active" : ""}`}>Templates</Link> : null}
      </div>
      {view === "templates" ? <Templates tenantId={viewer.tenantId} selected={template} /> : <Journeys viewer={viewer} scope={scope} active={view === "active"} manage={manage} />}
    </>
  );
}

async function Journeys({ viewer, scope, active, manage }: { viewer: Awaited<ReturnType<typeof requireAuth>>; scope: Record<string, unknown>; active: boolean; manage: boolean }) {
  const journeys = await prisma.journey.findMany({
    where: { tenantId: viewer.tenantId, trigger: { not: "EXIT" }, status: active ? "ACTIVE" : { in: ["COMPLETED", "CANCELLED"] }, employee: scope },
    include: {
      employee: { select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } } },
      tasks: { select: { status: true, isRequired: true, dueDate: true, owner: true } },
    },
    orderBy: { anchorDate: "desc" },
  });
  const [employees, templates] = manage ? await Promise.all([
    prisma.employee.findMany({ where: { ...scopedEmployeeWhere(viewer, P.ONBOARDING_MANAGE), status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" } }),
    prisma.journeyTemplate.findMany({ where: { tenantId: viewer.tenantId, isActive: true, trigger: { not: "EXIT" } }, orderBy: { name: "asc" } }),
  ]) : [[], []];
  const all = journeys.map((j) => ({ j, p: journeyProgress(j.tasks) }));
  const overdue = all.reduce((s, x) => s + x.p.overdue, 0);

  return (
    <div className="stack gap-4">
      {active ? (
        <div className="grid grid-4">
          <Stat label="Journeys in progress" value={String(all.length)} meta="across joining, promotion and more" />
          <Stat label="Joiners" value={String(all.filter((x) => x.j.trigger === "JOINING").length)} meta="onboarding now" />
          <Stat label="Overdue tasks" value={String(overdue)} meta={overdue ? "need attention" : "all on track"} />
          <Stat label="Average completion" value={`${all.length ? Math.round(all.reduce((s, x) => s + x.p.pct, 0) / all.length) : 100}%`} meta="of tasks done" />
        </div>
      ) : null}
      {manage && active ? (
        <Card title="Start a journey" description="Joining journeys start themselves when an employee is created. Start one here for a promotion, transfer or anything else.">
          <Disclosure label="Start a journey">
            <StartJourneyForm employees={employees.map((e) => ({ value: e.id, label: `${e.employeeNumber} — ${e.displayName}` }))} templates={templates.map((t) => ({ value: t.id, label: `${t.name} (${t.trigger.toLowerCase()})` }))} />
          </Disclosure>
        </Card>
      ) : null}
      <Card tight>
        {all.length === 0 ? <Empty title={active ? "No journeys in progress" : "No completed journeys"} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Journey</th><th>Anchor</th><th style={{ width: 200 }}>Progress</th><th>Waiting on</th><th /></tr></thead>
              <tbody>
                {all.map(({ j, p }) => {
                  const waiting = [...new Set(j.tasks.filter((t) => t.status === "PENDING").map((t) => t.owner.toLowerCase()))];
                  return (
                    <tr key={j.id}>
                      <td><Person name={j.employee.displayName ?? ""} meta={`${j.employee.employeeNumber} · ${j.employee.department?.name ?? ""}`} /></td>
                      <td className="text-sm">{j.title.split(" — ")[0]} <Badge>{j.trigger.toLowerCase()}</Badge></td>
                      <td className="nowrap text-sm">{formatDate(j.anchorDate)}</td>
                      <td>
                        <Progress value={p.done} max={Math.max(1, p.total)} tone={p.overdue ? "warning" : "success"} />
                        <div className="text-xs subtle" style={{ marginTop: 3 }}>{p.done}/{p.total}{p.overdue ? ` · ${p.overdue} overdue` : ""}</div>
                      </td>
                      <td className="text-xs muted">{waiting.join(", ") || "—"}</td>
                      <td className="right"><Link className="btn sm" href={`/onboarding/${j.id}`}>Open</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function Templates({ tenantId, selected }: { tenantId: string; selected?: string }) {
  const [templates, departments, locations] = await Promise.all([
    prisma.journeyTemplate.findMany({
      where: { tenantId }, orderBy: [{ trigger: "asc" }, { name: "asc" }],
      include: { tasks: { orderBy: [{ offsetDays: "asc" }, { sortOrder: "asc" }] }, _count: { select: { journeys: true } } },
    }),
    prisma.department.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
  ]);
  const t = templates.find((x) => x.id === selected) ?? templates[0];
  const dOpts = departments.map((d) => ({ value: d.id, label: d.name }));
  const lOpts = locations.map((l) => ({ value: l.id, label: l.name }));
  return (
    <div className="grid grid-2" style={{ gridTemplateColumns: "300px minmax(0, 1fr)", alignItems: "start" }}>
      <Card tight title="Templates">
        <div className="stack">
          {templates.map((x) => (
            <Link key={x.id} href={`/onboarding?tab=templates&template=${x.id}`} className={`nav-item${t?.id === x.id ? " active" : ""}`} style={{ margin: 4 }}>
              <span>{x.name}</span><span className="spacer" /><span className="text-xs subtle">{x.trigger.toLowerCase()}</span>
            </Link>
          ))}
        </div>
        <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
          <Disclosure label="New template" variant="default"><TemplateForm departments={dOpts} locations={lOpts} /></Disclosure>
        </div>
      </Card>
      {t ? (
        <Card tight title={t.name} description={`${t.description ?? ""} · used by ${t._count.journeys} journey(s)${t.jobTitle ? ` · role: ${t.jobTitle}` : ""} · v${t.version}`}
          action={<Link className="btn sm" href={`/onboarding/templates/${t.id}`}>Designer &amp; history</Link>}>
          <div style={{ padding: 18, borderBottom: "1px solid var(--border)" }}>
            <Disclosure label="Edit template" variant="default">
              <TemplateForm key={t.id} template={t} departments={dOpts} locations={lOpts} />
            </Disclosure>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Day</th><th>Task</th><th>Owner</th><th>Check</th><th /></tr></thead>
              <tbody>
                {t.tasks.map((k) => (
                  <tr key={k.id}>
                    <td className="num nowrap">{k.offsetDays >= 0 ? `+${k.offsetDays}` : k.offsetDays}</td>
                    <td className="text-sm">{k.title}{!k.isRequired ? <span className="subtle"> · optional</span> : null}<div className="text-xs subtle">{k.category.toLowerCase()}</div></td>
                    <td><Badge>{k.owner.toLowerCase()}</Badge></td>
                    <td className="text-xs muted">{k.autoCheck ? k.autoCheck.replace(/_/g, " ").toLowerCase() : "manual"}</td>
                    <td className="right"><DeleteTemplateTaskButton id={k.id} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <AddTemplateTaskForm templateId={t.id} autoChecks={AUTO_CHECK_CODES} />
        </Card>
      ) : <Card><Empty title="No templates yet" /></Card>}
    </div>
  );
}
