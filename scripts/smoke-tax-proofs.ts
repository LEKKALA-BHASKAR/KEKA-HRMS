/**
 * Tax proof review through the action: only payroll reviewers may act, and
 * never on their own proofs; a rejection needs a reason and accepting less
 * than declared needs one too; nothing above the declared amount is accepted;
 * the declaration's approved total and status follow its lines; and the
 * employee is told the outcome.
 *
 * Works on throwaway declarations for FY 2030, removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const FY = 2030;

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

async function main() {
  const act = await import("../apps/web/src/app/actions/tax-proofs");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const byEmail = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email } }, include: { user: true } });
  const meera = await byEmail("meera.krishnan@acme.test");
  const ramesh = await byEmail("ramesh.iyer@acme.test");
  const since = new Date();
  const review = (itemId: string, decision: string, extra: Record<string, string> = {}) => act.reviewProofAction({}, fd({ itemId, decision, ...extra }));

  const decl = await prisma.investmentDeclaration.create({
    data: {
      employeeId: meera.id, fyStartYear: FY, regime: "OLD", status: "SUBMITTED", declaredTotal: 110000, submittedAt: new Date(), isLocked: true,
      items: { create: [
        { section: "80C", category: "Public Provident Fund", declaredAmount: 60000, proofStatus: "SUBMITTED", proofFileUrl: "/files/none" },
        { section: "80D", category: "Health insurance", declaredAmount: 25000, proofStatus: "SUBMITTED" },
        { section: "80E", category: "Education loan interest", declaredAmount: 25000, proofStatus: "SUBMITTED" },
        { section: "80G", category: "Donation", declaredAmount: 1000, proofStatus: "NOT_SUBMITTED" },
      ] },
    },
    include: { items: true },
  });
  const own = await prisma.investmentDeclaration.create({
    data: { employeeId: ramesh.id, fyStartYear: FY, regime: "OLD", status: "SUBMITTED", items: { create: [{ section: "80C", category: "ELSS", declaredAmount: 50000, proofStatus: "SUBMITTED" }] } },
    include: { items: true },
  });
  const [ppf, health, edu, gift] = ["80C", "80D", "80E", "80G"].map((s) => decl.items.find((i) => i.section === s)!);
  const item = (id: string) => prisma.declarationItem.findUniqueOrThrow({ where: { id } });
  const declaration = () => prisma.investmentDeclaration.findUniqueOrThrow({ where: { id: decl.id } });

  console.log("\nTax proof review\n" + "=".repeat(72));
  try {
    section("Access");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot review proofs", await denied(() => review(ppf.id, "approve")));
    await signInAs("ramesh.iyer@acme.test");
    const self = await review(own.items[0].id, "approve");
    check("A reviewer cannot accept their own proof", self.ok === false && /own/.test(self.message ?? ""), self.message);

    section("Rules");
    const noReason = await review(edu.id, "reject");
    check("A rejection needs a reason", noReason.ok === false && /reason/.test(noReason.message ?? ""), noReason.message);
    const tooMuch = await review(ppf.id, "approve", { approvedAmount: "70000" });
    check("Nothing above the declared amount is accepted", tooMuch.ok === false && /at most/.test(tooMuch.message ?? ""), tooMuch.message);
    const lessNoWhy = await review(health.id, "approve", { approvedAmount: "20000" });
    check("Accepting less than declared needs a reason", lessNoWhy.ok === false && /why/i.test(lessNoWhy.message ?? ""), lessNoWhy.message);
    const noProof = await review(gift.id, "approve");
    check("A line with no proof cannot be reviewed", noProof.ok === false && /No proof/.test(noProof.message ?? ""), noProof.message);
    check("Refused reviews change nothing", (await item(ppf.id)).proofStatus === "SUBMITTED" && (await item(edu.id)).proofStatus === "SUBMITTED");

    section("Reviewing");
    const full = await review(ppf.id, "approve");
    const p = await item(ppf.id);
    check("Accepting takes the declared amount by default", full.ok === true && p.proofStatus === "APPROVED" && Number(p.approvedAmount) === 60000 && p.reviewedBy === ramesh.userId && !!p.reviewedAt, full.message);
    let d = await declaration();
    check("The declaration is partly approved, with its approved total", d.status === "PARTIALLY_APPROVED" && Number(d.approvedTotal) === 60000, `${d.status} ${d.approvedTotal}`);
    const part = await review(health.id, "approve", { approvedAmount: "20000", remark: "Policy covers self only" });
    check("A partial amount is accepted with its reason", part.ok === true && Number((await item(health.id)).approvedAmount) === 20000 && (await item(health.id)).proofRemark === "Policy covers self only");
    const rej = await review(edu.id, "reject", { remark: "Certificate is from FY 2028" });
    const e = await item(edu.id);
    check("A rejection counts nothing and keeps the reason", rej.ok === true && e.proofStatus === "REJECTED" && Number(e.approvedAmount) === 0 && e.proofRemark === "Certificate is from FY 2028");
    d = await declaration();
    check("Approved total adds only accepted amounts", Number(d.approvedTotal) === 80000, String(d.approvedTotal));
    check("With a line still unproven the declaration stays partly approved", d.status === "PARTIALLY_APPROVED", d.status);
    const twice = await review(ppf.id, "reject", { remark: "changed my mind" });
    check("A reviewed proof cannot be reviewed again", twice.ok === false && /Already/.test(twice.message ?? ""), twice.message);

    const notes = await prisma.notification.findMany({ where: { userId: meera.userId!, createdAt: { gte: since }, kind: "PAYROLL" } });
    check("The employee is told about every outcome", notes.length === 3 && notes.some((n) => /rejected/i.test(n.title) && n.body === "Certificate is from FY 2028") && notes.some((n) => /20,000 of/.test(n.title)), notes.map((n) => n.title).join(" | "));
    const audits = await prisma.auditLog.count({ where: { tenantId: tenant.id, entityType: "DeclarationItem", entityId: { in: decl.items.map((i) => i.id) } } });
    check("Each decision is audited", audits === 3, String(audits));
  } finally {
    const ids = [...decl.items, ...own.items].map((i) => i.id);
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, entityType: "DeclarationItem", entityId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: [meera.userId!, ramesh.userId!] }, createdAt: { gte: since }, kind: "PAYROLL" } });
    await prisma.investmentDeclaration.deleteMany({ where: { id: { in: [decl.id, own.id] } } });
  }
  report("Tax proof review");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
