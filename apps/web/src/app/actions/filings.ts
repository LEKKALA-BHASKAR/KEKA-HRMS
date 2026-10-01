"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { buildPfEcr, buildEsiFile, buildBankAdvice, buildForm24q, form16Pdf, type BuiltFile } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { saveFile } from "@/lib/storage";
import { writeAudit, actionDone as done, toErrorState, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;
type FilingKind = "PF_ECR" | "ESI_ECR" | "FORM_24Q";

/** Record a generated file against its filing slot, replacing an earlier draft. */
async function recordFiling(tenantId: string, kind: FilingKind, fy: number, slot: { month?: number; quarter?: number; payGroupId?: string }, file: BuiltFile, userId: string) {
  const existing = await prisma.statutoryFiling.findFirst({ where: { tenantId, type: kind, fyStartYear: fy, month: slot.month ?? null, quarter: slot.quarter ?? null } });
  if (existing && ["FILED", "ACKNOWLEDGED"].includes(existing.status)) {
    throw new Error("This return is already marked filed. A correction is a revised return, filed on the portal.");
  }
  const filing = existing ?? await prisma.statutoryFiling.create({ data: { tenantId, type: kind, fyStartYear: fy, month: slot.month ?? null, quarter: slot.quarter ?? null, payGroupId: slot.payGroupId ?? null } });
  const stored = await saveFile({ tenantId, filename: file.filename, mimeType: file.mimeType, data: file.content, relatedType: "StatutoryFiling", relatedId: filing.id, uploadedBy: userId });
  await prisma.statutoryFiling.update({
    where: { id: filing.id },
    data: { status: "GENERATED", fileUrl: `/files/${stored.id}`, generatedAt: new Date(), meta: { summary: file.summary, issues: file.issues, fileId: stored.id } },
  });
  return { filing, stored };
}

const fyOf = (year: number, month: number) => (month >= 4 ? year : year - 1);

export async function generateMonthlyFiling(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const runId = String(formData.get("runId"));
  const kind = String(formData.get("kind")) as "PF_ECR" | "ESI_ECR" | "BANK";
  try {
    const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId: viewer.tenantId } });
    if (!run) return { ok: false, message: "Run not found." };
    if (kind === "BANK") {
      const file = await buildBankAdvice(runId, viewer.tenantId);
      await saveFile({ tenantId: viewer.tenantId, filename: file.filename, mimeType: file.mimeType, data: file.content, relatedType: "PayrollOutput", relatedId: runId, uploadedBy: viewer.user.id });
      await writeAudit(viewer, { module: "PAYROLL", action: "EXPORT", entityType: "PayrollRun", entityId: runId, summary: `Generated bank advice: ${file.summary}` });
      return done(["/payroll/filings"], `Bank advice ready: ${file.summary}.${file.issues.length ? ` ${file.issues.length} left out: ${file.issues.slice(0, 2).join("; ")}` : ""}`);
    }
    const file = kind === "PF_ECR" ? await buildPfEcr(runId, viewer.tenantId) : await buildEsiFile(runId, viewer.tenantId);
    await recordFiling(viewer.tenantId, kind, fyOf(run.year, run.month), { month: run.month, payGroupId: run.payGroupId }, file, viewer.user.id);
    await writeAudit(viewer, { module: "PAYROLL", action: "EXPORT", entityType: "StatutoryFiling", entityId: runId, summary: `Generated ${kind.replace("_", " ")} for ${run.month}/${run.year}: ${file.summary}` });
    return done(["/payroll/filings", "/reports"], `${kind === "PF_ECR" ? "PF ECR" : "ESI file"} ready: ${file.summary}.${file.issues.length ? ` ${file.issues.length} issue(s): ${file.issues.slice(0, 2).join("; ")}` : ""}`);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function generate24q(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const fy = Number(formData.get("fy")), quarter = Number(formData.get("quarter"));
  try {
    const file = await buildForm24q(viewer.tenantId, fy, quarter);
    await recordFiling(viewer.tenantId, "FORM_24Q", fy, { quarter }, file, viewer.user.id);
    await writeAudit(viewer, { module: "PAYROLL", action: "EXPORT", entityType: "StatutoryFiling", summary: `Generated Form 24Q Q${quarter} FY${fy}: ${file.summary}` });
    return done(["/payroll/filings"], `Form 24Q Q${quarter} ready: ${file.summary}.${file.issues.length ? ` ${file.issues.join("; ")}` : ""}`);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function markFiled(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const id = String(formData.get("filingId"));
  const receipt = String(formData.get("receipt") ?? "").trim();
  if (!receipt) return { ok: false, message: "Enter the portal's acknowledgement (TRRN, challan or token number).", errors: { receipt: "Required" } };
  const f = await prisma.statutoryFiling.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!f) return { ok: false, message: "Filing not found." };
  if (f.status !== "GENERATED") return { ok: false, message: "Generate the file before marking it filed." };
  await prisma.statutoryFiling.update({ where: { id }, data: { status: "FILED", receiptNumber: receipt, filedAt: new Date() } });
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "StatutoryFiling", entityId: id, summary: `Marked ${f.type.replace("_", " ")} filed: ${receipt}` });
  return done(["/payroll/filings", "/reports", "/"], "Marked as filed.");
}

export async function generateForm16(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const fy = Number(formData.get("fy"));
  const employees = await prisma.payrollRunEmployee.findMany({
    where: { run: { tenantId: viewer.tenantId, status: "FINALIZED", rolledBackAt: null, OR: [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: 3 } }] } },
    distinct: ["employeeId"], select: { employeeId: true },
  });
  if (employees.length === 0) return { ok: false, message: "No finalised salary in that financial year." };
  let made = 0;
  const issues: string[] = [];
  let provisional = false;
  for (const { employeeId } of employees) {
    try {
      const f = await form16Pdf(employeeId, fy);
      provisional = f.provisional;
      // Replace any earlier copy so an employee only ever sees the latest.
      await prisma.storedFile.deleteMany({ where: { tenantId: viewer.tenantId, relatedType: "Form16", employeeId, relatedId: String(fy) } });
      await saveFile({ tenantId: viewer.tenantId, filename: f.filename, mimeType: f.mimeType, data: f.content, relatedType: "Form16", relatedId: String(fy), employeeId, uploadedBy: viewer.user.id });
      made++;
      issues.push(...f.issues.filter((i) => !i.startsWith("Provisional")));
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
    }
  }
  const existing = await prisma.statutoryFiling.findFirst({ where: { tenantId: viewer.tenantId, type: "FORM_16", fyStartYear: fy } });
  const meta = { summary: `${made} employee(s)${provisional ? " — provisional" : ""}`, issues };
  if (existing) await prisma.statutoryFiling.update({ where: { id: existing.id }, data: { status: "GENERATED", generatedAt: new Date(), meta } });
  else await prisma.statutoryFiling.create({ data: { tenantId: viewer.tenantId, type: "FORM_16", fyStartYear: fy, status: "GENERATED", generatedAt: new Date(), meta } });
  await writeAudit(viewer, { module: "PAYROLL", action: "EXPORT", entityType: "StatutoryFiling", summary: `Generated Form 16 Part B for ${made} employees, FY${fy}` });
  return done(["/payroll/filings", "/me/tax"], `Form 16 Part B generated for ${made} employee(s)${provisional ? " (provisional — the year is not over)" : ""}.${issues.length ? ` ${issues.length} issue(s).` : ""}`);
}
