import { prisma } from "@keka/db";
import { monthlyWages } from "./time-requests";
import { overtimeRate } from "./time-math";

/**
 * Overtime as a payroll input. Approved overtime requests become entries for
 * a pay month; payroll can also add hours directly, set the hourly rate when
 * there was no salary to price them, and decide each entry: pay it in the
 * run, mark it paid outside payroll, or void it. Entries consumed by a
 * finalised run are read-only until that run is rolled back.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
export type OvertimeAction = "PAY" | "VOID" | "PAID_OUTSIDE";

async function monthClosed(tenantId: string, employeeId: string, year: number, month: number): Promise<boolean> {
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { payGroupId: true } });
  if (!emp?.payGroupId) return false;
  return !!(await prisma.payrollRun.findFirst({ where: { payGroupId: emp.payGroupId, year, month, type: "REGULAR", status: "FINALIZED", rolledBackAt: null }, select: { id: true } }));
}

export async function addOvertimeEntry(input: { tenantId: string; employeeId: string; year: number; month: number; hours: number; rate?: number | null }): Promise<{ ok: boolean; message: string; id?: string }> {
  if (!(input.hours > 0) || input.hours > 300) return { ok: false, message: "Hours must be between 0 and 300." };
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { id: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  if (await monthClosed(input.tenantId, input.employeeId, input.year, input.month)) return { ok: false, message: "That month's payroll is finalised. Add it to the next month." };
  let rate = input.rate ?? null;
  if (rate === null) {
    const wages = await monthlyWages(input.employeeId, new Date(Date.UTC(input.year, input.month, 0)));
    rate = overtimeRate((wages?.basic ?? 0) * 12);
  }
  const entry = await prisma.overtimeEntry.create({
    data: { tenantId: input.tenantId, employeeId: input.employeeId, year: input.year, month: input.month, hours: r2(input.hours), rate, amount: r2(input.hours * rate), payAction: "PAY" },
  });
  return { ok: true, id: entry.id, message: rate > 0 ? `Added ${input.hours} hrs at ₹${rate.toFixed(2)}/hr.` : `Added ${input.hours} hrs. There is no salary to price them; set the rate.` };
}

type Opened = { error: string; entry?: undefined } | { error?: undefined; entry: NonNullable<Awaited<ReturnType<typeof prisma.overtimeEntry.findFirst>>> };
async function openEntry(tenantId: string, id: string): Promise<Opened> {
  const e = await prisma.overtimeEntry.findFirst({ where: { id, tenantId } });
  if (!e) return { error: "Overtime entry not found." };
  if (e.isProcessed) return { error: "This was paid in a finalised payroll. Roll that payroll back to change it." };
  return { entry: e };
}

export async function decideOvertimeEntry(tenantId: string, id: string, action: OvertimeAction): Promise<{ ok: boolean; message: string }> {
  const got = await openEntry(tenantId, id);
  if (!got.entry) return { ok: false, message: got.error };
  await prisma.overtimeEntry.update({ where: { id }, data: { payAction: action, ...(action === "PAID_OUTSIDE" ? { isProcessed: false } : {}) } });
  return { ok: true, message: action === "PAY" ? "Will be paid in the run." : action === "VOID" ? "Voided; it will not be paid." : "Marked as paid outside payroll." };
}

export async function setOvertimeRate(tenantId: string, id: string, rate: number): Promise<{ ok: boolean; message: string }> {
  if (!(rate >= 0) || rate > 100_000) return { ok: false, message: "Enter an hourly rate." };
  const got = await openEntry(tenantId, id);
  if (!got.entry) return { ok: false, message: got.error };
  const amount = r2(Number(got.entry.hours) * rate);
  await prisma.overtimeEntry.update({ where: { id }, data: { rate, amount } });
  return { ok: true, message: `Rate set: ${Number(got.entry.hours)} hrs come to ₹${amount.toLocaleString("en-IN")}.` };
}
