/**
 * Positions & job architecture, workforce planning & budgeting, and the
 * contingent workforce — end to end through the real actions, pages and
 * CSV exports, signed in as real seeded users:
 *
 *   Vikram (Global Admin) raises things; Priya (HR Manager) approves them;
 *   Meera (no role) is refused; Sneha decides her contractor's timesheet as
 *   the contract's manager.
 *
 *   1. Job families and levels: create, nest, search, edit, submit, approve /
 *      reject (never self-approve), retire, export.
 *   2. Jobs: versioned descriptions — v1 approved, v2 drafted while v1 stays
 *      current, rejected, withdrawn; competency tags; export.
 *   3. Positions: request → approve → vacant; pay-grade range check; edit with
 *      field-level audit; fill / vacate with incumbency history; freeze,
 *      unfreeze, close; clone; bulk update; raise a linked requisition;
 *      readiness checklist; vacancy aging, headcount and reconciliation
 *      reports; the nightly job vacates a leaver's seat.
 *   4. Workforce planning: template plan, lines, forecast from live data,
 *      submit / approve / reject, activate, beyond-plan warnings on
 *      positions and requisitions, scenarios compared, budgets built from a
 *      plan with payroll actuals and versioning, capacity plans, exports.
 *   5. Contingent workforce: vendor onboarding (checklist, documents,
 *      activation), contractors and vendor workers through approval, rate
 *      cards, assignments priced from the rate card, payment profile
 *      verification, timesheets (manager decides), expenses, SOW
 *      milestones, extension, access, feedback, expiry alerts, contract end
 *      and offboarding, conversion to employee, spend and exports.
 *   6. Tenant isolation: another company's records cannot be read or acted on.
 *
 * Everything it creates is tagged and removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const TAG = `wf${Date.now().toString(36)}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
type Res = { ok?: boolean; message?: string; values?: Record<string, string> };

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = (await import("react")) as typeof import("react");
  /** Await every async server component in the tree, so the static renderer sees plain elements. */
  async function resolve(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) return Promise.all(node.map(resolve));
    if (!React.isValidElement(node)) return node;
    const el = node as import("react").ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
      return resolve(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    }
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el.props ?? {})) if (k !== "children") props[k] = React.isValidElement(v) || Array.isArray(v) ? await resolve(v) : v;
    const children = el.props?.children;
    return Array.isArray(children) ? React.cloneElement(el, props, ...((await resolve(children)) as import("react").ReactNode[])) : React.cloneElement(el, props, (await resolve(children)) as import("react").ReactNode);
  }
  const html = async (node: Promise<unknown>) => renderToStaticMarkup((await resolve(await node)) as Parameters<typeof renderToStaticMarkup>[0]);
  const sp = <T extends object>(o: T) => Promise.resolve(o);

  const pos = await import("../apps/web/src/app/actions/positions");
  const wfp = await import("../apps/web/src/app/actions/workforce-planning");
  const cw = await import("../apps/web/src/app/actions/contingent");
  const reqs = await import("../apps/web/src/app/actions/workforce-requests");
  const hiring = await import("../apps/web/src/app/actions/hiring");
  const svc = await import("@keka/services");
  const { NextRequest } = await import("next/server");
  const pages = {
    positions: (await import("../apps/web/src/app/(app)/positions/page")).default,
    position: (await import("../apps/web/src/app/(app)/positions/[id]/page")).default,
    jobs: (await import("../apps/web/src/app/(app)/positions/jobs/page")).default,
    job: (await import("../apps/web/src/app/(app)/positions/jobs/[id]/page")).default,
    arch: (await import("../apps/web/src/app/(app)/positions/architecture/page")).default,
    posApprovals: (await import("../apps/web/src/app/(app)/positions/approvals/page")).default,
    posReports: (await import("../apps/web/src/app/(app)/positions/reports/page")).default,
    wfp: (await import("../apps/web/src/app/(app)/workforce-planning/page")).default,
    plan: (await import("../apps/web/src/app/(app)/workforce-planning/[id]/page")).default,
    scenarios: (await import("../apps/web/src/app/(app)/workforce-planning/scenarios/page")).default,
    budgets: (await import("../apps/web/src/app/(app)/workforce-planning/budgets/page")).default,
    capacity: (await import("../apps/web/src/app/(app)/workforce-planning/capacity/page")).default,
    wfpApprovals: (await import("../apps/web/src/app/(app)/workforce-planning/approvals/page")).default,
    cw: (await import("../apps/web/src/app/(app)/contingent/page")).default,
    workers: (await import("../apps/web/src/app/(app)/contingent/workers/page")).default,
    worker: (await import("../apps/web/src/app/(app)/contingent/workers/[id]/page")).default,
    vendors: (await import("../apps/web/src/app/(app)/contingent/vendors/page")).default,
    vendor: (await import("../apps/web/src/app/(app)/contingent/vendors/[id]/page")).default,
    rates: (await import("../apps/web/src/app/(app)/contingent/rate-cards/page")).default,
    cwApprovals: (await import("../apps/web/src/app/(app)/contingent/approvals/page")).default,
  };
  const exportPos = (await import("../apps/web/src/app/(app)/positions/export/route")).GET;
  const exportWfp = (await import("../apps/web/src/app/(app)/workforce-planning/export/route")).GET;
  const exportCw = (await import("../apps/web/src/app/(app)/contingent/export/route")).GET;
  const csv = async (get: (r: InstanceType<typeof NextRequest>) => Promise<Response>, url: string) => {
    const r = await get(new NextRequest(`http://acme.localhost${url}`));
    return { status: r.status, text: await r.text() };
  };
  const { buildNav } = await import("../apps/web/src/lib/nav");
  const { viewerForUser } = await import("../apps/web/src/lib/context");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { tenantId: t, email } });
  const vikram = await user("vikram.menon@acme.test");
  const priya = await user("priya.sharma@acme.test");
  const sneha = await user("sneha.reddy@acme.test");
  const snehaEmp = await prisma.employee.findFirstOrThrow({ where: { userId: sneha.id } });
  const dept = await prisma.department.findFirstOrThrow({ where: { tenantId: t, name: "Product Engineering" } });
  const dept2 = await prisma.department.findFirstOrThrow({ where: { tenantId: t, name: "Design" } });
  const location = await prisma.location.findFirstOrThrow({ where: { tenantId: t, stateCode: { not: null } } });
  const otherLocation = await prisma.location.findFirstOrThrow({ where: { tenantId: t, id: { not: location.id } } });
  const entity = await prisma.legalEntity.findFirstOrThrow({ where: { tenantId: t } });
  const g3 = await prisma.payGrade.findFirstOrThrow({ where: { tenantId: t, name: "G3" } });
  const cc = await prisma.costCenter.findFirst({ where: { tenantId: t } });
  const seriesBefore = await prisma.employeeNumberSeries.findFirst({ where: { tenantId: t, isDefault: true } });
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const fy = svc.fiscalYearOf(today);
  const made = { requisitionIds: [] as string[], employeeIds: [] as string[], rivalTenantId: "" };

  const as = async (who: "vikram" | "priya" | "meera" | "sneha") => signInAs(`${who === "vikram" ? "vikram.menon" : who === "priya" ? "priya.sharma" : who === "meera" ? "meera.krishnan" : "sneha.reddy"}@acme.test`);
  const pendingFor = (entityId: string, kind?: string) => prisma.workforceRequest.findFirstOrThrow({ where: { tenantId: t, entityId, status: "PENDING", ...(kind ? { kind } : {}) }, orderBy: { requestedAt: "desc" } });
  const decide = async (entityId: string, decision: "approve" | "reject", note?: string, kind?: string) => {
    const r = await pendingFor(entityId, kind);
    return (await reqs.decideWorkforceRequestAction({}, fd({ id: r.id, decision, note }))) as Res;
  };
  const audits = (entityType: string, entityId: string) => prisma.auditLog.count({ where: { tenantId: t, entityType, entityId } });

  try {
    // =================================================================
    section("Access: navigation and permissions");
    {
      const admin = await viewerForUser(vikram.id);
      const tabs = buildNav(admin!, {} as never, { hasExit: false, managesProject: false })
        .find((s) => s.key === "org")!.tabs.map((x) => x.href);
      check("Org nav links Positions, Workforce Planning and Contingent Workforce", ["/positions", "/workforce-planning", "/contingent"].every((h) => tabs.includes(h)), tabs.join(" "));
      const meera = await viewerForUser((await user("meera.krishnan@acme.test")).id);
      const meeraTabs = buildNav(meera!, {} as never, { hasExit: false, managesProject: false }).flatMap((s) => s.tabs.map((x) => x.href));
      check("…but not for an employee without the permissions", !meeraTabs.some((h) => ["/positions", "/workforce-planning", "/contingent"].includes(h)));
      await as("meera");
      check("An employee cannot create a job family", await denied(() => pos.saveJobFamilyAction({}, fd({ name: `${TAG} nope` }))));
      check("…open the positions page", await denied(() => pages.positions({ searchParams: sp({}) })));
      check("…create a workforce plan", await denied(() => wfp.savePlanAction({}, fd({ name: "x", fiscalYear: fy }))));
      check("…or add a contractor", await denied(() => cw.saveWorkerAction({}, fd({ firstName: "x", lastName: "y", workerKind: "CONTRACTOR", engagementType: "FIXED_TERM" }))));
      const csvDenied = await csv(exportCw, "/contingent/export?report=workers");
      check("…or download contingent CSVs", csvDenied.status === 403, String(csvDenied.status));
    }

    // =================================================================
    section("1. Job families and levels");
    await as("vikram");
    let r = (await pos.saveJobFamilyAction({}, fd({ name: `${TAG} Engineering`, code: "ENG", description: "Builds the product" }))) as Res;
    check("Create a job family (as a draft)", !!r.ok, r.message);
    const fam = await prisma.jobFamily.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Engineering` } });
    check("…status DRAFT", fam.status === "DRAFT");
    r = (await pos.saveJobFamilyAction({}, fd({ name: `${TAG} Backend`, parentId: fam.id }))) as Res;
    const sub = await prisma.jobFamily.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Backend` } });
    check("Nest a sub-family under it", !!r.ok && sub.parentId === fam.id);
    r = (await pos.saveJobFamilyAction({}, fd({ id: fam.id, name: `${TAG} Engineering`, parentId: sub.id }))) as Res;
    check("A family cannot become its own ancestor", r.ok === false, r.message);
    r = (await pos.saveJobFamilyAction({}, fd({ id: fam.id, name: `${TAG} Engineering`, code: "ENGG", description: "Builds and runs the product" }))) as Res;
    check("Edit the family", !!r.ok && (await prisma.jobFamily.findUniqueOrThrow({ where: { id: fam.id } })).code === "ENGG");
    check("Architecture page search finds it", (await html(pages.arch({ searchParams: sp({ q: TAG }) }))).includes(`${TAG} Backend`));
    r = (await pos.submitArchitectureAction({}, fd({ kind: "family", id: fam.id }))) as Res;
    check("Submit the family for approval", !!r.ok && (await prisma.jobFamily.findUniqueOrThrow({ where: { id: fam.id } })).status === "PENDING_APPROVAL");
    r = await decide(fam.id, "approve");
    check("The requester cannot approve their own request", r.ok === false && /own request/.test(r.message ?? ""), r.message);
    await as("priya");
    check("Pending request shows on the approvals page", (await html(pages.posApprovals())).includes(`${TAG} Engineering`));
    r = await decide(fam.id, "approve", "Looks right");
    check("An approver approves it → ACTIVE", !!r.ok && (await prisma.jobFamily.findUniqueOrThrow({ where: { id: fam.id } })).status === "ACTIVE", r.message);
    check("…and the requester is notified", (await prisma.notification.count({ where: { userId: vikram.id, title: { contains: `${TAG} Engineering` } } })) >= 1);
    await as("vikram");
    await pos.submitArchitectureAction({}, fd({ kind: "family", id: sub.id }));
    await as("priya");
    r = await decide(sub.id, "reject");
    check("Rejecting needs a reason", r.ok === false, r.message);
    r = await decide(sub.id, "reject", "Merge into Engineering");
    check("Reject with a reason → REJECTED", !!r.ok && (await prisma.jobFamily.findUniqueOrThrow({ where: { id: sub.id } })).status === "REJECTED");
    await as("vikram");
    r = (await pos.saveJobLevelAction({}, fd({ name: `${TAG} L3`, code: "L3", rank: 3, track: "IC", careerDefinition: "Owns features end to end", payGradeId: g3.id }))) as Res;
    const lvl = await prisma.jobLevel.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} L3` } });
    check("Create a job level with a career definition and pay grade", !!r.ok && lvl.payGradeId === g3.id);
    r = (await pos.saveJobLevelAction({}, fd({ id: lvl.id, name: `${TAG} L3`, rank: 4, track: "IC", payGradeId: g3.id }))) as Res;
    check("Edit the level", !!r.ok && (await prisma.jobLevel.findUniqueOrThrow({ where: { id: lvl.id } })).rank === 4);
    await pos.submitArchitectureAction({}, fd({ kind: "level", id: lvl.id }));
    await as("priya");
    r = await decide(lvl.id, "approve");
    check("Approve the level", !!r.ok && (await prisma.jobLevel.findUniqueOrThrow({ where: { id: lvl.id } })).status === "ACTIVE");
    await as("vikram");
    const lvlTmp = (await pos.saveJobLevelAction({}, fd({ name: `${TAG} L9`, rank: 9, track: "EXECUTIVE" }))) as Res;
    const lvl9 = await prisma.jobLevel.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} L9` } });
    r = (await pos.retireArchitectureAction({}, fd({ kind: "level", id: lvl9.id }))) as Res;
    check("Retire a level", !!lvlTmp.ok && !!r.ok && (await prisma.jobLevel.findUniqueOrThrow({ where: { id: lvl9.id } })).status === "RETIRED");
    check("Family and level changes are audited", (await audits("JobFamily", fam.id)) >= 4 && (await audits("JobLevel", lvl.id)) >= 3);
    let out = await csv(exportPos, "/positions/export?report=families");
    check("Families CSV lists the family and its parent", out.status === 200 && out.text.includes(`${TAG} Backend`) && out.text.includes(`${TAG} Engineering`));
    out = await csv(exportPos, "/positions/export?report=levels");
    check("Levels CSV lists the level", out.text.includes(`${TAG} L3`));

    // =================================================================
    section("2. Jobs and versioned job descriptions");
    r = (await pos.saveJobAction({}, fd({ title: `${TAG} Backend Engineer`, familyId: fam.id, levelId: lvl.id, summary: "Builds APIs", responsibilities: "Design, build, run services", competencies: "Ownership, Communication", skills: "TypeScript, PostgreSQL" }))) as Res;
    const job = await prisma.jobProfile.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} Backend Engineer` }, include: { versions: true } });
    check("Create a job with a v1 draft description", !!r.ok && job.status === "DRAFT" && job.versions.length === 1 && job.code.startsWith("JOB-"));
    check("…with competency tags", job.competencies.join("|") === "Ownership|Communication");
    r = (await pos.submitJobDescriptionAction({}, fd({ id: job.id }))) as Res;
    check("Submit v1 for approval", !!r.ok && (await prisma.jobProfile.findUniqueOrThrow({ where: { id: job.id } })).status === "PENDING_APPROVAL");
    await as("priya");
    r = await decide(job.id, "approve");
    let j = await prisma.jobProfile.findUniqueOrThrow({ where: { id: job.id } });
    check("Approve → job ACTIVE on v1", !!r.ok && j.status === "ACTIVE" && j.version === 1);
    await as("vikram");
    r = (await pos.saveJobAction({}, fd({ id: job.id, title: `${TAG} Backend Engineer`, familyId: fam.id, levelId: lvl.id, summary: "Builds and operates APIs", responsibilities: "Design, build, run services; on-call", competencies: "Ownership, Communication, Mentoring", skills: "TypeScript, PostgreSQL" }))) as Res;
    j = await prisma.jobProfile.findUniqueOrThrow({ where: { id: job.id } });
    check("Editing an approved description drafts v2; v1 stays current", !!r.ok && j.summary === "Builds APIs" && (await prisma.jobDescriptionVersion.count({ where: { jobId: job.id } })) === 2, r.message);
    await pos.submitJobDescriptionAction({}, fd({ id: job.id }));
    await as("priya");
    r = await decide(job.id, "reject", "Keep on-call out");
    j = await prisma.jobProfile.findUniqueOrThrow({ where: { id: job.id } });
    check("Rejecting v2 keeps the job active on v1", !!r.ok && j.status === "ACTIVE" && j.version === 1);
    await as("vikram");
    r = (await pos.saveJobAction({}, fd({ id: job.id, title: `${TAG} Backend Engineer`, familyId: fam.id, levelId: lvl.id, summary: "Builds and operates APIs", responsibilities: "Design, build, run services", competencies: "Ownership, Communication, Mentoring", skills: "TypeScript, PostgreSQL" }))) as Res;
    check("Reworking the rejected v2 updates it in place", !!r.ok && (await prisma.jobDescriptionVersion.count({ where: { jobId: job.id } })) === 2);
    await pos.submitJobDescriptionAction({}, fd({ id: job.id }));
    const wd = await pendingFor(job.id);
    r = (await reqs.withdrawWorkforceRequestAction({}, fd({ id: wd.id }))) as Res;
    check("The requester can withdraw; v2 goes back to draft", !!r.ok && (await prisma.jobDescriptionVersion.findFirstOrThrow({ where: { jobId: job.id, version: 2 } })).status === "DRAFT");
    await pos.submitJobDescriptionAction({}, fd({ id: job.id }));
    await as("priya");
    r = await decide(job.id, "approve");
    j = await prisma.jobProfile.findUniqueOrThrow({ where: { id: job.id } });
    check("Approving v2 makes it current and retires v1", !!r.ok && j.version === 2 && j.summary === "Builds and operates APIs" && (await prisma.jobDescriptionVersion.findFirstOrThrow({ where: { jobId: job.id, version: 1 } })).status === "RETIRED");
    await as("vikram");
    check("Job catalogue search by competency", (await html(pages.jobs({ searchParams: sp({ q: "Mentoring" }) }))).includes(job.code));
    check("Job page shows both versions", (await html(pages.job({ params: sp({ id: job.id }) }))).includes("v2"));
    out = await csv(exportPos, "/positions/export?report=jobs");
    check("Jobs CSV", out.text.includes(job.code) && out.text.includes("Mentoring"));

    // =================================================================
    section("3. Positions");
    const base = { title: `${TAG} Backend Engineer`, jobId: job.id, departmentId: dept.id, locationId: location.id, costCenterId: cc?.id, payGradeId: g3.id, budgetStatus: "BUDGETED", fte: 1, isHeadcount: true, criticality: "HIGH", workMode: "HYBRID", vacancyReason: "NEW", skills: "TypeScript, PostgreSQL", competencies: "Ownership", effectiveFrom: iso(today) };
    r = (await pos.savePositionAction({}, fd({ ...base, budgetedAnnualSalary: 5_000_000 }))) as Res;
    check("A budget outside the pay grade's range is refused", r.ok === false && /range/.test(r.message ?? ""), r.message);
    const f1 = fd({ ...base, budgetedAnnualSalary: 1_500_000 });
    f1.append("allowedLocationIds", otherLocation.id);
    r = (await pos.savePositionAction({}, f1)) as Res;
    const p1 = await prisma.position.findUniqueOrThrow({ where: { id: r.values!.id } });
    check("Request a position → PROPOSED with a pending request", !!r.ok && p1.status === "PROPOSED" && p1.code.startsWith("POS-") && !!(await pendingFor(p1.id, "POSITION_CREATE")));
    check("…with location constraint, remote eligibility, skills and competencies", p1.allowedLocationIds[0] === otherLocation.id && p1.workMode === "HYBRID" && p1.skills.length === 2 && p1.criticality === "HIGH");
    await as("priya");
    r = await decide(p1.id, "approve");
    let p = await prisma.position.findUniqueOrThrow({ where: { id: p1.id } });
    check("Approve → VACANT, vacant since today, reason NEW", !!r.ok && p.status === "VACANT" && !!p.vacantSince && p.vacancyReason === "NEW");
    await as("vikram");
    check("Positions list search by control number", (await html(pages.positions({ searchParams: sp({ q: p1.code }) }))).includes(p1.code));
    check("Positions list filter by status", (await html(pages.positions({ searchParams: sp({ status: "VACANT", departmentId: dept.id }) }))).includes(p1.code));
    const detail = await html(pages.position({ params: sp({ id: p1.id }) }));
    check("Position page shows the posting readiness checklist", detail.includes("Job posting readiness") && detail.includes("Ready to recruit for."));
    r = (await pos.savePositionAction({}, fd({ ...base, id: p1.id, budgetedAnnualSalary: 1_600_000, criticality: "CRITICAL" }))) as Res;
    const upd = await prisma.auditLog.findFirst({ where: { tenantId: t, entityType: "Position", entityId: p1.id, action: "UPDATE" }, orderBy: { createdAt: "desc" } });
    check("Edit a position; the audit names the changed fields", !!r.ok && !!upd?.summary?.includes("criticality") && !!upd?.summary?.includes("budgetedAnnualSalary"), upd?.summary ?? "");
    const emps = await prisma.employee.findMany({ where: { tenantId: t, departmentId: dept.id, status: { in: ["CONFIRMED", "PROBATION"] } }, take: 2 });
    const empA = emps[0];
    r = (await pos.fillPositionAction({}, fd({ id: p1.id, employeeId: empA.id, startDate: iso(today) }))) as Res;
    p = await prisma.position.findUniqueOrThrow({ where: { id: p1.id } });
    check("Fill it → FILLED with an incumbency record", (!!r.ok && p.status === "FILLED" && p.incumbentEmployeeId === empA.id && (await prisma.positionIncumbency.count({ where: { positionId: p1.id } })) === 1) || /location/.test(r.message ?? ""), r.message);
    if (!r.ok) {
      // The employee sits elsewhere: the location constraint refused it, which is also correct; use a remote seat instead.
      await prisma.position.update({ where: { id: p1.id }, data: { workMode: "REMOTE" } });
      r = (await pos.fillPositionAction({}, fd({ id: p1.id, employeeId: empA.id }))) as Res;
      check("…a remote seat can be filled from anywhere", !!r.ok, r.message);
    }
    r = (await pos.vacatePositionAction({}, fd({ id: p1.id, vacancyReason: "TRANSFER" }))) as Res;
    p = await prisma.position.findUniqueOrThrow({ where: { id: p1.id } });
    const inc = await prisma.positionIncumbency.findFirstOrThrow({ where: { positionId: p1.id } });
    check("Vacate it → VACANT (transfer), incumbency closed", !!r.ok && p.status === "VACANT" && p.vacancyReason === "TRANSFER" && !!inc.endDate);
    r = (await pos.requestPositionChangeAction({}, fd({ id: p1.id, change: "freeze", reason: "Hiring pause" }))) as Res;
    await as("priya");
    await decide(p1.id, "approve");
    check("Freeze request approved → FROZEN", !!r.ok && (await prisma.position.findUniqueOrThrow({ where: { id: p1.id } })).status === "FROZEN");
    await as("vikram");
    r = (await pos.requestPositionChangeAction({}, fd({ id: p1.id, change: "freeze", reason: "again" }))) as Res;
    check("A frozen position cannot be frozen again", r.ok === false);
    await pos.requestPositionChangeAction({}, fd({ id: p1.id, change: "unfreeze", reason: "Budget released" }));
    await as("priya");
    await decide(p1.id, "approve");
    check("Unfreeze approved → VACANT", (await prisma.position.findUniqueOrThrow({ where: { id: p1.id } })).status === "VACANT");
    await as("vikram");
    r = (await pos.clonePositionAction({}, fd({ id: p1.id, count: 2, title: `${TAG} Backend Engineer II` }))) as Res;
    const clones = await prisma.position.findMany({ where: { tenantId: t, title: `${TAG} Backend Engineer II` } });
    check("Clone into 2 new position requests", !!r.ok && clones.length === 2 && clones.every((c) => c.status === "PROPOSED" && c.jobId === job.id));
    const bulk = fd({ criticality: "LOW", budgetChangePct: 10 });
    for (const c of clones) bulk.append("ids", c.id);
    r = (await pos.bulkUpdatePositionsAction({}, bulk)) as Res;
    const after = await prisma.position.findMany({ where: { id: { in: clones.map((c) => c.id) } } });
    check("Bulk update criticality and budget +10%", !!r.ok && after.every((c) => c.criticality === "LOW" && Number(c.budgetedAnnualSalary) === 1_760_000), r.message);
    await as("priya");
    for (const c of clones) await decide(c.id, "approve");
    await as("vikram");
    r = (await pos.requestPositionChangeAction({}, fd({ id: clones[1].id, change: "close", reason: "Not needed" }))) as Res;
    await as("priya");
    await decide(clones[1].id, "approve");
    check("Close a vacant position", !!r.ok && (await prisma.position.findUniqueOrThrow({ where: { id: clones[1].id } })).status === "CLOSED");
    await as("vikram");
    r = (await pos.raiseRequisitionForPositionAction({}, fd({ id: p1.id }))) as Res;
    p = await prisma.position.findUniqueOrThrow({ where: { id: p1.id } });
    if (p.requisitionId) made.requisitionIds.push(p.requisitionId);
    const req = p.requisitionId ? await prisma.requisition.findUnique({ where: { id: p.requisitionId } }) : null;
    check("Raise a requisition from the vacant position, linked to it", !!r.ok && !!req && req.departmentId === dept.id && req.status === "PENDING_APPROVAL" && req.justification?.includes(p.code) === true, r.message);
    r = (await pos.raiseRequisitionForPositionAction({}, fd({ id: p1.id }))) as Res;
    check("…only once while it is open", r.ok === false);
    // The nightly job vacates a seat whose incumbent has left.
    const leaver = await prisma.employee.create({ data: { tenantId: t, employeeNumber: `${TAG}L`, firstName: "Leaving", lastName: TAG, displayName: `Leaving ${TAG}`, dateOfJoining: new Date("2024-01-01"), departmentId: dept.id, locationId: location.id, status: "CONFIRMED" } });
    made.employeeIds.push(leaver.id);
    await prisma.position.update({ where: { id: clones[0].id }, data: { workMode: "REMOTE" } });
    r = (await pos.fillPositionAction({}, fd({ id: clones[0].id, employeeId: leaver.id }))) as Res;
    r = (await pos.fillPositionAction({}, fd({ id: p1.id, employeeId: leaver.id }))) as Res;
    check("One employee cannot hold two positions", r.ok === false && /already holds/.test(r.message ?? ""), r.message);
    await prisma.employee.update({ where: { id: leaver.id }, data: { status: "EXITED", lastWorkingDay: today } });
    const job1 = await svc.runWorkforceJob(t);
    p = await prisma.position.findUniqueOrThrow({ where: { id: clones[0].id } });
    check("Nightly job vacates the seat of an employee who left", job1.vacated >= 1 && p.status === "VACANT" && p.vacancyReason === "RESIGNATION" && p.incumbentEmployeeId === null);
    const reports = await html(pages.posReports());
    check("Reports: vacancy aging, headcount positions and reconciliation", reports.includes(p1.code) && reports.includes("Position-to-headcount reconciliation") && reports.includes(dept.name));
    out = await csv(exportPos, "/positions/export?report=positions&q=" + TAG);
    check("Positions CSV respects the search", out.text.includes(p1.code) && out.text.includes(clones[0].code) && out.text.split("\r\n").length === 4, String(out.text.split("\r\n").length));
    out = await csv(exportPos, "/positions/export?report=vacancy");
    check("Vacancy aging CSV", out.text.includes(p1.code));
    out = await csv(exportPos, "/positions/export?report=reconciliation");
    check("Reconciliation CSV", out.text.includes(dept.name));
    out = await csv(exportPos, "/positions/export?report=headcount");
    check("Headcount positions CSV", out.text.includes(dept.name));
    out = await csv(exportPos, "/positions/export?report=approvals");
    check("Position approvals CSV (approval history)", out.text.includes("Freeze position") && out.text.includes(p1.code));
    check("Lifecycle audit trail covers create → approve → fill → vacate → freeze", (await audits("Position", p1.id)) >= 8, String(await audits("Position", p1.id)));
    check("Exports are themselves audited", (await prisma.auditLog.count({ where: { tenantId: t, action: "EXPORT", entityType: "Position", createdAt: { gte: today } } })) >= 4);

    // =================================================================
    section("4. Workforce planning and budgeting");
    r = (await wfp.savePlanAction({}, fd({ name: `${TAG} Plan`, fiscalYear: fy, template: "GROWTH", notes: "FY plan" }))) as Res;
    const planId = r.values?.id ?? "";
    let plan = await prisma.workforcePlan.findUniqueOrThrow({ where: { id: planId } });
    check("Create a plan from a template; its assumptions apply", !!r.ok && Number(plan.attritionPct) === 15 && Number(plan.salaryIncreasePct) === 10);
    r = (await wfp.savePlanLineAction({}, fd({ planId, departmentId: dept.id, plannedHeadcount: 1, newHires: 2, avgAnnualSalary: 1_500_000, hireMonth: 4 }))) as Res;
    check("New hires cannot exceed the line's headcount", r.ok === false);
    r = (await wfp.savePlanLineAction({}, fd({ planId, departmentId: dept.id, locationId: location.id, jobId: job.id, plannedHeadcount: 1, newHires: 1, avgAnnualSalary: 1_500_000, hireMonth: 4 }))) as Res;
    check("Add a headcount line", !!r.ok);
    r = (await wfp.forecastPlanLinesAction({}, fd({ planId }))) as Res;
    const lines = await prisma.workforcePlanLine.findMany({ where: { planId } });
    const live = await svc.headcountActuals(t);
    const designLine = lines.find((l) => l.departmentId === dept2.id);
    const dl = live.get(dept2.id)!;
    check("Forecast fills other departments from live headcount and requisitions", !!r.ok && !!designLine && designLine.plannedHeadcount === dl.active + dl.preJoining + dl.openRequisitions, r.message);
    check("…replacement hires follow the attrition assumption", designLine?.replacementHires === svc.replacementHiresFor(dl.active, 15));
    const planHtml = await html(pages.plan({ params: sp({ id: planId }) }));
    check("Plan page: plan vs live headcount, calendar, location cost comparison", planHtml.includes("Plan vs live headcount") && planHtml.includes("Future headcount calendar") && planHtml.includes("Location cost comparison"));
    const hcRows = await svc.planHeadcount(t, planId);
    const pe = hcRows.find((h) => h.departmentId === dept.id)!;
    const liveActive = await prisma.employee.count({ where: { tenantId: t, departmentId: dept.id, status: { in: ["ONBOARDING", "PROBATION", "CONFIRMED", "NOTICE_PERIOD"] } } });
    check("Headcount actuals are counted from employee records", pe.active === liveActive && pe.planned === 1, `${pe.active} vs ${liveActive}`);
    r = (await wfp.submitPlanningAction({}, fd({ kind: "plan", id: planId }))) as Res;
    check("Submit the plan → PENDING_APPROVAL", !!r.ok && (await prisma.workforcePlan.findUniqueOrThrow({ where: { id: planId } })).status === "PENDING_APPROVAL");
    r = (await wfp.savePlanAction({}, fd({ id: planId, name: `${TAG} Plan`, fiscalYear: fy }))) as Res;
    check("A submitted plan cannot be edited", r.ok === false);
    check("Plan waits on the planning approvals page", (await html(pages.wfpApprovals())).includes(`${TAG} Plan`));
    await as("priya");
    r = await decide(planId, "approve");
    check("Approve the plan", !!r.ok && (await prisma.workforcePlan.findUniqueOrThrow({ where: { id: planId } })).status === "ACTIVE");
    await as("vikram");
    r = (await wfp.activatePlanAction({}, fd({ id: planId }))) as Res;
    check("Activate it for the year", !!r.ok && (await prisma.workforcePlan.findUniqueOrThrow({ where: { id: planId } })).isActive);
    r = (await pos.savePositionAction({}, fd({ ...base, title: `${TAG} Over plan`, budgetedAnnualSalary: 1_500_000 }))) as Res;
    check("Requesting a position beyond the active plan warns", !!r.ok && /beyond its workforce plan/.test(r.message ?? ""), r.message);
    const overPlanPos = r.values?.id;
    const rq = fd({ title: `${TAG} Engineer`, departmentId: dept.id, newHire: true, newPositions: 1, currency: "INR", salaryMin: 1200000, salaryMax: 1800000, salaryFrequency: "ANNUAL", description: "Build and run the product's backend services.", justification: "Smoke test" });
    r = (await hiring.raiseRequisitionAction({}, rq)) as Res;
    if (r.values?.id) made.requisitionIds.push(r.values.id);
    check("Raising a requisition beyond the plan warns too", !!r.ok && /beyond its workforce plan/.test(r.message ?? ""), `${r.message} ${JSON.stringify((r as { errors?: unknown }).errors ?? {})}`);
    check("Dashboard shows plans in force and the risk heatmap", (await html(pages.wfp({ searchParams: sp({ fy: String(fy) }) }))).includes("Workforce risk heatmap"));
    check("Plans list search", (await html(pages.wfp({ searchParams: sp({ fy: String(fy), q: TAG }) }))).includes(`${TAG} Plan`));
    r = (await wfp.createScenarioAction({}, fd({ planId, name: `${TAG} Scenario +50%`, headcountChangePct: 50, salaryIncreasePct: 12, attritionPct: 15 }))) as Res;
    const scen = await prisma.workforcePlan.findUniqueOrThrow({ where: { id: r.values!.id }, include: { lines: true } });
    const baseLines = await prisma.workforcePlanLine.findMany({ where: { planId } });
    check("Copy the plan as a scenario with headcount +50% and a 12% increment", !!r.ok && scen.isScenario && scen.baseplanId === planId && scen.lines.length === baseLines.length && Number(scen.salaryIncreasePct) === 12);
    const scenHtml = await html(pages.scenarios({ searchParams: sp({ base: planId }) }));
    check("Scenarios page compares cost side by side", scenHtml.includes(`${TAG} Scenario +50%`) && scenHtml.includes("Δ cost"));
    out = await csv(exportWfp, `/workforce-planning/export?report=scenarios&base=${planId}`);
    check("Scenario comparison CSV", out.text.includes(`${TAG} Scenario +50%`));
    r = (await wfp.submitPlanningAction({}, fd({ kind: "plan", id: scen.id }))) as Res;
    await as("priya");
    r = await decide(scen.id, "reject", "Too costly");
    check("Reject the scenario with a reason", !!r.ok && (await prisma.workforcePlan.findUniqueOrThrow({ where: { id: scen.id } })).status === "REJECTED");
    await as("vikram");
    r = (await wfp.budgetFromPlanAction({}, fd({ planId }))) as Res;
    const budget = await prisma.workforceBudget.findUniqueOrThrow({ where: { id: r.values!.id } });
    plan = await prisma.workforcePlan.findUniqueOrThrow({ where: { id: planId } });
    check("Build a budget from the plan's cost model", !!r.ok && Number(budget.salaryBudget) > 0 && budget.planId === planId);
    r = (await wfp.saveBudgetAction({}, fd({ id: budget.id, name: `${TAG} Budget`, fiscalYear: fy, salaryBudget: 50_000_000, benefitsBudget: 5_000_000, hiringBudget: 500_000, contractorBudget: 1_000_000 }))) as Res;
    check("Edit the draft budget", !!r.ok && Number((await prisma.workforceBudget.findUniqueOrThrow({ where: { id: budget.id } })).salaryBudget) === 50_000_000);
    await wfp.submitPlanningAction({}, fd({ kind: "budget", id: budget.id }));
    await as("priya");
    r = await decide(budget.id, "approve");
    check("Approve the budget", !!r.ok && (await prisma.workforceBudget.findUniqueOrThrow({ where: { id: budget.id } })).status === "ACTIVE");
    await as("vikram");
    r = (await wfp.saveBudgetAction({}, fd({ id: budget.id, name: `${TAG} Budget`, fiscalYear: fy, salaryBudget: 1 }))) as Res;
    check("An approved budget is locked", r.ok === false);
    r = (await wfp.reviseBudgetAction({}, fd({ id: budget.id }))) as Res;
    const v2 = await prisma.workforceBudget.findUniqueOrThrow({ where: { id: r.values!.id } });
    check("Revise → v2 draft, v1 superseded but kept", !!r.ok && v2.version === 2 && v2.previousId === budget.id && !(await prisma.workforceBudget.findUniqueOrThrow({ where: { id: budget.id } })).isCurrent);
    const actual = await svc.payrollActuals(t, fy);
    const direct = await prisma.payrollRunEmployee.aggregate({ where: { run: { tenantId: t, status: { in: ["LOCKED", "FINALIZED"] }, OR: svc.fiscalMonths(fy).map((m) => ({ year: m.year, month: m.month })) } }, _sum: { grossEarnings: true, employerCost: true } });
    check("Budget actuals come from locked/finalised payroll", Math.abs(actual.salary - Number(direct._sum.grossEarnings ?? 0)) < 0.01 && Math.abs(actual.employer - Number(direct._sum.employerCost ?? 0)) < 0.01, `${actual.salary}`);
    const budgetsHtml = await html(pages.budgets({ searchParams: sp({ fy: String(fy), history: "1" }) }));
    check("Budgets page shows budget vs actual and both versions", budgetsHtml.includes(`${TAG} Budget`) && budgetsHtml.includes("v2") && budgetsHtml.includes("Salary (gross pay)"));
    out = await csv(exportWfp, `/workforce-planning/export?report=budgets&fy=${fy}`);
    check("Budgets CSV with actuals", out.text.includes(`${TAG} Budget`) && out.text.includes(String(actual.salary)));
    r = (await wfp.saveCapacityPlanAction({}, fd({ name: `${TAG} Capacity`, departmentId: dept.id, periodStart: iso(today), periodEnd: iso(new Date(today.getTime() + 90 * DAY)) }))) as Res;
    const capId = r.values!.id;
    r = (await wfp.saveCapacityLineAction({}, fd({ planId: capId, role: "Software Engineer", demandFte: 10 }))) as Res;
    const supply = await prisma.employee.count({ where: { tenantId: t, departmentId: dept.id, jobTitleName: { equals: "Software Engineer", mode: "insensitive" }, status: { in: ["ONBOARDING", "PROBATION", "CONFIRMED", "NOTICE_PERIOD"] } } });
    const capHtml = await html(pages.capacity({ searchParams: sp({ q: TAG }) }));
    check("Capacity plan: demand vs live supply", !!r.ok && capHtml.includes(`${TAG} Capacity`) && capHtml.includes(`>${supply}<`), String(supply));
    await wfp.submitPlanningAction({}, fd({ kind: "capacity", id: capId }));
    await as("priya");
    r = await decide(capId, "approve");
    check("Approve the capacity plan", !!r.ok && (await prisma.capacityPlan.findUniqueOrThrow({ where: { id: capId } })).status === "ACTIVE");
    await as("vikram");
    out = await csv(exportWfp, "/workforce-planning/export?report=capacity");
    check("Capacity CSV", out.text.includes(`${TAG} Capacity`) && out.text.includes("Software Engineer"));
    out = await csv(exportWfp, `/workforce-planning/export?report=plans&fy=${fy}`);
    check("Plans CSV", out.text.includes(`${TAG} Plan`));
    out = await csv(exportWfp, `/workforce-planning/export?report=package&fy=${fy}`);
    check("Plan export package: lines, live headcount and calendar", out.text.includes("Live headcount") && out.text.includes("Calendar") && out.text.includes(`${TAG} Plan`));
    out = await csv(exportWfp, "/workforce-planning/export?report=approvals");
    check("Planning approvals CSV", out.text.includes("Approve workforce plan"));
    check("Workforce budget audit trail", (await audits("WorkforceBudget", budget.id)) >= 3 && (await audits("WorkforcePlan", planId)) >= 4);

    // =================================================================
    section("5. Contingent workforce");
    r = (await cw.saveVendorAction({}, fd({ name: `${TAG} Staffing`, gstin: "29ABCDE1234F1X5" }))) as Res;
    check("An invalid GSTIN is refused", r.ok === false);
    r = (await cw.saveVendorAction({}, fd({ name: `${TAG} Staffing`, code: "TS", gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F", contactName: "Ravi", email: "ravi@staffing.test" }))) as Res;
    const vendorId = r.values!.id;
    check("Add a vendor (onboarding)", !!r.ok && (await prisma.contingentVendor.findUniqueOrThrow({ where: { id: vendorId } })).status === "ONBOARDING");
    r = (await cw.setVendorStatusAction({}, fd({ id: vendorId, status: "ACTIVE" }))) as Res;
    check("It cannot be activated before onboarding", r.ok === false && /onboarding/i.test(r.message ?? ""));
    const cl = fd({ id: vendorId });
    for (const c of svc.VENDOR_CHECKLIST) cl.append("items", c.key);
    await cw.saveVendorChecklistAction({}, cl);
    r = (await cw.setVendorStatusAction({}, fd({ id: vendorId, status: "ACTIVE" }))) as Res;
    check("…nor without its compliance documents", r.ok === false && /MSA/.test(r.message ?? ""), r.message);
    for (const docType of ["MSA", "GST_CERT", "PAN"]) await cw.addVendorDocumentAction({}, fd({ vendorId, docType, number: `${docType}-1` }));
    r = (await cw.addVendorDocumentAction({}, fd({ vendorId, docType: "INSURANCE", number: "INS-1", validUntil: iso(new Date(today.getTime() + 20 * DAY)) }))) as Res;
    r = (await cw.setVendorStatusAction({}, fd({ id: vendorId, status: "ACTIVE" }))) as Res;
    check("With checklist and documents it activates", !!r.ok && (await prisma.contingentVendor.findUniqueOrThrow({ where: { id: vendorId } })).status === "ACTIVE", r.message);
    check("Vendor page flags the insurance expiring soon", (await html(pages.vendor({ params: sp({ id: vendorId }) }))).includes("expiring"));
    r = (await cw.saveWorkerAction({}, fd({ firstName: "Arjun", lastName: TAG, email: `arjun.${TAG}@contractor.test`, workerKind: "VENDOR_WORKER", engagementType: "TIME_AND_MATERIAL", skills: "React, Node" }))) as Res;
    check("A vendor worker needs its agency", r.ok === false);
    r = (await cw.saveWorkerAction({}, fd({ firstName: "Arjun", lastName: TAG, email: `arjun.${TAG}@contractor.test`, workerKind: "VENDOR_WORKER", engagementType: "TIME_AND_MATERIAL", vendorId, skills: "React, Node", departmentId: dept.id, managerEmployeeId: snehaEmp.id }))) as Res;
    const workerId = r.values!.id;
    let w = await prisma.contingentWorker.findUniqueOrThrow({ where: { id: workerId } });
    check("Add a vendor worker → pending engagement approval (not an employee)", !!r.ok && w.status === "PENDING_APPROVAL" && w.code.startsWith("CW-") && (await prisma.employee.count({ where: { tenantId: t, lastName: TAG, firstName: "Arjun" } })) === 0);
    r = (await cw.saveWorkerAction({}, fd({ firstName: "Kavya", lastName: TAG, email: `kavya.${TAG}@contractor.test`, workerKind: "CONTRACTOR", engagementType: "SOW", pan: "ABCDE1234G", departmentId: dept2.id }))) as Res;
    const contractorId = r.values!.id;
    check("Add an independent contractor", !!r.ok);
    await as("priya");
    await decide(workerId, "approve");
    await decide(contractorId, "approve");
    w = await prisma.contingentWorker.findUniqueOrThrow({ where: { id: workerId } });
    check("Approve both engagements → ACTIVE", w.status === "ACTIVE" && (await prisma.contingentWorker.findUniqueOrThrow({ where: { id: contractorId } })).status === "ACTIVE");
    await as("vikram");
    r = (await cw.saveWorkerAction({}, fd({ id: workerId, firstName: "Arjun", lastName: TAG, email: `arjun.${TAG}@contractor.test`, phone: "9876543210", workerKind: "VENDOR_WORKER", engagementType: "TIME_AND_MATERIAL", vendorId, skills: "React, Node, AWS", departmentId: dept.id, managerEmployeeId: snehaEmp.id }))) as Res;
    check("Maintain the worker profile", !!r.ok && (await prisma.contingentWorker.findUniqueOrThrow({ where: { id: workerId } })).skills.includes("AWS"));
    r = (await cw.saveRateCardAction({}, fd({ role: `${TAG} Developer`, vendorId, rateType: "HOURLY", rate: 1500, effectiveFrom: iso(new Date(today.getTime() - 365 * DAY)) }))) as Res;
    check("Add a vendor rate card", !!r.ok);
    r = (await cw.saveRateCardAction({}, fd({ role: `${TAG} Developer`, vendorId, rateType: "HOURLY", rate: 1600, effectiveFrom: iso(today) }))) as Res;
    check("An overlapping rate is refused (effective dating)", r.ok === false);
    const rc = await prisma.contractorRateCard.findFirstOrThrow({ where: { tenantId: t, role: `${TAG} Developer` } });
    r = (await cw.endRateCardAction({}, fd({ id: rc.id, effectiveTo: iso(new Date(today.getTime() - 61 * DAY)) }))) as Res;
    r = (await cw.saveRateCardAction({}, fd({ role: `${TAG} Developer`, vendorId, rateType: "HOURLY", rate: 1600, effectiveFrom: iso(new Date(today.getTime() - 60 * DAY)) }))) as Res;
    check("End the old rate and start a new one", !!r.ok);
    r = (await cw.saveAssignmentAction({}, fd({ workerId, role: `${TAG} Developer`, departmentId: dept.id, managerEmployeeId: snehaEmp.id, startDate: iso(new Date(today.getTime() - 30 * DAY)), endDate: iso(new Date(today.getTime() + 10 * DAY)), rateType: "HOURLY", poNumber: `PO-${TAG}`, poAmount: 900000, sowReference: `SOW-${TAG}`, sowDescription: "Checkout rebuild" }))) as Res;
    const aId = r.values!.id;
    let a = await prisma.contractAssignment.findUniqueOrThrow({ where: { id: aId } });
    check("A contract without a rate takes the rate card in force on its start date", !!r.ok && Number(a.rate) === 1600 && a.status === "PENDING_APPROVAL" && a.poNumber === `PO-${TAG}`, `${a.rate}`);
    await as("priya");
    r = await decide(aId, "approve");
    check("Approve the contract → ACTIVE", !!r.ok && (await prisma.contractAssignment.findUniqueOrThrow({ where: { id: aId } })).status === "ACTIVE");
    await as("vikram");
    r = (await cw.saveAssignmentAction({}, fd({ workerId, assignmentId: aId, role: `${TAG} Developer`, departmentId: dept.id, managerEmployeeId: snehaEmp.id, startDate: iso(today), endDate: iso(today), rateType: "HOURLY", rate: 1, poNumber: `PO-${TAG}-B`, poAmount: 900000, sowReference: `SOW-${TAG}`, sowDescription: "Checkout rebuild" }))) as Res;
    a = await prisma.contractAssignment.findUniqueOrThrow({ where: { id: aId } });
    check("A running contract's PO can change; its rate and dates cannot", !!r.ok && a.poNumber === `PO-${TAG}-B` && Number(a.rate) === 1600);
    r = (await cw.savePaymentProfileAction({}, fd({ workerId, payee: "WORKER", rateType: "HOURLY", tdsSection: "194J", accountNumber: "123456789", ifsc: "BAD" }))) as Res;
    check("A bad IFSC is refused", r.ok === false);
    r = (await cw.savePaymentProfileAction({}, fd({ workerId, payee: "WORKER", rateType: "HOURLY", gstRegistered: true, gstin: "29ABCDE1234F1Z5", gstRatePct: 18, tdsSection: "194J", tdsRatePct: 10, bankName: "HDFC", accountNumber: "123456789012", ifsc: "HDFC0001234", accountHolder: "Arjun" }))) as Res;
    check("Set up the payment profile → pending verification", !!r.ok && (await prisma.contractorPaymentProfile.findUniqueOrThrow({ where: { workerId } })).status === "PENDING_APPROVAL");
    await as("priya");
    r = await decide(workerId, "approve", undefined, "PAYMENT_PROFILE");
    check("Verify it", !!r.ok && (await prisma.contractorPaymentProfile.findUniqueOrThrow({ where: { workerId } })).status === "VERIFIED");
    await as("vikram");
    r = (await cw.savePaymentProfileAction({}, fd({ workerId, payee: "WORKER", rateType: "HOURLY", tdsSection: "194J", bankName: "ICICI", accountNumber: "999988887777", ifsc: "ICIC0001111" }))) as Res;
    const ppAudit = await prisma.auditLog.findFirst({ where: { tenantId: t, entityId: workerId, summary: { contains: "payment profile" } }, orderBy: { createdAt: "desc" } });
    check("Changing bank details needs verification again; the audit masks the account", !!r.ok && (await prisma.contractorPaymentProfile.findUniqueOrThrow({ where: { workerId } })).status === "PENDING_APPROVAL" && JSON.stringify(ppAudit?.newValue).includes("••••7777") && !JSON.stringify(ppAudit?.newValue).includes("999988887777"));
    const tsStart = new Date(today.getTime() - 14 * DAY), tsEnd = new Date(today.getTime() - 8 * DAY);
    r = (await cw.submitContractorTimesheetAction({}, fd({ assignmentId: aId, periodStart: iso(tsStart), periodEnd: iso(tsEnd), hours: 40, daysPresent: 5 }))) as Res;
    const ts = await prisma.contractorTimesheet.findFirstOrThrow({ where: { assignmentId: aId } });
    check("Log a timesheet: 40 h × ₹1,600 = ₹64,000, with days present", !!r.ok && Number(ts.amount) === 64000 && Number(ts.daysPresent) === 5);
    r = (await cw.decideContractorTimesheetAction({}, fd({ id: ts.id, decision: "approve" }))) as Res;
    check("Whoever logged it cannot approve it", r.ok === false);
    await as("sneha");
    r = (await cw.decideContractorTimesheetAction({}, fd({ id: ts.id, decision: "approve" }))) as Res;
    check("The contract's manager approves it", !!r.ok && (await prisma.contractorTimesheet.findUniqueOrThrow({ where: { id: ts.id } })).status === "APPROVED", r.message);
    await as("vikram");
    r = (await cw.submitContractorExpenseAction({}, fd({ assignmentId: aId, date: iso(today), category: "Travel", amount: 2500, description: "Client visit" }))) as Res;
    const ex = await prisma.contractorExpense.findFirstOrThrow({ where: { assignmentId: aId } });
    await as("priya");
    r = (await cw.decideContractorExpenseAction({}, fd({ id: ex.id, decision: "approve" }))) as Res;
    check("Log and approve a contractor expense", !!r.ok && (await prisma.contractorExpense.findUniqueOrThrow({ where: { id: ex.id } })).status === "APPROVED");
    await as("vikram");
    r = (await cw.addMilestoneAction({}, fd({ assignmentId: aId, name: "Design sign-off", dueDate: iso(today), amount: 50000 }))) as Res;
    const ms = await prisma.sowMilestone.findFirstOrThrow({ where: { assignmentId: aId } });
    r = (await cw.setMilestoneStatusAction({}, fd({ id: ms.id, status: "PAID" }))) as Res;
    check("Milestones cannot skip completion", r.ok === false);
    await cw.setMilestoneStatusAction({}, fd({ id: ms.id, status: "COMPLETED" }));
    r = (await cw.setMilestoneStatusAction({}, fd({ id: ms.id, status: "PAID" }))) as Res;
    check("SOW milestone: pending → completed → paid", !!r.ok && (await prisma.sowMilestone.findUniqueOrThrow({ where: { id: ms.id } })).status === "PAID");
    const { contingentSpendTotal } = await import("../apps/web/src/lib/workforce");
    const spentTotal = await contingentSpendTotal(t, fy, null);
    check("Contingent spend totals approved timesheets, expenses and paid milestones", spentTotal >= 64000 + 2500 + 50000, String(spentTotal));
    out = await csv(exportCw, "/contingent/export?report=spend");
    check("Spend CSV has the timesheet, expense and milestone", out.text.includes("Timesheet") && out.text.includes("Expense") && out.text.includes("Milestone") && out.text.includes("64000") && out.text.includes("2500") && out.text.includes("50000"));
    const dash = await html(pages.cw());
    check("Dashboard: expiry alerts, compliance, scorecards and spend", dash.includes(`${TAG} Developer`) && dash.includes("Vendor scorecards") && dash.includes("Contingent spend analytics") && dash.includes(`${TAG} Staffing`));
    const job2 = await svc.runWorkforceJob(t);
    a = await prisma.contractAssignment.findUniqueOrThrow({ where: { id: aId } });
    check("Nightly job alerts once on a contract ending within 30 days", job2.alerted >= 1 && !!a.alertedAt && (await prisma.notification.count({ where: { tenantId: t, kind: "CONTINGENT", title: { contains: w.code } } })) >= 1);
    check("…and only once", (await svc.runWorkforceJob(t)).alerted === 0);
    r = (await cw.requestContractChangeAction({}, fd({ id: aId, change: "extend", newEndDate: iso(new Date(today.getTime() + 60 * DAY)), newRate: 1700, reason: "Phase 2" }))) as Res;
    check("Request an extension", !!r.ok);
    const ext = await pendingFor(aId, "CONTRACT_EXTEND");
    r = (await cw.revisePendingContractChangeAction({}, fd({ requestId: ext.id, date: iso(new Date(today.getTime() + 90 * DAY)), reason: "Phase 2 and 3" }))) as Res;
    check("Reschedule the pending extension", !!r.ok && String((await prisma.workforceRequest.findUniqueOrThrow({ where: { id: ext.id } })).payload && JSON.stringify((await prisma.workforceRequest.findUniqueOrThrow({ where: { id: ext.id } })).payload)).includes(iso(new Date(today.getTime() + 90 * DAY))));
    await as("priya");
    r = await decide(aId, "approve", undefined, "CONTRACT_EXTEND");
    a = await prisma.contractAssignment.findUniqueOrThrow({ where: { id: aId } });
    check("Approve → new end date and rate, extension counted, alert re-armed", !!r.ok && iso(a.endDate) === iso(new Date(today.getTime() + 90 * DAY)) && Number(a.rate) === 1700 && a.extensions === 1 && a.alertedAt === null);
    await as("vikram");
    r = (await cw.requestContractorAccessAction({}, fd({ workerId, system: "GitHub", level: "STANDARD" }))) as Res;
    const acc = await prisma.contractorAccess.findFirstOrThrow({ where: { workerId } });
    await as("priya");
    await decide(acc.id, "approve");
    check("Access request approved → GRANTED", !!r.ok && (await prisma.contractorAccess.findUniqueOrThrow({ where: { id: acc.id } })).status === "GRANTED");
    await as("sneha");
    r = (await cw.addContractorFeedbackAction({}, fd({ workerId, rating: 4, comment: "Solid delivery" }))) as Res;
    check("The manager gives performance feedback", !!r.ok);
    await as("meera");
    r = (await cw.addContractorFeedbackAction({}, fd({ workerId, rating: 1 }))) as Res;
    check("…someone unrelated cannot", r.ok === false);
    await as("vikram");
    const workerHtml = await html(pages.worker({ params: sp({ id: workerId }) }));
    const wantWorker = [`PO-${TAG}-B`, `SOW-${TAG}`, "Timesheets", "Payment profile", "Contractor audit history"];
    check("Worker page: contract, PO, SOW, timesheets, payment profile, audit history", wantWorker.every((x) => workerHtml.includes(x)), wantWorker.filter((x) => !workerHtml.includes(x)).join(", "));
    check("Workers list search by skill and PO", (await html(pages.workers({ searchParams: sp({ q: `PO-${TAG}` }) }))).includes(w.code) && (await html(pages.workers({ searchParams: sp({ q: "AWS" }) }))).includes(w.code));
    check("Vendors, rate cards and approvals pages render", (await html(pages.vendors({ searchParams: sp({ q: TAG }) }))).includes(`${TAG} Staffing`) && (await html(pages.rates({ searchParams: sp({ q: TAG }) }))).includes(`${TAG} Developer`) && (await html(pages.cwApprovals())).includes("Extend contract"));
    // Contract end with offboarding: ends today, so it applies on approval.
    r = (await cw.requestContractChangeAction({}, fd({ id: aId, change: "end", endDate: iso(today), reason: "Project closed" }))) as Res;
    await as("priya");
    r = await decide(aId, "approve", undefined, "CONTRACT_END");
    a = await prisma.contractAssignment.findUniqueOrThrow({ where: { id: aId } });
    w = await prisma.contingentWorker.findUniqueOrThrow({ where: { id: workerId } });
    check("Approve the contract end → ENDED; access revoked; worker offboarded", !!r.ok && a.status === "ENDED" && a.endReason === "Project closed" && w.status === "ENDED" && (await prisma.contractorAccess.findUniqueOrThrow({ where: { id: acc.id } })).status === "REVOKED");
    await as("vikram");
    // Expired contract ended by the nightly job.
    r = (await cw.saveAssignmentAction({}, fd({ workerId: contractorId, role: "Design consultant", rateType: "MONTHLY", rate: 150000, startDate: iso(new Date(today.getTime() - 60 * DAY)), endDate: iso(new Date(today.getTime() - 1 * DAY)) }))) as Res;
    const a2 = r.values!.id;
    await as("priya");
    await decide(a2, "approve");
    const job3 = await svc.runWorkforceJob(t);
    check("Nightly job ends a contract past its end date", job3.ended >= 1 && (await prisma.contractAssignment.findUniqueOrThrow({ where: { id: a2 } })).status === "ENDED");
    // Conversion to employee.
    await as("vikram");
    r = (await cw.saveAssignmentAction({}, fd({ workerId: contractorId, role: "Design consultant", rateType: "MONTHLY", rate: 150000, startDate: iso(today), endDate: iso(new Date(today.getTime() + 120 * DAY)) }))) as Res;
    check("An ended worker cannot take a new contract", r.ok === false);
    await prisma.contingentWorker.update({ where: { id: contractorId }, data: { status: "ACTIVE" } });
    r = (await cw.saveAssignmentAction({}, fd({ workerId: contractorId, role: "Design consultant", rateType: "MONTHLY", rate: 150000, startDate: iso(today), endDate: iso(new Date(today.getTime() + 120 * DAY)) }))) as Res;
    await as("priya");
    await decide(r.values!.id, "approve");
    await as("vikram");
    r = (await cw.requestConversionAction({}, fd({ workerId: contractorId, reason: "Strong performer" }))) as Res;
    const convFd = { workerId: contractorId, legalEntityId: entity.id, locationId: location.id, dateOfJoining: iso(today), workEmail: `kavya.${TAG}@acme.test`, departmentId: dept2.id };
    r = (await cw.convertContractorAction({}, fd(convFd))) as Res;
    check("Conversion needs approval first", r.ok === false && /not been approved/.test(r.message ?? ""));
    await as("priya");
    await decide(contractorId, "approve", undefined, "CONVERSION");
    await as("vikram");
    r = (await cw.convertContractorAction({}, fd(convFd))) as Res;
    const newEmp = await prisma.employee.findFirst({ where: { tenantId: t, workEmail: `kavya.${TAG}@acme.test` } });
    if (newEmp) made.employeeIds.push(newEmp.id);
    const kav = await prisma.contingentWorker.findUniqueOrThrow({ where: { id: contractorId } });
    check("Convert → an employee record; worker CONVERTED and contracts ended", !!r.ok && !!newEmp && kav.status === "CONVERTED" && kav.convertedEmployeeId === newEmp.id && (await prisma.contractAssignment.count({ where: { workerId: contractorId, status: "ACTIVE" } })) === 0, r.message);
    for (const [report, needle] of [["workers", w.code], ["assignments", `PO-${TAG}-B`], ["vendors", `${TAG} Staffing`], ["rate-cards", `${TAG} Developer`], ["approvals", "Convert contractor to employee"], ["expiring", "Worker"]] as const) {
      out = await csv(exportCw, `/contingent/export?report=${report}`);
      check(`Contingent ${report} CSV`, out.status === 200 && out.text.includes(needle));
    }
    check("Contractor audit history is complete", (await audits("ContingentWorker", workerId)) >= 6 && (await audits("ContractAssignment", aId)) >= 5);

    // =================================================================
    section("6. Tenant isolation");
    const rival = await prisma.tenant.create({ data: { subdomain: `rival-${TAG}`, name: "Rival" } });
    made.rivalTenantId = rival.id;
    const rPos = await prisma.position.create({ data: { tenantId: rival.id, code: "POS-0001", title: "Rival seat", status: "VACANT", effectiveFrom: today } });
    const rReq = await prisma.workforceRequest.create({ data: { tenantId: rival.id, kind: "POSITION_FREEZE", entityType: "Position", entityId: rPos.id, label: "Rival", requestedBy: "someone" } });
    const rWorker = await prisma.contingentWorker.create({ data: { tenantId: rival.id, code: "CW-0001", firstName: "Rival", lastName: "Worker", status: "ACTIVE" } });
    r = (await reqs.decideWorkforceRequestAction({}, fd({ id: rReq.id, decision: "approve" }))) as Res;
    check("Cannot decide another company's request", r.ok === false && (await prisma.position.findUniqueOrThrow({ where: { id: rPos.id } })).status === "VACANT");
    r = (await pos.fillPositionAction({}, fd({ id: rPos.id, employeeId: empA.id }))) as Res;
    check("Cannot fill another company's position", r.ok === false);
    r = (await cw.requestConversionAction({}, fd({ workerId: rWorker.id, reason: "x" }))) as Res;
    check("Cannot act on another company's contractor", r.ok === false);
    check("Another company's position page is not found", await denied(() => pages.position({ params: sp({ id: rPos.id }) })));
    out = await csv(exportPos, "/positions/export?report=positions");
    check("Exports never include another company's rows", !out.text.includes("Rival seat"));
    r = (await pos.savePositionAction({}, fd({ ...base, title: `${TAG} cross`, budgetedAnnualSalary: 1_500_000, reportsToId: rPos.id }))) as Res;
    check("Cannot link a position to another company's position", r.ok === false);
    await prisma.tenant.delete({ where: { id: rival.id } });
    made.rivalTenantId = "";
    check("Deleting a company removes its workforce rows", (await prisma.position.count({ where: { tenantId: rival.id } })) + (await prisma.contingentWorker.count({ where: { tenantId: rival.id } })) + (await prisma.workforceRequest.count({ where: { tenantId: rival.id } })) === 0);
    void overPlanPos;
  } finally {
    // -----------------------------------------------------------------
    //  Clean up so repeat runs stay deterministic.
    if (made.rivalTenantId) await prisma.tenant.delete({ where: { id: made.rivalTenantId } }).catch(() => null);
    const positions = await prisma.position.findMany({ where: { tenantId: t, title: { startsWith: TAG } }, select: { id: true, requisitionId: true } });
    const workers = await prisma.contingentWorker.findMany({ where: { tenantId: t, lastName: TAG }, select: { id: true, assignments: { select: { id: true } }, accessRequests: { select: { id: true } } } });
    const plans = await prisma.workforcePlan.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
    const budgets = await prisma.workforceBudget.findMany({ where: { tenantId: t, OR: [{ name: { startsWith: TAG } }, { planId: { in: plans.map((p) => p.id) } }] }, select: { id: true } });
    const caps = await prisma.capacityPlan.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
    const fams = await prisma.jobFamily.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
    const lvls = await prisma.jobLevel.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
    const jobs = await prisma.jobProfile.findMany({ where: { tenantId: t, title: { startsWith: TAG } }, select: { id: true } });
    const vendors = await prisma.contingentVendor.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
    const entityIds = [...positions, ...workers, ...workers.flatMap((w) => w.assignments), ...workers.flatMap((w) => w.accessRequests), ...plans, ...budgets, ...caps, ...fams, ...lvls, ...jobs, ...vendors].map((x) => x.id);
    await prisma.workforceRequest.deleteMany({ where: { tenantId: t, entityId: { in: entityIds } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: t, entityId: { in: entityIds } } });
    await prisma.position.deleteMany({ where: { id: { in: positions.map((p) => p.id) } } });
    await prisma.contractorRateCard.deleteMany({ where: { tenantId: t, role: { startsWith: TAG } } });
    await prisma.contingentWorker.deleteMany({ where: { id: { in: workers.map((w) => w.id) } } });
    await prisma.contingentVendor.deleteMany({ where: { id: { in: vendors.map((v) => v.id) } } });
    await prisma.workforceBudget.deleteMany({ where: { id: { in: budgets.map((b) => b.id) } } });
    await prisma.workforcePlan.updateMany({ where: { id: { in: plans.map((p) => p.id) } }, data: { baseplanId: null } });
    await prisma.workforcePlan.deleteMany({ where: { id: { in: plans.map((p) => p.id) } } });
    await prisma.capacityPlan.deleteMany({ where: { id: { in: caps.map((c) => c.id) } } });
    await prisma.jobProfile.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
    await prisma.jobFamily.updateMany({ where: { id: { in: fams.map((f) => f.id) } }, data: { parentId: null } });
    await prisma.jobFamily.deleteMany({ where: { id: { in: fams.map((f) => f.id) } } });
    await prisma.jobLevel.deleteMany({ where: { id: { in: lvls.map((l) => l.id) } } });
    const reqIds = [...made.requisitionIds, ...positions.map((p) => p.requisitionId).filter((x): x is string => !!x)];
    await prisma.requisition.deleteMany({ where: { tenantId: t, id: { in: reqIds } } });
    for (const id of made.employeeIds) {
      await prisma.employee.delete({ where: { id } }).catch(async () => {
        await prisma.employee.update({ where: { id }, data: { status: "EXITED" } }).catch(() => null);
      });
    }
    await prisma.user.deleteMany({ where: { tenantId: t, email: { contains: TAG } } });
    if (seriesBefore) await prisma.employeeNumberSeries.update({ where: { id: seriesBefore.id }, data: { nextNumber: seriesBefore.nextNumber } });
    await prisma.notification.deleteMany({ where: { tenantId: t, title: { contains: TAG } } });
  }
  report("Workforce: positions, planning, contingent");
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
