/**
 * Hiring offers end to end: candidates imported from CSV into a job, an offer
 * letter rendered from an offer template with its salary breakup (typed, and
 * from the pay structure), approval above budget, the candidate's signed and
 * expiring link — forged, expired, revoked and rate-limited — and the
 * candidate accepting with an e-signature or declining with a reason.
 */
import { signInAs, setTestHeaders, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { unlink } from "node:fs/promises";
import path from "node:path";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const tag = Date.now().toString(36);
const email = (who: string) => `offers.smoke.${who}.${tag}@mail.test`;

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
  const hiring = await import("../apps/web/src/app/actions/hiring");
  const letters = await import("../apps/web/src/app/actions/letters");
  const importer = await import("../apps/web/src/app/actions/import");
  const portal = await import("../apps/web/src/app/offer/actions");
  const Portal = (await import("../apps/web/src/app/offer/[token]/page")).default;
  const letterRoute = await import("../apps/web/src/app/offer/[token]/letter/route");
  const svc = await import("@keka/services");
  const { STORAGE_DIR } = await import("../apps/web/src/lib/storage");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const priyaUser = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: "priya.sharma@acme.test" }, include: { employee: true } });
  const sneha = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: "ACM0005" } });
  const started = new Date();
  const ids = { flow: "", job: "", template: "", apps: [] as string[] };
  const page = async (token: string) => html(await Portal({ params: Promise.resolve({ token }) }));
  const tokenFromMail = async (to: string) => {
    const mail = await prisma.emailOutbox.findFirst({ where: { toAddress: to, relatedType: "Offer", textBody: { contains: "/offer/" } }, orderBy: { createdAt: "desc" } });
    return /\/offer\/([A-Za-z0-9_.-]+)/.exec(mail?.textBody ?? "")?.[1] ?? "";
  };
  const as = (ip: string) => setTestHeaders({ "x-forwarded-for": ip, "user-agent": "smoke-offers" });

  console.log("\nOffers\n" + "=".repeat(72));
  try {
    // A flow of our own with a preboarding stage, so acceptance has somewhere to move to.
    const flow = await prisma.hiringFlow.create({
      data: {
        tenantId: tenant.id, name: `Offers smoke ${tag}`, isActive: false,
        stages: { create: [["Applied", "APPLIED"], ["Offer", "OFFER"], ["Preboarding", "PREBOARDING"]].map(([name, stageKind], i) => ({ name, stageKind, sequence: i + 1 })) },
      },
      include: { stages: true },
    });
    ids.flow = flow.id;
    const job = await prisma.job.create({
      data: { tenantId: tenant.id, flowId: flow.id, title: "Offers Smoke Engineer", code: `JOB-OFS-${tag}`, openings: 3, maxAnnualCtc: 3000000, status: "OPEN", hiringManagerId: sneha.id, recruiterId: priyaUser.employee?.id ?? null },
    });
    ids.job = job.id;

    section("Bulk candidate import");
    await signInAs("priya.sharma@acme.test");
    const csv = [
      "First name,Last name,Email,Current employer,Expected CTC,Source",
      `Asha,Pillai,${email("asha")},Infosys,"24,00,000",job board`,
      `Rohan,Kapoor,${email("rohan")},TCS,2600000,AGENCY`,
      `Bad,Row,not-an-email,,abc,`,
      `Asha,Again,${email("asha")},,,`,
    ].join("\n");
    const checked = await importer.runImportAction({}, fd({ kind: "candidates", mode: "check", jobId: job.id, file: csv }));
    check("Checking reports every bad row by line and changes nothing", checked.ok === false && checked.rowErrors?.length === 2 && checked.rowErrors[0]!.line === 4 && /email/.test(checked.rowErrors[0]!.message) && /twice/.test(checked.rowErrors[1]!.message), JSON.stringify(checked.rowErrors));
    check("…no application was created", (await prisma.application.count({ where: { jobId: job.id } })) === 0);
    const good = csv.split("\n").slice(0, 3).join("\n");
    const imported = await importer.runImportAction({}, fd({ kind: "candidates", mode: "import", jobId: job.id, file: good }));
    const apps = await prisma.application.findMany({ where: { jobId: job.id }, include: { candidate: true }, orderBy: { appliedAt: "asc" } });
    ids.apps = apps.map((a) => a.id);
    check("A clean file imports both candidates into the job's first stage", imported.ok === true && imported.imported === 2 && apps.length === 2 && apps.every((a) => a.currentStageId === flow.stages.find((s) => s.sequence === 1)!.id), imported.message);
    check("…with what the sheet said", apps[0]!.candidate.currentEmployer === "Infosys" && Number(apps[0]!.candidate.expectedAnnualCtc) === 2400000 && apps[0]!.candidate.source === "JOB_BOARD");
    const again = await importer.runImportAction({}, fd({ kind: "candidates", mode: "import", jobId: job.id, file: good }));
    check("Importing the same people again is refused row by row, not duplicated", again.imported === 0 && again.rowErrors?.length === 2 && (await prisma.application.count({ where: { jobId: job.id } })) === 2, again.message);
    await signInAs("meera.krishnan@acme.test");
    let blocked = false;
    try { await importer.runImportAction({}, fd({ kind: "candidates", mode: "check", file: good })); } catch { blocked = true; }
    check("An employee without recruiting rights cannot import candidates", blocked);
    await signInAs("priya.sharma@acme.test");
    const [asha, rohan] = apps as [typeof apps[number], typeof apps[number]];

    section("Offer templates and rendering");
    const body = `<p>Dear {{candidate_name}},</p><p>You are offered the role of {{job_title}} at an annual CTC of {{annual_ctc}}, joining on {{joining_date}}.</p>{{salary_breakup}}<p>Valid until {{offer_expiry}}.</p>`;
    const wrongCat = await letters.saveLetterTemplateAction({}, fd({ name: `Smoke offer ${tag}`, category: "CONFIRMATION", body, workflow: "" }));
    check("Offer-only placeholders are refused outside the Offer category", wrongCat.ok === false && /salary_breakup/.test(wrongCat.message ?? ""), wrongCat.message);
    const saved = await letters.saveLetterTemplateAction({}, fd({ name: `Smoke offer ${tag}`, category: "OFFER", body, workflow: "" }));
    const template = await prisma.documentTemplate.findFirstOrThrow({ where: { tenantId: tenant.id, name: `Smoke offer ${tag}` } });
    ids.template = template.id;
    check("…and accepted on an offer template", saved.ok === true, saved.message);

    const base = { applicationId: asha.id, annualCtc: 1200000, proposedJoiningDate: iso(new Date(Date.now() + 40 * DAY)), expiresOn: iso(new Date(Date.now() + 7 * DAY)), templateId: template.id };
    const off = await hiring.draftOfferAction({}, fd({ ...base, breakupMode: "MANUAL", breakup: "Basic: 600000\nHRA: 200000" }));
    check("A typed breakup that does not add up to the CTC is refused", off.ok === false && /add up/.test(off.message ?? ""), off.message);
    const drafted = await hiring.draftOfferAction({}, fd({ ...base, breakupMode: "MANUAL", breakup: "Basic: 6,00,000\nHRA: 2,40,000\nSpecial <allowance>: 3,60,000" }));
    check("Within budget the offer is approved at once", drafted.ok === true && /approved/i.test(drafted.message ?? ""), drafted.message);
    const preview = await svc.previewOfferLetter(tenant.id, asha.id);
    check("The preview fills the template from the candidate and offer", !!preview.html?.includes("Dear Asha Pillai") && preview.html.includes("Offers Smoke Engineer") && preview.html.includes("₹12,00,000"), preview.missing?.join(","));
    check("…with the salary table, names escaped", !!preview.html?.includes("<table") && preview.html.includes("Special &lt;allowance&gt;") && preview.html.includes("₹50,000") && preview.missing?.length === 0);

    const draftedB = await hiring.draftOfferAction({}, fd({ applicationId: rohan.id, annualCtc: 3200000, proposedJoiningDate: iso(new Date(Date.now() + 40 * DAY)), expiresOn: iso(new Date(Date.now() + 7 * DAY)), breakupMode: "STRUCTURE" }));
    check("Above the job's budget the offer waits for approval (the existing approval)", draftedB.ok === true && /approval/.test(draftedB.message ?? ""), draftedB.message);
    const early = await hiring.offerOpAction({}, fd({ applicationId: rohan.id, op: "extend" }));
    check("…and cannot be sent before it", early.ok === false);
    await signInAs("vikram.menon@acme.test");
    const appr = await hiring.offerOpAction({}, fd({ applicationId: rohan.id, op: "approve" }));
    check("An approver signs it off", appr.ok === true, appr.message);
    await signInAs("priya.sharma@acme.test");
    const previewB = await svc.previewOfferLetter(tenant.id, rohan.id);
    const structureTotal = (previewB.breakup ?? []).reduce((s, r) => s + r.annual, 0);
    check("Without a typed breakup the components come from the pay structure for the CTC", (previewB.breakup?.length ?? 0) >= 2 && Math.abs(structureTotal - 3200000) <= 3200000 * 0.02, `${previewB.breakup?.length} rows, total ${structureTotal}`);

    const ext = await hiring.offerOpAction({}, fd({ applicationId: asha.id, op: "extend" }));
    const offerA = await prisma.offer.findUniqueOrThrow({ where: { applicationId: asha.id } });
    const pdf = await prisma.storedFile.findUnique({ where: { id: offerA.letterUrl?.replace("/files/", "") ?? "" } });
    check("Extending freezes the rendered letter with its fingerprint", ext.ok === true && offerA.status === "EXTENDED" && !!offerA.renderedBody?.includes("Special &lt;allowance&gt;") && offerA.contentHash === svc.hashBody(offerA.renderedBody ?? ""), ext.message);
    check("…saves the letter as a PDF", pdf?.mimeType === "application/pdf" && pdf.sizeBytes > 1000);
    let tokenA = await tokenFromMail(asha.candidate.email);
    check("…and emails the candidate a link to the offer portal", svc.offerTokenSigned(tokenA, process.env.AUTH_SECRET!), tokenA.slice(0, 12));
    check("Only the token's hash is stored", (await prisma.offerLink.count({ where: { offerId: offerA.id, tokenHash: svc.hashOfferToken(tokenA) } })) === 1 && (await prisma.offerLink.count({ where: { tokenHash: tokenA } })) === 0);

    section("Link security");
    as("10.9.0.1");
    const viewA = await svc.openOfferLink(tokenA);
    check("The link opens this candidate's offer", viewA?.state === "OPEN" && viewA.candidateName === "Asha Pillai");
    const exposed = JSON.stringify(viewA);
    check("…and carries nothing of another candidate or any internal id beyond its own", !exposed.includes("Rohan") && !exposed.includes(rohan.id) && !exposed.includes(asha.candidate.email));
    const shown = await page(tokenA);
    check("The portal page shows the letter and the choice to accept or decline", shown.includes("Congratulations, Asha") && shown.includes("Accept and sign") && shown.includes("Decline"));
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    const [rand, sig] = tokenA.split(".") as [string, string];
    check("A forged signature is refused", (await svc.openOfferLink(`${rand}.${flip(sig)}`)) === null);
    check("An altered token is refused", (await svc.openOfferLink(`${flip(rand)}.${sig}`)) === null);
    check("A correctly signed token that was never issued is refused", (await svc.openOfferLink(svc.newOfferToken(process.env.AUTH_SECRET!).token)) === null);
    check("Junk and injection attempts are refused", (await svc.openOfferLink("' or 1=1 --")) === null && (await svc.openOfferLink("")) === null);
    check("The portal says a bad link is not valid, and shows nothing", (await page(`${rand}.${flip(sig)}`)).includes("This link is not valid"));
    const forgedAccept = await portal.acceptOfferAction({}, fd({ token: `${rand}.${flip(sig)}`, typedName: "Asha Pillai", consent: "on", signature: PNG }));
    check("Accepting through a forged link is refused", forgedAccept.ok === false && /not valid/.test(forgedAccept.message ?? ""));
    const pdfRes = await letterRoute.GET(new Request(`http://x/offer/${tokenA}/letter`) as never, { params: Promise.resolve({ token: tokenA }) });
    const pdfBad = await letterRoute.GET(new Request("http://x/offer/x/letter") as never, { params: Promise.resolve({ token: `${rand}.${flip(sig)}` }) });
    check("The candidate can download the PDF; a forged link gets 404", pdfRes.status === 200 && pdfRes.headers.get("content-type") === "application/pdf" && pdfBad.status === 404);

    await prisma.offerLink.updateMany({ where: { offerId: offerA.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const expiredView = await svc.openOfferLink(tokenA);
    const expiredAccept = await portal.acceptOfferAction({}, fd({ token: tokenA, typedName: "Asha Pillai", consent: "on", signature: PNG }));
    check("An expired link shows as expired and cannot accept", expiredView?.state === "EXPIRED" && expiredAccept.ok === false && /expired/.test(expiredAccept.message ?? ""), expiredAccept.message);
    check("…and its page offers no choice", !(await page(tokenA)).includes("Accept and sign"));
    const resent = await hiring.offerOpAction({}, fd({ applicationId: asha.id, op: "resend" }));
    const oldToken = tokenA;
    tokenA = await tokenFromMail(asha.candidate.email);
    check("Resending emails a fresh link", resent.ok === true && tokenA !== oldToken && (await svc.openOfferLink(tokenA))?.state === "OPEN", resent.message);
    check("…and the old one is revoked", (await svc.openOfferLink(oldToken))?.state === "REVOKED");
    const revoked = await hiring.offerOpAction({}, fd({ applicationId: asha.id, op: "revoke" }));
    const revokedDecline = await portal.declineOfferAction({}, fd({ token: tokenA, reason: "x" }));
    check("Revoking stops the link working", revoked.ok === true && (await svc.openOfferLink(tokenA))?.state === "REVOKED" && revokedDecline.ok === false, revokedDecline.message);
    await signInAs("meera.krishnan@acme.test");
    const notMine = await hiring.offerOpAction({}, fd({ applicationId: asha.id, op: "resend" }));
    check("Someone without offer rights cannot resend a link", notMine.ok === false);
    await signInAs("priya.sharma@acme.test");
    await hiring.offerOpAction({}, fd({ applicationId: asha.id, op: "resend" }));
    tokenA = await tokenFromMail(asha.candidate.email);

    as("10.9.0.99");
    const tries: boolean[] = [];
    for (let i = 0; i < 12; i++) tries.push(/Too many/.test((await portal.declineOfferAction({}, fd({ token: svc.newOfferToken("guessing").token, reason: "guess" }))).message ?? ""));
    check("Hammering the portal from one address is rate-limited", tries.slice(0, 10).every((t) => !t) && tries.slice(10).every((t) => t));

    section("Accept with e-signature");
    as("10.9.0.2");
    const wrongName = await portal.acceptOfferAction({}, fd({ token: tokenA, typedName: "Someone Else", consent: "on", signature: PNG }));
    check("The typed name must match the candidate's", wrongName.ok === false && /full name/.test(wrongName.message ?? ""));
    check("…and the refused signature image is not kept", (await prisma.storedFile.count({ where: { tenantId: tenant.id, relatedType: "OfferSignature", relatedId: asha.id } })) === 0);
    const noConsent = await portal.acceptOfferAction({}, fd({ token: tokenA, typedName: "Asha Pillai", signature: PNG }));
    check("Consent to sign electronically is required", noConsent.ok === false && /electronically/.test(noConsent.message ?? ""));
    const noSig = await portal.acceptOfferAction({}, fd({ token: tokenA, typedName: "Asha Pillai", consent: "on", signature: "" }));
    check("A drawn signature is required", noSig.ok === false && /signature/.test(noSig.message ?? ""));
    const accepted = await portal.acceptOfferAction({}, fd({ token: tokenA, typedName: "asha  pillai", consent: "on", signature: PNG }));
    check("The candidate accepts and signs", accepted.ok === true, accepted.message);
    const offerAfter = await prisma.offer.findUniqueOrThrow({ where: { applicationId: asha.id } });
    const appAfter = await prisma.application.findUniqueOrThrow({ where: { id: asha.id } });
    check("The offer records the signature, time, address and browser", offerAfter.status === "ACCEPTED" && offerAfter.signerName === "asha  pillai" && !!offerAfter.signatureFileId && offerAfter.signedIp === "10.9.0.2" && offerAfter.signedUserAgent === "smoke-offers");
    const signedPdf = await prisma.storedFile.findUnique({ where: { id: offerAfter.signedLetterUrl?.replace("/files/", "") ?? "" } });
    check("…and a signed copy of the letter is kept", signedPdf?.mimeType === "application/pdf" && signedPdf.relatedId === asha.id);
    check("The candidate moves to preboarding", appAfter.status === "OFFER_ACCEPTED" && appAfter.currentStageId === flow.stages.find((s) => s.stageKind === "PREBOARDING")!.id);
    const told = await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: priyaUser.id, link: `/hiring/applications/${asha.id}`, title: { contains: "accepted" } } });
    check("The recruiter is notified", !!told, told?.title);
    check("…and the candidate gets a welcome email", !!(await prisma.emailOutbox.findFirst({ where: { toAddress: asha.candidate.email, subject: { startsWith: "Welcome" } } })));
    const twice = await portal.acceptOfferAction({}, fd({ token: tokenA, typedName: "Asha Pillai", consent: "on", signature: PNG }));
    check("Accepting twice is refused", twice.ok === false && /already accepted/.test(twice.message ?? ""), twice.message);
    const after = await page(tokenA);
    check("The portal now shows the signed outcome and the signed copy", after.includes("Welcome aboard") && after.includes("Download signed copy") && !after.includes("Accept and sign"));
    const signedRes = await letterRoute.GET(new Request(`http://x/offer/${tokenA}/letter?copy=signed`) as never, { params: Promise.resolve({ token: tokenA }) });
    check("…and the signed copy downloads", signedRes.status === 200);

    section("Decline with a reason");
    const extB = await hiring.offerOpAction({}, fd({ applicationId: rohan.id, op: "extend" }));
    const tokenB = await tokenFromMail(rohan.candidate.email);
    check("The approved offer goes out with its own link", extB.ok === true && !!tokenB && tokenB !== tokenA, extB.message);
    check("One candidate's link never opens another's offer", (await svc.openOfferLink(tokenB))?.applicationId === rohan.id && (await svc.openOfferLink(tokenA))?.applicationId === asha.id);
    as("10.9.0.3");
    const noReason = await portal.declineOfferAction({}, fd({ token: tokenB, reason: "  " }));
    check("Declining needs a reason", noReason.ok === false);
    const declined = await portal.declineOfferAction({}, fd({ token: tokenB, reason: "Accepted a counter-offer" }));
    const offerB = await prisma.offer.findUniqueOrThrow({ where: { applicationId: rohan.id } });
    check("The candidate declines", declined.ok === true && offerB.status === "DECLINED" && offerB.declineReason === "Accepted a counter-offer", declined.message);
    check("…the application is marked declined", (await prisma.application.findUniqueOrThrow({ where: { id: rohan.id } })).status === "OFFER_DECLINED");
    check("…and the hiring team is told why", !!(await prisma.notification.findFirst({ where: { tenantId: tenant.id, link: `/hiring/applications/${rohan.id}`, body: { contains: "counter-offer" } } })));
    const lateAccept = await portal.acceptOfferAction({}, fd({ token: tokenB, typedName: "Rohan Kapoor", consent: "on", signature: PNG }));
    check("A declined offer cannot then be accepted", lateAccept.ok === false && /declined/.test(lateAccept.message ?? ""), lateAccept.message);
  } finally {
    setTestHeaders({});
    const files = await prisma.storedFile.findMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, relatedId: { in: ids.apps.length ? ids.apps : ["-"] } } });
    for (const x of files) await unlink(path.join(STORAGE_DIR, x.storageKey)).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { id: { in: files.map((x) => x.id) } } });
    if (ids.job) await prisma.job.delete({ where: { id: ids.job } }).catch(() => {});
    if (ids.flow) await prisma.hiringFlow.delete({ where: { id: ids.flow } }).catch(() => {});
    if (ids.template) await prisma.documentTemplate.delete({ where: { id: ids.template } }).catch(() => {});
    await prisma.candidate.deleteMany({ where: { tenantId: tenant.id, email: { startsWith: "offers.smoke." } } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, OR: [{ toAddress: { startsWith: "offers.smoke." } }, { subject: { contains: "the offer for Offers Smoke Engineer" } }] } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, link: { in: ids.apps.map((a) => `/hiring/applications/${a}`) } } });
  }
  report("Offers");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
