import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { weekStart, getTimesheetPolicy, getOpsSettings, timeTemplatesFor, templateRowsFor } from "@keka/services";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { timesheetsToApproveWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat, Progress } from "@/components/ui";
import { Disclosure } from "../org/forms";
import { TimesheetGrid, TimesheetDecision, TaskStatus, ProjectForm, ClientForm, InvoiceOps, type SheetRow } from "./forms";
import { firstSettingsHref } from "./billing/nav";

const P = PERMISSIONS;
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();
const HEALTH: Record<string, "success" | "warning" | "danger"> = { GREEN: "success", AMBER: "warning", RED: "danger" };
const SHEET: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { DRAFT: "neutral", SUBMITTED: "warning", APPROVED: "success", REJECTED: "danger", LOCKED: "info" };
const INVOICE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { DRAFT: "neutral", SENT: "info", PARTIALLY_PAID: "warning", PAID: "success", OVERDUE: "danger", CANCELLED: "neutral", WRITTEN_OFF: "danger" };

/** Projects a viewer can open: all of them with PROJECT_VIEW, else the ones they manage or work on. */
function visibleProjects(viewer: Viewer): Record<string, unknown> {
  if (canAny(viewer, [P.PROJECT_VIEW, P.PROJECT_MANAGE])) return { tenantId: viewer.tenantId };
  const me = viewer.employee?.id ?? "__none__";
  return { tenantId: viewer.tenantId, OR: [{ projectManagerId: me }, { allocations: { some: { employeeId: me } } }] };
}

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ tab?: string; week?: string }> }) {
  const viewer = await requireViewer();
  const managesAny = viewer.employee ? (await prisma.project.count({ where: { tenantId: viewer.tenantId, projectManagerId: viewer.employee.id } })) > 0 : false;
  const approver = can(viewer, P.TIMESHEET_APPROVE) || managesAny;
  const billing = canAny(viewer, [P.INVOICE_MANAGE, P.CLIENT_MANAGE, P.CLIENT_VIEW]);
  const tabs = [...(viewer.employee ? ["time"] : []), ...(approver ? ["approvals"] : []), "projects", ...(billing ? ["billing"] : [])];
  const sp = await searchParams;
  const tab = tabs.includes(sp.tab ?? "") ? sp.tab! : tabs[0];
  const settings = firstSettingsHref(viewer);
  const links = [
    canAny(viewer, [P.OPPORTUNITY_VIEW, P.OPPORTUNITY_MANAGE]) && <Link key="pipe" className="btn" href="/projects/pipeline">Pipeline</Link>,
    canAny(viewer, [P.RESOURCE_VIEW, P.RESOURCE_MANAGE]) && <Link key="res" className="btn" href="/projects/resources">Resource planner</Link>,
    can(viewer, P.INVOICE_MANAGE) && <Link key="bill" className="btn" href="/projects/billing">Billing</Link>,
    settings && <Link key="set" className="btn" href={settings}>Settings</Link>,
  ].filter(Boolean);
  return (
    <>
      <PageHead title="Projects & time" subtitle="Log time against the projects you are on; approved billable time becomes the client's invoice"
        actions={links.length ? <>{links}</> : undefined} />
      <div className="tabs">
        {tabs.map((t) => <Link key={t} href={`/projects?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>{{ time: "My time", approvals: "Approvals", projects: "Projects", billing: "Clients & invoices" }[t]}</Link>)}
      </div>
      {tab === "time" ? <MyTime viewer={viewer} weekRaw={sp.week} /> : null}
      {tab === "approvals" ? <Approvals viewer={viewer} /> : null}
      {tab === "projects" ? <ProjectList viewer={viewer} /> : null}
      {tab === "billing" ? <Billing viewer={viewer} /> : null}
    </>
  );
}

async function MyTime({ viewer, weekRaw }: { viewer: Viewer; weekRaw?: string }) {
  const me = viewer.employee!;
  const week = weekStart(/^\d{4}-\d{2}-\d{2}$/.test(weekRaw ?? "") ? new Date(`${weekRaw}T00:00:00Z`) : new Date());
  const end = new Date(week.getTime() + 6 * DAY);
  const dates = Array.from({ length: 7 }, (_, i) => iso(new Date(week.getTime() + i * DAY)));
  const [sheet, allocations, tasks, recent] = await Promise.all([
    prisma.timesheet.findUnique({ where: { employeeId_periodStart: { employeeId: me.id, periodStart: week } }, include: { entries: true } }),
    prisma.resourceAllocation.findMany({
      where: { employeeId: me.id, startDate: { lte: end }, OR: [{ endDate: null }, { endDate: { gte: week } }], project: { status: { notIn: ["COMPLETED", "CANCELLED"] } } },
      include: { project: { select: { id: true, name: true, code: true } } },
    }),
    prisma.task.findMany({ where: { tenantId: viewer.tenantId, assigneeId: me.id, status: { not: "DONE" } }, include: { project: { select: { name: true } } }, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }] }),
    prisma.timesheet.findMany({ where: { employeeId: me.id }, orderBy: { periodStart: "desc" }, take: 8 }),
  ]);
  const projectIds = [...new Set(allocations.map((a) => a.projectId))];
  const projectTasks = await prisma.task.findMany({ where: { projectId: { in: projectIds }, status: { not: "DONE" } }, select: { id: true, title: true, projectId: true }, orderBy: { title: "asc" } });

  // Fold the saved entries back into grid rows: one per project and task.
  const rows = new Map<string, SheetRow>();
  for (const e of sheet?.entries ?? []) {
    const k = `${e.projectId}:${e.taskId ?? ""}`;
    const r = rows.get(k) ?? { projectId: e.projectId, taskId: e.taskId ?? "", hours: [0, 0, 0, 0, 0, 0, 0], note: e.description ?? "", timeCode: e.timeCode ?? "", workPackageId: e.workPackageId ?? "", milestoneId: e.milestoneId ?? "" };
    r.hours[Math.round((e.date.getTime() - week.getTime()) / DAY)] += Number(e.hours);
    rows.set(k, r);
  }
  const editable = !sheet || ["DRAFT", "REJECTED"].includes(sheet.status);
  // Ops depth: activity codes, work packages, milestones, saved templates and attestation.
  const [opsSet, codes, wps, mss, tpls] = await Promise.all([
    getOpsSettings(viewer.tenantId),
    prisma.opsTimeCode.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.opsWorkPackage.findMany({ where: { tenantId: viewer.tenantId, projectId: { in: projectIds }, status: "OPEN" }, orderBy: { code: "asc" } }),
    prisma.milestone.findMany({ where: { projectId: { in: projectIds }, status: { notIn: ["COMPLETED", "INVOICED"] } }, select: { id: true, name: true, projectId: true }, orderBy: { dueDate: "asc" } }),
    timeTemplatesFor(viewer.tenantId, me.id),
  ]);
  const allowedTasks = new Set(projectTasks.map((t) => t.id));
  const templates = tpls.map((t) => ({ id: t.id, name: t.name, rows: templateRowsFor(t.rows, new Set(projectIds), allowedTasks).map((r) => ({ projectId: r.projectId, taskId: r.taskId, hours: r.hours, note: r.note, timeCode: r.timeCode, workPackageId: r.workPackageId })) })).filter((t) => t.rows.length > 0);
  const prev = iso(new Date(week.getTime() - 7 * DAY)), next = iso(new Date(week.getTime() + 7 * DAY));
  const thisMonth = recent.filter((s) => s.periodStart.getUTCMonth() === new Date().getUTCMonth());

  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="This week" value={`${Number(sheet?.totalHours ?? 0)} h`} meta={sheet ? <Badge tone={SHEET[sheet.status]}>{label(sheet.status)}</Badge> : "not started"} />
        <Stat label="Billable this month" value={`${thisMonth.reduce((s, x) => s + Number(x.billableHours), 0)} h`} meta={`of ${thisMonth.reduce((s, x) => s + Number(x.totalHours), 0)} h logged`} />
        <Stat label="Open tasks" value={tasks.length} meta={tasks.filter((t) => t.dueDate && t.dueDate < new Date()).length ? `${tasks.filter((t) => t.dueDate && t.dueDate < new Date()).length} overdue` : "none overdue"} />
      </div>
      <Card
        title={`Week of ${formatDate(week)}`}
        description={sheet?.status === "REJECTED" ? `Sent back: ${sheet.rejectReason ?? ""}` : editable ? "Quarter hours. Only the projects you are allocated to appear." : `This week is ${label(sheet!.status)} and locked.`}
        action={<div className="row gap-2"><Link className="btn sm" href={`/projects?tab=time&week=${prev}`}>← Previous</Link><Link className="btn sm" href="/projects?tab=time">This week</Link><Link className="btn sm" href={`/projects?tab=time&week=${next}`}>Next →</Link></div>}
      >
        {allocations.length === 0 && !sheet ? (
          <Empty title="You are not on any project this week">A project manager allocates people to a project before time can be logged against it.</Empty>
        ) : (
          <TimesheetGrid key={`${iso(week)}:${sheet?.updatedAt.getTime() ?? 0}`} week={iso(week)} dates={dates} rows={[...rows.values()]} editable={editable}
            projects={allocations.map((a) => ({ value: a.project.id, label: a.project.code ? `${a.project.code} · ${a.project.name}` : a.project.name })).filter((p, i, all) => all.findIndex((x) => x.value === p.value) === i)}
            tasks={projectTasks.map((t) => ({ value: t.id, label: t.title, projectId: t.projectId }))}
            codes={codes.map((c) => ({ value: c.code, label: `${c.code} · ${c.label}` }))} workPackages={wps.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}`, projectId: w.projectId }))}
            milestones={mss.map((m) => ({ value: m.id, label: m.name, projectId: m.projectId }))} templates={templates} attest={opsSet.requireAttestation} />
        )}
      </Card>
      <div className="grid grid-2">
        <Card tight title="My tasks">
          {tasks.length === 0 ? <Empty title="Nothing assigned to you" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Task</th><th>Due</th><th>Status</th></tr></thead>
              <tbody>{tasks.map((t) => (
                <tr key={t.id}>
                  <td><Link href={`/projects/${t.projectId}`} className="strong text-sm">{t.title}</Link><div className="text-xs subtle">{t.project.name} · {label(t.priority)}{t.estimatedHours ? ` · ${Number(t.loggedHours)}/${Number(t.estimatedHours)} h` : ""}</div></td>
                  <td className="text-sm nowrap" style={{ color: t.dueDate && t.dueDate < new Date() ? "var(--danger)" : undefined }}>{t.dueDate ? formatDate(t.dueDate) : "—"}</td>
                  <td><TaskStatus taskId={t.id} status={t.status} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Card tight title="Recent weeks">
          {recent.length === 0 ? <Empty title="No timesheets yet" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Week</th><th className="num">Hours</th><th className="num">Billable</th><th>Status</th></tr></thead>
              <tbody>{recent.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/projects?tab=time&week=${iso(s.periodStart)}`} className="text-sm">{formatDate(s.periodStart)}</Link></td>
                  <td className="num">{Number(s.totalHours)}</td><td className="num">{Number(s.billableHours)}</td>
                  <td><Badge tone={SHEET[s.status]}>{label(s.status)}</Badge></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </div>
  );
}

async function Approvals({ viewer }: { viewer: Viewer }) {
  const sheets = await prisma.timesheet.findMany({
    where: timesheetsToApproveWhere(viewer),
    include: { employee: { select: { displayName: true, employeeNumber: true } }, entries: { include: { project: { select: { name: true } }, task: { select: { title: true } } }, orderBy: { date: "asc" } } },
    orderBy: { submittedAt: "asc" },
  });
  const policy = await getTimesheetPolicy(viewer.tenantId);
  const decided = await prisma.timesheet.findMany({ where: { tenantId: viewer.tenantId, approvedBy: viewer.user.id }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { approvedAt: "desc" }, take: 10 });
  return (
    <div className="stack gap-4">
      <Card tight title={`Waiting for you (${sheets.length})`} description="Each sheet shows where the hours went before you approve it">
        {sheets.length === 0 ? <Empty title="No timesheets to approve" /> : (
          <div className="stack">
            {sheets.map((s) => {
              const byProject = new Map<string, number>();
              for (const e of s.entries) byProject.set(e.project.name, (byProject.get(e.project.name) ?? 0) + Number(e.hours));
              return (
                <div key={s.id} className="row wrap gap-3" style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", justifyContent: "space-between" }}>
                  <div style={{ minWidth: 220 }}>
                    <Person name={s.employee.displayName ?? ""} meta={`Week of ${formatDate(s.periodStart)} · ${Number(s.totalHours)} h, ${Number(s.billableHours)} billable`} />
                    <div className="text-xs subtle" style={{ marginTop: 6 }}>{[...byProject].map(([p, h]) => `${p} ${h} h`).join(" · ")}</div>
                    {Number(s.totalHours) > policy.flagWeeklyHoursAbove ? <div className="text-xs" style={{ color: "var(--warning)" }}>More than {policy.flagWeeklyHoursAbove} hours in a week</div> : null}
                    {s.approvalStep > 0 ? <div className="text-xs subtle">Approved by the line manager; yours is the second level</div> : null}
                  </div>
                  <TimesheetDecision timesheetId={s.id} />
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <Card tight title="You approved recently">
        {decided.length === 0 ? <Empty title="None yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Employee</th><th>Week</th><th className="num">Hours</th><th>Approved</th></tr></thead>
            <tbody>{decided.map((s) => <tr key={s.id}><td><Person name={s.employee.displayName ?? ""} meta={s.employee.employeeNumber} /></td><td className="text-sm">{formatDate(s.periodStart)}</td><td className="num">{Number(s.totalHours)}</td><td className="text-sm">{s.approvedAt ? formatDate(s.approvedAt) : "—"}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

async function ProjectList({ viewer }: { viewer: Viewer }) {
  const manage = can(viewer, P.PROJECT_MANAGE);
  const [projects, clients, people] = await Promise.all([
    prisma.project.findMany({
      where: visibleProjects(viewer),
      include: { client: { select: { name: true } }, projectManager: { select: { displayName: true } }, _count: { select: { allocations: true, tasks: true } } },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    manage ? prisma.client.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }) : [],
    manage ? prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }) : [],
  ]);
  const hours = new Map((await prisma.timeEntry.groupBy({ by: ["projectId"], where: { projectId: { in: projects.map((p) => p.id) } }, _sum: { hours: true } })).map((h) => [h.projectId, Number(h._sum.hours ?? 0)]));
  const active = projects.filter((p) => p.status === "ACTIVE");
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Active projects" value={active.length} meta={`${projects.length} in all`} />
        <Stat label="At risk" value={active.filter((p) => p.health !== "GREEN").length} meta="amber or red" tone={active.some((p) => p.health === "RED") ? "neg" : undefined} />
        <Stat label="Hours logged" value={`${[...hours.values()].reduce((a, b) => a + b, 0).toLocaleString("en-IN")} h`} meta="across these projects" />
      </div>
      {manage ? (
        <Card title="New project" description="Billable projects need a client; people are allocated on the project page.">
          <Disclosure label="New project">
            <ProjectForm clients={clients.map((c) => ({ value: c.id, label: c.name }))} people={people.map((p) => ({ value: p.id, label: p.displayName ?? "" }))} />
          </Disclosure>
        </Card>
      ) : null}
      <Card tight title="Projects">
        {projects.length === 0 ? <Empty title="No projects">{manage ? "Create one above." : "You are not on any project yet."}</Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Project</th><th>Client</th><th>Manager</th><th>Billing</th><th style={{ minWidth: 140 }}>Hours</th><th>Health</th><th>Status</th></tr></thead>
            <tbody>{projects.map((p) => {
              const used = hours.get(p.id) ?? 0, budget = p.estimatedHours === null ? null : Number(p.estimatedHours);
              return (
                <tr key={p.id}>
                  <td><Link href={`/projects/${p.id}`} className="strong text-sm">{p.name}</Link><div className="text-xs subtle">{p.code ?? ""}{p.code ? " · " : ""}{p._count.allocations} people · {p._count.tasks} tasks</div></td>
                  <td className="text-sm">{p.client?.name ?? <span className="subtle">Internal</span>}</td>
                  <td className="text-sm">{p.projectManager?.displayName ?? "—"}</td>
                  <td className="text-sm">{label(p.billingModel)}</td>
                  <td>{budget ? <><Progress value={used} max={budget} tone={used > budget ? "warning" : undefined} /><div className="text-xs subtle">{used} / {budget} h</div></> : <span className="text-sm">{used} h</span>}</td>
                  <td><Badge tone={HEALTH[p.health]} dot>{label(p.health)}</Badge></td>
                  <td><Badge tone={p.status === "ACTIVE" ? "info" : "neutral"}>{label(p.status)}</Badge></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

async function Billing({ viewer }: { viewer: Viewer }) {
  const invoices = can(viewer, P.INVOICE_MANAGE);
  const [clients, list] = await Promise.all([
    prisma.client.findMany({ where: { tenantId: viewer.tenantId }, include: { _count: { select: { projects: true } } }, orderBy: { name: "asc" } }),
    invoices ? prisma.invoice.findMany({ where: { tenantId: viewer.tenantId }, include: { client: { select: { name: true } }, project: { select: { name: true } } }, orderBy: { issueDate: "desc" }, take: 100 }) : [],
  ]);
  const owed = list.filter((i) => ["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(i.status));
  const overdue = list.filter((i) => i.status === "OVERDUE");
  const year = new Date().getUTCFullYear();
  return (
    <div className="stack gap-4">
      {invoices ? (
        <div className="grid grid-3">
          <Stat label="Receivable" value={formatINR(owed.reduce((s, i) => s + Number(i.amountDue), 0))} meta={`${owed.length} open invoice(s)`} />
          <Stat label="Overdue" value={formatINR(overdue.reduce((s, i) => s + Number(i.amountDue), 0))} meta={`${overdue.length} invoice(s)`} tone={overdue.length ? "neg" : undefined} />
          <Stat label={`Collected in ${year}`} value={formatINR(list.filter((i) => i.issueDate.getUTCFullYear() === year).reduce((s, i) => s + Number(i.amountPaid), 0))} />
        </div>
      ) : null}
      {invoices ? (
        <Card tight title="Invoices" description="Drafted from a project page; sending files the PDF and emails the client">
          {list.length === 0 ? <Empty title="No invoices yet">Open a client project and draft one for a period.</Empty> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Invoice</th><th>Client</th><th>Issued</th><th>Due</th><th className="num">Total</th><th className="num">Outstanding</th><th>Status</th><th /></tr></thead>
              <tbody>{list.map((i) => (
                <tr key={i.id}>
                  <td><Link href={`/projects/billing/${i.id}`} className="strong text-sm">{i.invoiceNumber}</Link>{i.fileUrl ? <> · <a href={i.fileUrl} className="text-xs">PDF</a></> : null}<div className="text-xs subtle">{i.project ? <Link href={`/projects/${i.projectId}`}>{i.project.name}</Link> : ""}</div></td>
                  <td className="text-sm">{i.client.name}</td>
                  <td className="text-sm nowrap">{formatDate(i.issueDate)}</td>
                  <td className="text-sm nowrap">{formatDate(i.dueDate)}</td>
                  <td className="num">{formatINR(Number(i.total))}</td>
                  <td className="num">{Number(i.amountDue) ? formatINR(Number(i.amountDue)) : "—"}</td>
                  <td><Badge tone={INVOICE[i.status]}>{label(i.status)}</Badge></td>
                  <td><InvoiceOps invoiceId={i.id} status={i.status} due={Number(i.amountDue)} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      ) : null}
      {can(viewer, P.CLIENT_MANAGE) ? <Card title="New client" description="The client's state decides the GST split on its invoices."><Disclosure label="Add client"><ClientForm /></Disclosure></Card> : null}
      <Card tight title="Clients">
        {clients.length === 0 ? <Empty title="No clients yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Client</th><th>Place of supply</th><th>GSTIN</th><th>Billing contact</th><th className="num">Projects</th></tr></thead>
            <tbody>{clients.map((c) => (
              <tr key={c.id}>
                <td className="strong text-sm">{c.name}{c.code ? <span className="subtle"> · {c.code}</span> : null}</td>
                <td className="text-sm">{c.countryCode === "IN" ? c.state ?? "—" : `Export (${c.countryCode})`}</td>
                <td className="mono text-xs">{c.gstin ?? "—"}</td>
                <td className="text-sm">{c.contactName ?? "—"}{c.contactEmail ? <div className="text-xs subtle">{c.contactEmail}</div> : null}</td>
                <td className="num">{c._count.projects}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
