/**
 * Statutory outputs from the seeded, finalised payroll: every file must
 * reconcile to the run it came from, filed returns must lock, and the
 * download routes must hand files only to the people entitled to them.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { unlink } from "node:fs/promises";
import path from "node:path";

const prisma = new PrismaClient();

async function main() {
  const a = await import("../apps/web/src/app/actions/filings");
  const { GET: fileGet } = await import("../apps/web/src/app/files/[id]/route");
  const { GET: payslipGet } = await import("../apps/web/src/app/(app)/payroll/payslips/[id]/pdf/route");
  const { STORAGE_DIR, sniffUpload } = await import("../apps/web/src/lib/storage");
  const { opensWith } = await import("@keka/documents");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const aug = await prisma.payrollRun.findFirstOrThrow({ where: { tenantId: tenant.id, year: 2026, month: 8, status: "FINALIZED" } });
  const started = new Date();
  const req = () => new Request("http://localhost/x") as never;
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const fileOf = async (filingType: string, month?: number) => {
    const f = await prisma.statutoryFiling.findFirstOrThrow({ where: { tenantId: tenant.id, type: filingType as never, ...(month ? { month } : {}) }, orderBy: { generatedAt: "desc" } });
    const id = (f.meta as { fileId: string }).fileId;
    return { filing: f, stored: await prisma.storedFile.findUniqueOrThrow({ where: { id } }) };
  };
  const body = async (res: Response) => Buffer.from(await res.arrayBuffer());

  console.log("\nStatutory filings\n" + "=".repeat(72));
  try {
    section("PF ECR");
    await signInAs("meera.krishnan@acme.test");
    let blocked = false;
    try { await a.generateMonthlyFiling({}, fd({ runId: aug.id, kind: "PF_ECR" })); } catch (e) { blocked = /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
    check("An employee cannot generate filings", blocked);

    await signInAs("ramesh.iyer@acme.test");
    const open = await prisma.payrollRun.findFirst({ where: { tenantId: tenant.id, status: "IN_PROGRESS" } });
    if (open) {
      const r = await a.generateMonthlyFiling({}, fd({ runId: open.id, kind: "PF_ECR" }));
      check("A month still open cannot be filed", r.ok === false && /finalised/.test(r.message ?? ""), r.message);
    }
    const g = await a.generateMonthlyFiling({}, fd({ runId: aug.id, kind: "PF_ECR" }));
    check("Payroll generates the August ECR", g.ok === true, g.message);
    const { filing: ecrFiling, stored: ecr } = await fileOf("PF_ECR", 8);
    const res = await fileGet(req(), params(ecr.id));
    const text = (await body(res)).toString();
    const lines = text.trim().split("\n");
    const run = await prisma.payrollRunEmployee.aggregate({ where: { runId: aug.id, pfEmployee: { gt: 0 } }, _sum: { pfEmployee: true, vpf: true, epsEmployer: true, pfEmployer: true }, _count: { _all: true } });
    check("One line per PF member, eleven fields each", lines.length === run._count._all && lines.every((l) => l.split("#~#").length === 11), `${lines.length} lines`);
    const eeSum = lines.reduce((s, l) => s + Number(l.split("#~#")[6]), 0);
    const expectedEe = Math.round(Number(run._sum.pfEmployee ?? 0) + Number(run._sum.vpf ?? 0));
    check("Employee contributions in the file equal the run's, to the rupee", Math.abs(eeSum - expectedEe) <= lines.length, `${eeSum} vs ${expectedEe}`);
    const erSum = lines.reduce((s, l) => s + Number(l.split("#~#")[7]) + Number(l.split("#~#")[8]), 0);
    check("…and so do employer contributions (EPS + EPF difference)", Math.abs(erSum - Math.round(Number(run._sum.epsEmployer ?? 0) + Number(run._sum.pfEmployer ?? 0))) <= 2 * lines.length);

    const noReceipt = await a.markFiled({}, fd({ filingId: ecrFiling.id }));
    check("Marking filed needs the portal acknowledgement", noReceipt.ok === false, noReceipt.message);
    const filed = await a.markFiled({}, fd({ filingId: ecrFiling.id, receipt: "TRRN1234567890" }));
    check("With a TRRN it is marked filed", filed.ok === true);
    const again = await a.generateMonthlyFiling({}, fd({ runId: aug.id, kind: "PF_ECR" }));
    check("A filed return cannot be regenerated", again.ok === false && /already marked filed/.test(again.message ?? ""), again.message);

    section("ESI and bank advice");
    const esi = await a.generateMonthlyFiling({}, fd({ runId: aug.id, kind: "ESI_ECR" }));
    check("The ESI file is generated", esi.ok === true, esi.message);
    const bank = await a.generateMonthlyFiling({}, fd({ runId: aug.id, kind: "BANK" }));
    const bankFile = await prisma.storedFile.findFirstOrThrow({ where: { tenantId: tenant.id, relatedType: "PayrollOutput", relatedId: aug.id }, orderBy: { createdAt: "desc" } });
    const csvRows = (await body(await fileGet(req(), params(bankFile.id)))).toString().replace(/^﻿/, "").trim().split("\r\n").slice(1);
    const fileTotal = csvRows.reduce((s, r) => s + Number(r.split(",")[3]), 0);
    const net = await prisma.payrollRunEmployee.aggregate({ where: { runId: aug.id, payAction: "PROCESS_AS_SALARY" }, _sum: { netPay: true } });
    check("The bank advice pays exactly the run's net pay", bank.ok === true && Math.abs(fileTotal - Number(net._sum.netPay ?? 0)) < 0.01, `${fileTotal} vs ${net._sum.netPay}`);

    const { REPORTS } = await import("../apps/web/src/lib/reports");
    const { getViewer } = await import("../apps/web/src/lib/context");
    const dues = await REPORTS.find((r) => r.key === "statutory-dues")!.run((await getViewer())!, { fy: 2026 });
    check("The dues report now shows August as filed", dues.rows.find((r) => r.month === "Aug 2026")?.status === "filed", String(dues.rows.find((r) => r.month === "Aug 2026")?.status));

    section("Form 24Q and Form 16");
    const q1 = await a.generate24q({}, fd({ fy: 2026, quarter: 1 }));
    const { stored: q1File } = await fileOf("FORM_24Q");
    const q1Rows = (await body(await fileGet(req(), params(q1File.id)))).toString().replace(/^﻿/, "").trim().split("\r\n").slice(1);
    const q1Lines = await prisma.payrollRunEmployee.count({ where: { run: { tenantId: tenant.id, year: 2026, month: { in: [4, 5, 6] }, status: "FINALIZED" } } });
    check("24Q Q1 has a row per employee per month", q1.ok === true && q1Rows.length === q1Lines, `${q1Rows.length} vs ${q1Lines}`);
    const q4 = await a.generate24q({}, fd({ fy: 2026, quarter: 4 }));
    check("A quarter with no finalised payroll is refused", q4.ok === false, q4.message);

    const f16 = await a.generateForm16({}, fd({ fy: 2026 }));
    const f16Files = await prisma.storedFile.findMany({ where: { tenantId: tenant.id, relatedType: "Form16", relatedId: "2026" } });
    check("Form 16 Part B is generated for everyone paid in the year", f16.ok === true && f16Files.length >= 29, f16.message);
    const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: "ACM0009" }, include: { identityDocs: { where: { type: "PAN" } } } });
    const mine = f16Files.find((f) => f.employeeId === meera.id)!;

    await signInAs("meera.krishnan@acme.test");
    const myRes = await fileGet(req(), params(mine.id));
    const pdf = await body(myRes);
    check("An employee downloads their own Form 16", myRes.status === 200 && pdf.subarray(0, 5).toString() === "%PDF-");
    check("…which opens with their PAN and not with anything else",
      opensWith(pdf, meera.identityDocs[0].number.toUpperCase()) && !opensWith(pdf, "WRONGPAN0X") && !opensWith(pdf, ""));
    const other = f16Files.find((f) => f.employeeId !== meera.id)!;
    check("…but not a colleague's (404, not 403, so ids cannot be probed)", (await fileGet(req(), params(other.id))).status === 404);
    check("…and not the PF return", (await fileGet(req(), params(ecr.id))).status === 404);

    section("Payslip PDF");
    const slip = await prisma.payslip.findFirstOrThrow({ where: { employeeId: meera.id, status: "RELEASED" }, orderBy: [{ year: "desc" }, { month: "desc" }] });
    const ps = await payslipGet(req(), params(slip.id));
    check("An employee downloads their released payslip as a PDF", ps.status === 200 && (await body(ps)).toString("latin1").includes("/Encrypt"));
    const someoneElse = await prisma.payslip.findFirstOrThrow({ where: { employeeId: { not: meera.id }, status: "RELEASED" } });
    check("…not someone else's", (await payslipGet(req(), params(someoneElse.id))).status === 404);
    await signInAs("ramesh.iyer@acme.test");
    check("Payroll can download anyone's in scope", (await payslipGet(req(), params(someoneElse.id))).status === 200);

    section("Document upload");
    const docs = await import("../apps/web/src/app/actions/documents");
    const wp = await import("../apps/web/src/app/actions/workplace");
    const slot = await prisma.employeeDocument.findFirst({ where: { employeeId: meera.id, status: { in: ["PENDING_ON_EMPLOYEE", "REJECTED"] } } })
      ?? await prisma.employeeDocument.create({ data: { tenantId: tenant.id, employeeId: meera.id, name: "Smoke test document", status: "PENDING_ON_EMPLOYEE" } });
    const before = { status: slot.status, fileUrl: slot.fileUrl, uploadedAt: slot.uploadedAt };
    const upload = (bytes: Buffer, name: string, type: string) => {
      const f = new FormData();
      f.set("documentId", slot.id);
      f.set("file", new File([new Uint8Array(bytes)], name, { type }));
      return docs.uploadDocumentAction({}, f);
    };
    await signInAs("meera.krishnan@acme.test");
    const evil = await upload(Buffer.from("<html><script>steal()</script></html>"), "offer.pdf", "application/pdf");
    check("An HTML page named .pdf is refused", evil.ok === false, evil.message);
    const ok = await upload(Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF"), "pan-card.pdf", "application/pdf");
    const after = await prisma.employeeDocument.findUniqueOrThrow({ where: { id: slot.id } });
    check("A real PDF uploads and waits for verification", ok.ok === true && after.status === "PENDING_VERIFICATION" && !!after.fileUrl?.startsWith("/files/"), ok.message);
    const fileId = after.fileUrl!.replace("/files/", "");
    check("The employee can open their upload", (await fileGet(req(), params(fileId))).status === 200);
    await signInAs("ramesh.iyer@acme.test");
    check("Someone without document rights over them cannot", (await fileGet(req(), params(fileId))).status === 404);
    await signInAs("priya.sharma@acme.test");
    check("HR can open it", (await fileGet(req(), params(fileId))).status === 200);
    await wp.verifyDocument(fd({ id: slot.id, decision: "approve" }));
    check("HR verifies it", (await prisma.employeeDocument.findUniqueOrThrow({ where: { id: slot.id } })).status === "VERIFIED");
    const priyaEmp = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: "ACM0003" } });
    const own = await prisma.employeeDocument.create({ data: { tenantId: tenant.id, employeeId: priyaEmp.id, name: "Smoke own doc", status: "PENDING_VERIFICATION" } });
    let refused = false;
    try { await wp.verifyDocument(fd({ id: own.id, decision: "approve" })); } catch { refused = true; }
    check("…but cannot verify a document of her own", refused && (await prisma.employeeDocument.findUniqueOrThrow({ where: { id: own.id } })).status === "PENDING_VERIFICATION");
    await prisma.employeeDocument.delete({ where: { id: own.id } });
    if (slot.name === "Smoke test document") await prisma.employeeDocument.delete({ where: { id: slot.id } });
    else await prisma.employeeDocument.update({ where: { id: slot.id }, data: { status: before.status, fileUrl: before.fileUrl, uploadedAt: before.uploadedAt, verifiedAt: null, verifiedBy: null } });

    section("Upload validation");
    check("A real PDF is accepted", sniffUpload(Buffer.from("%PDF-1.4\n..."), "application/pdf").ok);
    check("An HTML file renamed .pdf is refused", !sniffUpload(Buffer.from("<html><script>alert(1)</script>"), "application/pdf").ok);
    check("A PNG claiming to be a PDF is refused", !sniffUpload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "application/pdf").ok);
  } finally {
    const files = await prisma.storedFile.findMany({ where: { tenantId: tenant.id, createdAt: { gte: started } } });
    for (const f of files) await unlink(path.join(STORAGE_DIR, f.storageKey)).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    await prisma.statutoryFiling.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started } } });
  }
  report("Statutory filings");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
