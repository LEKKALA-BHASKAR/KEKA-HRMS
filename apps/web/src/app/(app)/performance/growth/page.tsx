import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { growthItemsOf } from "@keka/services";
import { requireViewer, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Progress } from "@/components/ui";
import { inPerformanceWorkspace } from "../_parts/access";
import { Disclosure } from "../_parts/disclosure";
import { GrowthTemplateForm, ToggleGrowthTemplate, StartGrowthPlanForm, GrowthItemToggle } from "../_parts/talent-forms";

const P = PERMISSIONS;

/**
 * Performance › Growth Plans: templates HR maintains (skills, courses,
 * milestones, mentoring with due dates), and the plans started from them for
 * a manager's reports or anyone in HR's scope.
 */
export default async function GrowthPlansPage() {
  const viewer = await requireViewer();
  if (!inPerformanceWorkspace(viewer) && !canAny(viewer, [P.CAREER_PATH_MANAGE])) redirect("/me/performance/growth");
  const manage = canAny(viewer, [P.PERFORMANCE_MANAGE, P.CAREER_PATH_MANAGE]);
  const reach = { OR: [{ id: { in: [...viewer.allReportIds] } }, ...(manage ? [scopedEmployeeWhere(viewer, P.PERFORMANCE_MANAGE)] : [])] };
  const [templates, plans, people] = await Promise.all([
    prisma.growthPlanTemplate.findMany({ where: { tenantId: viewer.tenantId, ...(manage ? {} : { isActive: true }) }, orderBy: [{ isActive: "desc" }, { name: "asc" }] }),
    prisma.growthPlan.findMany({ where: { tenantId: viewer.tenantId, employee: reach }, include: { employee: { select: { displayName: true, employeeNumber: true } }, items: { orderBy: { displayOrder: "asc" } } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200 }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] }, NOT: { id: viewer.employee?.id ?? "__none__" }, ...reach }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { displayName: "asc" }, take: 1000 }),
  ]);
  return (
    <>
      <PageHead title="Growth plans" subtitle="Structured development plans from templates — skills to build, courses, milestones and mentoring" />
      <div className="stack gap-4">
        <Card title="Start a plan" description="For one of your reports, or anyone in your HR scope. They are notified and can tick items off.">
          {templates.some((t) => t.isActive) && people.length ? (
            <StartGrowthPlanForm templates={templates.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name }))} people={people.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.employeeNumber}` }))} />
          ) : <Empty title={templates.length ? "Nobody to start a plan for" : "No templates yet"}>{manage ? "Add a template below first." : "HR has not added growth plan templates yet."}</Empty>}
        </Card>
        <Card tight title={`Plans (${plans.length})`}>
          {plans.length === 0 ? <Empty title="No growth plans yet" /> : (
            <div className="table-wrap"><table className="data"><tbody>
              {plans.map((p) => {
                const done = p.items.filter((i) => i.doneAt).length;
                return (
                  <tr key={p.id} style={{ verticalAlign: "top" }}>
                    <td style={{ width: 220 }}><Person name={p.employee.displayName ?? ""} meta={p.employee.employeeNumber} /></td>
                    <td>
                      <div className="strong text-sm">{p.title} <Badge tone={p.status === "COMPLETED" ? "success" : "info"}>{p.status.toLowerCase()}</Badge></div>
                      <ul className="text-sm" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                        {p.items.map((i) => (
                          <li key={i.id} style={{ marginBottom: 4 }}>
                            <span style={{ textDecoration: i.doneAt ? "line-through" : undefined }}>{i.title}</span> <span className="text-xs subtle">{i.kind.toLowerCase()}{i.dueDate ? ` · due ${formatDate(i.dueDate)}` : ""}</span>{" "}
                            {p.status === "ACTIVE" ? <GrowthItemToggle id={i.id} done={!!i.doneAt} /> : null}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td style={{ width: 180 }}><Progress value={done} max={p.items.length || 1} /><div className="text-xs subtle">{done} of {p.items.length} done · since {formatDate(p.startDate)}</div></td>
                  </tr>
                );
              })}
            </tbody></table></div>
          )}
        </Card>
        <Card tight title={`Templates (${templates.length})`}>
          {manage ? <div style={{ padding: 14 }}><Disclosure label="New template"><GrowthTemplateForm /></Disclosure></div> : null}
          {templates.length === 0 ? <Empty title="No templates yet" /> : (
            <div className="table-wrap"><table className="data"><tbody>
              {templates.map((t) => (
                <tr key={t.id} style={{ verticalAlign: "top" }}>
                  <td><div className="strong text-sm">{t.name} {t.isActive ? null : <Badge>archived</Badge>}</div>{t.description ? <div className="text-xs subtle">{t.description}</div> : null}</td>
                  <td className="text-sm">{growthItemsOf(t.items).map((i, k) => <div key={k}>{i.title} <span className="text-xs subtle">{i.kind.toLowerCase()}{i.dueInDays !== null ? ` · ${i.dueInDays} days` : ""}</span></div>)}</td>
                  <td className="right">{manage ? <ToggleGrowthTemplate id={t.id} active={t.isActive} /> : null}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Card>
      </div>
    </>
  );
}
