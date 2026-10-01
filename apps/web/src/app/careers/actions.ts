"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@keka/db";
import { applyCandidate, notify } from "@keka/services";
import { tenantFromHost } from "@/lib/tenant-host";
import { saveFile, sniffUpload } from "@/lib/storage";
import { parseForm, type ActionState } from "@/lib/forms";
import { publicJobWhere } from "./data";

/**
 * Applying from the public careers site. No sign-in: the company comes from
 * the host, the job must be open and published, the résumé must really be a
 * PDF, and a hidden field plus a per-address limit keep bots out.
 */

const WINDOW_MS = 10 * 60_000;
const PER_WINDOW = 5;
const recent = new Map<string, number[]>();

function throttled(key: string): boolean {
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= PER_WINDOW) { recent.set(key, hits); return true; }
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5000) for (const [k, v] of recent) if (v.every((t) => now - t >= WINDOW_MS)) recent.delete(k);
  return false;
}

const optNum = (max: number) => z.string().optional().transform((v, ctx) => {
  if (!v || !v.trim()) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Between 0 and ${max}` }); return z.NEVER; }
  return n;
});

const schema = z.object({
  jobId: z.string().min(1),
  firstName: z.string().trim().min(1, "Required").max(60),
  lastName: z.string().trim().min(1, "Required").max(60),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  phone: z.string().trim().max(20).optional().transform((v) => v || null),
  currentEmployer: z.string().trim().max(120).optional().transform((v) => v || null),
  totalExperienceYears: optNum(60),
  noticePeriodDays: optNum(365),
  consent: z.literal("on", { errorMap: () => ({ message: "Please agree to continue" }) }),
});

const DONE = "The hiring team will be in touch by email.";

export async function applyToJobAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  // A filled honeypot gets the same answer as a real application, and nothing is stored.
  if (String(formData.get("website") ?? "").trim()) return { ok: true, message: DONE };
  const tenant = await tenantFromHost();
  if (!tenant) return { ok: false, message: "This careers site is not available." };
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "unknown";
  if (throttled(`${tenant.id}|${ip}`)) return { ok: false, message: "Too many applications from your network just now. Please try again in a few minutes." };

  const parsed = parseForm(schema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const job = await prisma.job.findFirst({ where: { id: d.jobId, ...publicJobWhere(tenant.id) }, select: { id: true, title: true, recruiterId: true, hiringManagerId: true } });
  if (!job) return { ok: false, message: "This role is no longer open." };

  const file = formData.get("resume");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || file.size === 0) return { ok: false, message: "Attach your résumé as a PDF.", errors: { resume: "Required" } };
  if (file.size > 5 * 1024 * 1024) return { ok: false, message: "The résumé is larger than 5 MB.", errors: { resume: "Too large" } };
  const data = Buffer.from(await file.arrayBuffer());
  const sniff = sniffUpload(data, file.type);
  if (!sniff.ok || sniff.mimeType !== "application/pdf") return { ok: false, message: "The résumé must be a PDF.", errors: { resume: "PDF only" } };

  const res = await applyCandidate({
    tenantId: tenant.id, jobId: job.id, firstName: d.firstName, lastName: d.lastName, email: d.email, phone: d.phone,
    currentEmployer: d.currentEmployer, totalExperienceYears: d.totalExperienceYears, noticePeriodDays: d.noticePeriodDays, source: "CAREER_PORTAL", updateExisting: false,
  });
  if (!res.ok) {
    // Do not reveal whether an address is already on file beyond this job.
    return /already applied/.test(res.message) ? { ok: false, message: "You have already applied to this role." } : { ok: false, message: res.message };
  }
  const app = await prisma.application.findUniqueOrThrow({ where: { id: res.applicationId! }, select: { candidateId: true } });
  const stored = await saveFile({ tenantId: tenant.id, filename: `resume-${d.firstName}-${d.lastName}.pdf`, mimeType: "application/pdf", data, relatedType: "CandidateResume", relatedId: app.candidateId });
  // The résumé goes on the application's candidate only if they have none yet;
  // otherwise it stays attached to them for the recruiter to compare.
  await prisma.candidate.updateMany({ where: { id: app.candidateId, resumeUrl: null }, data: { resumeUrl: `/files/${stored.id}` } });

  const people = await prisma.employee.findMany({ where: { id: { in: [job.recruiterId, job.hiringManagerId].filter((x): x is string => !!x) } }, select: { userId: true } });
  await notify({ tenantId: tenant.id, userIds: people.map((p) => p.userId), kind: "HIRING", title: `New application: ${d.firstName} ${d.lastName} for ${job.title}`, body: "Applied from the careers site.", link: `/hiring/applications/${res.applicationId}` });
  return { ok: true, message: DONE };
}
