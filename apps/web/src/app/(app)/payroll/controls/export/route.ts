import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { latestValidation, varianceBreaches, closeChecklist, componentHierarchy, payrollTrace, payrollInputAudit, lwfReconciliation, OPS_SIGNOFF_TYPES, type OpsIssue } from "@keka/services";
import { getViewer, canAny } from "@/lib/context";
import { opsCsv, d10, monthParam } from "@/lib/ops-export";

/** CSV downloads for Payroll controls. */
export async function GET(req: NextRequest) {
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in first.", { status: 401 });
  if (!canAny(v, [P.PAYROLL_RUN, P.PAYROLL_LOCK, P.PAYROLL_SETTINGS, P.PAYROLL_APPROVE, P.STATUTORY_MANAGE])) return new NextResponse("Forbidden.", { status: 403 });
  const sp = req.nextUrl.searchParams;
  const t = v.tenantId;
  const run = sp.get("run") ? await prisma.payrollRun.findFirst({ where: { id: sp.get("run")!, tenantId: t }, select: { id: true, year: true, month: true } }) : await prisma.payrollRun.findFirst({ where: { tenantId: t, rolledBackAt: null }, orderBy: [{ year: "desc" }, { month: "desc" }], select: { id: true, year: true, month: true } });
  const tag = run ? `${run.year}-${String(run.month).padStart(2, "0")}` : "none";
  const needRun = () => new NextResponse("Pick a payroll run.", { status: 400 });
  switch (sp.get("tab") ?? "validation") {
    case "validation": {
      if (!run) return needRun();
      const last = await latestValidation(t, run.id);
      const issues = (last?.issues ?? []) as unknown as OpsIssue[];
      return opsCsv(v, "PAYROLL", "OpsPayrollValidation", `payroll-validation-${tag}`, ["Severity", "Employee", "Check", "Detail"], issues.map((i) => [i.severity, i.employee, i.code, i.message]));
    }
    case "variance": {
      if (!run) return needRun();
      const b = await varianceBreaches(t, run.id);
      return opsCsv(v, "PAYROLL", "OpsVarianceRule", `payroll-variance-${tag}`, ["Employee", "Rule", "Severity", "Previous", "This run", "Change", "Change %", "Reviewed note"], (b?.rows ?? []).map((r) => [r.employee, r.rule, r.severity, r.prev, r.curr, r.change, r.pct ?? "", r.review?.note ?? ""]));
    }
    case "close": {
      if (!run) return needRun();
      const items = await closeChecklist(t, run.id);
      return opsCsv(v, "PAYROLL", "OpsPayrollCloseItem", `payroll-close-${tag}`, ["Step", "Done", "Done at", "Note"], items.map((i) => [i.label, i.done ? "Yes" : "No", d10(i.doneAt), i.note ?? ""]));
    }
    case "components": {
      const h = await componentHierarchy(t, sp.get("kind") === "DEDUCTION" ? "DEDUCTION" : "EARNING", run?.id ?? null);
      return opsCsv(v, "PAYROLL", "OpsComponentGroup", `component-hierarchy-${tag}`, ["Group path", "Depth", "Components", "Total"], h.groups.map((g) => [g.path, g.depth, g.components.map((c) => `${c.code}=${c.amount}`).join("; "), g.total]));
    }
    case "recurring": {
      const rows = await prisma.opsRecurringComponentRule.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } });
      return opsCsv(v, "PAYROLL", "OpsRecurringComponentRule", "recurring-rules", ["Name", "Type", "Amount", "Frequency", "Months", "From", "Until", "Active"], rows.map((r) => [r.name, r.type, Number(r.amount), r.frequency, r.months.join(" "), d10(r.startDate), d10(r.endDate), r.isActive ? "Yes" : "No"]));
    }
    case "trace": {
      if (!run) return needRun();
      const emp = sp.get("emp") ?? (await prisma.payrollRunEmployee.findFirst({ where: { runId: run.id }, select: { employeeId: true } }))?.employeeId ?? "";
      const tr = await payrollTrace(t, run.id, emp);
      if (!tr) return new NextResponse("Not in this run.", { status: 404 });
      return opsCsv(v, "PAYROLL", "PayrollRunEmployee", `payroll-trace-${tag}`, ["Employee", "Period", "Step", "Detail"], tr.steps.map((s) => [tr.employee, tr.period, s.step, s.detail]));
    }
    case "signoff": {
      const rows = await prisma.statutoryFiling.findMany({ where: { tenantId: t, type: { in: Object.keys(OPS_SIGNOFF_TYPES) as never[] } }, orderBy: { createdAt: "desc" } });
      return opsCsv(v, "PAYROLL", "StatutoryFiling", "statutory-signoffs", ["Return", "FY", "Month", "Quarter", "Status", "Signed off", "Filed"], rows.map((f) => { const meta = (f.meta ?? {}) as Record<string, unknown>; return [OPS_SIGNOFF_TYPES[f.type] ?? f.type, f.fyStartYear, f.month ?? "", f.quarter ?? "", f.status, String(meta.signedOffAt ?? ""), d10(f.filedAt)]; }));
    }
    case "exceptions": {
      const rows = await prisma.opsStatutoryException.findMany({ where: { tenantId: t }, orderBy: { createdAt: "desc" } });
      return opsCsv(v, "PAYROLL", "OpsStatutoryException", "statutory-exceptions", ["Raised", "Kind", "Detail", "Severity", "Status", "Note", "Resolved"], rows.map((r) => [d10(r.createdAt), r.kind, r.detail, r.severity, r.status, r.note ?? "", d10(r.resolvedAt)]));
    }
    case "lwf": {
      const [y, m] = monthParam(sp.get("month"));
      const r = await lwfReconciliation(t, y, m);
      return opsCsv(v, "PAYROLL", "PayrollRunEmployee", `lwf-reconciliation-${y}-${m}`, ["Employee", "State", "Expected employee", "Deducted employee", "Expected employer", "Deducted employer", "Difference", "Status"], r.rows.map((x) => [x.employee, x.stateCode ?? "", x.expectedEmployee, x.deductedEmployee, x.expectedEmployer, x.deductedEmployer, x.difference, x.status]));
    }
    default: {
      const rows = await payrollInputAudit(t, { q: sp.get("q") || undefined });
      return opsCsv(v, "PAYROLL", "AuditLog", "payroll-input-audit", ["When", "Who", "Action", "Record", "Id", "Summary"], rows.map((r) => [r.createdAt.toISOString(), r.actorLabel ?? "", r.action, r.entityType, r.entityId ?? "", r.summary]));
    }
  }
}
