/**
 * Custom fields: only settings managers define them; keys come from labels
 * and stay unique; values are checked by type and mandatory fields enforced
 * on the profile; employees cannot edit others; a field with values is
 * switched off rather than deleted, and its type cannot change.
 *
 * Everything is created with labels starting "Smoke " and removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

async function main() {
  const act = await import("../apps/web/src/app/actions/custom-fields");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const defs = () => prisma.customFieldDefinition.findMany({ where: { tenantId: tenant.id, label: { startsWith: "Smoke " } }, orderBy: { createdAt: "asc" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: "meera.krishnan@acme.test" } });
  const other = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, id: { not: meera.id }, status: { not: "EXITED" } } });

  console.log("\nCustom fields\n" + "=".repeat(72));
  try {
    section("Defining fields");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot define fields", await denied(() => act.saveCustomFieldAction({}, fd({ label: "Smoke X", type: "TEXT" }))));
    await signInAs("vikram.menon@acme.test");
    const fewOpts = await act.saveCustomFieldAction({}, fd({ label: "Smoke Shirt size", type: "DROPDOWN", options: "M" }));
    check("A dropdown needs two options", fewOpts.ok === false && !!fewOpts.errors?.options);
    await act.saveCustomFieldAction({}, fd({ label: "Smoke Shirt size", type: "DROPDOWN", options: "S, M\nL\nm", isMandatory: "on", isActive: "on" }));
    await act.saveCustomFieldAction({}, fd({ label: "Smoke Joined via referral", type: "CHECKBOX", isActive: "on", section: "Hiring" }));
    await act.saveCustomFieldAction({}, fd({ label: "Smoke Badge expiry", type: "DATE", isActive: "on" }));
    const dup = await act.saveCustomFieldAction({}, fd({ label: "Smoke Badge expiry", type: "TEXT", isActive: "on" }));
    const [shirt, referral, expiry, expiry2] = await defs();
    check("Fields are created with keys from their labels", shirt?.fieldKey === "smoke_shirt_size" && referral?.section === "Hiring");
    check("Dropdown options are de-duplicated", JSON.stringify(shirt?.options) === JSON.stringify(["S", "M", "L"]), JSON.stringify(shirt?.options));
    check("A second field with the same label gets its own key", dup.ok === true && expiry2?.fieldKey === "smoke_badge_expiry_2" && expiry?.fieldKey === "smoke_badge_expiry");

    section("Filling them in");
    await signInAs("meera.krishnan@acme.test");
    const notOthers = await act.saveEmployeeCustomFieldsAction({}, fd({ employeeId: other.id, [`f_${shirt.id}`]: "M" })).catch(() => ({ ok: false }));
    check("An employee cannot edit someone else's fields", notOthers.ok === false);
    await signInAs("vikram.menon@acme.test");
    const missing = await act.saveEmployeeCustomFieldsAction({}, fd({ employeeId: meera.id, [`f_${expiry.id}`]: "2026-02-30" }));
    check("Mandatory and badly typed values are refused together", missing.ok === false && /required/.test(missing.errors?.[`f_${shirt.id}`] ?? "") && /date/.test(missing.errors?.[`f_${expiry.id}`] ?? ""), JSON.stringify(missing.errors));
    check("…and nothing is saved", (await prisma.customFieldValue.count({ where: { ownerId: meera.id, definitionId: { in: [shirt.id, expiry.id] } } })) === 0);
    const saved = await act.saveEmployeeCustomFieldsAction({}, fd({ employeeId: meera.id, [`f_${shirt.id}`]: "l", [`f_${referral.id}`]: "on", [`f_${expiry.id}`]: "2027-03-31" }));
    const vals = Object.fromEntries((await prisma.customFieldValue.findMany({ where: { ownerId: meera.id, definitionId: { in: [shirt.id, referral.id, expiry.id] } } })).map((v) => [v.definitionId, v.value]));
    check("Valid values are saved, normalised", saved.ok === true && vals[shirt.id] === "L" && vals[referral.id] === "true" && vals[expiry.id] === "2027-03-31", JSON.stringify(vals));
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, entityType: "Employee", entityId: meera.id, summary: { contains: "Smoke Shirt size" } }, orderBy: { createdAt: "desc" } });
    check("The change is audited with old and new values", !!audit && JSON.stringify(audit.newValue).includes("\"L\""));
    const same = await act.saveEmployeeCustomFieldsAction({}, fd({ employeeId: meera.id, [`f_${shirt.id}`]: "L", [`f_${referral.id}`]: "on", [`f_${expiry.id}`]: "2027-03-31" }));
    check("Saving unchanged values writes nothing", same.message === "No changes.");

    section("Changing and removing fields");
    const retype = await act.saveCustomFieldAction({}, fd({ id: expiry.id, label: "Smoke Badge expiry", type: "TEXT", isActive: "on" }));
    check("A field's type cannot change once it has values", retype.ok === false && !!retype.errors?.type);
    const relabel = await act.saveCustomFieldAction({}, fd({ id: expiry.id, label: "Smoke Access badge expiry", type: "DATE", isActive: "on" }));
    const after = await prisma.customFieldDefinition.findUnique({ where: { id: expiry.id } });
    check("Relabelling keeps the key", relabel.ok === true && after?.label === "Smoke Access badge expiry" && after.fieldKey === "smoke_badge_expiry");
    const off = await act.deleteCustomFieldAction({}, fd({ id: shirt.id }));
    const shirtAfter = await prisma.customFieldDefinition.findUnique({ where: { id: shirt.id } });
    check("Deleting a field with values switches it off and keeps them", off.ok === true && shirtAfter?.isActive === false && (await prisma.customFieldValue.count({ where: { definitionId: shirt.id } })) === 1);
    const noShirt = await act.saveEmployeeCustomFieldsAction({}, fd({ employeeId: meera.id, [`f_${referral.id}`]: "on", [`f_${expiry.id}`]: "2027-03-31" }));
    check("A switched-off mandatory field no longer blocks the profile", noShirt.ok === true, noShirt.message);
    await act.deleteCustomFieldAction({}, fd({ id: expiry2.id }));
    check("An unused field is deleted outright", !(await prisma.customFieldDefinition.findUnique({ where: { id: expiry2.id } })));
  } finally {
    const ours = await defs();
    await prisma.customFieldDefinition.deleteMany({ where: { id: { in: ours.map((d) => d.id) } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, summary: { contains: "Smoke " } } });
  }
  report("Custom fields");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
