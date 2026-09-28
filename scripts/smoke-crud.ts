/**
 * Exercises the master-data CRUD actions directly, including the guards.
 * A create form that cannot round-trip, or a delete that orphans a record,
 * is worse than no form at all.
 */
// Must be first: stubs server-only and next/headers, and loads the env.
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  // Sign in as the Global Admin. The action's own requireAuth runs for real.
  await signInAs("vikram.menon@acme.test");

  const org = await import("../apps/web/src/app/actions/org");

  console.log("\nMaster-data CRUD\n" + "=".repeat(72));

  // ---------------------------------------------------------------
  section("Location — create, validate, edit, guarded delete");

  const badLoc = await org.saveLocation({}, fd({ name: "", stateCode: "KA" }));
  check("Blank name is rejected with a field error", badLoc.ok !== true && !!badLoc.errors?.name,
    badLoc.errors?.name ?? badLoc.message);

  const created = await org.saveLocation({}, fd({
    name: "Pune Office", code: "PNQ", city: "Pune", state: "Maharashtra",
    stateCode: "mh", postalCode: "411001", countryCode: "IN", timezone: "Asia/Kolkata",
  }));
  check("Created a location", created.ok === true, created.message);

  const loc = await prisma.location.findFirst({ where: { tenantId: tenant.id, name: "Pune Office" } });
  check("Location persisted", !!loc);
  check("State code was upper-cased", loc?.stateCode === "MH", loc?.stateCode ?? "");

  const dupe = await org.saveLocation({}, fd({
    name: "Pune Office", stateCode: "MH", countryCode: "IN", timezone: "Asia/Kolkata",
  }));
  check("Duplicate name is a user error, not a crash",
    dupe.ok !== true && /already in use/i.test(dupe.message ?? ""), dupe.message);

  const renamed = await org.saveLocation({}, fd({
    id: loc!.id, name: "Pune — Kharadi", stateCode: "MH", city: "Pune",
    countryCode: "IN", timezone: "Asia/Kolkata",
  }));
  check("Edited the location", renamed.ok === true, renamed.message);

  // Attach an employee, then confirm the delete is refused.
  const someEmployee = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const originalLocation = someEmployee.locationId;
  await prisma.employee.update({ where: { id: someEmployee.id }, data: { locationId: loc!.id } });

  const blocked = await org.deleteLocation({}, fd({ id: loc!.id }));
  check("Delete refused while an employee is based there",
    blocked.ok !== true && /employee/i.test(blocked.message ?? ""), blocked.message);

  await prisma.employee.update({ where: { id: someEmployee.id }, data: { locationId: originalLocation } });
  const deleted = await org.deleteLocation({}, fd({ id: loc!.id }));
  check("Delete succeeded once nothing referenced it", deleted.ok === true, deleted.message);
  const gone = await prisma.location.findUnique({ where: { id: loc!.id } });
  check("Location is actually gone", gone === null);

  // ---------------------------------------------------------------
  section("Department — create, head assignment, guarded delete");

  const bu = await prisma.businessUnit.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const deptRes = await org.saveDepartment({}, fd({
    name: "Internal Audit", code: "AUD", businessUnitId: bu.id,
  }));
  check("Created a department", deptRes.ok === true, deptRes.message);
  const dept = await prisma.department.findFirst({ where: { tenantId: tenant.id, name: "Internal Audit" } });
  check("Department persisted", !!dept);

  const headRes = await org.setOrgHead({}, fd({
    kind: "department", id: dept!.id, headId: someEmployee.id,
  }));
  check("Assigned a department head", headRes.ok === true, headRes.message);
  const withHead = await prisma.department.findUniqueOrThrow({ where: { id: dept!.id } });
  check("Head persisted, which derives the implicit role", withHead.headId === someEmployee.id);

  // A role scope pointing at the department must be cleared on delete.
  const assignment = await prisma.userRoleAssignment.findFirstOrThrow({});
  await prisma.roleScope.create({ data: { assignmentId: assignment.id, departmentId: dept!.id } });
  const scopesBefore = await prisma.roleScope.count({ where: { departmentId: dept!.id } });
  check("A role scope was attached for the test", scopesBefore === 1);

  const deptDel = await org.deleteDepartment({}, fd({ id: dept!.id }));
  check("Deleted the empty department", deptDel.ok === true, deptDel.message);
  const scopesAfter = await prisma.roleScope.count({ where: { departmentId: dept!.id } });
  check("Its role scopes were cleared, not orphaned", scopesAfter === 0);

  // ---------------------------------------------------------------
  section("Lookups — pay grade validation, delete guard");

  const badGrade = await org.savePayGrade({}, fd({
    name: "G-Bad", minAnnual: "900000", maxAnnual: "100000",
  }));
  check("Max below min is rejected",
    badGrade.ok !== true && !!badGrade.errors?.maxAnnual, badGrade.errors?.maxAnnual ?? badGrade.message);

  const gradeRes = await org.savePayGrade({}, fd({
    name: "G6", minAnnual: "6000000", maxAnnual: "9000000",
  }));
  check("Created a pay grade", gradeRes.ok === true, gradeRes.message);
  const grade = await prisma.payGrade.findFirst({ where: { tenantId: tenant.id, name: "G6" } });
  check("Midpoint was computed", Number(grade?.midAnnual) === 7500000, String(grade?.midAnnual));

  const gradeDel = await org.deleteLookup({}, fd({ kind: "payGrade", id: grade!.id }));
  check("Deleted the unused pay grade", gradeDel.ok === true, gradeDel.message);

  const usedBand = await prisma.band.findFirstOrThrow({
    where: { tenantId: tenant.id, employees: { some: {} } },
  });
  const bandDel = await org.deleteLookup({}, fd({ kind: "band", id: usedBand.id }));
  check("Delete refused for a band still in use",
    bandDel.ok !== true && /reference/i.test(bandDel.message ?? ""), bandDel.message);

  // ---------------------------------------------------------------
  section("Number series — single default invariant");

  const seriesRes = await org.saveNumberSeries({}, fd({
    name: "Interns", prefix: "INT", digits: "3", suffix: "",
    nextNumber: "1", isDefault: "on", isActive: "on",
  }));
  check("Created a series marked default", seriesRes.ok === true, seriesRes.message);
  const defaults = await prisma.employeeNumberSeries.count({
    where: { tenantId: tenant.id, isDefault: true },
  });
  check("Exactly one series is default", defaults === 1, `${defaults} defaults`);

  const newDefault = await prisma.employeeNumberSeries.findFirstOrThrow({
    where: { tenantId: tenant.id, name: "Interns" },
  });
  const seriesDel = await org.deleteNumberSeries({}, fd({ id: newDefault.id }));
  check("The default series cannot be deleted",
    seriesDel.ok !== true && /default/i.test(seriesDel.message ?? ""), seriesDel.message);

  // Restore the original default and clean up.
  const original = await prisma.employeeNumberSeries.findFirstOrThrow({
    where: { tenantId: tenant.id, name: "Default" },
  });
  await prisma.employeeNumberSeries.update({ where: { id: original.id }, data: { isDefault: true } });
  await prisma.employeeNumberSeries.update({ where: { id: newDefault.id }, data: { isDefault: false } });
  const cleanup = await org.deleteNumberSeries({}, fd({ id: newDefault.id }));
  check("Deletable once it is no longer default", cleanup.ok === true, cleanup.message);

  // ---------------------------------------------------------------
  section("Visibility settings");

  const visRes = await org.saveVisibilitySettings({}, fd({
    restrictByLegalEntity: "on", managerReporteeOverride: "on",
  }));
  check("Saved visibility settings", visRes.ok === true, visRes.message);
  const vis = await prisma.tenantVisibilitySetting.findUniqueOrThrow({ where: { tenantId: tenant.id } });
  check("Legal-entity restriction is on", vis.restrictByLegalEntity === true);
  check("Business-unit restriction stayed off", vis.restrictByBusinessUnit === false);
  // Put it back so later tests see the seeded state.
  await prisma.tenantVisibilitySetting.update({
    where: { tenantId: tenant.id },
    data: { restrictByLegalEntity: false, restrictByBusinessUnit: false, managerReporteeOverride: true },
  });

  report("Master-data CRUD");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
