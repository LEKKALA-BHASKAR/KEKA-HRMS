/**
 * HR letters with e-signature: templates are validated (known placeholders
 * only, no scripts); a generated letter freezes its text and fingerprint and
 * escapes employee values; an approval step must be taken by someone other
 * than whoever generated it and hides the letter from the employee until
 * then; signing needs the employee's own letter, their typed name, consent
 * and a drawn signature, and is refused if the text was altered;
 * acknowledgement and withdrawal close their flows; scoped HR cannot
 * generate outside their scope. Temporary templates are named "Smoke …".
 */
import { signInAs, setTestHeaders, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function main() {
  const act = await import("../apps/web/src/app/actions/letters");
  const svc = await import("../packages/services/src/letters");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: "ACM0009" } });
  const sales = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, department: { name: "Sales" }, status: { not: "EXITED" } } });
  const cleanup = async () => {
    const t = await prisma.documentTemplate.findMany({ where: { tenantId: tenant.id, name: { startsWith: "Smoke " } }, select: { id: true } });
    const docs = await prisma.generatedDocument.findMany({ where: { templateId: { in: t.map((x) => x.id) } }, select: { id: true } });
    await prisma.storedFile.deleteMany({ where: { relatedType: "LetterSignature", relatedId: { in: docs.map((d) => d.id) } } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, link: { in: docs.map((d) => `/documents/letters/${d.id}`) } } });
    await prisma.documentTemplate.deleteMany({ where: { id: { in: t.map((x) => x.id) } } });
  };
  await cleanup();
  setTestHeaders({ "x-forwarded-for": "203.0.113.7", "user-agent": "smoke-test" });
  try {
    section("Templates");
    await signInAs("priya.sharma@acme.test");
    const body = "<p>Dear {{employee_name}},</p><p>You are confirmed as {{job_title}}.</p><p>{{signatory_name}}</p>";
    const unknown = await act.saveLetterTemplateAction({}, fd({ name: "Smoke Sign", category: "CUSTOM", workflow: "APPROVE,SIGN", body: body + "{{shoe_size}}" }));
    check("An unknown placeholder is refused", unknown.ok === false && /shoe_size/.test(unknown.message ?? ""), unknown.message);
    const script = await act.saveLetterTemplateAction({}, fd({ name: "Smoke Sign", category: "CUSTOM", workflow: "SIGN", body: body + "<img src=x onerror=alert(1)>" }));
    check("Event handlers and scripts are refused", script.ok === false, script.message);
    const made = await act.saveLetterTemplateAction({}, fd({ name: "Smoke Sign", category: "CUSTOM", workflow: "APPROVE,SIGN", body }));
    const tpl = await prisma.documentTemplate.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke Sign" } });
    check("A valid template is saved with its placeholders", made.ok && JSON.stringify(tpl.placeholders) === JSON.stringify(["employee_name", "job_title", "signatory_name"]), made.message);
    await act.saveLetterTemplateAction({}, fd({ name: "Smoke Ack", category: "CONFIRMATION", workflow: "ACKNOWLEDGE", body }));
    const ackTpl = await prisma.documentTemplate.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke Ack" } });
    const dupName = await act.saveLetterTemplateAction({}, fd({ name: "Smoke Ack", category: "CUSTOM", workflow: "", body }));
    check("Template names are unique", dupName.ok === false);
    const r = svc.renderLetter("<p>{{employee_name}} {{today}}</p>", { employee_name: "<b>Eve</b>" });
    check("Employee values are escaped and gaps are marked", r.html.includes("&lt;b&gt;Eve&lt;/b&gt;") && r.html.includes("[TODAY NOT AVAILABLE]") && r.missing[0] === "today");

    section("Generate and approve");
    await signInAs("deepak.chauhan@acme.test");
    const outside = await act.generateLetterAction({}, fd({ templateId: tpl.id, employeeId: sales.id }));
    check("Scoped HR cannot generate a letter outside their scope", outside.ok === false, outside.message);
    await signInAs("priya.sharma@acme.test");
    const gen = await act.generateLetterAction({}, fd({ templateId: tpl.id, employeeId: meera.id }));
    const letter = await prisma.generatedDocument.findFirstOrThrow({ where: { templateId: tpl.id, employeeId: meera.id }, orderBy: { issuedOn: "desc" } });
    check("A letter needing approval starts awaiting approval", gen.ok && letter.status === "PENDING_APPROVAL", gen.message);
    check("Its text and fingerprint are frozen", letter.renderedBody.includes(meera.displayName ?? "") && letter.contentHash === svc.hashBody(letter.renderedBody));
    await signInAs("meera.krishnan@acme.test");
    const early = await act.signLetterAction({}, fd({ id: letter.id, signature: PNG, typedName: meera.displayName ?? "", consent: "on" }));
    check("The employee cannot sign before approval", early.ok === false, early.message);
    await signInAs("priya.sharma@acme.test");
    const self = await act.decideLetterAction({}, fd({ id: letter.id, decision: "approve" }));
    check("Whoever generated it cannot approve it", self.ok === false, self.message);
    await signInAs("vikram.menon@acme.test");
    const noNote = await act.decideLetterAction({}, fd({ id: letter.id, decision: "reject" }));
    check("A rejection needs a note", noNote.ok === false);
    const ok = await act.decideLetterAction({}, fd({ id: letter.id, decision: "approve" }));
    check("Another approver releases it for signature", ok.ok && (await prisma.generatedDocument.findUniqueOrThrow({ where: { id: letter.id } })).status === "PENDING_SIGNATURE", ok.message);
    const note = await prisma.notification.findFirst({ where: { userId: meera.userId!, link: `/documents/letters/${letter.id}` } });
    check("The employee is asked to sign", !!note && /sign/.test(note.title));

    section("Sign");
    await signInAs("ananya.ghosh@acme.test");
    const other = await act.signLetterAction({}, fd({ id: letter.id, signature: PNG, typedName: meera.displayName ?? "", consent: "on" }));
    check("Nobody else can sign someone's letter", other.ok === false);
    await signInAs("meera.krishnan@acme.test");
    const noSig = await act.signLetterAction({}, fd({ id: letter.id, signature: "", typedName: meera.displayName ?? "", consent: "on" }));
    check("A drawn signature is required", noSig.ok === false, noSig.message);
    const wrongName = await act.signLetterAction({}, fd({ id: letter.id, signature: PNG, typedName: "Someone Else", consent: "on" }));
    check("The typed name must match", wrongName.ok === false, wrongName.message);
    const noConsent = await act.signLetterAction({}, fd({ id: letter.id, signature: PNG, typedName: meera.displayName ?? "" }));
    check("Consent to sign electronically is required", noConsent.ok === false, noConsent.message);
    check("Refused attempts leave no signature files behind", (await prisma.storedFile.count({ where: { relatedType: "LetterSignature", relatedId: letter.id } })) === 0);
    const signed = await act.signLetterAction({}, fd({ id: letter.id, signature: PNG, typedName: ` ${(meera.displayName ?? "").toUpperCase()} `, consent: "on" }));
    const after = await prisma.generatedDocument.findUniqueOrThrow({ where: { id: letter.id } });
    check("Signing records name, signature, time, IP and browser", signed.ok && after.status === "SIGNED" && !!after.signatureFileId && after.signedIp === "203.0.113.7" && after.signedUserAgent === "smoke-test" && !!after.signedAt, signed.message);
    const twice = await act.signLetterAction({}, fd({ id: letter.id, signature: PNG, typedName: meera.displayName ?? "", consent: "on" }));
    check("A signed letter cannot be signed again", twice.ok === false);

    section("Tampering, acknowledgement and withdrawal");
    await signInAs("vikram.menon@acme.test");
    await act.generateLetterAction({}, fd({ templateId: tpl.id, employeeId: meera.id }));
    const second = await prisma.generatedDocument.findFirstOrThrow({ where: { templateId: tpl.id, employeeId: meera.id, status: "PENDING_APPROVAL" } });
    await signInAs("priya.sharma@acme.test");
    await act.decideLetterAction({}, fd({ id: second.id, decision: "approve" }));
    await prisma.generatedDocument.update({ where: { id: second.id }, data: { renderedBody: second.renderedBody + "<p>Extra clause</p>" } });
    await signInAs("meera.krishnan@acme.test");
    const tampered = await act.signLetterAction({}, fd({ id: second.id, signature: PNG, typedName: meera.displayName ?? "", consent: "on" }));
    check("A letter altered after generation cannot be signed", tampered.ok === false && /changed/.test(tampered.message ?? ""), tampered.message);
    await signInAs("priya.sharma@acme.test");
    const noReason = await act.voidLetterAction({}, fd({ id: second.id, reason: "" }));
    check("Withdrawing needs a reason", noReason.ok === false);
    const voided = await act.voidLetterAction({}, fd({ id: second.id, reason: "Reissuing" }));
    check("HR can withdraw a letter", voided.ok && (await prisma.generatedDocument.findUniqueOrThrow({ where: { id: second.id } })).status === "VOID", voided.message);

    await act.generateLetterAction({}, fd({ templateId: ackTpl.id, employeeId: meera.id }));
    const ack = await prisma.generatedDocument.findFirstOrThrow({ where: { templateId: ackTpl.id, employeeId: meera.id } });
    check("An acknowledgement letter goes straight to the employee", ack.status === "PENDING_ACKNOWLEDGEMENT");
    await signInAs("meera.krishnan@acme.test");
    const sign = await act.signLetterAction({}, fd({ id: ack.id, signature: PNG, typedName: meera.displayName ?? "", consent: "on" }));
    check("An acknowledgement letter cannot be signed instead", sign.ok === false);
    const acked = await act.acknowledgeLetterAction({}, fd({ id: ack.id }));
    const ackAfter = await prisma.generatedDocument.findUniqueOrThrow({ where: { id: ack.id } });
    check("The employee acknowledges it", acked.ok && ackAfter.status === "ACKNOWLEDGED" && !!ackAfter.acknowledgedAt, acked.message);
  } finally {
    await cleanup();
  }
}

main().then(() => report("HR letters")).catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
