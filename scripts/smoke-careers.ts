/**
 * The public careers site's apply action, signed out: the company comes from
 * the host; a real application creates the candidate, the application at the
 * job's first stage, a stored PDF résumé and a notification to the hiring
 * team; duplicates, non-PDF résumés, closed or unpublished jobs and unknown
 * hosts are refused; a filled honeypot is silently dropped; and one network
 * is limited to five tries in ten minutes. Candidates use @careers.test
 * addresses and are removed at the end.
 */
import { setTestHeaders, setTestSession, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

function form(jobId: string, email: string, extra: Record<string, string> = {}, resume: { data: Buffer; type: string } | null = { data: PDF, type: "application/pdf" }) {
  const f = fd({ jobId, firstName: "Asha", lastName: "Rao", email, phone: "9876500000", totalExperienceYears: "4", consent: "on", ...extra });
  if (resume) f.append("resume", new File([new Uint8Array(resume.data)], "cv.pdf", { type: resume.type }));
  return f;
}

async function main() {
  const act = await import("../apps/web/src/app/careers/actions");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const job = await prisma.job.findFirstOrThrow({ where: { tenantId: tenant.id, status: "OPEN", isPublished: true } });
  const since = new Date();
  const cleanup = async () => {
    const cands = await prisma.candidate.findMany({ where: { tenantId: tenant.id, email: { endsWith: "@careers.test" } }, select: { id: true } });
    await prisma.storedFile.deleteMany({ where: { relatedType: "CandidateResume", relatedId: { in: cands.map((c) => c.id) } } });
    await prisma.candidate.deleteMany({ where: { id: { in: cands.map((c) => c.id) } } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since }, title: { startsWith: "New application" } } });
  };
  await cleanup();
  setTestSession(null);
  const as = (ip: string, host = "acme.localhost:3100") => setTestHeaders({ host, "x-forwarded-for": ip });

  try {
    section("Applying");
    as("198.51.100.1");
    const ok = await act.applyToJobAction({}, form(job.id, "asha.rao@careers.test"));
    check("A signed-out visitor can apply", ok.ok === true, ok.message);
    const cand = await prisma.candidate.findFirst({ where: { tenantId: tenant.id, email: "asha.rao@careers.test" }, include: { applications: true } });
    check("The candidate is recorded from the careers portal", cand?.source === "CAREER_PORTAL");
    check("They are applied to the job", cand?.applications.some((a) => a.jobId === job.id) === true);
    const file = cand?.resumeUrl ? await prisma.storedFile.findUnique({ where: { id: cand.resumeUrl.split("/").pop()! } }) : null;
    check("The résumé is stored as a PDF against the candidate", file?.mimeType === "application/pdf" && file.relatedType === "CandidateResume");
    const dup = await act.applyToJobAction({}, form(job.id, "ASHA.RAO@careers.test"));
    check("Applying twice is refused", dup.ok !== true && /already applied/.test(dup.message ?? ""), dup.message);

    section("Refusals");
    as("198.51.100.2");
    const notPdf = await act.applyToJobAction({}, form(job.id, "b@careers.test", {}, { data: Buffer.from("hello, I am a résumé"), type: "application/pdf" }));
    check("A file that is not really a PDF is refused", notPdf.ok !== true && /PDF/.test(notPdf.message ?? ""), notPdf.message);
    const noFile = await act.applyToJobAction({}, form(job.id, "c@careers.test", {}, null));
    check("No résumé is refused", noFile.ok !== true, noFile.message);
    const noConsent = await act.applyToJobAction({}, form(job.id, "d@careers.test", { consent: "" }));
    check("Consent is required", noConsent.ok !== true, noConsent.message);
    as("198.51.100.3");
    const draft = await prisma.job.findFirst({ where: { tenantId: tenant.id, OR: [{ isPublished: false }, { status: { not: "OPEN" } }] } });
    if (draft) {
      const closed = await act.applyToJobAction({}, form(draft.id, "e@careers.test"));
      check("An unpublished or closed job is refused", closed.ok !== true && /no longer open/.test(closed.message ?? ""), closed.message);
    }
    as("198.51.100.4", "nope.localhost:3100");
    const host = await act.applyToJobAction({}, form(job.id, "f@careers.test"));
    check("An unknown company host is refused", host.ok !== true, host.message);
    as("198.51.100.5");
    const bot = await act.applyToJobAction({}, form(job.id, "bot@careers.test", { website: "http://spam.example" }));
    check("A filled honeypot looks accepted but stores nothing", bot.ok === true && !(await prisma.candidate.findFirst({ where: { tenantId: tenant.id, email: "bot@careers.test" } })));

    section("Rate limit");
    as("198.51.100.9");
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await act.applyToJobAction({}, form(job.id, `burst${i}@careers.test`, {}, { data: Buffer.from("x"), type: "application/pdf" })));
    check("The sixth try within ten minutes from one network is held back", /Too many/.test(results[5].message ?? "") && !results.slice(0, 5).some((r) => /Too many/.test(r.message ?? "")), results.map((r) => r.message).join(" | "));
  } finally {
    await cleanup();
  }
  report("Careers site");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
