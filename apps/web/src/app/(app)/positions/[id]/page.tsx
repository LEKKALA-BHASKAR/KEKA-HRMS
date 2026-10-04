import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { postingReadiness, daysBetween } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { orgNames, auditTrail } from "@/lib/workforce";
import { PageHead, Card, KeyValue, Badge, Empty } from "@/components/ui";
import { Disclosure, SimpleForm, ActionButton, F, Select } from "@/components/workforce-ui";
import { StatusPill, RequestsTable, AuditTable, inr } from "@/components/workforce-tables";
import {
  savePositionAction, requestPositionChangeAction, fillPositionAction, vacatePositionAction, clonePositionAction, raiseRequisitionForPositionAction,
} from "@/app/actions/positions";
import { PositionFields } from "../fields";

const P = PERMISSIONS;

export default async function PositionPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.POSITION_VIEW);
  const { id } = await params;
  const p = await prisma.position.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { job: { include: { family: true, level: true } }, reportsTo: { select: { id: true, code: true, title: true } }, directReports: { select: { id: true, code: true, title: true, status: true } }, incumbencies: { orderBy: { startDate: "desc" } } },
  });
  if (!p) notFound();
  const canManage = can(viewer, P.POSITION_MANAGE);
  const [names, requests, audit, users, others, requisition] = await Promise.all([
    orgNames(viewer.tenantId),
    prisma.workforceRequest.findMany({ where: { tenantId: viewer.tenantId, entityType: "Position", entityId: p.id }, orderBy: { requestedAt: "desc" } }),
    auditTrail(viewer.tenantId, ["Position"], p.id),
    prisma.user.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, email: true } }),
    prisma.position.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["CLOSED", "REJECTED"] }, NOT: { id: p.id } }, select: { id: true, code: true, title: true }, orderBy: { code: "asc" } }),
    p.requisitionId ? prisma.requisition.findFirst({ where: { id: p.requisitionId, tenantId: viewer.tenantId }, select: { id: true, code: true, status: true } }) : null,
  ]);
  const grade = p.payGradeId ? names.payGrades.find((g) => g.id === p.payGradeId) : null;
  const readiness = postingReadiness({
    status: p.status, jobStatus: p.job?.status ?? null, hasDescription: !!(p.job?.summary || p.job?.responsibilities),
    budgetedAnnualSalary: p.budgetedAnnualSalary === null ? null : Number(p.budgetedAnnualSalary), budgetStatus: p.budgetStatus,
    payGradeId: p.payGradeId, skills: p.skills, locationId: p.locationId, departmentId: p.departmentId, requisitionId: requisition && ["PENDING_APPROVAL", "APPROVED", "ON_HOLD", "DRAFT"].includes(requisition.status) ? requisition.id : null,
  });
  const opt = <T extends { id: string; name: string }>(xs: T[]) => xs.map((x) => ({ value: x.id, label: x.name }));
  const opts = {
    jobs: names.jobs.filter((j) => j.status !== "RETIRED").map((j) => ({ value: j.id, label: `${j.code} ${j.title}` })),
    departments: opt(names.departments), locations: opt(names.locations), costCenters: opt(names.costCenters), payGrades: opt(names.payGrades),
    positions: others.map((o) => ({ value: o.id, label: `${o.code} ${o.title}` })),
  };
  const empOpts = names.employees.filter((e) => e.status !== "EXITED").map((e) => ({ value: e.id, label: `${e.displayName ?? `${e.firstName} ${e.lastName}`} (${e.employeeNumber})` }));
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  return (
    <>
      <PageHead
        title={<>{p.code} · {p.title}</>}
        subtitle={<><StatusPill status={p.status} /> {p.departmentId ? names.dept.get(p.departmentId) : ""}{p.locationId ? ` · ${names.loc.get(p.locationId)}` : ""}</>}
        actions={<Link className="btn sm" href="/positions">All positions</Link>}
      />
      <div className="grid grid-2">
        <Card title="Position">
          <KeyValue items={[
            ["Job", p.job ? <Link href={`/positions/jobs/${p.job.id}`}>{p.job.code} {p.job.title}</Link> : null],
            ["Family / level", p.job ? `${p.job.family?.name ?? "—"} / ${p.job.level?.name ?? "—"}` : null],
            ["Cost centre", p.costCenterId ? names.cc.get(p.costCenterId) : null],
            ["Reports to", p.reportsTo ? <Link href={`/positions/${p.reportsTo.id}`}>{p.reportsTo.code} {p.reportsTo.title}</Link> : null],
            ["Budgeted salary", <>{inr(p.budgetedAnnualSalary)} <Badge>{p.budgetStatus.toLowerCase()}</Badge></>],
            ["Compensation range", grade ? `${grade.name}: ${inr(grade.minAnnual)} – ${inr(grade.maxAnnual)}` : null],
            ["FTE", String(Number(p.fte))],
            ["Headcount", p.isHeadcount ? "Counts toward headcount" : "Not a headcount seat"],
            ["Criticality", p.criticality],
            ["Work mode", p.workMode.toLowerCase()],
            ["Also fillable from", p.allowedLocationIds.map((l) => names.loc.get(l)).join(", ") || null],
            ["Skills", p.skills.join(", ") || null],
            ["Competencies", p.competencies.join(", ") || null],
            ["Effective", `${formatDate(p.effectiveFrom)}${p.effectiveTo ? ` → ${formatDate(p.effectiveTo)}` : ""}`],
            ["Incumbent", p.incumbentEmployeeId ? names.emp.get(p.incumbentEmployeeId) : null],
            ["Vacant since", p.vacantSince ? `${formatDate(p.vacantSince)} (${daysBetween(p.vacantSince, new Date())} days, ${p.vacancyReason?.toLowerCase() ?? "—"})` : null],
            ["Frozen", p.frozenAt ? `${formatDate(p.frozenAt)}: ${p.frozenReason ?? ""}` : null],
            ["Requisition", requisition ? <Link href={`/hiring/requisitions?req=${requisition.id}`}>{requisition.code} ({requisition.status.toLowerCase().replace("_", " ")})</Link> : null],
            ["Direct reports", p.directReports.map((d) => d.code).join(", ") || null],
          ]} />
        </Card>
        <Card title="Job posting readiness" description={readiness.ready ? "Ready to recruit for." : "Complete these before advertising the seat."}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {readiness.items.map((i) => <li key={i.key} className="text-sm" style={{ padding: "4px 0" }}>{i.done ? "✓" : "○"} {i.label}</li>)}
          </ul>
          {canManage && p.status === "VACANT" && can(viewer, P.REQUISITION_MANAGE) ? (
            <div style={{ marginTop: 12 }}><ActionButton action={raiseRequisitionForPositionAction} hidden={{ id: p.id }} label="Raise requisition" variant="primary" /></div>
          ) : null}
        </Card>
      </div>

      {canManage && !["CLOSED", "REJECTED"].includes(p.status) ? (
        <Card title="Maintain">
          <div className="row gap-2 wrap" style={{ alignItems: "flex-start" }}>
            <Disclosure label="Edit position" variant="default">
              <SimpleForm action={savePositionAction} hidden={{ id: p.id }}>
                <PositionFields opts={opts} d={{ ...p, budgetedAnnualSalary: p.budgetedAnnualSalary === null ? null : Number(p.budgetedAnnualSalary), fte: Number(p.fte), effectiveFrom: iso(p.effectiveFrom) ?? undefined, effectiveTo: iso(p.effectiveTo) }} />
              </SimpleForm>
            </Disclosure>
            {p.status === "VACANT" ? (
              <Disclosure label="Fill" variant="default">
                <SimpleForm action={fillPositionAction} hidden={{ id: p.id }} submitLabel="Assign incumbent">
                  <F label="Employee"><Select name="employeeId" options={empOpts} placeholder="Choose" required /></F>
                  <F label="Start date"><input className="input" type="date" name="startDate" defaultValue={new Date().toISOString().slice(0, 10)} /></F>
                </SimpleForm>
              </Disclosure>
            ) : null}
            {p.status === "FILLED" ? (
              <Disclosure label="Vacate" variant="default">
                <SimpleForm action={vacatePositionAction} hidden={{ id: p.id }} submitLabel="Vacate">
                  <F label="Vacancy reason"><Select name="vacancyReason" options={["RESIGNATION", "TERMINATION", "TRANSFER", "PROMOTION", "RETIREMENT"].map((v) => ({ value: v, label: v.toLowerCase() }))} required /></F>
                </SimpleForm>
              </Disclosure>
            ) : null}
            {["VACANT", "FROZEN"].includes(p.status) ? (
              <Disclosure label={p.status === "FROZEN" ? "Unfreeze or close" : "Freeze or close"} variant="default">
                <SimpleForm action={requestPositionChangeAction} hidden={{ id: p.id }} submitLabel="Send for approval">
                  <F label="Change"><Select name="change" options={[...(p.status === "VACANT" ? [{ value: "freeze", label: "Freeze" }] : [{ value: "unfreeze", label: "Unfreeze" }]), { value: "close", label: "Close" }]} /></F>
                  <F label="Reason"><input className="input" name="reason" required maxLength={500} /></F>
                </SimpleForm>
              </Disclosure>
            ) : null}
            <Disclosure label="Clone" variant="default">
              <SimpleForm action={clonePositionAction} hidden={{ id: p.id }} submitLabel="Create copies">
                <F label="Copies"><input className="input" type="number" name="count" min={1} max={20} defaultValue={1} /></F>
                <F label="Title for the copies"><input className="input" name="title" defaultValue={p.title} /></F>
              </SimpleForm>
            </Disclosure>
          </div>
        </Card>
      ) : null}

      <Card title="Incumbency history">
        {p.incumbencies.length === 0 ? <Empty title="Nobody has held this position yet." /> : (
          <table className="data"><thead><tr><th>Employee</th><th>From</th><th>To</th><th>Why it ended</th></tr></thead>
            <tbody>{p.incumbencies.map((i) => <tr key={i.id}><td>{names.emp.get(i.employeeId) ?? "—"}</td><td>{formatDate(i.startDate)}</td><td>{i.endDate ? formatDate(i.endDate) : "Current"}</td><td>{i.endReason ?? ""}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      <Card title="Approval history"><RequestsTable rows={requests} viewer={viewer} users={new Map(users.map((u) => [u.id, u.email]))} /></Card>
      <Card title="Lifecycle audit trail"><AuditTable rows={audit} /></Card>
    </>
  );
}
