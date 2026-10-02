import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { journeyProgress } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat, Progress } from "@/components/ui";
import { InitiateExitForm } from "../_lifecycle/forms";
import { Disclosure } from "../org/forms";

const P = PERMISSIONS;
const STATUS_TONE: Record<string, "warning" | "info" | "success" | "neutral" | "danger"> = {
  INITIATED: "warning", PENDING_APPROVAL: "warning", APPROVED: "info", IN_CLEARANCE: "info",
  SETTLED: "success", COMPLETED: "success", REJECTED: "neutral", RETAINED: "neutral", CANCELLED: "neutral",
};

export default async function ExitsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.EXIT_MANAGE, P.EXIT_APPROVE, P.FNF_MANAGE, P.EXIT_INITIATE])) redirect("/me/exit");
  const { view } = await searchParams;
  const active = view !== "closed";

  // Widest permission the viewer holds decides whose exits they see.
  const perm = can(viewer, P.EXIT_MANAGE) ? P.EXIT_MANAGE : can(viewer, P.FNF_MANAGE) ? P.FNF_MANAGE : can(viewer, P.EXIT_APPROVE) ? P.EXIT_APPROVE : P.EXIT_INITIATE;
  const scope = scopedEmployeeWhere(viewer, perm);

  const [exits, candidates] = await Promise.all([
    prisma.exitRecord.findMany({
      where: {
        employee: { ...scope, NOT: viewer.employee ? { id: viewer.employee.id } : undefined },
        status: active ? { in: ["INITIATED", "PENDING_APPROVAL", "APPROVED", "IN_CLEARANCE"] } : { in: ["SETTLED", "COMPLETED", "REJECTED", "RETAINED", "CANCELLED"] },
      },
      include: {
        employee: {
          select: {
            id: true, displayName: true, employeeNumber: true, department: { select: { name: true } },
            fnfSettlement: { select: { status: true, netSettlement: true } },
            journeys: { where: { trigger: "EXIT", status: { not: "CANCELLED" } }, select: { id: true, tasks: { select: { status: true, isRequired: true, dueDate: true } } } },
          },
        },
      },
      orderBy: { lastWorkingDay: "asc" },
    }),
    can(viewer, P.EXIT_INITIATE)
      ? prisma.employee.findMany({
          where: { ...scopedEmployeeWhere(viewer, P.EXIT_INITIATE), status: { notIn: ["EXITED", "NOTICE_PERIOD"] }, NOT: viewer.employee ? { id: viewer.employee.id } : undefined },
          select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const count = (s: string[]) => exits.filter((e) => s.includes(e.status)).length;
  const today = new Date();

  return (
    <>
      <PageHead title="Exits" subtitle="Resignations, clearance and full-and-final settlement" />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Awaiting approval" value={String(count(["INITIATED", "PENDING_APPROVAL"]))} meta="resignations to decide" />
        <Stat label="Serving notice" value={String(exits.filter((e) => e.status === "APPROVED" && e.lastWorkingDay >= today).length)} meta="approved, still working" />
        <Stat label="In clearance" value={String(exits.filter((e) => e.lastWorkingDay < today && ["APPROVED", "IN_CLEARANCE"].includes(e.status)).length)} meta="left, settlement open" />
        <Stat label="Settlements to finalise" value={String(exits.filter((e) => e.employee.fnfSettlement?.status === "IN_REVIEW").length)} meta="drafted, under review" />
      </div>

      {candidates.length > 0 ? (
        <Card title="Initiate an exit" description="Resignations wait for approval; HR-recorded exits take effect immediately and start the exit checklist.">
          <Disclosure label="Initiate exit">
            <InitiateExitForm canRecordAll={can(viewer, P.EXIT_MANAGE)}
              reasons={(await prisma.exitReason.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }] }))
                .map((r) => ({ value: r.id, label: `${r.name}${r.kind === "INVOLUNTARY" ? " (involuntary)" : ""}` }))}
              employees={candidates.map((e) => ({ value: e.id, label: `${e.employeeNumber} — ${e.displayName}` }))} />
          </Disclosure>
        </Card>
      ) : null}

      <div className="tabs" style={{ marginTop: 16 }}>
        <Link href="/exits" className={`tab${active ? " active" : ""}`}>In progress</Link>
        <Link href="/exits?view=closed" className={`tab${!active ? " active" : ""}`}>Closed</Link>
        {canAny(viewer, [P.FNF_MANAGE, P.FNF_APPROVE]) ? <Link href="/exits/settlements" className="tab">Settlements report</Link> : null}
      </div>
      <Card tight>
        {exits.length === 0 ? <Empty title={active ? "No exits in progress" : "No closed exits"} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Type</th><th>Notice</th><th>Last day</th><th>Status</th><th style={{ width: 160 }}>Exit readiness</th><th className="num">Settlement</th><th /></tr></thead>
              <tbody>
                {exits.map((x) => {
                  const j = x.employee.journeys[0];
                  const p = j ? journeyProgress(j.tasks) : null;
                  const s = x.employee.fnfSettlement;
                  return (
                    <tr key={x.id}>
                      <td><Person name={x.employee.displayName ?? ""} meta={`${x.employee.employeeNumber} · ${x.employee.department?.name ?? ""}`} /></td>
                      <td className="text-sm">{x.type.replace(/_/g, " ").toLowerCase()}</td>
                      <td className="nowrap text-sm">{formatDate(x.noticeDate)}</td>
                      <td className="nowrap text-sm">
                        {formatDate(x.lastWorkingDay)}
                        {Number(x.noticeBuyoutDays ?? 0) > 0 ? <div className="text-xs" style={{ color: "var(--warning)" }}>{Number(x.noticeBuyoutDays)}d short</div> : null}
                      </td>
                      <td><Badge tone={STATUS_TONE[x.status]}>{x.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                      <td>
                        {p ? (
                          <>
                            <Progress value={p.done} max={Math.max(1, p.total)} tone={p.overdue ? "warning" : "success"} />
                            <div className="text-xs subtle" style={{ marginTop: 3 }}>{p.pct}%{p.overdue ? ` · ${p.overdue} overdue` : ""}</div>
                          </>
                        ) : <span className="text-xs subtle">starts on approval</span>}
                      </td>
                      <td className="num text-sm">
                        {s ? <>{formatINR(Number(s.netSettlement))}<div className="text-xs subtle">{s.status.replace(/_/g, " ").toLowerCase()}</div></> : <span className="subtle">—</span>}
                      </td>
                      <td className="right"><Link className="btn sm" href={`/exits/${x.id}`}>Open</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
