import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";
import { employeeNames, fmtDay, matches, pretty } from "@/lib/engage-depth";
import { PageHead, Card, Callout, Stat, Badge } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { saveServiceTypeAction, toggleServiceTypeAction, requestServiceAction, serviceRequestOpAction, rateServiceAction } from "@/app/actions/engage-wellness";
import { withdrawWorkflowAction } from "@/app/actions/workflows";

const P = PERMISSIONS;
const ALL_TABS = { catalog: "Request a service", mine: "My requests", queue: "Fulfilment queue", setup: "Service catalog setup", reports: "Reports" };
type Tab = keyof typeof ALL_TABS;
const CATS = ["ID_CARD", "PARKING", "VISA_LETTER", "TRANSPORT", "CAFETERIA", "WORKSPACE", "ERGONOMICS", "ACCOMMODATION", "WELLNESS_APPOINTMENT", "EAP", "FACILITY", "OTHER"];

/** Employee services: a catalog of requestable services with approval, SLA-tracked fulfilment, ratings and reports. */
export default async function ServicesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const admin = can(viewer, P.SERVICE_MANAGE);
  const tabs = Object.fromEntries(Object.entries(ALL_TABS).filter(([k]) => admin || !["queue", "setup", "reports"].includes(k))) as Record<string, string>;
  const tab: Tab = (sp.tab ?? "") in tabs ? (sp.tab as Tab) : "catalog";
  const t = viewer.tenantId;
  return (
    <>
      <PageHead title="Employee Services" subtitle="ID cards, parking, letters, workspace and more — requested, approved and fulfilled in one place" actions={<Link className="btn" href="/engage/wellness?tab=support">Support & benefits</Link>} />
      <Tabs base="/engage/services" tabs={tabs} active={tab} />
      {tab === "catalog" ? <Catalog tenantId={t} q={sp.q} hasEmployee={!!viewer.employee} /> : null}
      {tab === "mine" ? <Mine tenantId={t} userId={viewer.user.id} /> : null}
      {tab === "queue" && admin ? <Queue tenantId={t} status={sp.status} q={sp.q} userId={viewer.user.id} /> : null}
      {tab === "setup" && admin ? <Setup tenantId={t} editId={sp.edit} /> : null}
      {tab === "reports" && admin ? <Reports tenantId={t} /> : null}
    </>
  );
}

async function Catalog({ tenantId, q, hasEmployee }: { tenantId: string; q?: string; hasEmployee: boolean }) {
  const types = (await prisma.serviceType.findMany({ where: { tenantId, isActive: true }, orderBy: [{ category: "asc" }, { name: "asc" }] })).filter((x) => matches(q, x.name, x.description, x.category));
  return (
    <div className="stack gap-4">
      <form method="get" className="row gap-2"><input type="hidden" name="tab" value="catalog" /><input className="input" name="q" defaultValue={q ?? ""} placeholder="Search services…" /><button className="btn sm">Search</button></form>
      {types.length === 0 ? <Callout title="No services listed">The service team has not published anything matching yet.</Callout> : (
        <div className="grid grid-2">
          {types.map((x) => (
            <Card key={x.id} title={x.name} description={x.description ?? undefined} action={<Badge>{pretty(x.category)}</Badge>}>
              <div className="text-xs muted" style={{ marginBottom: 8 }}>{x.requiresApproval ? "Needs approval · " : ""}Usually done within {x.slaDays} day{x.slaDays === 1 ? "" : "s"}{x.confidential ? " · Confidential" : ""}</div>
              {hasEmployee ? (
                <details><summary className="btn sm primary" style={{ display: "inline-block" }}>Request</summary>
                  <div style={{ marginTop: 10 }}>
                    <SpecForm action={requestServiceAction} hidden={{ typeId: x.id }} submitLabel="Submit request" columns={1} fields={[
                      ...x.fields.map((label, i) => ({ name: `f_${i}`, label, required: true })),
                      { name: "details", label: "Anything else", type: "textarea" as const },
                    ]} />
                  </div>
                </details>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

async function Mine({ tenantId, userId }: { tenantId: string; userId: string }) {
  const rows = await prisma.serviceRequest.findMany({ where: { tenantId, requesterUserId: userId }, orderBy: { createdAt: "desc" } });
  const types = new Map((await prisma.serviceType.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  return (
    <Card tight title="My service requests">
      <Table head={["Service", "Requested", "Due", "Status", "Outcome", ""]} empty={rows.length === 0}>
        {rows.map((r) => (
          <tr key={r.id}>
            <td><strong>{types.get(r.typeId)}</strong><div className="text-xs muted">{Object.entries((r.answers as Record<string, string> | null) ?? {}).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div></td>
            <td>{fmtDay(r.createdAt)}</td><td>{r.dueOn ? fmtDay(r.dueOn) : "—"}</td><td><Pill s={r.status} /></td><td className="text-xs">{r.fulfilmentNote ?? ""}</td>
            <td className="row gap-2">
              {r.status === "PENDING_APPROVAL" && r.workflowRequestId ? <ActButton action={withdrawWorkflowAction} hidden={{ requestId: r.workflowRequestId }} label="Withdraw" variant="ghost" /> : null}
              {["OPEN", "IN_PROGRESS"].includes(r.status) ? <ActButton action={serviceRequestOpAction} hidden={{ id: r.id, op: "cancel" }} label="Cancel" variant="ghost" confirmText="Cancel this request?" /> : null}
              {r.status === "FULFILLED" && r.rating === null ? <ActButton action={rateServiceAction} hidden={{ id: r.id }} label="Rate" input={{ name: "rating", placeholder: "1–5", required: true }} /> : null}
              {r.rating !== null ? <span className="text-xs">Rated {r.rating}/5</span> : null}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Queue({ tenantId, status, q, userId }: { tenantId: string; status?: string; q?: string; userId: string }) {
  const rows = await prisma.serviceRequest.findMany({ where: { tenantId, ...(status ? { status } : { status: { in: ["OPEN", "IN_PROGRESS"] } }) }, orderBy: [{ dueOn: "asc" }, { createdAt: "asc" }] });
  const types = new Map((await prisma.serviceType.findMany({ where: { tenantId } })).map((x) => [x.id, x]));
  const names = await employeeNames(tenantId, rows.map((r) => r.employeeId));
  const now = new Date();
  const shown = rows.filter((r) => matches(q, types.get(r.typeId)?.name, names.get(r.employeeId)));
  return (
    <Card tight title="Fulfilment queue" description="Requests that need approval reach this queue once approved." action={<a className="btn sm" href="/engage/export?report=service-requests">Export CSV</a>}>
      <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="queue" />
        <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search by person or service…" />
        <select className="select" name="status" defaultValue={status ?? ""} style={{ width: 200 }}><option value="">Open and in progress</option>{["PENDING_APPROVAL", "OPEN", "IN_PROGRESS", "FULFILLED", "REJECTED", "CANCELLED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select>
        <button className="btn sm">Filter</button></form>
      <Table head={["Service", "Employee", "Details", "Due", "Status", ""]} empty={shown.length === 0}>
        {shown.map((r) => {
          const ty = types.get(r.typeId);
          const late = r.dueOn && r.dueOn < now && ["OPEN", "IN_PROGRESS"].includes(r.status);
          return (
            <tr key={r.id}>
              <td><strong>{ty?.name}</strong>{ty?.confidential ? <div><Badge tone="warning">Confidential</Badge></div> : null}</td>
              <td>{names.get(r.employeeId)}</td>
              <td className="text-xs">{Object.entries((r.answers as Record<string, string> | null) ?? {}).map(([k, v]) => <div key={k}>{k}: {v}</div>)}{r.details ? <div>{r.details}</div> : null}</td>
              <td>{r.dueOn ? <span className={late ? "neg" : ""}>{fmtDay(r.dueOn)}{late ? " (late)" : ""}</span> : "—"}</td>
              <td><Pill s={r.status} /></td>
              <td className="stack gap-2">{r.requesterUserId !== userId ? <>
                {r.status === "OPEN" ? <ActButton action={serviceRequestOpAction} hidden={{ id: r.id, op: "start" }} label="Pick up" /> : null}
                {["OPEN", "IN_PROGRESS"].includes(r.status) ? <ActButton action={serviceRequestOpAction} hidden={{ id: r.id, op: "fulfil" }} label="Fulfil" variant="primary" input={{ name: "note", placeholder: "What was done", required: true }} /> : null}
                {["OPEN", "IN_PROGRESS"].includes(r.status) ? <ActButton action={serviceRequestOpAction} hidden={{ id: r.id, op: "reject" }} label="Decline" variant="danger" input={{ name: "note", placeholder: "Reason", required: true }} /> : null}
              </> : <span className="text-xs muted">Your own request</span>}</td>
            </tr>
          );
        })}
      </Table>
    </Card>
  );
}

async function Setup({ tenantId, editId }: { tenantId: string; editId?: string }) {
  const types = await prisma.serviceType.findMany({ where: { tenantId }, orderBy: [{ category: "asc" }, { name: "asc" }] });
  const e = editId ? types.find((x) => x.id === editId) : undefined;
  return (
    <div className="stack gap-4">
      <Card tight title="Services">
        <Table head={["Service", "Category", "Form fields", "Approval", "SLA", "Status", ""]} empty={types.length === 0}>
          {types.map((x) => (
            <tr key={x.id}>
              <td><strong>{x.name}</strong>{x.confidential ? <div className="text-xs muted">Confidential</div> : null}</td><td>{pretty(x.category)}</td><td className="text-xs">{x.fields.join(", ") || "—"}</td>
              <td>{x.requiresApproval ? "Manager" : "None"}</td><td>{x.slaDays}d</td><td><Pill s={x.isActive ? "ACTIVE" : "RETIRED"} /></td>
              <td className="row gap-2"><ActButton action={toggleServiceTypeAction} hidden={{ id: x.id }} label={x.isActive ? "Retire" : "Reactivate"} variant="ghost" /><Link className="btn sm ghost" href={`/engage/services?tab=setup&edit=${x.id}`}>Edit</Link></td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card key={e?.id ?? "new"} title={e ? `Edit "${e.name}"` : "Add a service"} description="Approval routes through the workflow engine (Admin › Workflows can define a custom chain for SERVICE_REQUEST).">
        <SpecForm action={saveServiceTypeAction} hidden={e ? { id: e.id } : undefined} submitLabel={e ? "Save service" : "Add service"} fields={[
          { name: "name", label: "Name", required: true, defaultValue: e?.name },
          { name: "category", label: "Category", type: "select", required: true, defaultValue: e?.category ?? "OTHER", options: CATS.map((v) => ({ value: v, label: pretty(v) })) },
          { name: "slaDays", label: "Fulfil within (days)", type: "number", defaultValue: e?.slaDays ?? 3 },
          { name: "requiresApproval", label: "Approval", type: "checkbox", defaultValue: e ? e.requiresApproval : true, placeholder: "Needs manager approval first" },
          { name: "confidential", label: "Confidential", type: "checkbox", defaultValue: e?.confidential ?? false, placeholder: "Hide details from approvers" },
          { name: "fields", label: "Form fields, one per line", type: "textarea", defaultValue: e?.fields.join("\n") },
          { name: "description", label: "Description", type: "textarea", wide: true, defaultValue: e?.description },
        ]} />
      </Card>
    </div>
  );
}

async function Reports({ tenantId }: { tenantId: string }) {
  const [rows, types] = await Promise.all([
    prisma.serviceRequest.findMany({ where: { tenantId }, select: { typeId: true, status: true, createdAt: true, fulfilledAt: true, dueOn: true, rating: true } }),
    prisma.serviceType.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);
  const done = rows.filter((r) => r.status === "FULFILLED" && r.fulfilledAt);
  const onTime = done.filter((r) => !r.dueOn || r.fulfilledAt! <= r.dueOn).length;
  const rated = rows.filter((r) => r.rating !== null);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Requests" value={rows.length} meta={`${rows.filter((r) => ["OPEN", "IN_PROGRESS", "PENDING_APPROVAL"].includes(r.status)).length} open`} />
        <Stat label="Fulfilled" value={done.length} />
        <Stat label="On time" value={done.length ? `${Math.round((onTime / done.length) * 100)}%` : "—"} />
        <Stat label="Satisfaction" value={avg(rated.map((r) => r.rating!)) ?? "—"} meta={`${rated.length} ratings`} />
      </div>
      <Card tight title="By service" action={<a className="btn sm" href="/engage/export?report=service-requests">Export CSV</a>}>
        <Table head={["Service", "Requests", "Open", "Fulfilled", "Avg days to fulfil", "Rating"]} empty={types.length === 0}>
          {types.map((ty) => {
            const rs = rows.filter((r) => r.typeId === ty.id);
            const d = rs.filter((r) => r.status === "FULFILLED" && r.fulfilledAt);
            return <tr key={ty.id}><td>{ty.name}</td><td>{rs.length}</td><td>{rs.filter((r) => ["OPEN", "IN_PROGRESS", "PENDING_APPROVAL"].includes(r.status)).length}</td><td>{d.length}</td><td>{avg(d.map((r) => (r.fulfilledAt!.getTime() - r.createdAt.getTime()) / 86_400_000)) ?? "—"}</td><td>{avg(rs.filter((r) => r.rating !== null).map((r) => r.rating!)) ?? "—"}</td></tr>;
          })}
        </Table>
      </Card>
    </div>
  );
}
