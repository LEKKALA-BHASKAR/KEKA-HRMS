import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { plannerResources, benchFor, isCritical } from "@keka/services/src/psa";
import { requireViewer, can, canAny } from "@/lib/context";
import { PageHead, Card, Empty, Badge } from "@/components/ui";
import { ResourceTabs, iso } from "../nav";
import { RaiseRequest, RequestOps, AllocateForm } from "../forms";

const STATUS: Record<string, "warning" | "info" | "success" | "danger" | "neutral"> = { OPEN: "warning", HIRING: "info", ALLOCATED: "success", REJECTED: "danger", CANCELLED: "neutral" };
const PRIORITY: Record<string, "danger" | "warning" | "neutral"> = { URGENT: "danger", HIGH: "warning", MEDIUM: "neutral", LOW: "neutral" };

/** Projects › Resources › Requests: ask for people, then fill each request from the bench or send it to hiring. */
export default async function ResourceRequests({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.RESOURCE_MANAGE, P.RESOURCE_REQUEST])) forbidden();
  const manage = can(viewer, P.RESOURCE_MANAGE);
  const sp = await searchParams;
  const closed = sp.view === "closed";
  const today = new Date();
  const [requests, projects, roles] = await Promise.all([
    prisma.resourceRequest.findMany({
      where: { tenantId: viewer.tenantId, status: closed ? { in: ["ALLOCATED", "REJECTED", "CANCELLED"] } : { in: ["OPEN", "HIRING"] }, ...(manage ? {} : { requestedById: viewer.user.id }) },
      include: { billingRole: { select: { name: true } }, project: { select: { id: true, name: true } } },
      orderBy: closed ? { closedAt: "desc" } : [{ startDate: "asc" }], take: closed ? 100 : 200,
    }),
    prisma.project.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.billingRole.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const people = manage || roles.length ? await plannerResources(viewer.tenantId, today, new Date(today.getTime() + 180 * 86_400_000)) : [];
  const filled = new Map((await prisma.resourceAllocation.groupBy({ by: ["requestId"], where: { requestId: { in: requests.map((r) => r.id) } }, _count: true })).map((g) => [g.requestId, g._count]));
  const allocatedTo = await prisma.resourceAllocation.findMany({ where: { requestId: { in: requests.map((r) => r.id) } }, select: { requestId: true, employeeId: true } });
  const requesters = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(requests.map((r) => r.requestedById))] } }, select: { id: true, email: true, employee: { select: { displayName: true } } } })).map((u) => [u.id, u.employee?.displayName ?? u.email]));
  const named = new Map(people.map((p) => [p.id, p.name]));

  return (
    <>
      <PageHead title="Resource requests" subtitle={manage ? "Every open request in the company" : "Requests you raised"} />
      <ResourceTabs viewer={viewer} active="/projects/resources/requests" />
      <div className="stack gap-3">
        {can(viewer, P.RESOURCE_REQUEST) ? (
          <Card title="Request people">
            {roles.length && projects.length ? <RaiseRequest projects={projects.map((p) => ({ value: p.id, label: p.name }))} roles={roles.map((r) => ({ value: r.id, label: r.name }))} people={people.map((p) => ({ value: p.id, label: `${p.name} (${p.number})` }))} />
              : <Empty title={roles.length ? "No open projects" : "No billing roles yet"}>{manage && !roles.length ? <Link href="/projects/resources/settings">Add billing roles</Link> : null}</Empty>}
          </Card>
        ) : null}
        <div className="tabs">
          <Link href="/projects/resources/requests" className={`tab${closed ? "" : " active"}`}>Open</Link>
          <Link href="/projects/resources/requests?view=closed" className={`tab${closed ? " active" : ""}`}>Closed</Link>
        </div>
        {requests.length === 0 ? <Card><Empty title={closed ? "No closed requests" : "No open requests"} /></Card> : requests.map((r) => {
          const have = filled.get(r.id) ?? 0;
          const on = allocatedTo.filter((a) => a.requestId === r.id).map((a) => a.employeeId);
          const candidates = r.status === "OPEN" && manage ? benchFor(people, Number(r.allocationPercent), r.startDate, r.endDate, on).slice(0, 5) : [];
          return (
            <Card key={r.id}
              title={<>{r.count} × {r.billingRole.name} for {r.project ? <Link href={`/projects/${r.project.id}`}>{r.project.name}</Link> : "an opportunity"}</>}
              description={`${Number(r.allocationPercent)}% from ${iso(r.startDate)}${r.endDate ? ` to ${iso(r.endDate)}` : ""} · raised by ${requesters.get(r.requestedById) ?? "someone"}${r.type === "RESOURCE" && r.employeeId ? ` · asks for ${named.get(r.employeeId) ?? "a named person"}` : ""}${r.skills.length ? ` · ${r.skills.join(", ")}` : ""}${r.minExperienceYears ? ` · ${r.minExperienceYears}+ yrs` : ""}`}
              action={<div className="row gap-1">{isCritical(r, today) ? <Badge tone="danger">Starts soon</Badge> : null}<Badge tone={PRIORITY[r.priority] ?? "neutral"}>{r.priority.toLowerCase()}</Badge><Badge tone={STATUS[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge></div>}>
              <div className="stack gap-2">
                {r.notes ? <div className="text-sm">{r.notes}</div> : null}
                <div className="text-sm subtle">{have} of {r.count} filled{r.closeReason && closed ? ` · ${r.closeReason}` : ""}</div>
                {candidates.length ? <div className="text-sm">Free from the bench: {candidates.map((c) => `${c.name} (${c.free}% free)`).join(", ")}</div> : r.status === "OPEN" && manage ? <div className="text-sm subtle">Nobody on the bench has {Number(r.allocationPercent)}% free for these dates.</div> : null}
                {r.status === "OPEN" && manage ? (
                  <AllocateForm requestId={r.id} projects={projects.map((p) => ({ value: p.id, label: p.name }))} roles={roles.map((x) => x.name)}
                    people={[...candidates, ...people.filter((p) => !candidates.some((c) => c.id === p.id))].map((p) => ({ value: p.id, label: `${p.name} (${p.number})` }))}
                    defaults={{ projectId: r.projectId ?? undefined, employeeId: r.type === "RESOURCE" ? r.employeeId ?? undefined : candidates[0]?.id, billingRole: r.billingRole.name, allocationPercent: Number(r.allocationPercent), startDate: iso(r.startDate), endDate: r.endDate ? iso(r.endDate) : undefined }} />
                ) : null}
                {!closed && manage ? <RequestOps id={r.id} canHire={r.status === "OPEN"} /> : null}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
