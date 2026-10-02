/**
 * Go-live settings: notice period policies (one default, per-employee
 * assignment, fallbacks), exit reasons (offered on resignation, switched off
 * rather than deleted once used), and employee document types (mandatory
 * ones requested from everyone and from each joiner, idempotently).
 *
 * Everything is created with names starting "Smoke " and removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

async function main() {
  const ws = await import("../apps/web/src/app/actions/workplace-settings");
  const lc = await import("../apps/web/src/app/actions/lifecycle");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: "meera.krishnan@acme.test" }, include: { exitRecord: true } });
  const originalDefault = await prisma.noticePeriodPolicy.findFirst({ where: { tenantId: tenant.id, isDefault: true } });
  const hadExit = !!meera.exitRecord;
  const meeraDocs = new Set((await prisma.employeeDocument.findMany({ where: { employeeId: meera.id }, select: { id: true } })).map((d) => d.id));
  const smoke = { startsWith: "Smoke " };

  console.log("\nGo-live settings\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------------
    section("Notice periods");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot change notice policies", await denied(() => ws.saveNoticePolicyAction({}, fd({ name: "Smoke X", resignationDays: "1", terminationDays: "1", probationDays: "1", buyoutBasis: "GROSS" }))));
    await signInAs("vikram.menon@acme.test");
    const before = await svc.noticeDaysFor(meera.id, "RESIGNATION");
    const add = await ws.saveNoticePolicyAction({}, fd({ name: "Smoke Senior", resignationDays: "90", terminationDays: "45", probationDays: "30", allowBuyout: "on", buyoutBasis: "BASIC", isActive: "on" }));
    const senior = await prisma.noticePeriodPolicy.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke Senior" } });
    check("A policy is added", add.ok === true && senior.resignationDays === 90 && senior.buyoutBasis === "BASIC", add.message);
    check("A new policy does not change anyone's notice by itself", (await svc.noticeDaysFor(meera.id, "RESIGNATION")).days === before.days);
    const assign = await ws.setEmployeeNoticePolicyAction({}, fd({ employeeId: meera.id, noticePeriodPolicyId: senior.id }));
    const mine = await svc.noticeDaysFor(meera.id, "RESIGNATION");
    check("An employee put on a policy serves its notice", assign.ok === true && mine.days === (meera.status === "PROBATION" ? 30 : 90) && mine.policy === "Smoke Senior", `${assign.message} ${JSON.stringify(mine)}`);
    check("…and the change is audited", (await prisma.auditLog.count({ where: { tenantId: tenant.id, entityId: meera.id, summary: { contains: "Smoke Senior" } } })) === 1);
    const blocked = await ws.deleteNoticePolicyAction({}, fd({ id: senior.id }));
    check("A policy someone follows cannot be deleted", blocked.ok === false && /1 employee/.test(blocked.message ?? ""), blocked.message);
    await ws.saveNoticePolicyAction({}, fd({ id: senior.id, name: "Smoke Senior", resignationDays: "90", terminationDays: "45", probationDays: "30", buyoutBasis: "BASIC" }));
    check("Switching a policy off returns its people to the default", (await svc.noticeDaysFor(meera.id, "RESIGNATION")).days === before.days);
    const defOff = await ws.saveNoticePolicyAction({}, fd({ id: senior.id, name: "Smoke Senior", resignationDays: "90", terminationDays: "45", probationDays: "30", buyoutBasis: "BASIC", isDefault: "on" }));
    check("The default must be active", defOff.ok === false && !!defOff.errors?.isActive);
    await ws.saveNoticePolicyAction({}, fd({ id: senior.id, name: "Smoke Senior", resignationDays: "90", terminationDays: "45", probationDays: "30", buyoutBasis: "BASIC", isDefault: "on", isActive: "on" }));
    const defaults = await prisma.noticePeriodPolicy.findMany({ where: { tenantId: tenant.id, isDefault: true } });
    check("There is only ever one default", defaults.length === 1 && defaults[0].id === senior.id);
    const notDefault = await ws.deleteNoticePolicyAction({}, fd({ id: senior.id }));
    check("The default cannot be deleted", notDefault.ok === false);
    if (originalDefault) await prisma.noticePeriodPolicy.update({ where: { id: originalDefault.id }, data: { isDefault: true } });
    await prisma.noticePeriodPolicy.update({ where: { id: senior.id }, data: { isDefault: false } });
    await ws.setEmployeeNoticePolicyAction({}, fd({ employeeId: meera.id, noticePeriodPolicyId: "" }));
    const gone = await ws.deleteNoticePolicyAction({}, fd({ id: senior.id }));
    check("An unused, non-default policy is deleted", gone.ok === true && !(await prisma.noticePeriodPolicy.findUnique({ where: { id: senior.id } })));

    // -----------------------------------------------------------------------
    section("Exit reasons");
    await ws.saveExitReasonAction({}, fd({ name: "Smoke Sabbatical", kind: "VOLUNTARY", isActive: "on" }));
    await ws.saveExitReasonAction({}, fd({ name: "Smoke Retired reason", kind: "OTHER" }));
    const sabbatical = await prisma.exitReason.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke Sabbatical" } });
    const retired = await prisma.exitReason.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke Retired reason" } });
    const dup = await ws.saveExitReasonAction({}, fd({ name: "Smoke Sabbatical", kind: "OTHER", isActive: "on" }));
    check("Reasons are unique by name", dup.ok === false, dup.message);
    if (!hadExit) {
      await signInAs("meera.krishnan@acme.test");
      const noWhy = await lc.resignAction({}, fd({}));
      check("A resignation needs a reason picked or written", noWhy.ok === false && !!noWhy.errors?.reason);
      const off = await lc.resignAction({}, fd({ reasonId: retired.id }));
      check("A switched-off reason cannot be picked", off.ok === false && /from the list/.test(off.message ?? ""), off.message);
      const resign = await lc.resignAction({}, fd({ reasonId: sabbatical.id, reason: "Taking a year to travel." }));
      const exit = await prisma.exitRecord.findUnique({ where: { employeeId: meera.id } });
      check("A resignation records the reason picked and the comment", resign.ok === true && exit?.reasonId === sabbatical.id && exit.reason === "Taking a year to travel.", resign.message);
      if (exit) await lc.withdrawExitAction({}, fd({ exitId: exit.id }));
      await signInAs("vikram.menon@acme.test");
      const used = await ws.deleteExitReasonAction({}, fd({ id: sabbatical.id }));
      const kept = await prisma.exitReason.findUnique({ where: { id: sabbatical.id } });
      check("A reason on an exit is switched off, not deleted", used.ok === true && kept?.isActive === false, used.message);
    } else {
      check("(skipped resignation checks: the test employee already has an exit)", true);
    }
    await ws.deleteExitReasonAction({}, fd({ id: retired.id }));
    check("An unused reason is deleted", !(await prisma.exitReason.findUnique({ where: { id: retired.id } })));

    // -----------------------------------------------------------------------
    section("Document types");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot add document folders", await denied(() => ws.saveDocumentFolderAction({}, fd({ name: "Smoke X", scope: "EMPLOYEE" }))));
    await signInAs("vikram.menon@acme.test");
    await ws.saveDocumentFolderAction({}, fd({ name: "Smoke Statutory", scope: "EMPLOYEE" }));
    await ws.saveDocumentFolderAction({}, fd({ name: "Smoke Policies", scope: "ORGANISATION" }));
    const folder = await prisma.documentFolder.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke Statutory" } });
    const policies = await prisma.documentFolder.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke Policies" } });
    const orgMand = await ws.saveDocumentTypeAction({}, fd({ folderId: policies.id, name: "Smoke Handbook", isMandatory: "on" }));
    check("Organisation documents cannot be mandatory", orgMand.ok === false && !!orgMand.errors?.isMandatory);
    const live = await prisma.employee.count({ where: { tenantId: tenant.id, status: { not: "EXITED" } } });
    const mand = await ws.saveDocumentTypeAction({}, fd({ folderId: folder.id, name: "Smoke Passport", isMandatory: "on", requireVerification: "on", trackExpiry: "on" }));
    const passport = await prisma.documentType.findFirstOrThrow({ where: { folderId: folder.id, name: "Smoke Passport" } });
    const asked = await prisma.employeeDocument.count({ where: { documentTypeId: passport.id, status: "PENDING_ON_EMPLOYEE" } });
    check("A mandatory type is requested from every current employee", mand.ok === true && asked === live, `${mand.message} asked=${asked} live=${live}`);
    const again = await ws.requestDocumentTypeAction({}, fd({ id: passport.id }));
    check("Requesting again asks nobody twice", again.ok === true && (await prisma.employeeDocument.count({ where: { documentTypeId: passport.id } })) === live, again.message);
    await prisma.employeeDocument.deleteMany({ where: { documentTypeId: passport.id, employeeId: meera.id } });
    check("A joiner is asked for every mandatory document", (await svc.requestMandatoryDocuments(meera.id)) >= 1 && (await prisma.employeeDocument.count({ where: { documentTypeId: passport.id, employeeId: meera.id } })) === 1);
    const scope = await ws.saveDocumentFolderAction({}, fd({ id: folder.id, name: "Smoke Statutory", scope: "ORGANISATION" }));
    check("A folder holding documents cannot change scope", scope.ok === false && !!scope.errors?.scope);
    const folderInUse = await ws.deleteDocumentFolderAction({}, fd({ id: folder.id }));
    check("A folder holding documents cannot be deleted", folderInUse.ok === false);
    const delType = await ws.deleteDocumentTypeAction({}, fd({ id: passport.id }));
    check("Deleting a type nobody uploaded withdraws its requests", delType.ok === true && (await prisma.employeeDocument.count({ where: { documentTypeId: passport.id } })) === 0, delType.message);
    const delFolder = await ws.deleteDocumentFolderAction({}, fd({ id: folder.id }));
    check("An empty folder is deleted", delFolder.ok === true);
  } finally {
    await prisma.employee.update({ where: { id: meera.id }, data: { noticePeriodPolicyId: null } });
    // Requests the joiner check raised for seeded mandatory types go too.
    await prisma.employeeDocument.deleteMany({ where: { employeeId: meera.id, status: "PENDING_ON_EMPLOYEE", id: { notIn: [...meeraDocs] } } });
    if (!hadExit) {
      const ex = await prisma.exitRecord.findUnique({ where: { employeeId: meera.id } });
      if (ex) {
        await prisma.notification.deleteMany({ where: { relatedId: ex.id } }).catch(() => undefined);
        await prisma.exitRecord.delete({ where: { id: ex.id } });
      }
      await prisma.employee.update({ where: { id: meera.id }, data: { exitInitiatedAt: null, status: meera.status, lastWorkingDay: meera.lastWorkingDay } });
    }
    if (originalDefault) await prisma.noticePeriodPolicy.update({ where: { id: originalDefault.id }, data: { isDefault: true } });
    await prisma.noticePeriodPolicy.deleteMany({ where: { tenantId: tenant.id, name: smoke } });
    await prisma.exitReason.deleteMany({ where: { tenantId: tenant.id, name: smoke } });
    const folders = await prisma.documentFolder.findMany({ where: { tenantId: tenant.id, name: smoke }, select: { id: true } });
    await prisma.employeeDocument.deleteMany({ where: { folderId: { in: folders.map((f) => f.id) } } });
    await prisma.documentFolder.deleteMany({ where: { id: { in: folders.map((f) => f.id) } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, summary: { contains: "Smoke " } } });
  }
  report("Go-live settings");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
