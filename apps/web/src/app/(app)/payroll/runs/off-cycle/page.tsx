import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Callout } from "@/components/ui";
import { StartOffCycleForm } from "../../_forms/off-cycle";

/** Start an off-cycle payroll against a finalised regular month. */
export default async function NewOffCyclePage({ searchParams }: { searchParams: Promise<{ base?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.PAYROLL_RUN);
  const base = await prisma.payrollRun.findFirst({
    where: { id: (await searchParams).base ?? "", tenantId: viewer.tenantId, type: "REGULAR" },
    include: { payGroup: { select: { name: true } }, lines: { include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } }, orderBy: { employee: { employeeNumber: "asc" } } } },
  });
  if (!base) notFound();
  return (
    <>
      <PageHead title={`Off-cycle payroll · ${formatPeriod(base.year, base.month)}`} subtitle={`${base.payGroup.name}. Pay a few people something outside the monthly run: a bonus, a correction or a one-off payment.`} />
      {base.status !== "FINALIZED" ? (
        <Callout tone="warning" title="This month is not finalised">Add the payment to the <Link href={`/payroll/runs/${base.id}`}>regular run</Link> instead, or finalise it first.</Callout>
      ) : (
        <Card title="Who and why" description="Only salary items you add are paid. Income tax is the extra tax the payment adds to each person's year; PF, ESI, PT and LWF do not apply.">
          <StartOffCycleForm baseRunId={base.id} today={new Date().toISOString().slice(0, 10)}
            employees={base.lines.map((l) => ({ value: l.employee.id, label: `${l.employee.employeeNumber} — ${l.employee.displayName ?? ""}` }))} />
        </Card>
      )}
    </>
  );
}
