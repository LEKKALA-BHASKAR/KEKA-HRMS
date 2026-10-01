import { prisma } from "@keka/db";
import { recomputeBalance } from "./time";
import { monthlyWages, nextPayrollMonth } from "./time-requests";
import { encashmentFormulaParts, encashmentEstimate } from "./time-math";
import { yearEndSplit, expiredCarryLapse, nextLeaveYear, type YearEndActionKind } from "./leave-year-end-math";

/**
 * Leave year-end: close every leave year that has ended, per each leave
 * type's year-end action. Unused days are carried into the next year (up to
 * the cap, expiring if the type says so), paid out through payroll as a
 * taxable payment, or lapsed — each as a ledger entry, so balances stay
 * explained. Then lapse carried-forward days that have expired.
 *
 * Safe to run every night: a closed year has nothing left to close, and
 * every entry carries an idempotency key.
 */

const DAY = 86_400_000;
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface YearEndRow {
  employeeId: string; employeeName: string; employeeNumber: string;
  leaveTypeId: string; leaveType: string; yearStart: Date; nextYear: Date;
  available: number; carry: number; pay: number; lapse: number; amount: number;
}

export interface YearEndResult { rows: YearEndRow[]; closed: number; paid: number; expired: number; expiredDays: number }

/** Preview (apply: false) or post (apply: true) year-end for one tenant. */
export async function runLeaveYearEnd(opts: { tenantId: string; today?: Date; apply: boolean; byUserId?: string | null }): Promise<YearEndResult> {
  const today = utcMidnight(opts.today ?? new Date());
  const yearAgo = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));
  const groups = (await prisma.leaveLedgerEntry.groupBy({
    by: ["employeeId", "leaveTypeId", "yearStart"],
    where: { tenantId: opts.tenantId, yearStart: { lte: yearAgo } },
    _sum: { days: true },
  })).filter((g) => nextLeaveYear(g.yearStart).getTime() <= today.getTime() && Math.abs(Number(g._sum.days ?? 0)) > 0.001);

  const result: YearEndResult = { rows: [], closed: 0, paid: 0, expired: 0, expiredDays: 0 };
  if (groups.length) {
    const [types, people] = await Promise.all([
      prisma.leaveType.findMany({ where: { id: { in: [...new Set(groups.map((g) => g.leaveTypeId))] } } }),
      prisma.employee.findMany({ where: { id: { in: [...new Set(groups.map((g) => g.employeeId))] } }, select: { id: true, displayName: true, employeeNumber: true, status: true } }),
    ]);
    const typeById = new Map(types.map((t) => [t.id, t]));
    const personById = new Map(people.map((p) => [p.id, p]));
    const payMonth = opts.apply ? await nextPayrollMonth(opts.tenantId, today) : null;

    for (const g of groups.sort((a, b) => a.yearStart.getTime() - b.yearStart.getTime())) {
      const type = typeById.get(g.leaveTypeId);
      const person = personById.get(g.employeeId);
      // Exits settle leave in full and final; comp-off credits lapse on their own dates.
      if (!type || !person || person.status === "EXITED" || type.isUnlimited || type.category === "COMP_OFF") continue;
      const available = r2(Number(g._sum.days ?? 0));
      const split = yearEndSplit(available, type.yearEndAction as YearEndActionKind, {
        carryMax: type.carryForwardMax === null ? null : Number(type.carryForwardMax),
        payMax: type.encashmentMaxDaysPerYear === null ? null : Number(type.encashmentMaxDaysPerYear),
        payEnabled: type.encashmentEnabled,
      });
      const ny = nextLeaveYear(g.yearStart);
      let amount = 0, wageNote = "";
      if (split.pay > 0) {
        const wages = await monthlyWages(g.employeeId, new Date(ny.getTime() - DAY));
        const { code, divisor } = encashmentFormulaParts(type.encashmentFormula);
        const wage = code === "GROSS" ? wages?.gross ?? 0 : (wages?.byCode(code) || wages?.basic) ?? 0;
        amount = encashmentEstimate(split.pay, wage, divisor);
        wageNote = `${split.pay} day(s) at ₹${divisor > 0 ? r2(wage / divisor) : 0}/day (${code} ÷ ${divisor})`;
      }
      result.rows.push({
        employeeId: g.employeeId, employeeName: person.displayName ?? person.employeeNumber, employeeNumber: person.employeeNumber,
        leaveTypeId: type.id, leaveType: type.name, yearStart: g.yearStart, nextYear: ny, available, ...split, amount,
      });
      if (!opts.apply) continue;

      // A year closed before and reopened by a late correction gets a fresh key.
      const prior = await prisma.leaveLedgerEntry.count({ where: { employeeId: g.employeeId, leaveTypeId: type.id, periodKey: { startsWith: `YEAREND:${iso(g.yearStart)}` } } });
      const key = `YEAREND:${iso(g.yearStart)}${prior ? `#${prior}` : ""}`;
      const base = { tenantId: opts.tenantId, employeeId: g.employeeId, leaveTypeId: type.id, createdBy: opts.byUserId ?? null };
      const label = `${g.yearStart.getUTCFullYear()}-${String(ny.getUTCFullYear()).slice(2)}`;
      await prisma.$transaction(async (tx) => {
        if (split.lapse) await tx.leaveLedgerEntry.create({ data: { ...base, yearStart: g.yearStart, kind: "LAPSE", days: -split.lapse, periodKey: key, note: `Lapsed at the end of the ${label} leave year` } });
        let payEntryId: string | null = null;
        if (split.pay) {
          const e = await tx.leaveLedgerEntry.create({ data: { ...base, yearStart: g.yearStart, kind: "ENCASHMENT", days: -split.pay, periodKey: key, note: `Paid out at the end of the ${label} leave year` } });
          payEntryId = e.id;
        }
        if (split.carry) {
          await tx.leaveLedgerEntry.create({ data: { ...base, yearStart: g.yearStart, kind: "CARRY_FORWARD", days: -split.carry, periodKey: `${key}:OUT`, note: split.carry > 0 ? `Carried into ${ny.getUTCFullYear()}` : "Deficit carried into next year" } });
          await tx.leaveLedgerEntry.create({
            data: {
              ...base, yearStart: ny, kind: "CARRY_FORWARD", days: split.carry, periodKey: `${key}:IN`,
              note: split.carry > 0 ? `Carried forward from ${label}` : `Deficit carried from ${label}`,
              expiresOn: split.carry > 0 && type.carryForwardExpiryDays ? new Date(ny.getTime() + type.carryForwardExpiryDays * DAY) : null,
            },
          });
        }
        await recomputeBalance(g.employeeId, type.id, g.yearStart, tx);
        if (split.carry) await recomputeBalance(g.employeeId, type.id, ny, tx);
        if (split.pay && amount > 0 && payMonth) {
          await tx.adhocTransaction.create({
            data: {
              employeeId: g.employeeId, type: "PAYMENT", name: `${type.name} encashment (year end)`, componentCode: "LEAVE_ENCASH",
              amount, taxTreatment: "TAXABLE", year: payMonth.year, month: payMonth.month, comment: wageNote,
              sourceType: "LeaveYearEnd", sourceId: payEntryId, createdBy: opts.byUserId ?? null,
            },
          });
          result.paid++;
        }
      });
      result.closed++;
    }
  }

  // Carried-forward days whose expiry has passed.
  const expiring = await prisma.leaveLedgerEntry.findMany({
    where: { tenantId: opts.tenantId, kind: "CARRY_FORWARD", days: { gt: 0 }, expiresOn: { lte: today }, employee: { status: { not: "EXITED" } } },
  });
  for (const cf of expiring) {
    const marker = `CF-EXPIRY:${cf.id}`;
    if (await prisma.leaveLedgerEntry.count({ where: { employeeId: cf.employeeId, leaveTypeId: cf.leaveTypeId, kind: "LAPSE", periodKey: marker } })) continue;
    const entries = await prisma.leaveLedgerEntry.findMany({ where: { employeeId: cf.employeeId, leaveTypeId: cf.leaveTypeId, yearStart: cf.yearStart } });
    const available = entries.reduce((s, e) => s + Number(e.days), 0);
    const used = -entries.filter((e) => e.kind === "USED" || e.kind === "REVERSAL").reduce((s, e) => s + Number(e.days), 0);
    const lapse = expiredCarryLapse(Number(cf.days), used, available);
    if (lapse <= 0) continue;
    result.expired++; result.expiredDays = r2(result.expiredDays + lapse);
    if (!opts.apply) continue;
    await prisma.$transaction(async (tx) => {
      await tx.leaveLedgerEntry.create({
        data: { tenantId: opts.tenantId, employeeId: cf.employeeId, leaveTypeId: cf.leaveTypeId, yearStart: cf.yearStart, kind: "LAPSE", days: -lapse, periodKey: marker, note: `Carried-forward days expired on ${iso(cf.expiresOn!)}`, createdBy: opts.byUserId ?? null },
      });
      await recomputeBalance(cf.employeeId, cf.leaveTypeId, cf.yearStart, tx);
    });
  }
  return result;
}
