import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { projectHealth } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Person, Stat, Progress, KeyValue } from "@/components/ui";
import { Disclosure } from "../../org/forms";
import { ProjectForm, AllocateForm, TaskForm, TaskStatus, MilestoneForm, MilestoneComplete, InvoiceDraftForm, InvoiceOps } from "../forms";

const P = PERMISSIONS;
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();
const HEALTH: Record<string, "success" | "warning" | "danger"> = { GREEN: "success", AMBER: "warning", RED: "danger" };
const TASK: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { TODO: "neutral", IN_PROGRESS: "info", IN_REVIEW: "info", BLOCKED: "danger", DONE: "success" };
const MS: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { PENDING: "neutral", IN_PROGRESS: "info", DELAYED: "danger", COMPLETED: "success", INVOICED: "info" };
const INVOICE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { DRAFT: "neutral", SENT: "info", PARTIALLY_PAID: "warning", PAID: "success", OVERDUE: "danger", CANCELLED: "neutral", WRITTEN_OFF: "danger" };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const p = await prisma.project.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      client: true, projectManager: { select: { id: true, displayName: true } },
      allocations: { include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } }, orderBy: { startDate: "asc" } },
      milestones: { orderBy: { dueDate: "asc" } },
      tasks: { include: { assignee: { select: { displayName: true } } }, orderBy: [{ status: "asc" }, { dueDate: "asc" }] },
      invoices: { orderBy: { issueDate: "desc" } },
    },
  });
  if (!p) notFound();
  const me = viewer.employee?.id;
  const isPm = !!me && p.projectManagerId === me;
  const onTeam = !!me && p.allocations.some((a) => a.employeeId === me);
  // Someone with no route to the project gets the same 404 as a missing one.
  if (!canAny(viewer, [P.PROJECT_VIEW, P.PROJECT_MANAGE]) && !isPm && !onTeam) notFound();
  const manage = can(viewer, P.PROJECT_MANAGE);
  const lead = manage || isPm;
  const seeRates = lead || can(viewer, P.INVOICE_MANAGE);

  const [byPerson, totals, unbilled, people, clients] = await Promise.all([
    prisma.timeEntry.groupBy({ by: ["employeeId"], where: { projectId: p.id }, _sum: { hours: true } }),
    prisma.timeEntry.aggregate({ where: { projectId: p.id }, _sum: { hours: true } }),
    prisma.timeEntry.findMany({ where: { projectId: p.id, isBillable: true, isInvoiced: false, timesheet: { status: { in: ["APPROVED", "LOCKED"] } } }, select: { hours: true, billRate: true } }),
    lead ? prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }) : [],
    manage ? prisma.client.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }) : [],
  ]);
  const used = Number(totals._sum.hours ?? 0);
  const hoursOf = new Map(byPerson.map((b) => [b.employeeId, Number(b._sum.hours ?? 0)]));
  const unbilledValue = unbilled.reduce((s, e) => s + Number(e.hours) * Number(e.billRate ?? 0), 0);
  const overdue = p.milestones.filter((m) => !["COMPLETED", "INVOICED"].includes(m.status) && m.dueDate < new Date()).length;
  const health = projectHealth({ start: p.startDate, end: p.endDate, budgetHours: p.estimatedHours === null ? null : Number(p.estimatedHours), hoursUsed: used, overdueMilestones: overdue });
  const budget = p.estimatedHours === null ? null : Number(p.estimatedHours);
  const team = p.allocations.map((a) => ({ value: a.employee.id, label: a.employee.displayName ?? "" })).filter((o, i, all) => all.findIndex((x) => x.value === o.value) === i);
  const now = new Date();
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const openTasks = p.tasks.filter((t) => t.status !== "DONE");

  return (
    <>
      <PageHead
        title={p.name}
        subtitle={<>{p.client?.name ?? "Internal project"} · {label(p.billingModel)}{p.code ? ` · ${p.code}` : ""} · <Badge tone={HEALTH[health.health]} dot>{label(health.health)}</Badge> <span className="text-xs subtle">{health.reason}</span></>}
        actions={<>{canAny(viewer, [P.PROJECT_MANAGE, P.INVOICE_MANAGE]) ? <Link className="btn sm" href={`/projects/${p.id}/billing`}>Billing, retainer & expenses</Link> : null}<Link className="btn sm" href="/projects?tab=projects">All projects</Link></>}
      />
      <div className="stack gap-4">
        <div className="grid grid-4">
          <Stat label="Hours logged" value={`${used.toLocaleString("en-IN")} h`} meta={budget ? <><Progress value={used} max={budget} tone={used > budget ? "warning" : undefined} />{Math.round((used / budget) * 100)}% of {budget} h</> : "no hour budget"} />
          <Stat label="Open tasks" value={openTasks.length} meta={`${p.tasks.filter((t) => t.status === "BLOCKED").length} blocked`} />
          <Stat label="Milestones" value={`${p.milestones.filter((m) => ["COMPLETED", "INVOICED"].includes(m.status)).length} / ${p.milestones.length}`} meta={overdue ? `${overdue} past due` : "none past due"} tone={overdue ? "neg" : undefined} />
          {seeRates ? <Stat label="Approved, not yet billed" value={formatINR(unbilledValue)} meta={`${unbilled.reduce((s, e) => s + Number(e.hours), 0)} h`} /> : <Stat label="People" value={p.allocations.length} />}
        </div>

        <Card title="Overview" action={manage ? <Disclosure label="Edit" variant="default"><ProjectForm clients={clients.map((c) => ({ value: c.id, label: c.name }))} people={people.map((x) => ({ value: x.id, label: x.displayName ?? "" }))}
          project={{ id: p.id, name: p.name, code: p.code, clientId: p.clientId, description: p.description, billingModel: p.billingModel, status: p.status, startDate: iso(p.startDate), endDate: iso(p.endDate), estimatedHours: budget, budget: p.budget === null ? null : Number(p.budget), retainerFee: p.retainerFee === null ? null : Number(p.retainerFee), projectManagerId: p.projectManagerId }} /></Disclosure> : null}>
          <KeyValue items={[
            ["Project manager", p.projectManager?.displayName ?? null],
            ["Status", label(p.status)],
            ["Runs", p.startDate ? `${formatDate(p.startDate)} – ${p.endDate ? formatDate(p.endDate) : "open"}` : null],
            ["Client", p.client ? `${p.client.name}${p.client.gstin ? ` · GSTIN ${p.client.gstin}` : ""}` : null],
            ...(seeRates && p.budget !== null ? [["Budget", formatINR(Number(p.budget))] as [string, string]] : []),
            ...(p.billingModel === "RETAINER" && seeRates ? [["Retainer", `${formatINR(Number(p.retainerFee ?? 0))} a month`] as [string, string]] : []),
            ["About", p.description],
          ]} />
        </Card>

        <Card tight title={`Team (${p.allocations.length})`} description="Only allocated people can log time here, at the rate on their allocation">
          {p.allocations.length === 0 ? <Empty title="Nobody allocated yet" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Person</th><th>Role</th><th className="num">Allocation</th>{seeRates ? <><th className="num">Bill rate</th><th className="num">Cost rate</th></> : null}<th>Period</th><th className="num">Hours</th></tr></thead>
              <tbody>{p.allocations.map((a) => (
                <tr key={a.id}>
                  <td><Person name={a.employee.displayName ?? ""} meta={a.employee.employeeNumber} /></td>
                  <td className="text-sm">{a.billingRole ?? "—"}{a.isBillable ? "" : <span className="subtle"> · non-billable</span>}</td>
                  <td className="num">{Number(a.allocationPercent)}%</td>
                  {seeRates ? <><td className="num">{a.billRate ? `₹${Number(a.billRate).toLocaleString("en-IN")}/h` : "—"}</td><td className="num">{a.costRate ? `₹${Number(a.costRate).toLocaleString("en-IN")}/h` : "—"}</td></> : null}
                  <td className="text-sm nowrap">{formatDate(a.startDate)} – {a.endDate ? formatDate(a.endDate) : "open"}</td>
                  <td className="num">{hoursOf.get(a.employeeId) ?? 0}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {lead ? <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}><Disclosure label="Allocate someone" variant="default"><AllocateForm projectId={p.id} people={people.map((x) => ({ value: x.id, label: x.displayName ?? "" }))} billable={p.billingModel !== "NON_BILLABLE"} /></Disclosure></div> : null}
        </Card>

        <Card tight title={`Tasks (${openTasks.length} open)`}>
          {p.tasks.length === 0 ? <Empty title="No tasks yet" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Task</th><th>Assignee</th><th>Due</th><th className="num">Hours</th><th>Status</th></tr></thead>
              <tbody>{p.tasks.map((t) => {
                const canMove = lead || t.assigneeId === me;
                return (
                  <tr key={t.id}>
                    <td className="text-sm"><span className="strong">{t.title}</span><div className="text-xs subtle">{label(t.priority)}{t.isBillable ? "" : " · non-billable"}</div></td>
                    <td className="text-sm">{t.assignee?.displayName ?? <span className="subtle">Unassigned</span>}</td>
                    <td className="text-sm nowrap" style={{ color: t.status !== "DONE" && t.dueDate && t.dueDate < now ? "var(--danger)" : undefined }}>{t.dueDate ? formatDate(t.dueDate) : "—"}</td>
                    <td className="num">{Number(t.loggedHours)}{t.estimatedHours ? ` / ${Number(t.estimatedHours)}` : ""}</td>
                    <td>{canMove ? <TaskStatus taskId={t.id} status={t.status} /> : <Badge tone={TASK[t.status]}>{label(t.status)}</Badge>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
          {lead ? <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}><Disclosure label="Add a task" variant="default"><TaskForm projectId={p.id} people={team} /></Disclosure></div> : null}
        </Card>

        <Card tight title="Milestones" description={p.billingModel === "MILESTONE" ? "Completed milestones with an amount are billed on the next invoice" : undefined}>
          {p.milestones.length === 0 ? <Empty title="No milestones" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Milestone</th><th>Due</th>{p.billingModel === "MILESTONE" && seeRates ? <th className="num">Amount</th> : null}<th>Status</th><th /></tr></thead>
              <tbody>{p.milestones.map((m) => {
                const late = !["COMPLETED", "INVOICED"].includes(m.status) && m.dueDate < now;
                return (
                  <tr key={m.id}>
                    <td className="text-sm strong">{m.name}</td>
                    <td className="text-sm nowrap" style={{ color: late ? "var(--danger)" : undefined }}>{formatDate(m.dueDate)}{m.completedOn ? <div className="text-xs subtle">done {formatDate(m.completedOn)}</div> : null}</td>
                    {p.billingModel === "MILESTONE" && seeRates ? <td className="num">{m.amount ? formatINR(Number(m.amount)) : "—"}</td> : null}
                    <td><Badge tone={late ? "danger" : MS[m.status]}>{late ? "past due" : label(m.status)}</Badge></td>
                    <td>{lead && ["PENDING", "IN_PROGRESS", "DELAYED"].includes(m.status) ? <MilestoneComplete projectId={p.id} milestoneId={m.id} /> : null}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
          {lead ? <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}><MilestoneForm projectId={p.id} priced={p.billingModel === "MILESTONE"} /></div> : null}
        </Card>

        {can(viewer, P.INVOICE_MANAGE) && p.clientId && p.billingModel !== "NON_BILLABLE" ? (
          <Card tight title="Invoices" description={p.billingModel === "TIME_AND_MATERIAL" ? "Approved billable time in the period, at each person's rate" : p.billingModel === "MILESTONE" ? "Completed milestones not yet invoiced" : "The month's retainer"}>
            {p.invoices.length === 0 ? <Empty title="Not invoiced yet" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Invoice</th><th>Period</th><th className="num">Total</th><th className="num">Outstanding</th><th>Status</th><th /></tr></thead>
                <tbody>{p.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="text-sm"><Link href={`/projects/billing/${i.id}`} className="strong">{i.invoiceNumber}</Link>{i.fileUrl ? <> · <a href={i.fileUrl} className="text-xs">PDF</a></> : null}<div className="text-xs subtle">due {formatDate(i.dueDate)}</div></td>
                    <td className="text-sm nowrap">{i.periodStart ? formatDate(i.periodStart) : "—"} – {i.periodEnd ? formatDate(i.periodEnd) : "—"}</td>
                    <td className="num">{formatINR(Number(i.total))}</td>
                    <td className="num">{Number(i.amountDue) ? formatINR(Number(i.amountDue)) : "—"}</td>
                    <td><Badge tone={INVOICE[i.status]}>{label(i.status)}</Badge></td>
                    <td><InvoiceOps invoiceId={i.id} status={i.status} due={Number(i.amountDue)} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}><InvoiceDraftForm projectId={p.id} from={iso(lastMonthStart)!} to={iso(lastMonthEnd)!} /></div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
