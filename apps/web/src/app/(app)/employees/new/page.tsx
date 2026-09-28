import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { PageHead, Callout, Card, Empty } from "@/components/ui";
import { EmployeeWizard } from "./wizard";

const P = PERMISSIONS;

export default async function NewEmployeePage() {
  const viewer = await requireAuth(P.EMPLOYEE_CREATE);

  const [
    entities, businessUnits, departments, locations, costCentres, bands, grades,
    workerTypes, jobTitles, managers, payGroups, structures, series, leavePlans,
  ] = await Promise.all([
    prisma.legalEntity.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true }, orderBy: { name: "asc" },
    }),
    prisma.businessUnit.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true }, orderBy: { name: "asc" },
    }),
    prisma.department.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true }, orderBy: { name: "asc" },
    }),
    prisma.location.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true, stateCode: true }, orderBy: { name: "asc" },
    }),
    prisma.costCenter.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true }, orderBy: { name: "asc" },
    }),
    prisma.band.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true }, orderBy: { rank: "asc" },
    }),
    prisma.payGrade.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true }, orderBy: { name: "asc" },
    }),
    prisma.workerType.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true }, orderBy: { name: "asc" },
    }),
    prisma.jobTitle.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true }, orderBy: { name: "asc" },
    }),
    prisma.employee.findMany({
      where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } },
      select: { id: true, displayName: true, employeeNumber: true, jobTitleName: true },
      orderBy: { firstName: "asc" },
    }),
    prisma.payGroup.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true, legalEntity: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.salaryStructure.findMany({
      where: { payGroup: { tenantId: viewer.tenantId }, isActive: true },
      select: {
        id: true, name: true, payGroupId: true,
        minAnnualCtc: true, maxAnnualCtc: true,
      },
      orderBy: { minAnnualCtc: "asc" },
    }),
    prisma.employeeNumberSeries.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      orderBy: { isDefault: "desc" },
    }),
    prisma.leavePlan.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      select: { id: true, name: true, isDefault: true }, orderBy: { isDefault: "desc" },
    }),
  ]);

  // Refuse to show a form that cannot succeed.
  const blockers: string[] = [];
  if (entities.length === 0) blockers.push("a legal entity");
  if (locations.length === 0) blockers.push("a location");
  if (series.length === 0) blockers.push("an employee number series");
  const unstated = locations.filter((l) => !l.stateCode);

  const defaultSeries = series.find((s) => s.isDefault) ?? series[0];
  const preview = defaultSeries
    ? `${defaultSeries.prefix}${String(defaultSeries.nextNumber).padStart(defaultSeries.digits, "0")}${defaultSeries.suffix}`
    : null;

  if (blockers.length > 0) {
    return (
      <>
        <PageHead title="Add employee" />
        <Card>
          <Empty title="Set up the organisation first">
            An employee record needs {blockers.join(", ")} before it can be created.
            <div style={{ marginTop: 14 }}>
              <Link className="btn primary" href="/org">Go to Organisation</Link>
            </div>
          </Empty>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Add employee"
        subtitle="Four steps, one transaction — the record, its first job history row, its statutory profile and its opening salary are created together"
        actions={<Link className="btn" href="/employees">Cancel</Link>}
      />

      {unstated.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warning" title={`${unstated.length} location(s) have no state set`}>
            {unstated.map((l) => l.name).join(", ")} cannot be used, because without a state
            there is no way to determine Professional Tax. Set it under{" "}
            <Link href="/org?tab=locations">Organisation → Locations</Link>.
          </Callout>
        </div>
      ) : null}

      {payGroups.length === 0 ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="info" title="No pay groups yet">
            You can still create the employee, but they will not appear in a payroll run
            until a pay group exists and is assigned.
          </Callout>
        </div>
      ) : null}

      <EmployeeWizard
        entities={entities.map((e) => ({ value: e.id, label: e.name }))}
        businessUnits={businessUnits.map((b) => ({ value: b.id, label: b.name }))}
        departments={departments.map((d) => ({ value: d.id, label: d.name }))}
        locations={locations
          .filter((l) => l.stateCode)
          .map((l) => ({ value: l.id, label: `${l.name} (${l.stateCode})` }))}
        costCentres={costCentres.map((c) => ({ value: c.id, label: c.name }))}
        bands={bands.map((b) => ({ value: b.id, label: b.name }))}
        grades={grades.map((g) => ({ value: g.id, label: g.name }))}
        workerTypes={workerTypes.map((w) => ({ value: w.id, label: w.name }))}
        jobTitles={jobTitles.map((j) => ({ value: j.id, label: j.name }))}
        managers={managers.map((m) => ({
          value: m.id,
          label: `${m.displayName} — ${m.jobTitleName ?? m.employeeNumber}`,
        }))}
        payGroups={payGroups.map((g) => ({
          value: g.id, label: `${g.name} (${g.legalEntity.name})`,
        }))}
        structures={structures.map((s) => ({
          value: s.id,
          payGroupId: s.payGroupId,
          label: s.minAnnualCtc || s.maxAnnualCtc
            ? `${s.name} — ${s.minAnnualCtc ? `₹${(Number(s.minAnnualCtc) / 100000).toFixed(1)}L` : "0"} to ${s.maxAnnualCtc ? `₹${(Number(s.maxAnnualCtc) / 100000).toFixed(1)}L` : "no limit"}`
            : s.name,
        }))}
        numberSeries={series.map((s) => ({
          value: s.id,
          label: `${s.name} — next ${s.prefix}${String(s.nextNumber).padStart(s.digits, "0")}${s.suffix}`,
        }))}
        leavePlans={leavePlans.map((p) => ({
          value: p.id, label: p.isDefault ? `${p.name} (default)` : p.name,
        }))}
        defaultSeriesPreview={preview}
      />
    </>
  );
}
