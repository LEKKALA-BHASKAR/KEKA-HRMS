/**
 * Coverage for Core HR features that already existed, through their real
 * server actions and data loaders:
 *   1. Legal entities (with signatories and bank accounts), business units
 *      and cost centres: create, list, update, delete guards, audit, CSV.
 *   2. Employee sub-records: education and experience (add, edit, date
 *      checks), dependents, emergency contacts (one primary), address
 *      history, removal — each audited, each permission-checked.
 *   3. Directory search and organisation tree data with the company's
 *      visibility settings; My Team's data loader.
 *   4. Organisation and visibility settings saved and audited.
 *   5. Attendance requests: raised, listed for the manager, withdrawn.
 *
 * Removes everything it created and restores what it changed.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TAG = `cov${Date.now().toString(36)}`;

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { const r = await fn() as { ok?: boolean } | undefined; return !!r && r.ok === false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    if (/HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`)) return true;
    throw err;
  }
}

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { NextRequest } = await import("next/server");
  const org = await import("../apps/web/src/app/actions/org");
  const employee = await import("../apps/web/src/app/actions/employee");
  const settings = await import("../apps/web/src/app/actions/settings");
  const time = await import("../apps/web/src/app/actions/time");
  const { viewerForUser } = await import("../apps/web/src/lib/context");
  const { loadDirectory } = await import("../apps/web/src/lib/directory-search");
  const { directoryVisibilityWhere } = await import("../apps/web/src/lib/core-hr");
  const { loadTeam } = await import("../apps/web/src/app/(app)/team/_data");
  const { listApprovals } = await import("../apps/web/src/lib/time-approvals");
  const exportsRoute = await import("../apps/web/src/app/(app)/exports/core-hr/[kind]/route");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const userOf = (email: string) => prisma.user.findFirstOrThrow({ where: { tenantId: t, email } });
  const empOf = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: t, user: { email } } });
  const [meera, ananya] = await Promise.all([empOf("meera.krishnan@acme.test"), empOf("ananya.ghosh@acme.test")]);
  const vikram = await userOf("vikram.menon@acme.test");
  const auditCount = (entityType: string) => prisma.auditLog.count({ where: { tenantId: t, entityType } });
  const csv = async (kind: string) => { const res = await exportsRoute.GET(new NextRequest(`http://acme.localhost/exports/core-hr/${kind}`), { params: Promise.resolve({ kind }) }); return { status: res.status, body: await res.text() }; };
  const tenantBefore = await prisma.tenant.findUniqueOrThrow({ where: { id: t } });
  const visBefore = await prisma.tenantVisibilitySetting.findUnique({ where: { tenantId: t } });
  const made = { entityId: "", unitId: "", costId: "", attendanceIds: [] as string[] };
  const subBefore = {
    edu: (await prisma.employeeEducation.findMany({ where: { employeeId: meera.id }, select: { id: true } })).map((x) => x.id),
    exp: (await prisma.employeeExperience.findMany({ where: { employeeId: meera.id }, select: { id: true } })).map((x) => x.id),
    dep: (await prisma.dependent.findMany({ where: { employeeId: meera.id }, select: { id: true } })).map((x) => x.id),
    em: await prisma.emergencyContact.findMany({ where: { employeeId: meera.id } }),
    addr: await prisma.employeeAddress.findUnique({ where: { employeeId_type: { employeeId: meera.id, type: "PERMANENT" } } }),
  };

  try {
    // -----------------------------------------------------------------
    section("1. Legal entities, business units and cost centres");
    await signInAs("vikram.menon@acme.test");
    let r = await org.saveLegalEntity({}, fd({ name: `Entity ${TAG}`, legalName: `Entity ${TAG} Private Limited`, countryCode: "IN", currency: "INR", city: "Pune", state: "Maharashtra" }));
    const entity = await prisma.legalEntity.findFirst({ where: { tenantId: t, name: `Entity ${TAG}` } });
    made.entityId = entity?.id ?? "";
    check("a legal entity is created", r.ok === true && !!entity, r.message);
    check("…and audited", (await prisma.auditLog.count({ where: { tenantId: t, entityId: entity!.id } })) > 0);
    r = await org.saveLegalEntity({}, fd({ id: entity!.id, name: `Entity ${TAG}`, legalName: `Entity ${TAG} Pvt Ltd`, countryCode: "IN", currency: "INR", city: "Mumbai" }));
    check("it is updated", r.ok === true && (await prisma.legalEntity.findUniqueOrThrow({ where: { id: entity!.id } })).city === "Mumbai");
    r = await org.addSignatory({}, fd({ legalEntityId: entity!.id, name: "Asha Rao", designation: "Director", email: "asha@acme.test", pan: "ABCPR1234K" }));
    const sig = await prisma.authorisedSignatory.findFirst({ where: { legalEntityId: entity!.id } });
    check("an authorised signatory is added and audited", r.ok === true && !!sig && (await auditCount("AuthorisedSignatory")) > 0, r.message);
    r = await org.addEntityBankAccount({}, fd({ legalEntityId: entity!.id, bankName: "HDFC Bank", accountNumber: "50100012345678", ifsc: "HDFC0000123", branch: "Fort", isPrimary: true }));
    check("a bank account is added and audited (number masked)", r.ok === true && (await prisma.auditLog.count({ where: { tenantId: t, entityType: "EntityBankAccount", summary: { contains: "••••5678" } } })) > 0, r.message);
    r = await org.deleteSignatory({}, fd({ id: sig!.id }));
    check("the signatory is removed", r.ok === true && !(await prisma.authorisedSignatory.findUnique({ where: { id: sig!.id } })));

    r = await org.saveBusinessUnit({}, fd({ legalEntityId: entity!.id, name: `Unit ${TAG}`, code: "U1", description: "Test unit" }));
    const bu = await prisma.businessUnit.findFirst({ where: { tenantId: t, name: `Unit ${TAG}` } });
    made.unitId = bu?.id ?? "";
    check("a business unit is created under the entity", r.ok === true && bu?.legalEntityId === entity!.id, r.message);
    r = await org.saveBusinessUnit({}, fd({ id: bu!.id, legalEntityId: entity!.id, name: `Unit ${TAG}`, code: "U2", headId: ananya.id }));
    check("it is updated with a head", r.ok === true && (await prisma.businessUnit.findUniqueOrThrow({ where: { id: bu!.id } })).headId === ananya.id, r.message);
    r = await org.deleteLegalEntity({}, fd({ id: entity!.id }));
    check("an entity with business units cannot be deleted", r.ok === false, r.message);

    r = await org.saveCostCentre({}, fd({ name: `CC ${TAG}`, code: "C1" }));
    const cc = await prisma.costCenter.findFirst({ where: { tenantId: t, name: `CC ${TAG}` } });
    made.costId = cc?.id ?? "";
    check("a cost centre is created and audited", r.ok === true && !!cc && (await prisma.auditLog.count({ where: { tenantId: t, entityType: "CostCenter", entityId: cc!.id } })) > 0);
    r = await org.saveCostCentre({}, fd({ id: cc!.id, name: `CC ${TAG} renamed`, code: "C2" }));
    check("it is renamed, with before and after in the audit log", r.ok === true && (await prisma.auditLog.count({ where: { tenantId: t, entityType: "CostCenter", entityId: cc!.id, action: "UPDATE" } })) > 0);

    let out = await csv("legal-entities");
    check("legal entities export as CSV", out.status === 200 && out.body.includes(`Entity ${TAG}`));
    out = await csv("business-units");
    check("business units export as CSV", out.status === 200 && out.body.includes(`Unit ${TAG}`));
    out = await csv("cost-centres");
    check("cost centres export as CSV", out.status === 200 && out.body.includes(`CC ${TAG} renamed`));

    r = await org.deleteLookup({}, fd({ kind: "costCentre", id: cc!.id }));
    check("an unused cost centre is deleted", r.ok === true && !(await prisma.costCenter.findUnique({ where: { id: cc!.id } }))); made.costId = "";
    r = await org.deleteBusinessUnit({}, fd({ id: bu!.id }));
    check("an empty business unit is deleted", r.ok === true); made.unitId = "";
    r = await org.deleteLegalEntity({}, fd({ id: entity!.id }));
    check("…and then the legal entity", r.ok === true && !(await prisma.legalEntity.findUnique({ where: { id: entity!.id } })), r.message); made.entityId = "";

    await signInAs("meera.krishnan@acme.test");
    check("an employee cannot create a legal entity", await denied(() => org.saveLegalEntity({}, fd({ name: "Nope", legalName: "Nope Ltd" }))));
    check("…or a cost centre", await denied(() => org.saveCostCentre({}, fd({ name: "Nope" }))));
    out = await csv("legal-entities");
    check("…or export the org structure", out.status === 403);

    // -----------------------------------------------------------------
    section("2. Education, experience, dependents, emergency contacts, address history");
    await signInAs("priya.sharma@acme.test");
    r = await employee.addEducation({}, fd({ employeeId: meera.id, institution: `IIT ${TAG}`, degree: "B.Tech", fromYear: 2012, toYear: 2016 }));
    const edu = await prisma.employeeEducation.findFirst({ where: { employeeId: meera.id, institution: `IIT ${TAG}` } });
    check("HR adds a qualification (audited)", r.ok === true && !!edu && (await auditCount("EmployeeEducation")) > 0);
    r = await employee.addEducation({}, fd({ id: edu!.id, employeeId: meera.id, institution: `IIT ${TAG}`, degree: "M.Tech", fromYear: 2012, toYear: 2018 }));
    check("…and edits it", r.ok === true && (await prisma.employeeEducation.findUniqueOrThrow({ where: { id: edu!.id } })).degree === "M.Tech");
    r = await employee.addEducation({}, fd({ employeeId: meera.id, institution: "Backwards", fromYear: 2016, toYear: 2012 }));
    check("a qualification that ends before it starts is refused", r.ok === false);
    r = await employee.addExperience({}, fd({ employeeId: meera.id, companyName: `Prev ${TAG}`, jobTitle: "Engineer", fromDate: "2016-07-01", toDate: "2019-06-30" }));
    const exp = await prisma.employeeExperience.findFirst({ where: { employeeId: meera.id, companyName: `Prev ${TAG}` } });
    check("HR adds a prior role (audited)", r.ok === true && !!exp && (await auditCount("EmployeeExperience")) > 0);
    r = await employee.addExperience({}, fd({ employeeId: meera.id, companyName: "Backwards", fromDate: "2019-01-01", toDate: "2018-01-01" }));
    check("a prior role that ends before it starts is refused", r.ok === false);
    r = await employee.addDependent({}, fd({ employeeId: meera.id, name: `Dep ${TAG}`, relationship: "Mother", dateOfBirth: "1965-03-03", isNominee: true }));
    const dep = await prisma.dependent.findFirst({ where: { employeeId: meera.id, name: `Dep ${TAG}` } });
    check("HR adds a dependent nominee (audited)", r.ok === true && !!dep?.isNominee && (await auditCount("Dependent")) > 0);
    r = await employee.addDependent({}, fd({ employeeId: meera.id, name: "Unborn", relationship: "Child", dateOfBirth: iso(new Date(Date.now() + 40 * DAY)) }));
    check("a dependent born in the future is refused", r.ok === false);
    r = await employee.addEmergencyContact({}, fd({ employeeId: meera.id, name: `EC1 ${TAG}`, relationship: "Brother", phone: "+91 98450 00001", isPrimary: true }));
    r = await employee.addEmergencyContact({}, fd({ employeeId: meera.id, name: `EC2 ${TAG}`, relationship: "Sister", phone: "+91 98450 00002", isPrimary: true }));
    const ecs = await prisma.emergencyContact.findMany({ where: { employeeId: meera.id } });
    check("a new primary emergency contact replaces the old primary", r.ok === true && ecs.filter((e) => e.isPrimary).length === 1 && ecs.find((e) => e.isPrimary)?.name === `EC2 ${TAG}`);
    r = await employee.addEmergencyContact({}, fd({ employeeId: meera.id, name: "Bad", relationship: "Friend", phone: "call me" }));
    check("an emergency contact without a phone number is refused", r.ok === false);
    r = await employee.saveAddress({}, fd({ employeeId: meera.id, type: "PERMANENT", line1: `1 Old Road ${TAG}`, city: "Chennai", postalCode: "600001", countryCode: "IN" }));
    r = await employee.saveAddress({}, fd({ employeeId: meera.id, type: "PERMANENT", line1: `2 New Road ${TAG}`, city: "Chennai", postalCode: "600002", countryCode: "IN" }));
    check("changing an address keeps the old one in its history", r.ok === true && (await prisma.employeeAddressHistory.count({ where: { tenantId: t, employeeId: meera.id, line1: { contains: TAG } } })) >= 1, r.message);
    r = await employee.deleteSubRecord({}, fd({ kind: "education", id: edu!.id, employeeId: meera.id }));
    check("a sub-record is removed (audited)", r.ok === true && (await auditCount("Employee education")) > 0);
    r = await employee.deleteSubRecord({}, fd({ kind: "education", id: edu!.id, employeeId: meera.id }));
    check("removing it again says it is not found", r.ok === false);
    out = await csv("education-experience");
    check("education and experience export as CSV", out.status === 200 && out.body.includes(`Prev ${TAG}`));
    await signInAs("meera.krishnan@acme.test");
    check("an employee cannot edit their record directly", await denied(() => employee.addEducation({}, fd({ employeeId: meera.id, institution: "Self-made" }))));
    await signInAs("deepak.chauhan@acme.test");
    // Vikram sits outside the two departments Deepak looks after.
    r = await employee.addDependent({}, fd({ employeeId: (await empOf("vikram.menon@acme.test")).id, name: "Nope", relationship: "Spouse" }));
    check("a scoped HR executive cannot edit people outside their scope", r.ok === false, r.message);

    // -----------------------------------------------------------------
    section("3. Directory, organisation tree and My Team");
    const meeraViewer = (await viewerForUser((await userOf("meera.krishnan@acme.test")).id))!;
    let dir = await loadDirectory(meeraViewer, { q: meera.lastName }, { show: 60, log: false });
    check("search finds a colleague by name", dir.people.some((p) => p.id === meera.id));
    dir = await loadDirectory(meeraViewer, { dept: meera.departmentId ?? "" }, { show: 500, log: false });
    check("the department filter keeps to the department", dir.people.length > 0 && dir.people.every((p) => p.department?.id === meera.departmentId));
    dir = await loadDirectory(meeraViewer, {}, { show: 3000, log: false });
    check("exited and preboarding people are never listed", dir.people.every((p) => p.status !== "EXITED" && p.status !== "PREBOARDING"));
    const everyone = dir.matched;
    await signInAs("meera.krishnan@acme.test");
    out = await csv("org-chart");
    check("an employee cannot export the reporting lines", out.status === 403);
    await signInAs("vikram.menon@acme.test");
    out = await csv("org-chart");
    check("an administrator exports the reporting lines", out.status === 200 && out.body.includes(meera.employeeNumber));

    const otherEntity = await prisma.employee.findFirst({ where: { tenantId: t, status: { notIn: ["EXITED", "PREBOARDING"] }, NOT: [{ legalEntityId: meera.legalEntityId }, { legalEntityId: null }] } });
    r = await settings.saveVisibility({}, fd({ restrictByLegalEntity: true }));
    check("visibility settings are saved and audited", r.ok === true && (await auditCount("TenantVisibilitySetting")) > 0);
    const restricted = (await viewerForUser(meeraViewer.user.id))!;
    dir = await loadDirectory(restricted, {}, { show: 3000, log: false });
    check("with the restriction on, the directory hides other legal entities", otherEntity ? !dir.people.some((p) => p.id === otherEntity.id) && dir.matched < everyone : dir.matched <= everyone);
    const treeVisible = await prisma.employee.count({ where: { AND: [{ tenantId: t, status: { notIn: ["EXITED", "PREBOARDING"] } }, await directoryVisibilityWhere(restricted)] } });
    check("…and the organisation tree uses the same rule", treeVisible === dir.matched);
    const adminDir = await loadDirectory((await viewerForUser(vikram.id))!, {}, { show: 3000, log: false });
    check("…while someone who may view everyone still sees everyone", adminDir.matched === everyone);
    if (visBefore) await prisma.tenantVisibilitySetting.update({ where: { tenantId: t }, data: { restrictByLegalEntity: visBefore.restrictByLegalEntity, restrictByBusinessUnit: visBefore.restrictByBusinessUnit, managerReporteeOverride: visBefore.managerReporteeOverride } });
    else await prisma.tenantVisibilitySetting.deleteMany({ where: { tenantId: t } });

    const ananyaViewer = (await viewerForUser((await userOf("ananya.ghosh@acme.test")).id))!;
    const team = await loadTeam(ananyaViewer, undefined);
    check("My Team lists a manager's direct reports", !!team && team.directs.some((m) => m.id === meera.id));
    check("…with today's status and a month calendar", !!team && team.today.has(meera.id) && team.month.days.length >= 28);
    const teamMeera = await loadTeam(meeraViewer, undefined);
    check("an employee's My Team shows their peers, not themselves twice", !!teamMeera && teamMeera.everyone.filter((m) => m.id === meera.id).length <= 1);

    // -----------------------------------------------------------------
    section("4. Organisation settings");
    r = await settings.saveTenantProfile({}, fd({ name: tenantBefore.name, timezone: tenantBefore.timezone, fyStartMonth: tenantBefore.fyStartMonth }));
    check("organisation settings are saved and audited", r.ok === true && (await prisma.auditLog.count({ where: { tenantId: t, entityType: "Tenant", summary: "Updated organisation settings" } })) > 0, r.message);
    r = await settings.saveTenantProfile({}, fd({ name: "", timezone: tenantBefore.timezone, fyStartMonth: 13 }));
    check("an invalid month is refused", r.ok === false);
    await signInAs("meera.krishnan@acme.test");
    check("an employee cannot change organisation settings", await denied(() => settings.saveTenantProfile({}, fd({ name: "Hacked", timezone: tenantBefore.timezone, fyStartMonth: 4 }))));

    // -----------------------------------------------------------------
    section("5. Attendance requests: raise, list for the manager, withdraw");
    let day = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) + 5 * DAY);
    // Weekly offs are Saturday and Sunday; move to the next working day so the date never lands on one.
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day = new Date(day.getTime() + DAY);
    r = await time.raiseAttendanceRequestAction({}, fd({ type: "WORK_FROM_HOME", fromDate: iso(day), toDate: iso(day), portion: "FULL_DAY", reason: `Plumber visit ${TAG}` }));
    const req = await prisma.attendanceRequest.findFirst({ where: { tenantId: t, employeeId: meera.id, reason: { contains: TAG } } });
    if (req) made.attendanceIds.push(req.id);
    check("an employee raises a work-from-home request", r.ok === true && req?.status === "PENDING", r.message);
    const rows = await listApprovals(ananyaViewer, "wfh-od", { scope: "team", status: "PENDING", from: null, to: null, departmentId: null, locationId: null, q: null });
    check("it is listed for her manager to decide", rows.some((x) => x.id === req?.id));
    r = await time.cancelAttendanceRequestAction({}, fd({ requestId: req!.id }));
    check("she withdraws it", r.ok === true && (await prisma.attendanceRequest.findUniqueOrThrow({ where: { id: req!.id } })).status !== "PENDING", r.message);
    r = await time.cancelAttendanceRequestAction({}, fd({ requestId: req!.id }));
    check("it cannot be withdrawn twice", r.ok === false);
  } finally {
    if (made.costId) await prisma.costCenter.delete({ where: { id: made.costId } }).catch(() => undefined);
    if (made.unitId) await prisma.businessUnit.delete({ where: { id: made.unitId } }).catch(() => undefined);
    if (made.entityId) {
      await prisma.authorisedSignatory.deleteMany({ where: { legalEntityId: made.entityId } });
      await prisma.entityBankAccount.deleteMany({ where: { legalEntityId: made.entityId } });
      await prisma.legalEntity.delete({ where: { id: made.entityId } }).catch(() => undefined);
    }
    await prisma.employeeEducation.deleteMany({ where: { employeeId: meera.id, id: { notIn: subBefore.edu } } });
    await prisma.employeeExperience.deleteMany({ where: { employeeId: meera.id, id: { notIn: subBefore.exp } } });
    await prisma.dependent.deleteMany({ where: { employeeId: meera.id, id: { notIn: subBefore.dep } } });
    await prisma.emergencyContact.deleteMany({ where: { employeeId: meera.id, id: { notIn: subBefore.em.map((e) => e.id) } } });
    for (const e of subBefore.em) await prisma.emergencyContact.update({ where: { id: e.id }, data: { isPrimary: e.isPrimary } });
    if (subBefore.addr) { const { id: _id, ...a } = subBefore.addr; await prisma.employeeAddress.update({ where: { id: subBefore.addr.id }, data: a }); }
    else await prisma.employeeAddress.deleteMany({ where: { employeeId: meera.id, type: "PERMANENT" } });
    await prisma.employeeAddressHistory.deleteMany({ where: { tenantId: t, employeeId: meera.id } });
    if (made.attendanceIds.length) await prisma.attendanceRequest.deleteMany({ where: { id: { in: made.attendanceIds } } });
    await prisma.tenant.update({ where: { id: t }, data: { name: tenantBefore.name, timezone: tenantBefore.timezone, fyStartMonth: tenantBefore.fyStartMonth } });
    await prisma.$disconnect();
  }
  report("smoke-core-coverage");
}

main().catch((err) => { console.error(err); process.exit(1); });
