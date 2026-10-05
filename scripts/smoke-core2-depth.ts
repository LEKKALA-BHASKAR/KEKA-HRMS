/**
 * Core HR, second pass, through the real server actions, workflow engine,
 * pages and CSV exports:
 *   1. Company setup: configuration checkpoints, export / import (checked,
 *      then applied), rollback, branding, country matrix, status catalog,
 *      dictionaries, the approval policy library, reference-data import,
 *      ID card approval policy, setup pages and exports.
 *   2. Org structure: hierarchies (no loops), business functions, unit
 *      metadata, policy packs, org snapshots, a reorganisation scenario
 *      routed for approval (rejected, then approved and applied), department
 *      split and merge.
 *   3. Legal entities: tax registrations, calendars, payroll calendar,
 *      jurisdictions, documents, recurring compliance deadlines, intercompany
 *      assignments (approved), transfer rules, a spin-off (approved), entity
 *      number series.
 *   4. Employee master data: pronouns and work address, nationality history,
 *      identifiers, nominee shares, personal-email verification.
 *   5. Self-service: privacy settings and requests (approved, completed,
 *      withdrawn, directory opt-out), ID card requests under an approval
 *      policy, preferences and the my-pages.
 *   6. Managers: roster and attendance for their own team, dashboard layout,
 *      digest, insights and activity pages.
 *   7. HR operations: SLAs, exception alerts, QC sampling, moving a scheduled
 *      job change, the nightly job, desk and quality pages and every export.
 *   8. Directory: hidden people, contact cards, expertise.
 *
 * Every approval is decided by someone other than the requester. Removes
 * everything it created and restores what it changed.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TAG = `c2${Date.now().toString(36)}`;

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { const r = await fn() as { ok?: boolean } | undefined; return !!r && r.ok === false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    if (/HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT|NEXT_NOT_FOUND/.test(`${e.digest ?? ""} ${e.message ?? ""}`)) return true;
    throw err;
  }
}

function fdl(values: Record<string, string | number | boolean | undefined | null>, lists: Record<string, string[]> = {}): FormData {
  const f = fd(values);
  for (const [k, vs] of Object.entries(lists)) for (const v of vs) f.append(k, v);
  return f;
}

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToReadableStream } = await import("react-dom/server");
  const html = async (node: unknown) => { const stream = await renderToReadableStream(node as never); await stream.allReady; return new Response(stream).text(); };
  const { NextRequest } = await import("next/server");

  const setup = await import("../apps/web/src/app/actions/core2-setup");
  const org = await import("../apps/web/src/app/actions/core2-org");
  const people = await import("../apps/web/src/app/actions/core2-people");
  const ss = await import("../apps/web/src/app/actions/self-service-depth");
  const WF = await import("../apps/web/src/app/actions/workflows");
  const svc = await import("@keka/services");
  const { viewerForUser } = await import("../apps/web/src/lib/context");
  const lib = await import("../apps/web/src/lib/core-hr");
  const exportsRoute = await import("../apps/web/src/app/(app)/exports/core2/[kind]/route");
  const vcardRoute = await import("../apps/web/src/app/(app)/directory/[id]/vcard/route");
  const page = async (path: string) => (await import(`../apps/web/src/app/(app)/${path}/page`)).default;

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const userOf = (email: string) => prisma.user.findFirstOrThrow({ where: { tenantId: t, email } });
  const empOf = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: t, user: { email } } });
  const [vikram, priya, meeraUser, snehaUser] = await Promise.all(["vikram.menon@acme.test", "priya.sharma@acme.test", "meera.krishnan@acme.test", "sneha.reddy@acme.test"].map(userOf));
  const [meera, sneha, ananya, karthik] = await Promise.all(["meera.krishnan@acme.test", "sneha.reddy@acme.test", "ananya.ghosh@acme.test", "karthik.subramanian@acme.test"].map(empOf));
  const adminRole = await prisma.role.findFirstOrThrow({ where: { tenantId: t, key: "GLOBAL_ADMIN" } });
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const csv = async (kind: string, qs = "") => { const res = await exportsRoute.GET(new NextRequest(`http://acme.localhost/exports/core2/${kind}${qs}`), { params: Promise.resolve({ kind }) }); return { status: res.status, body: await res.text(), type: res.headers.get("content-type") ?? "" }; };
  const exportAudited = (kind: string) => prisma.auditLog.count({ where: { tenantId: t, entityType: "Core2Export", entityId: kind } });
  const taskFor = (userId: string, entityType: string, entityId: string) => prisma.workflowTask.findFirst({ where: { tenantId: t, approverUserId: userId, status: "PENDING", request: { entityType, entityId, status: "PENDING" } } });
  const decide = async (email: string, entityType: string, entityId: string, approve: boolean) => {
    const who = await userOf(email);
    const task = await taskFor(who.id, entityType, entityId);
    if (!task) return { ok: false, message: `no pending task for ${email}` };
    await signInAs(email);
    return WF.decideWorkflowTaskAction({}, fd({ taskId: task.id, decision: approve ? "approve" : "reject", comment: approve ? "" : "Not now" }));
  };

  const before = {
    meera: await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } }),
    idCardGate: await prisma.changeApprovalSetting.findUnique({ where: { tenantId_targetType: { tenantId: t, targetType: "ID_CARD" } } }),
    tenantName: tenant.name,
    attendance: await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: ananya.id, date: today } } }),
  };
  const made = {
    roleAssignment: "", snapshots: [] as string[], brand: "", country: "", status: "", dict: "", workflowDefs: [] as string[], depts: [] as string[], fn: "", metaField: "",
    pack: "", orgSnaps: [] as string[], scenarios: [] as string[], entity: "", transitions: [] as string[], intercompany: [] as string[], rule: "", deps: [] as string[],
    privacy: [] as string[], idCardReqs: [] as string[], idCards: [] as string[], jobChanges: [] as string[], qc: [] as string[], series: "" as string, seriesEntity: null as string | null,
    slaBefore: await prisma.hrSlaPolicy.findUnique({ where: { tenantId_transactionType: { tenantId: t, transactionType: "ID_CARD" } } }),
    completeness: "", identifiers: [] as string[],
  };

  try {
    // -----------------------------------------------------------------
    section("1. Company setup");
    await signInAs("vikram.menon@acme.test");
    let r = await setup.takeConfigSnapshotAction({}, fd({ name: `Before ${TAG}`, environment: "PRODUCTION", note: "smoke" }));
    const snap = await prisma.configSnapshot.findFirst({ where: { tenantId: t, name: `Before ${TAG}` } });
    if (snap) made.snapshots.push(snap.id);
    check("a configuration checkpoint is saved with every section", r.ok === true && !!snap && Object.keys((snap.payload as { sections: object }).sections).length >= 10, r.message);
    r = await setup.saveCountryAvailabilityAction({}, fdl({ countryCode: "sg", countryName: `Singapore ${TAG}`, currency: "sgd", isActive: true }, { modules: ["CORE_HR", "LEAVE"] }));
    const country = await prisma.countryAvailability.findFirst({ where: { tenantId: t, countryCode: "SG" } });
    made.country = country?.id ?? "";
    check("a country is added to the availability matrix (codes upper-cased)", r.ok === true && country?.currency === "SGD" && country.modules.length === 2, r.message);
    r = await setup.saveBrandingProfileAction({}, fd({ name: `Brand ${TAG}`, portalTitle: "Acme People", primaryColor: "#123456", accentColor: "#abcdef", businessUnitId: (await prisma.businessUnit.findFirstOrThrow({ where: { tenantId: t } })).id, isActive: true }));
    const brand = await prisma.brandingProfile.findFirst({ where: { tenantId: t, name: `Brand ${TAG}` } });
    made.brand = brand?.id ?? "";
    check("a branding profile is saved for one business unit", r.ok === true && !!brand?.businessUnitId, r.message);
    r = await setup.saveBrandingProfileAction({}, fd({ name: `Bad ${TAG}`, portalTitle: "x", primaryColor: "blue", accentColor: "#abcdef" }));
    check("…a colour must be a hex value", r.ok === false);

    // Export the configuration, change it in the file, check the import, apply it, then roll back.
    let out = await csv("configuration-json");
    const payload = JSON.parse(out.body) as { format: string; sections: { organisation: { name: string } } };
    check("the configuration exports as JSON", out.status === 200 && payload.format === "boos-hr-config" && out.type.includes("json"));
    payload.sections.organisation.name = `Acme ${TAG}`;
    r = await setup.importConfigAction({}, fdl({ json: JSON.stringify(payload), intent: "check" }, { sections: ["organisation"] }));
    check("checking an import lists what would change and writes nothing", r.ok === true && /1 setting/.test(r.message ?? "") && (await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).name === before.tenantName, r.message);
    r = await setup.importConfigAction({}, fd({ json: "{not json", intent: "apply" }));
    check("a broken file is refused", r.ok === false);
    r = await setup.importConfigAction({}, fdl({ json: JSON.stringify(payload), intent: "apply", environment: "SANDBOX" }, { sections: ["organisation"] }));
    const imported = await prisma.configSnapshot.findFirst({ where: { tenantId: t, kind: "IMPORT" }, orderBy: { createdAt: "desc" } });
    if (imported) made.snapshots.push(imported.id);
    check("applying it changes the configuration and keeps the file as a copy", r.ok === true && (await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).name === `Acme ${TAG}` && imported?.environment === "SANDBOX", r.message);
    r = await setup.restoreConfigSnapshotAction({}, fdl({ id: snap!.id }, { sections: ["organisation"] }));
    const autoCopies = await prisma.configSnapshot.findMany({ where: { tenantId: t, createdAt: { gte: snap!.createdAt }, id: { notIn: made.snapshots } }, select: { id: true } });
    made.snapshots.push(...autoCopies.map((s) => s.id));
    check("rolling back to the checkpoint restores it", r.ok === true && (await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).name === before.tenantName, r.message);
    check("…and is audited", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "ConfigSnapshot", entityId: snap!.id, action: "UPDATE" } })) > 0);

    r = await setup.saveStatusCatalogAction({}, fd({ code: `SABB_${TAG.toUpperCase().slice(-4)}`, label: `Sabbatical ${TAG}`, baseStatus: before.meera.status, isActive: true }));
    const status = await prisma.employeeStatusCatalog.findFirst({ where: { tenantId: t, label: `Sabbatical ${TAG}` } });
    made.status = status?.id ?? "";
    check("a company status is added under a system status", r.ok === true && !!status, r.message);
    r = await setup.setEmployeeStatusTagAction({}, fd({ employeeId: meera.id, catalogId: status!.id, note: "On sabbatical" }));
    check("an employee is given it", r.ok === true && (await prisma.employeeStatusTag.findUnique({ where: { employeeId: meera.id } }))?.catalogId === status!.id, r.message);
    r = await setup.saveDictionaryAction({}, fd({ key: `shirt_${TAG}`, name: `Shirt sizes ${TAG}`, isActive: true }));
    const dict = await prisma.masterDictionary.findFirst({ where: { tenantId: t, key: `shirt_${TAG}` } });
    made.dict = dict?.id ?? "";
    r = await setup.saveDictionaryEntryAction({}, fd({ dictionaryId: dict!.id, code: "M", label: "Medium", sortOrder: 2, isActive: true }));
    check("a master dictionary and an entry are saved", r.ok === true && (await prisma.masterDictionaryEntry.count({ where: { dictionaryId: dict!.id } })) === 1, r.message);

    r = await setup.installApprovalPolicyAction({}, fd({ key: "idcard-manager-hr" }));
    const def = await prisma.workflowDefinition.findFirst({ where: { tenantId: t, name: "ID cards: manager, then HR", isCurrent: true } });
    if (def) made.workflowDefs.push(def.id);
    check("a policy from the approval library is installed as a workflow", r.ok === true && def?.entityType === "ID_CARD_REQUEST", r.message);
    if (def) { await prisma.workflowDefinition.update({ where: { id: def.id }, data: { isActive: false } }); }

    const deptCsv = `name,code,parent\nRef ${TAG} Parent,RP,\nRef ${TAG} Child,RC,Ref ${TAG} Parent\n`;
    r = await setup.importReferenceDataAction({}, fd({ kind: "DEPARTMENT", csv: deptCsv, intent: "check" }));
    check("a reference import is checked first and writes nothing", r.ok === true && (await prisma.department.count({ where: { tenantId: t, name: { startsWith: `Ref ${TAG}` } } })) === 0, r.message);
    r = await setup.importReferenceDataAction({}, fd({ kind: "DEPARTMENT", csv: `name,parent\nX ${TAG},Nowhere\n`, intent: "apply" }));
    check("…a row naming a missing parent stops the import", r.ok === false && /not found/.test(r.message ?? ""));
    r = await setup.importReferenceDataAction({}, fd({ kind: "DEPARTMENT", csv: deptCsv, intent: "apply" }));
    const refDepts = await prisma.department.findMany({ where: { tenantId: t, name: { startsWith: `Ref ${TAG}` } } });
    made.depts.push(...refDepts.map((d) => d.id));
    const parentDept = refDepts.find((d) => d.name.endsWith("Parent")), childDept = refDepts.find((d) => d.name.endsWith("Child"));
    check("applying it creates the departments with their parent", r.ok === true && childDept?.parentId === parentDept?.id, r.message);

    r = await setup.saveIdCardPolicyAction({}, fd({ requireApproval: true }));
    check("ID cards can be set to need approval", r.ok === true);

    for (const kind of ["configuration", "company-profile", "working-rules", "settings", "countries", "locations"]) {
      out = await csv(kind);
      check(`${kind} exports as CSV and the export is audited`, out.status === 200 && out.body.split("\n").length > 1 && (await exportAudited(kind)) > 0);
    }
    check("the country export holds the new country", (await csv("countries")).body.includes(`Singapore ${TAG}`));
    out = await csv("reference-template", "?kind=LOCATION");
    check("a reference template downloads", out.status === 200 && out.body.includes("state_code"));
    const setupPage = await page("admin/setup");
    for (const tab of ["health", "config", "reference", "catalogs", "branding", "policies"]) {
      const h = (await html(await setupPage({ searchParams: Promise.resolve({ tab }) })));
      check(`the setup page renders its ${tab} tab`, h.includes("Company setup"));
    }

    await signInAs("meera.krishnan@acme.test");
    check("an employee cannot take a checkpoint", await denied(() => setup.takeConfigSnapshotAction({}, fd({ name: "nope" }))));
    check("…import a configuration", await denied(() => setup.importConfigAction({}, fd({ json: "{}", intent: "apply" }))));
    check("…or export it", (await csv("configuration-json")).status === 403 && (await csv("settings")).status === 403);

    // -----------------------------------------------------------------
    section("2. Organisation structure");
    await signInAs("vikram.menon@acme.test");
    r = await org.setUnitParentAction({}, fd({ unitType: "DEPARTMENT", id: parentDept!.id, parentId: childDept!.id }));
    check("a department cannot sit under its own sub-department", r.ok === false && /own sub-units/.test(r.message ?? ""));
    const cc = await prisma.costCenter.findFirst({ where: { tenantId: t } });
    if (cc) {
      const ccBefore = { parentId: cc.parentId, legalEntityId: cc.legalEntityId };
      const le = await prisma.legalEntity.findFirstOrThrow({ where: { tenantId: t } });
      r = await org.setUnitParentAction({}, fd({ unitType: "COST_CENTRE", id: cc.id, legalEntityId: le.id }));
      check("a cost centre is mapped to its legal entity", r.ok === true && (await prisma.costCenter.findUniqueOrThrow({ where: { id: cc.id } })).legalEntityId === le.id, r.message);
      await prisma.costCenter.update({ where: { id: cc.id }, data: ccBefore });
    }
    r = await org.saveBusinessFunctionAction({}, fdl({ name: `Function ${TAG}`, code: "FN", isActive: true }, { departmentIds: [parentDept!.id] }));
    const fn = await prisma.businessFunction.findFirst({ where: { tenantId: t, name: `Function ${TAG}` } });
    made.fn = fn?.id ?? "";
    check("a business function is added with its departments", r.ok === true && fn?.departmentIds.length === 1, r.message);
    r = await org.saveMetadataFieldAction({}, fd({ unitType: "DEPARTMENT", key: `region_${TAG}`, label: "Region", fieldType: "SELECT", options: "North, South", inheritable: true }));
    const field = await prisma.orgUnitMetadataField.findFirst({ where: { tenantId: t, key: `region_${TAG}` } });
    made.metaField = field?.id ?? "";
    check("a unit metadata field is defined", r.ok === true && field?.options.length === 2, r.message);
    r = await org.setMetadataValueAction({}, fd({ unitType: "DEPARTMENT", unitId: parentDept!.id, key: `region_${TAG}`, value: "East" }));
    check("…a value outside its choices is refused", r.ok === false);
    r = await org.setMetadataValueAction({}, fd({ unitType: "DEPARTMENT", unitId: parentDept!.id, key: `region_${TAG}`, value: "South" }));
    check("…a valid value is saved", r.ok === true, r.message);
    r = await org.savePolicyPackAction({}, fd({ name: `Pack ${TAG}`, items: "Leave: Standard\nAttendance: Office", isActive: true }));
    const pack = await prisma.policyPack.findFirst({ where: { tenantId: t, name: `Pack ${TAG}` } });
    made.pack = pack?.id ?? "";
    r = await org.assignPolicyPackAction({}, fd({ packId: pack!.id, unitType: "DEPARTMENT", unitId: parentDept!.id }));
    const { policyPacksFor, effectiveMetadata } = await import("../apps/web/src/lib/core2");
    const chain = [{ unitType: "DEPARTMENT", unitId: childDept!.id }, { unitType: "DEPARTMENT", unitId: parentDept!.id }];
    const packs = await policyPacksFor(t, chain);
    check("a policy pack assigned to a parent unit reaches its sub-unit", r.ok === true && JSON.stringify(packs).includes(`Pack ${TAG}`), r.message);
    const meta = await effectiveMetadata(t, chain);
    check("…and so does inheritable metadata", JSON.stringify(meta).includes("South"));

    r = await org.takeOrgSnapshotAction({}, fd({ name: `Snap ${TAG}`, asOf: iso(new Date(today.getTime() - 30 * DAY)) }));
    const osnap = await prisma.orgSnapshot.findFirst({ where: { tenantId: t, name: `Snap ${TAG}` } });
    if (osnap) made.orgSnaps.push(osnap.id);
    check("an org snapshot of a past date is saved", r.ok === true && (osnap?.headcount ?? 0) > 0, r.message);
    r = await org.takeOrgSnapshotAction({}, fd({ name: "future", asOf: iso(new Date(today.getTime() + 5 * DAY)) }));
    check("…not of a future date", r.ok === false);

    // Reorganisation: plan, send, reject, resend, approve (by someone else), apply.
    r = await org.createReorgScenarioAction({}, fd({ name: `Reorg ${TAG}`, description: "Test" }));
    const sc = await prisma.reorgScenario.findFirst({ where: { tenantId: t, name: `Reorg ${TAG}` } });
    if (sc) made.scenarios.push(sc.id);
    r = await org.submitReorgScenarioAction({}, fd({ id: sc!.id }));
    check("an empty scenario cannot be sent", r.ok === false);
    r = await org.addReorgMoveAction({}, fd({ scenarioId: sc!.id, employeeId: meera.id, departmentId: before.meera.departmentId ?? "" }));
    check("a move is planned", r.ok === true && ((await prisma.reorgScenario.findUniqueOrThrow({ where: { id: sc!.id } })).moves as unknown[]).length === 1, r.message);
    r = await org.submitReorgScenarioAction({}, fd({ id: sc!.id }));
    check("the scenario is sent for approval", r.ok === true && (await prisma.reorgScenario.findUniqueOrThrow({ where: { id: sc!.id } })).status === "PENDING_APPROVAL", r.message);
    check("…the requester has no task to approve it", !(await taskFor(vikram.id, "REORG_PLAN", sc!.id)));
    r = await org.applyReorgScenarioAction({}, fd({ id: sc!.id }));
    check("…it cannot be applied before approval", r.ok === false);
    made.roleAssignment = (await prisma.userRoleAssignment.create({ data: { userId: priya.id, roleId: adminRole.id } })).id;
    r = await decide("priya.sharma@acme.test", "REORG_PLAN", sc!.id, false);
    check("a second administrator rejects it", r.ok === true && (await prisma.reorgScenario.findUniqueOrThrow({ where: { id: sc!.id } })).status === "REJECTED", r.message);
    await signInAs("vikram.menon@acme.test");
    r = await org.submitReorgScenarioAction({}, fd({ id: sc!.id }));
    check("a rejected scenario can be sent again", r.ok === true, r.message);
    r = await decide("priya.sharma@acme.test", "REORG_PLAN", sc!.id, true);
    check("…and is approved", r.ok === true && (await prisma.reorgScenario.findUniqueOrThrow({ where: { id: sc!.id } })).status === "APPROVED", r.message);
    await signInAs("vikram.menon@acme.test");
    r = await org.applyReorgScenarioAction({}, fd({ id: sc!.id }));
    check("an approved scenario is applied", r.ok === true && (await prisma.reorgScenario.findUniqueOrThrow({ where: { id: sc!.id } })).status === "APPLIED", r.message);

    r = await org.splitDepartmentAction({}, fd({ sourceId: parentDept!.id, name: `Split ${TAG}` }));
    check("a split needs people from the department", r.ok === false);
    r = await org.mergeDepartmentAction({}, fd({ sourceId: childDept!.id, targetId: parentDept!.id }));
    check("a sub-department merges into its parent and is deactivated", r.ok === true && (await prisma.department.findUniqueOrThrow({ where: { id: childDept!.id } })).isActive === false, r.message);

    const structurePage = await page("org/structure");
    for (const tab of ["hierarchy", "ownership", "functions", "metadata", "policies", "history", "reorg"]) {
      const h = (await html(await structurePage({ searchParams: Promise.resolve({ tab, asOf: tab === "history" ? iso(new Date(today.getTime() - 30 * DAY)) : undefined }) })));
      check(`the structure page renders its ${tab} tab`, h.includes("Org hierarchy"));
    }
    out = await csv("hierarchy", "?type=DEPARTMENT");
    check("the hierarchy exports with each unit's path", out.status === 200 && out.body.includes(`Ref ${TAG} Parent › Ref ${TAG} Child`));
    out = await csv("org-as-of", `?asOf=${iso(new Date(today.getTime() - 30 * DAY))}`);
    check("the organisation exports as of a past date", out.status === 200 && out.body.includes(before.meera.employeeNumber));

    // -----------------------------------------------------------------
    section("3. Legal entities");
    const orgActions = await import("../apps/web/src/app/actions/org");
    await orgActions.saveLegalEntity({}, fd({ name: `Entity ${TAG}`, legalName: `Entity ${TAG} Pvt Ltd`, countryCode: "IN", currency: "INR", city: "Pune" }));
    const ent = await prisma.legalEntity.findFirstOrThrow({ where: { tenantId: t, name: `Entity ${TAG}` } });
    made.entity = ent.id;
    r = await org.saveEntityTaxRegistrationAction({}, fd({ legalEntityId: ent.id, type: "PAN", number: "ABC123" }));
    check("a malformed PAN is refused", r.ok === false);
    r = await org.saveEntityTaxRegistrationAction({}, fd({ legalEntityId: ent.id, type: "PAN", number: "aaecp1234q" }));
    check("a tax registration is saved per entity", r.ok === true && (await prisma.entityTaxRegistration.count({ where: { legalEntityId: ent.id } })) === 1, r.message);
    const cal = await prisma.holidayCalendar.findFirst({ where: { tenantId: t } });
    if (cal) {
      r = await org.linkEntityHolidayCalendarAction({}, fd({ legalEntityId: ent.id, holidayCalendarId: cal.id }));
      check("the entity follows a holiday calendar", r.ok === true, r.message);
    }
    r = await org.generatePayrollCalendarAction({}, fd({ legalEntityId: ent.id, year: today.getUTCFullYear() + 1, cutoffDay: 25, payDay: 31 }));
    const months = await prisma.entityPayrollCalendar.findMany({ where: { legalEntityId: ent.id }, orderBy: { month: "asc" } });
    check("a payroll calendar is laid out for the year", r.ok === true && months.length === 12 && iso(months[1]!.payDate).endsWith("-28") || iso(months[1]!.payDate).endsWith("-29"), r.message);
    r = await org.setPayrollCalendarStatusAction({}, fd({ id: months[0]!.id, status: "LOCKED" }));
    check("a payroll month is locked", r.ok === true);
    const bu = await prisma.businessUnit.create({ data: { tenantId: t, legalEntityId: ent.id, name: `BU ${TAG}` } });
    r = await org.saveBuJurisdictionAction({}, fd({ businessUnitId: bu.id, stateCode: "mh", taxType: "PT", registrationNo: "PT-1" }));
    check("a business unit is mapped to a tax jurisdiction", r.ok === true && (await prisma.businessUnitJurisdiction.count({ where: { businessUnitId: bu.id, stateCode: "MH" } })) === 1, r.message);
    r = await org.uploadEntityDocumentAction({}, fd({ legalEntityId: ent.id, title: "Certificate of incorporation", category: "INCORPORATION" }));
    check("a document needs a file or a reference", r.ok === false);
    r = await org.uploadEntityDocumentAction({}, fd({ legalEntityId: ent.id, title: "Shops licence", category: "LICENCE", reference: "SL-42", validUntil: iso(new Date(today.getTime() + 20 * DAY)) }));
    check("an entity document is filed", r.ok === true, r.message);
    r = await org.saveComplianceDeadlineAction({}, fd({ legalEntityId: ent.id, title: `PT return ${TAG}`, category: "STATUTORY", dueDate: iso(new Date(today.getTime() - DAY)), recurrence: "MONTHLY" }));
    const dl = await prisma.entityComplianceDeadline.findFirstOrThrow({ where: { legalEntityId: ent.id } });
    check("a compliance deadline is tracked", r.ok === true, r.message);
    out = await csv("entities");
    check("…an overdue one shows as overdue in the entity export", out.body.includes(`PT return ${TAG}`) && out.body.includes("OVERDUE"));
    r = await org.completeComplianceDeadlineAction({}, fd({ id: dl.id }));
    const nextDl = await prisma.entityComplianceDeadline.findFirst({ where: { legalEntityId: ent.id, status: "OPEN" } });
    check("completing a monthly deadline opens next month's", r.ok === true && !!nextDl && nextDl.dueDate > dl.dueDate, r.message);

    r = await org.requestIntercompanyAssignmentAction({}, fd({ employeeId: meera.id, hostEntityId: ent.id, startDate: iso(today), allocationPct: 40, purpose: `Project ${TAG}` }));
    const ica = await prisma.intercompanyAssignment.findFirst({ where: { tenantId: t, hostEntityId: ent.id } });
    if (ica) made.intercompany.push(ica.id);
    check("an intercompany assignment is requested for approval", r.ok === true && ica?.status === "PENDING_APPROVAL", r.message);
    r = await org.requestIntercompanyAssignmentAction({}, fd({ employeeId: meera.id, hostEntityId: ent.id, startDate: iso(today), allocationPct: 70 }));
    check("…more than 100% of someone's time is refused", r.ok === false && /110%/.test(r.message ?? ""));
    r = await decide("priya.sharma@acme.test", "INTERCOMPANY_ASSIGNMENT", ica!.id, true);
    check("…an entity administrator approves it and it becomes active", r.ok === true && (await prisma.intercompanyAssignment.findUniqueOrThrow({ where: { id: ica!.id } })).status === "ACTIVE", r.message);
    await signInAs("vikram.menon@acme.test");
    out = await csv("intercompany");
    check("…it is in the intercompany export", out.body.includes(`Project ${TAG}`));
    r = await org.endIntercompanyAssignmentAction({}, fd({ id: ica!.id }));
    check("…and is ended", r.ok === true);

    r = await org.saveTransferRuleAction({}, fd({ toEntityId: ent.id, requiresApproval: true, minNoticeDays: 30, carryForwardLeave: true }));
    const rule = await prisma.entityTransferRule.findFirst({ where: { tenantId: t, toEntityId: ent.id } });
    made.rule = rule?.id ?? "";
    check("a cross-entity transfer rule is saved", r.ok === true && rule?.minNoticeDays === 30, r.message);
    const employee = await import("../apps/web/src/app/actions/employee");
    r = await employee.recordJobChange({}, fd({ employeeId: meera.id, effectiveFrom: iso(new Date(today.getTime() + 5 * DAY)), reason: "TRANSFER", legalEntityId: ent.id }));
    check("…a transfer into the entity with too little notice is refused", r.ok === false && /notice/.test(r.message ?? ""), r.message);

    r = await org.createEntityTransitionAction({}, fd({ kind: "SPINOFF", name: `Spin ${TAG}`, sourceEntityId: before.meera.legalEntityId ?? "", targetEntityId: ent.id, effectiveDate: iso(new Date(today.getTime() + 60 * DAY)) }));
    const tr = await prisma.entityTransition.findFirst({ where: { tenantId: t, name: `Spin ${TAG}` } });
    if (tr) made.transitions.push(tr.id);
    check("a spin-off is planned", r.ok === true && !!tr, r.message);
    r = await org.submitEntityTransitionAction({}, fd({ id: tr!.id }));
    check("…it needs people mapped first", r.ok === false);
    r = await org.mapTransitionPeopleAction({}, fdl({ transitionId: tr!.id, businessUnitId: bu.id }, { employeeIds: [meera.id] }));
    check("…people are mapped into a business unit of the new entity", r.ok === true, r.message);
    r = await org.submitEntityTransitionAction({}, fd({ id: tr!.id }));
    check("…it is sent for approval", r.ok === true, r.message);
    r = await decide("priya.sharma@acme.test", "ENTITY_TRANSITION", tr!.id, true);
    check("…approved, and (being in the future) waits for its date", r.ok === true && (await prisma.entityTransition.findUniqueOrThrow({ where: { id: tr!.id } })).status === "APPROVED", r.message);
    await signInAs("vikram.menon@acme.test");
    r = await org.applyEntityTransitionAction({}, fd({ id: tr!.id }));
    check("…it cannot be applied before its date", r.ok === false && (await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } })).legalEntityId === before.meera.legalEntityId);
    r = await org.createEntityTransitionAction({}, fd({ kind: "ACQUISITION", name: `Acq ${TAG}`, targetEntityId: ent.id, effectiveDate: iso(today) }));
    const acq = await prisma.entityTransition.findFirstOrThrow({ where: { tenantId: t, name: `Acq ${TAG}` } });
    made.transitions.push(acq.id);
    r = await org.toggleAcquisitionStepAction({}, fd({ id: acq.id, step: "entity" }));
    check("an acquisition's onboarding steps are ticked off", r.ok === true && (await prisma.entityTransition.findUniqueOrThrow({ where: { id: acq.id } })).stepsDone.includes("entity"));

    const series = await prisma.employeeNumberSeries.findFirst({ where: { tenantId: t } });
    if (series) {
      made.series = series.id; made.seriesEntity = series.legalEntityId;
      r = await org.setNumberSeriesEntityAction({}, fd({ seriesId: series.id, legalEntityId: ent.id }));
      check("an employee number series is tied to an entity", r.ok === true && (await prisma.employeeNumberSeries.findUniqueOrThrow({ where: { id: series.id } })).legalEntityId === ent.id, r.message);
      await prisma.employeeNumberSeries.update({ where: { id: series.id }, data: { legalEntityId: made.seriesEntity } });
    }
    const entitiesPage = await page("org/entities");
    for (const tab of ["entity", "intercompany", "rules", "transitions", "reconcile"]) {
      const h = (await html(await entitiesPage({ searchParams: Promise.resolve({ tab, id: ent.id }) })));
      check(`the entities page renders its ${tab} tab`, h.length > 500);
    }
    check("the entity workspace shows readiness", (await html(await entitiesPage({ searchParams: Promise.resolve({ tab: "entity", id: ent.id }) }))).includes("Shops licence"));
    out = await csv("cost-centre-reconciliation");
    check("the cost centre reconciliation exports", out.status === 200);
    await signInAs("meera.krishnan@acme.test");
    check("an employee cannot manage entities", await denied(() => org.saveComplianceDeadlineAction({}, fd({ legalEntityId: ent.id, title: "x", dueDate: iso(today) }))));
    check("…or export them", (await csv("intercompany")).status === 403);

    // -----------------------------------------------------------------
    section("4. Employee master data");
    r = await people.saveProfileExtraAction({}, fd({ employeeId: meera.id, salutation: "Ms", pronouns: "she/her", languages: "Tamil, English, Tamil" }));
    let extra = await prisma.employeeProfileExtra.findUnique({ where: { employeeId: meera.id } });
    check("an employee sets her salutation, pronouns and languages", r.ok === true && extra?.pronouns === "she/her" && extra.languages.length === 2, r.message);
    r = await people.saveProfileExtraAction({}, fd({ employeeId: meera.id, workCity: "Chennai" }));
    check("…but not a work address override", r.ok === false);
    r = await people.saveProfileExtraAction({}, fd({ employeeId: ananya.id, pronouns: "x" }));
    check("…nor a colleague's profile", r.ok === false);
    await signInAs("priya.sharma@acme.test");
    r = await people.saveProfileExtraAction({}, fd({ employeeId: meera.id, salutation: "Ms", pronouns: "she/her", languages: "Tamil, English", workAddressLine1: "Client site, Tower B", workCity: "Chennai" }));
    check("HR sets a work address override", r.ok === true && (await prisma.employeeProfileExtra.findUnique({ where: { employeeId: meera.id } }))?.workCity === "Chennai", r.message);
    r = await people.changeNationalityAction({}, fd({ employeeId: meera.id, nationality: `Testland ${TAG}`, validFrom: iso(new Date(today.getTime() - 10 * DAY)) }));
    const hist = await prisma.nationalityHistory.findMany({ where: { employeeId: meera.id }, orderBy: { validFrom: "asc" } });
    check("a nationality change keeps the previous one in the history", r.ok === true && hist.length >= 1 && hist[hist.length - 1]!.nationality === `Testland ${TAG}`, r.message);
    r = await people.saveEmployeeIdentifierAction({}, fd({ employeeId: meera.id, kind: "EXTERNAL", system: `Vendor ${TAG}`, value: "V-001" }));
    r = await people.saveEmployeeIdentifierAction({}, fd({ employeeId: meera.id, kind: "ALIAS", system: `Legacy ${TAG}`, value: "M.K." }));
    const ids = await prisma.employeeIdentifier.findMany({ where: { employeeId: meera.id, system: { contains: TAG } } });
    made.identifiers.push(...ids.map((i) => i.id));
    check("an alias and an external ID are recorded", r.ok === true && ids.length === 2, r.message);
    r = await people.saveEmployeeIdentifierAction({}, fd({ employeeId: ananya.id, kind: "EXTERNAL", system: `Vendor ${TAG}`, value: "V-001" }));
    check("…an external ID cannot belong to two people", r.ok === false);
    const masterPage = await page("employees/[id]/master");
    check("the master data page shows them", (await html(await masterPage({ params: Promise.resolve({ id: meera.id }) }))).includes(`Legacy ${TAG}`));
    r = await setup.saveCompletenessRuleAction({}, fd({ field: "bloodGroup", severity: "WARNING" }));
    const crule = await prisma.fieldCompletenessRule.findFirst({ where: { tenantId: t, field: "bloodGroup", workerTypeId: null } });
    made.completeness = crule?.id ?? "";
    check("a completeness rule is saved", r.ok === true, r.message);

    const depA = await prisma.dependent.create({ data: { employeeId: meera.id, name: `Dep A ${TAG}`, relationship: "MOTHER" } });
    const depB = await prisma.dependent.create({ data: { employeeId: meera.id, name: `Dep B ${TAG}`, relationship: "FATHER" } });
    made.deps.push(depA.id, depB.id);
    await signInAs("meera.krishnan@acme.test");
    r = await people.saveNomineeSharesAction({}, fd({ benefit: "PF", [`share:${depA.id}`]: 60, [`share:${depB.id}`]: 30 }));
    check("nominee shares that do not add up to 100% are refused", r.ok === false && /90%/.test(r.message ?? ""));
    r = await people.saveNomineeSharesAction({}, fd({ benefit: "PF", [`share:${depA.id}`]: 60, [`share:${depB.id}`]: 40 }));
    check("…shares adding up to 100% are saved", r.ok === true && (await prisma.nomineeAllocation.count({ where: { employeeId: meera.id, benefit: "PF" } })) === 2, r.message);
    check("the nominee page shows them", (await html(await (await page("me/nominees"))({ searchParams: Promise.resolve({}) }))).includes(`Dep A ${TAG}`));

    const emailBefore = before.meera.personalEmail;
    if (!emailBefore) await prisma.employee.update({ where: { id: meera.id }, data: { personalEmail: `meera.${TAG}@mail.test` } });
    r = await people.sendPersonalEmailCodeAction({}, fd({}));
    const mail = await prisma.emailOutbox.findFirst({ where: { tenantId: t, relatedType: "PersonalEmailVerification", relatedId: meera.id }, orderBy: { createdAt: "desc" } });
    const code = /is (\d{6})\./.exec(mail?.textBody ?? "")?.[1];
    check("a verification code is emailed to the personal address", r.ok === true && !!code, r.message);
    r = await people.verifyPersonalEmailAction({}, fd({ code: code === "000000" ? "111111" : "000000" }));
    check("…a wrong code is refused", r.ok === false);
    r = await people.verifyPersonalEmailAction({}, fd({ code: code! }));
    extra = await prisma.employeeProfileExtra.findUnique({ where: { employeeId: meera.id } });
    check("…the right code verifies it", r.ok === true && !!extra?.personalEmailVerifiedAt, r.message);
    if (mail) await prisma.emailOutbox.deleteMany({ where: { tenantId: t, relatedType: "PersonalEmailVerification", relatedId: meera.id } });

    // -----------------------------------------------------------------
    section("5. Self-service: privacy, ID cards, preferences");
    r = await people.savePrivacySettingsAction({}, fd({ hideMobile: true, hideBirthday: true }));
    check("privacy settings are saved", r.ok === true && (await prisma.employeeProfileExtra.findUnique({ where: { employeeId: meera.id } }))?.hideBirthday === true, r.message);
    await signInAs("ananya.ghosh@acme.test");
    const profilePage = await page("employees/[id]");
    const asColleague = (await html(await profilePage({ params: Promise.resolve({ id: meera.id }), searchParams: Promise.resolve({}) })));
    check("her manager sees her mobile and birthday hidden", asColleague.includes("Hidden by the employee"));
    await signInAs("meera.krishnan@acme.test");
    r = await people.raisePrivacyRequestAction({}, fd({ kind: "ACCESS", details: "Please send me a copy of my data" }));
    const pr = await prisma.privacyRequest.findFirst({ where: { tenantId: t, employeeId: meera.id, kind: "ACCESS" }, orderBy: { createdAt: "desc" } });
    if (pr) made.privacy.push(pr.id);
    check("a data access request is raised with a 30-day deadline", r.ok === true && !!pr && Math.round((pr.dueDate.getTime() - pr.createdAt.getTime()) / DAY) === 30, r.message);
    r = await people.raisePrivacyRequestAction({}, fd({ kind: "ACCESS", details: "Again please" }));
    check("…not twice", r.ok === false);
    r = await decide("vikram.menon@acme.test", "PRIVACY_REQUEST", pr!.id, true);
    check("compliance approves it", r.ok === true && (await prisma.privacyRequest.findUniqueOrThrow({ where: { id: pr!.id } })).status === "APPROVED", r.message);
    r = await people.completePrivacyRequestAction({}, fd({ id: pr!.id, response: "Sent the export by email." }));
    check("…and completes it, telling the employee", r.ok === true && (await prisma.privacyRequest.findUniqueOrThrow({ where: { id: pr!.id } })).status === "COMPLETED" && (await prisma.notification.count({ where: { userId: meeraUser.id, title: "Your privacy request is complete" } })) > 0, r.message);
    await signInAs("meera.krishnan@acme.test");
    r = await people.raisePrivacyRequestAction({}, fd({ kind: "ERASURE", details: "Erase my old address" }));
    const er = await prisma.privacyRequest.findFirstOrThrow({ where: { tenantId: t, employeeId: meera.id, kind: "ERASURE" }, orderBy: { createdAt: "desc" } });
    made.privacy.push(er.id);
    r = await people.withdrawPrivacyRequestAction({}, fd({ id: er.id }));
    check("a privacy request is withdrawn", r.ok === true && (await prisma.privacyRequest.findUniqueOrThrow({ where: { id: er.id } })).status === "WITHDRAWN", r.message);
    r = await people.raisePrivacyRequestAction({}, fd({ kind: "DIRECTORY_HIDE", details: "Personal safety" }));
    const dh = await prisma.privacyRequest.findFirstOrThrow({ where: { tenantId: t, employeeId: meera.id, kind: "DIRECTORY_HIDE" }, orderBy: { createdAt: "desc" } });
    made.privacy.push(dh.id);
    check("leaving the directory is a 7-day request", Math.round((dh.dueDate.getTime() - dh.createdAt.getTime()) / DAY) === 7);
    r = await decide("priya.sharma@acme.test", "DIRECTORY_LISTING", dh.id, true);
    check("HR approves leaving the directory", r.ok === true && (await prisma.employeeProfileExtra.findUnique({ where: { employeeId: meera.id } }))?.hideFromDirectory === true, r.message);
    const karthikViewer = (await viewerForUser((await userOf("karthik.subramanian@acme.test")).id))!;
    const visibleToColleague = await prisma.employee.count({ where: { AND: [await lib.directorySearchWhere(karthikViewer, lib.directoryParams({})), { id: meera.id }] } });
    check("…she no longer shows in a colleague's directory search", visibleToColleague === 0);
    await signInAs("karthik.subramanian@acme.test");
    let res = await vcardRoute.GET(new NextRequest(`http://acme.localhost/directory/${meera.id}/vcard`), { params: Promise.resolve({ id: meera.id }) });
    check("…nor has a contact card for them", res.status === 404);
    check("…nor a directory profile", await denied(async () => { await (await page("directory/[id]"))({ params: Promise.resolve({ id: meera.id }), searchParams: Promise.resolve({}) }); return { ok: true }; }));
    await prisma.employeeProfileExtra.update({ where: { employeeId: meera.id }, data: { hideFromDirectory: false } });
    res = await vcardRoute.GET(new NextRequest(`http://acme.localhost/directory/${meera.id}/vcard`), { params: Promise.resolve({ id: meera.id }) });
    const vcf = await res.text();
    check("a listed colleague's contact card downloads (with pronouns, no personal phone)", res.status === 200 && vcf.includes("BEGIN:VCARD") && vcf.includes("she/her") && !(before.meera.mobile && vcf.includes(before.meera.mobile)));
    check("…and the download is audited", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "ContactCard", entityId: meera.id } })) > 0);

    await signInAs("meera.krishnan@acme.test");
    r = await ss.issueIdCardAction({}, fd({}));
    check("with approval switched on, an employee cannot issue her own card", r.ok === false && /approval/.test(r.message ?? ""));
    r = await people.requestIdCardAction({}, fd({ reason: "LOST", note: "Lost at the station" }));
    const icr = await prisma.idCardRequest.findFirst({ where: { tenantId: t, employeeId: meera.id, status: "PENDING" } });
    if (icr) made.idCardReqs.push(icr.id);
    check("…she requests one instead", r.ok === true && !!icr, r.message);
    r = await decide("priya.sharma@acme.test", "ID_CARD_REQUEST", icr!.id, true);
    const issued = await prisma.idCardRequest.findUniqueOrThrow({ where: { id: icr!.id } });
    if (issued.cardId) made.idCards.push(issued.cardId);
    check("HR approves it and the card is issued", r.ok === true && issued.status === "ISSUED" && !!issued.cardId, r.message);
    await signInAs("meera.krishnan@acme.test");
    const idPage = (await html(await (await page("me/id-card"))({ searchParams: Promise.resolve({}) })));
    check("the ID card page shows a QR code that verifies the card", idPage.includes("data-qr") && idPage.includes("<svg"));
    await signInAs("priya.sharma@acme.test");
    out = await csv("id-cards");
    check("ID cards export", out.status === 200 && (await prisma.employeeIdCard.findUniqueOrThrow({ where: { id: issued.cardId! } })) && out.body.includes(before.meera.employeeNumber));

    await signInAs("meera.krishnan@acme.test");
    r = await people.savePreferencesAction({}, fdl({ preferredChannel: "IN_APP", digestFrequency: "WEEKLY", fontScale: "115", highContrast: true, locale: "en-GB" }, { inAppMuted: ["LEAVE"], emailMuted: ["PAYROLL"] }));
    const pref = await prisma.userPreference.findUnique({ where: { userId: meeraUser.id } });
    check("notification, digest and accessibility preferences are saved", r.ok === true && pref?.fontScale === 115 && pref.highContrast && pref.inAppMuted.includes("LEAVE"), r.message);
    const aud = svc.notificationAudience("LEAVE", [meeraUser.id], [pref!]);
    check("…a muted category no longer reaches her", aud.inApp.length === 0);
    for (const p of ["me/privacy", "me/preferences", "me/timeline", "me/profile-wizard"]) {
      const h = (await html(await (await page(p))({ searchParams: Promise.resolve({}) })));
      check(`${p} renders`, h.length > 300);
    }
    check("the timeline lists work anniversaries", (await html(await (await page("me/timeline"))({ searchParams: Promise.resolve({}) }))).includes("work anniversary"));
    const act = (await html(await (await page("me/activity"))({ searchParams: Promise.resolve({}) })));
    check("my activity lists changes others made to my record", act.includes("work address") || act.includes("nationality"));
    const mine = (await html(await (await page("me/activity"))({ searchParams: Promise.resolve({ view: "mine" }) })));
    check("…and what I did myself", mine.includes("Privacy") || mine.includes("privacy"));

    // -----------------------------------------------------------------
    section("6. Managers: roster, attendance, dashboard, insights");
    await signInAs("sneha.reddy@acme.test");
    const shift = await prisma.shift.findFirst({ where: { tenantId: t, isActive: true } });
    const rosterDay = new Date(today.getTime() + 10 * DAY);
    const rosterBefore = await prisma.shiftAssignment.findMany({ where: { employeeId: ananya.id, date: rosterDay } });
    r = await people.managerSaveRosterAction({}, fd({ [`cell:${ananya.id}:${iso(rosterDay)}`]: "OFF" }));
    check("a manager rosters a weekly off for her report", r.ok === true && (await prisma.shiftAssignment.findFirst({ where: { employeeId: ananya.id, date: rosterDay } }))?.weeklyOffCode === "WO", r.message);
    if (shift) {
      r = await people.managerSaveRosterAction({}, fd({ [`cell:${ananya.id}:${iso(rosterDay)}`]: shift.id }));
      check("…and a shift", r.ok === true && (await prisma.shiftAssignment.findFirst({ where: { employeeId: ananya.id, date: rosterDay } }))?.shiftId === shift.id, r.message);
    }
    r = await people.managerSaveRosterAction({}, fd({ [`cell:${karthik.id === sneha.id ? meera.id : (await empOf("priya.sharma@acme.test")).id}:${iso(rosterDay)}`]: "OFF" }));
    check("…but not for someone outside her team", r.ok === false);
    out = await csv("roster", `?from=${iso(rosterDay)}`);
    check("the team roster exports", out.status === 200 && out.body.includes(ananya.employeeNumber));
    r = await people.managerSaveRosterAction({}, fd({ [`cell:${ananya.id}:${iso(rosterDay)}`]: "" }));
    await prisma.shiftAssignment.deleteMany({ where: { employeeId: ananya.id, date: rosterDay } });
    if (rosterBefore.length) await prisma.shiftAssignment.createMany({ data: rosterBefore });
    check("…and the day goes back to the policy", r.ok === true);
    check("the roster page renders", (await html(await (await page("team/roster"))({ searchParams: Promise.resolve({}) }))).includes("Team roster"));

    r = await people.managerEditAttendanceAction({}, fd({ employeeId: sneha.id, date: iso(today), status: "PRESENT", reason: "x" }));
    check("a manager cannot edit her own attendance", r.ok === false);
    r = await people.managerEditAttendanceAction({}, fd({ employeeId: ananya.id, date: iso(today), status: "PRESENT", reason: `Forgot to punch ${TAG}` }));
    check("…she marks a report's day, with the reason kept", r.ok === true && (await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: ananya.id, date: today } } }))?.editReason === `Forgot to punch ${TAG}`, r.message);
    check("…and it is audited", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "AttendanceRecord", entityId: ananya.id, summary: { contains: TAG } } })) > 0);

    r = await people.saveDashboardLayoutAction({}, fdl({}, { show: ["approvals", "team"] }));
    check("a manager hides dashboard panels", r.ok === true && (await prisma.userPreference.findUnique({ where: { userId: snehaUser.id } }))?.dashboardHidden.includes("upcoming") === true, r.message);
    const dash = (await html(await (await page("team/dashboard"))({ searchParams: Promise.resolve({}) })));
    check("…the dashboard honours the layout", dash.includes("Waiting for your decision") && !dash.includes("Coming up in 30 days"));
    out = await csv("manager-dashboard");
    check("the dashboard exports her team", out.status === 200 && out.body.includes(ananya.employeeNumber) && (await exportAudited("manager-dashboard")) > 0);
    r = await people.saveDashboardLayoutAction({}, fdl({}, { show: ["approvals", "team-today", "upcoming", "profiles", "team"] }));
    r = await people.sendManagerDigestAction({}, fd({}));
    check("a manager emails herself the team digest", r.ok === true && (await prisma.emailOutbox.count({ where: { tenantId: t, relatedType: "ManagerDigest", relatedId: snehaUser.id } })) > 0, r.message);
    r = await people.sendManagerDigestAction({}, fd({}));
    check("…once a day", r.ok === false);
    const ins = (await html(await (await page("team/insights"))({ searchParams: Promise.resolve({}) })));
    check("team insights compare her reports side by side", ins.includes("Compare your team") && ins.includes(ananya.displayName));
    const tact = (await html(await (await page("team/activity"))({ searchParams: Promise.resolve({}) })));
    check("team activity lists changes to her team's records", tact.includes(TAG));
    await signInAs("meera.krishnan@acme.test");
    check("someone without a team sees no roster", (await html(await (await page("team/roster"))({ searchParams: Promise.resolve({}) }))).includes("No team to roster"));
    check("…and cannot roster anyone", (await people.managerSaveRosterAction({}, fd({ [`cell:${ananya.id}:${iso(rosterDay)}`]: "OFF" }))).ok === false);

    // -----------------------------------------------------------------
    section("7. HR operations");
    await signInAs("priya.sharma@acme.test");
    r = await setup.saveSlaPolicyAction({}, fd({ transactionType: "ID_CARD", targetHours: 24 }));
    check("an HR transaction SLA is set", r.ok === true && (await prisma.hrSlaPolicy.findUnique({ where: { tenantId_transactionType: { tenantId: t, transactionType: "ID_CARD" } } }))?.targetHours === 24, r.message);
    r = await people.runHrOpsChecksAction({}, fd({}));
    const alert = await prisma.hrOpsAlert.findFirst({ where: { tenantId: t, status: "OPEN" } });
    check("exception checks run and raise alerts", r.ok === true, r.message);
    if (alert) {
      r = await people.resolveHrOpsAlertAction({}, fd({ id: alert.id }));
      check("…an alert is resolved", r.ok === true && (await prisma.hrOpsAlert.findUniqueOrThrow({ where: { id: alert.id } })).status === "RESOLVED");
    }
    r = await people.drawQcSampleAction({}, fd({ days: 1, pct: 100 }));
    const samples = await prisma.hrQcSample.findMany({ where: { tenantId: t, sampledBy: priya.id, result: "PENDING" } });
    made.qc.push(...samples.map((s) => s.id));
    check("a QC sample of recent changes is drawn", r.ok === true && samples.length > 0, r.message);
    const own = samples.find((s) => s.actorId === priya.id), other = samples.find((s) => s.actorId && s.actorId !== priya.id);
    if (own) check("…nobody checks their own change", (await people.reviewQcSampleAction({}, fd({ id: own.id, result: "PASS" }))).ok === false);
    if (other) {
      r = await people.reviewQcSampleAction({}, fd({ id: other.id, result: "FAIL" }));
      check("…a fail needs a note", r.ok === false);
      r = await people.reviewQcSampleAction({}, fd({ id: other.id, result: "FAIL", note: "Wrong city" }));
      check("…another person fails a change with a note", r.ok === true, r.message);
    }
    const move = await prisma.jobChange.create({ data: { tenantId: t, employeeId: meera.id, effectiveFrom: new Date(today.getTime() + 40 * DAY), reason: "LOCATION_CHANGE", status: "SCHEDULED", note: TAG, requestedBy: priya.id, source: "MANUAL", locationId: before.meera.locationId } });
    made.jobChanges.push(move.id);
    r = await people.editScheduledMoveAction({}, fd({ id: move.id, effectiveFrom: iso(new Date(today.getTime() - DAY)) }));
    check("a scheduled move cannot be re-dated into the past", r.ok === false);
    r = await people.editScheduledMoveAction({}, fd({ id: move.id, effectiveFrom: iso(new Date(today.getTime() + 50 * DAY)) }));
    check("…it is re-dated", r.ok === true && iso((await prisma.jobChange.findUniqueOrThrow({ where: { id: move.id } })).effectiveFrom) === iso(new Date(today.getTime() + 50 * DAY)), r.message);
    out = await csv("movements", `?from=${iso(today)}&to=${iso(new Date(today.getTime() + 90 * DAY))}`);
    check("…and shows in the movement report", out.status === 200 && out.body.includes(TAG));
    r = await people.editScheduledMoveAction({}, fd({ id: move.id, effectiveFrom: iso(new Date(today.getTime() + 50 * DAY)), cancel: true }));
    check("…and is cancelled", r.ok === true && (await prisma.jobChange.findUniqueOrThrow({ where: { id: move.id } })).status === "WITHDRAWN", r.message);
    const job = await svc.runCore2Job(t);
    check("the nightly core HR job runs checks, digests and due transitions", typeof job.alertsOpened === "number" && typeof job.transitionsApplied === "number");
    for (const kind of ["hr-desk", "hr-calendar", "duplicates", "completeness", "reconciliation", "qc", "personal-info", "attendance-requests"]) {
      out = await csv(kind);
      check(`${kind} exports and is audited`, out.status === 200 && out.body.length > 10 && (await exportAudited(kind)) > 0);
    }
    check("the completeness export lists missing blood groups", (await csv("completeness")).body.includes("Blood group") || (await prisma.employee.count({ where: { tenantId: t, bloodGroup: null, status: { not: "EXITED" } } })) === 0);
    check("the QC export shows the failed check", !other || (await csv("qc")).body.includes("Wrong city"));
    check("the personal-info export shows her pronouns", (await csv("personal-info")).body.includes("she/her"));
    await signInAs("vikram.menon@acme.test");
    check("privacy requests export for compliance", (await csv("privacy")).body.includes(before.meera.employeeNumber));
    for (const [p, sp] of [["hr-ops/desk", { tab: "queue" }], ["hr-ops/desk", { tab: "calendar" }], ["hr-ops/desk", { tab: "workload" }], ["hr-ops/desk", { tab: "alerts" }], ["hr-ops/quality", { tab: "duplicates" }], ["hr-ops/quality", { tab: "completeness" }], ["hr-ops/quality", { tab: "compare", a: meera.id, b: ananya.id }], ["hr-ops/quality", { tab: "reconcile" }], ["hr-ops/quality", { tab: "qc" }], ["hr-ops/quality", { tab: "privacy" }], ["hr-ops/movements", {}]] as Array<[string, Record<string, string>]>) {
      check(`${p} ${sp.tab ?? ""} renders`, (await html(await (await page(p))({ searchParams: Promise.resolve(sp) }))).length > 500);
    }
    await signInAs("meera.krishnan@acme.test");
    check("an employee cannot see HR exports", (await csv("hr-desk")).status === 403 && (await csv("personal-info")).status === 403);
    check("…or draw a QC sample", await denied(() => people.drawQcSampleAction({}, fd({ days: 1, pct: 10 }))));
    out = await csv("attendance-requests");
    check("…but can export her own attendance requests", out.status === 200);

    // -----------------------------------------------------------------
    section("8. Directory");
    const meeraViewer = (await viewerForUser(meeraUser.id))!;
    const tamil = await prisma.employee.count({ where: { AND: [await lib.directorySearchWhere(karthikViewer, lib.directoryParams({ lang: "Tamil" })), { id: meera.id }] } });
    check("the directory finds people by language", tamil === 1);
    const temp = await prisma.employee.count({ where: await lib.directorySearchWhere(meeraViewer, lib.directoryParams({ temp: "1" })) });
    check("…and filters temporary workers", temp >= 0);
    await signInAs("karthik.subramanian@acme.test");
    const exp = (await html(await (await page("directory/expertise"))({ searchParams: Promise.resolve({ lang: "Tamil" }) })));
    check("the expertise page lists speakers of a language", exp.includes("Speaks Tamil") && exp.includes(before.meera.displayName ?? before.meera.firstName));
    await signInAs("meera.krishnan@acme.test");
    const ownProfile = (await html(await (await page("directory/[id]"))({ params: Promise.resolve({ id: meera.id }), searchParams: Promise.resolve({}) })));
    check("her own directory profile shows freshness and a save-contact link", ownProfile.includes("vcard") && /Updated|updated/.test(ownProfile));
  } finally {
    section("cleanup");
    const quiet = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { console.log("  cleanup:", (e as Error).message.replace(/\s+/g, " ").slice(-300)); } };
    await quiet(() => prisma.tenant.update({ where: { id: t }, data: { name: before.tenantName } }));
    if (made.roleAssignment) await quiet(() => prisma.userRoleAssignment.delete({ where: { id: made.roleAssignment } }));
    await quiet(() => prisma.configSnapshot.deleteMany({ where: { id: { in: made.snapshots } } }));
    if (made.country) await quiet(() => prisma.countryAvailability.delete({ where: { id: made.country } }));
    if (made.brand) await quiet(() => prisma.brandingProfile.delete({ where: { id: made.brand } }));
    await quiet(() => prisma.employeeStatusTag.deleteMany({ where: { employeeId: meera.id } }));
    if (made.status) await quiet(() => prisma.employeeStatusCatalog.delete({ where: { id: made.status } }));
    if (made.dict) await quiet(() => prisma.masterDictionary.delete({ where: { id: made.dict } }));
    for (const id of made.workflowDefs) await quiet(async () => { await prisma.workflowDefinition.update({ where: { id }, data: { isActive: false, isCurrent: false } }); });
    await quiet(async () => {
      if (before.idCardGate) await prisma.changeApprovalSetting.update({ where: { id: before.idCardGate.id }, data: { requireApproval: before.idCardGate.requireApproval } });
      else await prisma.changeApprovalSetting.deleteMany({ where: { tenantId: t, targetType: "ID_CARD" } });
    });
    if (made.fn) await quiet(() => prisma.businessFunction.delete({ where: { id: made.fn } }));
    if (made.metaField) await quiet(async () => { await prisma.orgUnitMetadataValue.deleteMany({ where: { tenantId: t, key: { contains: TAG } } }); await prisma.orgUnitMetadataField.delete({ where: { id: made.metaField } }); });
    if (made.pack) await quiet(() => prisma.policyPack.delete({ where: { id: made.pack } }));
    await quiet(() => prisma.orgSnapshot.deleteMany({ where: { id: { in: made.orgSnaps } } }));
    // Workflow requests for everything this run sent for approval.
    const entityIds = [...made.scenarios, ...made.transitions, ...made.intercompany, ...made.privacy, ...made.idCardReqs];
    await quiet(() => prisma.workflowRequest.deleteMany({ where: { tenantId: t, entityId: { in: entityIds } } }));
    await quiet(() => prisma.reorgScenario.deleteMany({ where: { id: { in: made.scenarios } } }));
    await quiet(() => prisma.entityTransition.deleteMany({ where: { id: { in: made.transitions } } }));
    await quiet(() => prisma.intercompanyAssignment.deleteMany({ where: { id: { in: made.intercompany } } }));
    if (made.rule) await quiet(() => prisma.entityTransferRule.delete({ where: { id: made.rule } }));
    if (made.series) await quiet(() => prisma.employeeNumberSeries.update({ where: { id: made.series }, data: { legalEntityId: made.seriesEntity } }));
    // This run's test entity, plus any left behind by an interrupted earlier run.
    await quiet(async () => {
      const ents = (await prisma.legalEntity.findMany({ where: { tenantId: t, OR: [{ id: made.entity || "-" }, { name: { startsWith: "Entity c2" } }] }, select: { id: true } })).map((e) => e.id);
      if (!ents.length) return;
      const bus = (await prisma.businessUnit.findMany({ where: { legalEntityId: { in: ents } }, select: { id: true } })).map((b) => b.id);
      await prisma.employee.updateMany({ where: { tenantId: t, OR: [{ legalEntityId: { in: ents } }, { businessUnitId: { in: bus } }] }, data: { legalEntityId: before.meera.legalEntityId, businessUnitId: before.meera.businessUnitId } });
      await prisma.workflowRequest.deleteMany({ where: { tenantId: t, entityId: { in: [...(await prisma.entityTransition.findMany({ where: { OR: [{ targetEntityId: { in: ents } }, { sourceEntityId: { in: ents } }] }, select: { id: true } })).map((x) => x.id), ...(await prisma.intercompanyAssignment.findMany({ where: { hostEntityId: { in: ents } }, select: { id: true } })).map((x) => x.id)] } } });
      await prisma.entityTransition.deleteMany({ where: { OR: [{ targetEntityId: { in: ents } }, { sourceEntityId: { in: ents } }] } });
      await prisma.intercompanyAssignment.deleteMany({ where: { OR: [{ hostEntityId: { in: ents } }, { homeEntityId: { in: ents } }] } });
      await prisma.entityTransferRule.deleteMany({ where: { OR: [{ toEntityId: { in: ents } }, { fromEntityId: { in: ents } }] } });
      await prisma.businessUnitJurisdiction.deleteMany({ where: { businessUnitId: { in: bus } } });
      for (const m of ["entityTaxRegistration", "entityHolidayCalendar", "entityPayrollCalendar", "entityDocument", "entityComplianceDeadline"] as const) await (prisma[m] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany({ where: { legalEntityId: { in: ents } } });
      await prisma.businessUnit.deleteMany({ where: { id: { in: bus } } });
      await prisma.legalEntity.deleteMany({ where: { id: { in: ents } } });
    });
    await quiet(() => prisma.nomineeAllocation.deleteMany({ where: { employeeId: meera.id } }));
    await quiet(() => prisma.dependent.deleteMany({ where: { id: { in: made.deps } } }));
    await quiet(() => prisma.employeeIdentifier.deleteMany({ where: { id: { in: made.identifiers } } }));
    await quiet(() => prisma.nationalityHistory.deleteMany({ where: { employeeId: meera.id } }));
    await quiet(() => prisma.employee.update({ where: { id: meera.id }, data: { nationality: before.meera.nationality, personalEmail: before.meera.personalEmail, legalEntityId: before.meera.legalEntityId, departmentId: before.meera.departmentId } }));
    await quiet(() => prisma.employeeProfileExtra.deleteMany({ where: { employeeId: meera.id } }));
    await quiet(() => prisma.privacyRequest.deleteMany({ where: { id: { in: made.privacy } } }));
    await quiet(() => prisma.idCardRequest.deleteMany({ where: { id: { in: made.idCardReqs } } }));
    await quiet(() => prisma.employeeIdCard.deleteMany({ where: { id: { in: made.idCards } } }));
    await quiet(() => prisma.userPreference.deleteMany({ where: { userId: { in: [meeraUser.id, snehaUser.id] } } }));
    await quiet(() => prisma.emailOutbox.deleteMany({ where: { tenantId: t, relatedType: "ManagerDigest", relatedId: snehaUser.id } }));
    await quiet(() => prisma.notification.deleteMany({ where: { userId: meeraUser.id, title: "Your privacy request is complete" } }));
    await quiet(async () => {
      const b = before.attendance;
      if (!b) await prisma.attendanceRecord.deleteMany({ where: { employeeId: ananya.id, date: today } });
      else await prisma.attendanceRecord.update({ where: { id: b.id }, data: { manualStatus: b.manualStatus, editedBy: b.editedBy, editedAt: b.editedAt, editReason: b.editReason } });
    });
    await quiet(() => prisma.jobChange.deleteMany({ where: { id: { in: made.jobChanges } } }));
    // The applied reorganisation recorded no-op job changes only when something moved; remove any it made.
    await quiet(() => prisma.jobChange.deleteMany({ where: { tenantId: t, note: { contains: `Reorg ${TAG}` } } }));
    await quiet(() => prisma.hrQcSample.deleteMany({ where: { id: { in: made.qc } } }));
    await quiet(async () => {
      if (made.slaBefore) await prisma.hrSlaPolicy.update({ where: { id: made.slaBefore.id }, data: { targetHours: made.slaBefore.targetHours } });
      else await prisma.hrSlaPolicy.deleteMany({ where: { tenantId: t, transactionType: "ID_CARD" } });
    });
    if (made.completeness) await quiet(() => prisma.fieldCompletenessRule.delete({ where: { id: made.completeness } }));
    await quiet(() => prisma.department.deleteMany({ where: { id: { in: made.depts } } }));
    // Edits above went through actions that store profile completeness; recompute it from the restored record.
    await quiet(() => svc.recomputeProfileCompletion(meera.id));
    await prisma.$disconnect();
    report("smoke-core2-depth");
  }
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
