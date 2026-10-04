/**
 * Join depth: preboarding, onboarding, background verification, shift &
 * roster operations, holidays & calendars and overtime rules — end to end
 * through the server actions, the generic workflow engine, the pages and the
 * CSV exports.
 *   1. Preboarding: templates, the hire's plan, tasks (policy, location,
 *      reviewed tasks), new-hire forms, pre-joining messages with approval,
 *      manager introduction, provisioning, reminders, exports.
 *   2. Onboarding: plan sign-off, task hand-over and escalation, the journey
 *      designer and revision history, buddies, orientation sessions,
 *      30/60/90-day milestones, the completion certificate, insights.
 *   3. Background verification: vendors, packages, a case with identity,
 *      employment and education checks, adverse findings, recheck, evidence,
 *      result approval and amendment, consent, exports.
 *   4. Shifts & roster: swaps (peer, marketplace, approval), preferences,
 *      open shifts, staffing rules, roster publication, shift library, split
 *      shifts, workweek and shift-cycle changes, exports.
 *   5. Holidays: day types, regional calendars through versioned revisions
 *      with approval, import, count validation, rules, shutdowns, the
 *      exception queue, calendar assignment, exports.
 *   6. Overtime: rules with tiers, windows and caps (approved), timing
 *      rules, cap exceptions, alerts, comp-off reminders, reconciliation.
 *
 * Everything it creates is tagged "Smoke JD" or removed by time at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const TAG = "Smoke JD";
type AS = { ok?: boolean; message?: string };

function multi(values: Record<string, string | string[] | boolean | number | null | undefined>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "boolean") { if (v) f.set(k, "on"); continue; }
    for (const x of Array.isArray(v) ? v : [v]) f.append(k, String(x));
  }
  return f;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utcToday = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

async function main() {
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  async function resolve(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) return Promise.all(node.map(resolve));
    if (node instanceof Promise) return resolve(await node);
    if (!React.isValidElement(node)) return node;
    const el = node as React.ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolve(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    const props: Record<string, unknown> = {};
    let children: unknown = undefined;
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k === "children") children = await resolve(v);
      else props[k] = React.isValidElement(v) ? await resolve(v) : v;
    }
    if (children === undefined) return React.cloneElement(el, props as never);
    return Array.isArray(children) ? React.cloneElement(el, props as never, ...(children as React.ReactNode[])) : React.cloneElement(el, props as never, children as React.ReactNode);
  }
  const html = async (page: unknown) => renderToStaticMarkup((await resolve(await page)) as Parameters<typeof renderToStaticMarkup>[0]);
  const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

  const pre = await import("../apps/web/src/app/actions/join-preboarding");
  const onb = await import("../apps/web/src/app/actions/join-onboarding");
  const bgv = await import("../apps/web/src/app/actions/join-bgv");
  const ros = await import("../apps/web/src/app/actions/join-roster");
  const hol = await import("../apps/web/src/app/actions/join-holidays");
  const ot = await import("../apps/web/src/app/actions/join-overtime");
  const rosterAct = await import("../apps/web/src/app/actions/roster");
  const lc = await import("../apps/web/src/app/actions/lifecycle");
  const tr = await import("../apps/web/src/app/actions/time-requests");
  const wfAct = await import("../apps/web/src/app/actions/workflows");
  const svc = await import("@keka/services");
  const { NextRequest } = await import("next/server");
  const onbExport = await import("../apps/web/src/app/(app)/onboarding/export/route");
  const opsExport = await import("../apps/web/src/app/(app)/time/ops-export/route");
  const Desk = (await import("../apps/web/src/app/(app)/onboarding/preboarding/[section]/page")).default;
  const Welcome = (await import("../apps/web/src/app/(app)/me/onboarding/page")).default;
  const People = (await import("../apps/web/src/app/(app)/onboarding/people/page")).default;
  const Insights = (await import("../apps/web/src/app/(app)/onboarding/insights/page")).default;
  const Designer = (await import("../apps/web/src/app/(app)/onboarding/templates/[id]/page")).default;
  const Certificate = (await import("../apps/web/src/app/(app)/onboarding/certificate/[id]/page")).default;
  const JourneyPage = (await import("../apps/web/src/app/(app)/onboarding/[id]/page")).default;
  const Verification = (await import("../apps/web/src/app/(app)/onboarding/verification/page")).default;
  const CasePage = (await import("../apps/web/src/app/(app)/onboarding/verification/[id]/page")).default;
  const MyShifts = (await import("../apps/web/src/app/(app)/me/shifts/page")).default;
  const RosterOps = (await import("../apps/web/src/app/(app)/attendance/roster/ops/page")).default;
  const Holidays = (await import("../apps/web/src/app/(app)/time/holidays/page")).default;
  const OtRules = (await import("../apps/web/src/app/(app)/time/overtime/rules/page")).default;

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const emp = (who: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: t, user: { email: `${who}@acme.test` } } });
  const as = (who: string) => signInAs(`${who}@acme.test`);
  const ok = (label: string, r: AS, detail = "") => { check(label, !!r.ok, `${r.message ?? ""}${detail ? ` ${detail}` : ""}`); return !!r.ok; };
  const refused = (label: string, r: AS, needle?: RegExp) => check(label, !r.ok && (!needle || needle.test(r.message ?? "")), r.message ?? "");
  const csvOnb = async (q: string) => { const r = await onbExport.GET(new NextRequest(`http://acme.localhost/onboarding/export?${q}`)); return { status: r.status, body: await r.text() }; };
  const csvOps = async (q: string) => { const r = await opsExport.GET(new NextRequest(`http://acme.localhost/time/ops-export?${q}`)); return { status: r.status, body: await r.text() }; };
  async function render(label: string, page: unknown, needle?: string | RegExp): Promise<string> {
    try {
      const out = await html(page);
      check(label, needle === undefined || (typeof needle === "string" ? out.includes(needle) : needle.test(out)), needle ? `looking for ${needle}` : "");
      return out;
    } catch (e) { check(label, false, (e as Error).message.slice(0, 200)); return ""; }
  }
  /** Drive a workflow request to its end as each step's approver. */
  async function decide(entityType: string, entityId: string, approve: boolean): Promise<string> {
    const req = await prisma.workflowRequest.findFirst({ where: { tenantId: t, entityType, entityId }, orderBy: { createdAt: "desc" } });
    if (!req) return "NO_REQUEST";
    for (let i = 0; i < 6; i++) {
      const r = await prisma.workflowRequest.findUniqueOrThrow({ where: { id: req.id } });
      if (r.status !== "PENDING") return r.status;
      const task = await prisma.workflowTask.findFirst({ where: { requestId: req.id, status: "PENDING" } });
      if (!task) return r.status;
      const u = await prisma.user.findUniqueOrThrow({ where: { id: task.approverUserId } });
      await signInAs(u.email);
      const res = await wfAct.decideWorkflowTaskAction({}, fd({ taskId: task.id, decision: approve ? "approve" : "reject", comment: `${TAG} decision` }));
      if (!res.ok) return `ERROR: ${res.message}`;
    }
    return (await prisma.workflowRequest.findUniqueOrThrow({ where: { id: req.id } })).status;
  }

  const priya = await emp("priya.sharma"), vikram = await emp("vikram.menon"), sneha = await emp("sneha.reddy");
  const divya = await emp("divya.pillai"), sanjay = await emp("sanjay.gupta"), tanvi = await emp("tanvi.shah");
  const ramesh = await emp("ramesh.iyer");
  const startedAt = new Date();
  const settingsBefore = await prisma.joinSetting.findUnique({ where: { tenantId: t } });
  const tanviBefore = { status: tanvi.status, dateOfJoining: tanvi.dateOfJoining };
  const policyBefore = await prisma.employeeTimePolicy.findMany({ where: { employeeId: { in: [divya.id, sanjay.id] } } });
  const rosterFrom = new Date(utcToday().getTime() + 38 * DAY), rosterTo = new Date(utcToday().getTime() + 50 * DAY);
  const rosterBefore = await prisma.shiftAssignment.findMany({ where: { employeeId: { in: [divya.id, sanjay.id] }, date: { gte: rosterFrom, lte: rosterTo } } });
  const shifts = new Map((await prisma.shift.findMany({ where: { tenantId: t } })).map((s) => [s.code, s]));
  const GEN = shifts.get("GEN")!, EARLY = shifts.get("EARLY")!;
  const createdCalendarIds: string[] = [];
  const createdAttendance: string[] = [];
  const createdLedger: string[] = [];
  const createdOtEntries: string[] = [];
  let createdJourneyIds: string[] = [];
  let createdTemplateIds: string[] = [];
  let enrolmentCreated: { courseId: string; employeeId: string } | null = null;

  try {
    // Tanvi is the new hire for this run: preboarding, joining in ten days.
    const joining = new Date(utcToday().getTime() + 10 * DAY);
    await prisma.employee.update({ where: { id: tanvi.id }, data: { status: "PREBOARDING", dateOfJoining: joining } });

    // -----------------------------------------------------------------------
    section("1. Preboarding: templates, the hire's plan and tasks");
    await as("priya.sharma");
    ok("HR creates a role-specific preboarding template", await pre.savePreboardingTemplateAction({}, fd({ name: `${TAG} template`, description: "For the run", departmentId: tanvi.departmentId ?? "", jobTitle: tanvi.jobTitleName ?? "" })));
    const tpl = await prisma.preboardingTemplate.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} template` } });
    ok("adds a reviewed custom item", await pre.addPreboardingItemAction({}, fd({ templateId: tpl.id, title: `${TAG} upload offer acceptance`, kind: "CUSTOM", daysBeforeJoining: 5, requiresApproval: true })));
    ok("adds a joining-location confirmation", await pre.addPreboardingItemAction({}, fd({ templateId: tpl.id, title: `${TAG} confirm location`, kind: "LOCATION", daysBeforeJoining: 3 })));
    ok("adds bank, tax, benefits and emergency-contact collection items", (await Promise.all(["BANK", "TAX", "BENEFITS", "EMERGENCY"].map((k) => pre.addPreboardingItemAction({}, fd({ templateId: tpl.id, title: `${TAG} ${k.toLowerCase()} details`, kind: k, daysBeforeJoining: 4 }))))).reduce((a, r) => ({ ok: a.ok && r.ok, message: r.message }), { ok: true, message: "" } as AS));
    refused("a policy item must link a policy", await pre.addPreboardingItemAction({}, fd({ templateId: tpl.id, title: "x", kind: "POLICY" })), /Link/);
    const course = await prisma.course.findFirst({ where: { tenantId: t } });
    if (course) {
      const had = await prisma.courseEnrolment.findUnique({ where: { courseId_employeeId: { courseId: course.id, employeeId: tanvi.id } } });
      if (!had) enrolmentCreated = { courseId: course.id, employeeId: tanvi.id };
      ok("adds a training assignment linked to a course", await pre.addPreboardingItemAction({}, fd({ templateId: tpl.id, title: `${TAG} security basics`, kind: "TRAINING", refId: course.id, daysBeforeJoining: 2 })));
    }
    ok("generates the hire's plan from the template", await pre.generatePreboardingPlanAction({}, fd({ employeeId: tanvi.id, templateId: tpl.id })));
    const tasks = await prisma.preboardingTask.findMany({ where: { tenantId: t, employeeId: tanvi.id } });
    check("the plan has the template's tasks, due before joining", tasks.length >= 6 && tasks.every((x) => x.dueDate <= joining), `${tasks.length}`);
    if (course) check("the training item enrolled the hire in the course", !!(await prisma.courseEnrolment.findUnique({ where: { courseId_employeeId: { courseId: course.id, employeeId: tanvi.id } } })));
    ok("HR adds a one-off policy task", await pre.addPreboardingTaskAction({}, fd({ employeeId: tanvi.id, title: `${TAG} read the code of conduct`, kind: "POLICY", dueDate: iso(new Date(joining.getTime() - DAY)) })));
    ok("and a task it then maintains", await pre.addPreboardingTaskAction({}, fd({ employeeId: tanvi.id, title: `${TAG} waive me`, kind: "CUSTOM", dueDate: iso(joining) })));
    const waive = await prisma.preboardingTask.findFirstOrThrow({ where: { tenantId: t, employeeId: tanvi.id, title: `${TAG} waive me` } });
    ok("changes its due date", await pre.preboardingTaskOpAction({}, fd({ id: waive.id, op: "due", dueDate: iso(new Date(joining.getTime() - 2 * DAY)) })));
    ok("sends a reminder", await pre.preboardingTaskOpAction({}, fd({ id: waive.id, op: "remind" })));
    check("the reminder is in the communications log", (await prisma.prejoinMessageLog.count({ where: { tenantId: t, employeeId: tanvi.id, kind: "REMINDER" } })) > 0);
    refused("waiving needs a reason", await pre.preboardingTaskOpAction({}, fd({ id: waive.id, op: "waive" })), /why/);
    ok("waives it with a reason", await pre.preboardingTaskOpAction({}, fd({ id: waive.id, op: "waive", note: "Not needed" })));
    check("the task is waived", (await prisma.preboardingTask.findUniqueOrThrow({ where: { id: waive.id } })).status === "WAIVED");

    await as("tanvi.shah");
    const custom = tasks.find((x) => x.title === `${TAG} upload offer acceptance`)!;
    ok("the hire submits a reviewed task", await pre.submitPreboardingTaskAction({}, fd({ id: custom.id, note: "Signed and uploaded" })));
    check("it waits for HR review", (await prisma.preboardingTask.findUniqueOrThrow({ where: { id: custom.id } })).status === "SUBMITTED");
    check("HR approves it through the workflow engine", (await decide("PREBOARDING_TASK", custom.id, true)) === "APPROVED");
    check("the task is approved", (await prisma.preboardingTask.findUniqueOrThrow({ where: { id: custom.id } })).status === "APPROVED");
    await as("tanvi.shah");
    const loc = tasks.find((x) => x.kind === "LOCATION")!;
    refused("location confirmation needs an answer", await pre.submitPreboardingTaskAction({}, fd({ id: loc.id })), /Confirm/);
    ok("the hire confirms the joining location", await pre.submitPreboardingTaskAction({}, fd({ id: loc.id, confirm: "YES" })));
    const policy = await prisma.preboardingTask.findFirstOrThrow({ where: { tenantId: t, employeeId: tanvi.id, kind: "POLICY" } });
    refused("a policy cannot be acknowledged before it is opened", await pre.submitPreboardingTaskAction({}, fd({ id: policy.id, ack: true })), /Open/);
    ok("the hire opens the policy", await pre.openPolicyTaskAction({}, fd({ id: policy.id })));
    refused("and cannot confirm it in the same instant", await pre.submitPreboardingTaskAction({}, fd({ id: policy.id, ack: true })), /moment/);
    await prisma.preboardingTask.update({ where: { id: policy.id }, data: { viewedAt: new Date(Date.now() - 60_000) } });
    ok("then acknowledges it after reading", await pre.submitPreboardingTaskAction({}, fd({ id: policy.id, ack: true })));
    check("the acknowledgement is recorded", ((await prisma.preboardingTask.findUniqueOrThrow({ where: { id: policy.id } })).response as Record<string, string> | null)?.acknowledged !== undefined);
    const readiness = await svc.preboardingReadiness(t, tanvi.id);
    check("payroll setup / day-one readiness is computed", readiness.length >= 4, readiness.map((r) => `${r.key}:${r.ok}`).join(" "));

    section("1b. New-hire forms and pre-joining communication");
    await as("priya.sharma");
    ok("HR designs a new-hire form", await pre.saveNewHireFormAction({}, fd({ name: `${TAG} form`, fields: "T-shirt size | SELECT | required | S, M, L\nPreferred name | TEXT |  |" })));
    refused("a bad field definition is rejected", await pre.saveNewHireFormAction({}, fd({ name: `${TAG} bad`, fields: "Size | COLOUR" })), /unknown type/);
    const form = await prisma.newHireForm.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} form` } });
    ok("assigns it to the hire as a form task", await pre.addPreboardingTaskAction({}, fd({ employeeId: tanvi.id, title: `${TAG} fill the form`, kind: "FORM", refId: form.id, dueDate: iso(joining) })));
    const formTask = await prisma.preboardingTask.findFirstOrThrow({ where: { tenantId: t, employeeId: tanvi.id, kind: "FORM" } });
    await as("tanvi.shah");
    refused("a required answer is enforced", await pre.submitNewHireFormAction({}, fd({ formId: form.id, taskId: formTask.id, f_preferred_name: "Tan" })), /Check/);
    ok("the hire submits the form", await pre.submitNewHireFormAction({}, fd({ formId: form.id, taskId: formTask.id, f_t_shirt_size: "M", f_preferred_name: "Tan" })));
    const sub = await prisma.newHireFormSubmission.findFirstOrThrow({ where: { tenantId: t, formId: form.id } });
    check("HR rejects it in the workflow (send back)", (await decide("NEW_HIRE_FORM", sub.id, false)) === "REJECTED");
    check("the submission and its task are marked rejected", (await prisma.newHireFormSubmission.findUniqueOrThrow({ where: { id: sub.id } })).status === "REJECTED" && (await prisma.preboardingTask.findUniqueOrThrow({ where: { id: formTask.id } })).status === "REJECTED");
    await as("priya.sharma");
    ok("HR edits the form (new version)", await pre.saveNewHireFormAction({}, fd({ id: form.id, name: `${TAG} form`, isActive: true, fields: "T-shirt size | SELECT | required | S, M, L, XL\nPreferred name | TEXT |  |" })));
    check("the form version went up", (await prisma.newHireForm.findUniqueOrThrow({ where: { id: form.id } })).version === 2);
    ok("drafts a pre-joining message", await pre.savePrejoinMessageAction({}, fd({ name: `${TAG} welcome`, subject: "Welcome {{first_name}}", body: "We look forward to {{joining_date}}.", kind: "WELCOME", daysBeforeJoining: 7 })));
    const msg = await prisma.prejoinMessage.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} welcome` } });
    refused("a draft cannot be sent", await pre.prejoinMessageOpAction({}, fd({ id: msg.id, op: "send", employeeId: tanvi.id })), /approved/);
    ok("submits it for approval", await pre.prejoinMessageOpAction({}, fd({ id: msg.id, op: "submit" })));
    check("an approver approves it", (await decide("PREJOIN_MESSAGE", msg.id, true)) === "APPROVED");
    check("the message is active", (await prisma.prejoinMessage.findUniqueOrThrow({ where: { id: msg.id } })).status === "ACTIVE");
    await as("priya.sharma");
    ok("HR sends it to the hire", await pre.prejoinMessageOpAction({}, fd({ id: msg.id, op: "send", employeeId: tanvi.id })));
    const sent = await prisma.prejoinMessageLog.findFirst({ where: { tenantId: t, employeeId: tanvi.id, messageId: msg.id } });
    check("placeholders are filled in the sent copy", !!sent && !sent.subject.includes("{{") && sent.subject.includes("Welcome"), sent?.subject);
    ok("the scheduled dispatch runs", await pre.runPrejoinDispatchAction({}, fd({})));
    ok("HR sends a manager introduction", await pre.sendManagerIntroAction({}, fd({ employeeId: tanvi.id, message: "Hello Tanvi, looking forward to working with you." })));
    check("the introduction is logged", (await prisma.prejoinMessageLog.count({ where: { tenantId: t, employeeId: tanvi.id, kind: "INTRO" } })) === 1);
    await as("sanjay.gupta");
    refused("a colleague who is not the manager cannot send one", await pre.sendManagerIntroAction({}, fd({ employeeId: tanvi.id, message: "Hello there, a long message." })), /manager/);

    section("1c. Provisioning: IT accounts, access and asset reservations");
    await as("priya.sharma");
    ok("HR raises an IT account request", await pre.saveProvisionAction({}, fd({ employeeId: tanvi.id, kind: "IT_ACCOUNT", item: `${TAG} email account`, ownerTeam: "IT" })));
    ok("and an access request", await pre.saveProvisionAction({}, fd({ employeeId: tanvi.id, kind: "ACCESS", item: `${TAG} VPN`, ownerTeam: "IT" })));
    const asset = await prisma.asset.findFirst({ where: { tenantId: t, status: "AVAILABLE" } });
    if (asset) {
      ok("reserves an available asset", await pre.saveProvisionAction({}, fd({ employeeId: tanvi.id, kind: "ASSET", assetId: asset.id, ownerTeam: "ADMIN" })));
      check("the asset is held", (await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status === "UNAVAILABLE");
      const res = await prisma.preboardingProvision.findFirstOrThrow({ where: { tenantId: t, employeeId: tanvi.id, assetId: asset.id } });
      ok("cancelling releases it", await pre.provisionOpAction({}, fd({ id: res.id, op: "cancel" })));
      check("the asset is available again", (await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).status === "AVAILABLE");
    }
    const itReq = await prisma.preboardingProvision.findFirstOrThrow({ where: { tenantId: t, employeeId: tanvi.id, item: `${TAG} email account` } });
    ok("IT starts the request", await pre.provisionOpAction({}, fd({ id: itReq.id, op: "start" })));
    ok("and fulfils it", await pre.provisionOpAction({}, fd({ id: itReq.id, op: "fulfil", note: "Created" })));
    check("the request is fulfilled", (await prisma.preboardingProvision.findUniqueOrThrow({ where: { id: itReq.id } })).status === "FULFILLED");

    section("1d. Preboarding pages, settings and exports");
    ok("HR sets the reminder cadence", await pre.saveJoinSettingsAction({}, fd({ scope: "preboarding", preboardingReminderDays: 2, preboardingReminderMax: 4, journeyEscalationDays: 2 })));
    check("the cadence is saved", (await prisma.joinSetting.findUniqueOrThrow({ where: { tenantId: t } })).preboardingReminderDays === 2);
    for (const s of ["tasks", "exceptions", "forms", "comms", "provisioning", "templates", "settings"]) await render(`the preboarding desk renders: ${s}`, Desk({ params: Promise.resolve({ section: s }), searchParams: sp() }));
    await render("the exceptions dashboard shows the hire's completion score", Desk({ params: Promise.resolve({ section: "exceptions" }), searchParams: sp() }), tanvi.displayName ?? "");
    await render("the hire search finds tasks", Desk({ params: Promise.resolve({ section: "tasks" }), searchParams: sp({ q: "conduct" }) }), "code of conduct");
    for (const k of ["preboarding", "forms", "comms"]) {
      const r = await csvOnb(`kind=${k}`);
      check(`export ${k} downloads with this run's rows`, r.status === 200 && r.body.includes(tanvi.displayName ?? "~"), `${r.status}`);
    }
    const audit = await csvOnb("kind=audit");
    check("the onboarding audit package includes preboarding history", audit.status === 200 && audit.body.includes("PreboardingTask"));
    await as("tanvi.shah");
    await render("the welcome center shows the hire's checklist", Welcome(), `${TAG} confirm location`);
    const outsider = await onbExport.GET(new NextRequest("http://acme.localhost/onboarding/export?kind=preboarding"));
    check("a new hire cannot download the HR exports", outsider.status === 403);

    // -----------------------------------------------------------------------
    section("2. Onboarding: role paths, plan sign-off, designer and revisions");
    await as("priya.sharma");
    ok("HR creates a role- and department-specific journey template", await lc.saveTemplateAction({}, fd({ name: `${TAG} journey`, trigger: "CONFIRMATION", departmentId: divya.departmentId ?? "", jobTitle: divya.jobTitleName ?? "Engineer", isActive: true })));
    const jt = await prisma.journeyTemplate.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} journey` } });
    createdTemplateIds.push(jt.id);
    ok("adds a task that needs sign-off", await lc.addTemplateTaskAction({}, fd({ templateId: jt.id, title: `${TAG} meet the team`, owner: "MANAGER", offsetDays: 1, category: "MEETING", isRequired: true, needsApproval: true })));
    ok("adds a first-week task", await lc.addTemplateTaskAction({}, fd({ templateId: jt.id, title: `${TAG} laptop setup`, owner: "IT", offsetDays: 3, category: "ASSETS", isRequired: true })));
    check("each edit is a revision", (await prisma.journeyTemplateRevision.count({ where: { tenantId: t, templateId: jt.id } })) >= 2);
    const k1 = await prisma.journeyTaskTemplate.findFirstOrThrow({ where: { templateId: jt.id, title: `${TAG} laptop setup` } });
    ok("the designer moves a task to another phase", await onb.designerTaskAction({}, fd({ id: k1.id, op: "phase", phase: "FIRST_30" })));
    check("its offset follows the phase", (await prisma.journeyTaskTemplate.findUniqueOrThrow({ where: { id: k1.id } })).offsetDays >= 8);
    ok("reorders tasks", await onb.designerTaskAction({}, fd({ id: k1.id, op: "up" })));
    const revs = await prisma.journeyTemplateRevision.findMany({ where: { tenantId: t, templateId: jt.id }, orderBy: { version: "asc" } });
    ok("restores an earlier revision", await onb.restoreTemplateRevisionAction({}, fd({ id: (revs.find((r) => ((r.snapshot as { tasks?: unknown[] }).tasks ?? []).length === 2) ?? revs[0]!).id })));
    check("the restore is itself a new revision", (await prisma.journeyTemplateRevision.count({ where: { tenantId: t, templateId: jt.id } })) === revs.length + 1);
    await render("the designer page shows phases and history", Designer({ params: Promise.resolve({ id: jt.id }) }), "Restored version");
    ok("starts the journey for an employee in that role", await lc.startJourneyAction({}, fd({ employeeId: divya.id, trigger: "CONFIRMATION", anchorDate: iso(utcToday()) })));
    const jr = await prisma.journey.findFirstOrThrow({ where: { tenantId: t, employeeId: divya.id, trigger: "CONFIRMATION" }, orderBy: { createdAt: "desc" }, include: { tasks: true } });
    createdJourneyIds.push(jr.id);
    check("the role-specific template was picked", jr.templateId === jt.id);
    ok("HR sends the plan for the manager's sign-off", await onb.submitOnboardingPlanAction({}, fd({ journeyId: jr.id })));
    check("the manager approves the plan", (await decide("ONBOARDING_PLAN", jr.id, true)) === "APPROVED");
    check("the plan is signed off", (await prisma.journey.findUniqueOrThrow({ where: { id: jr.id } })).planStatus === "APPROVED");
    const signTask = jr.tasks.find((x) => x.needsApproval)!;
    await as("priya.sharma");
    ok("marking a sign-off task done starts its approval", await lc.setTaskAction({}, fd({ taskId: signTask.id, status: "DONE" })));
    check("it waits for sign-off", (await prisma.journeyTask.findUniqueOrThrow({ where: { id: signTask.id } })).approvalStatus === "PENDING");
    check("onboarding HR signs it off", (await decide("JOURNEY_TASK", signTask.id, true)) === "APPROVED");
    check("the task is done", (await prisma.journeyTask.findUniqueOrThrow({ where: { id: signTask.id } })).status === "DONE");
    await as("priya.sharma");
    const other = jr.tasks.find((x) => !x.needsApproval)!;
    ok("HR hands a task to a colleague", await onb.delegateJourneyTaskAction({}, fd({ taskId: other.id, toEmployeeId: sanjay.id, note: "Sanjay owns laptops" })));
    check("the task records the hand-over", (await prisma.journeyTask.findUniqueOrThrow({ where: { id: other.id } })).assigneeEmployeeId === sanjay.id);
    await prisma.journeyTask.update({ where: { id: other.id }, data: { dueDate: new Date(Date.now() - 6 * DAY) } });
    ok("the escalation sweep runs", await onb.escalateJourneyTasksAction({}, fd({})));
    check("the overdue task is escalated", (await prisma.journeyTask.findUniqueOrThrow({ where: { id: other.id } })).escalationLevel > 0);
    await render("the journey page shows sign-off and hand-over", JourneyPage({ params: Promise.resolve({ id: jr.id }) }), /handed|Handed/);
    await as("sanjay.gupta");
    ok("the new assignee completes it", await lc.setTaskAction({}, fd({ taskId: other.id, status: "DONE" })));
    check("the journey completes", (await prisma.journey.findUniqueOrThrow({ where: { id: jr.id } })).status === "COMPLETED");

    section("2b. Completion certificate");
    const join = await prisma.journey.create({ data: { tenantId: t, employeeId: tanvi.id, trigger: "JOINING", title: `${TAG} joining`, anchorDate: joining, status: "COMPLETED", completedAt: new Date() } });
    createdJourneyIds.push(join.id);
    await as("priya.sharma");
    ok("HR issues the completion certificate", await onb.issueOnboardingCertificateAction({}, fd({ journeyId: join.id })));
    refused("only once", await onb.issueOnboardingCertificateAction({}, fd({ journeyId: join.id })), /already/);
    await as("tanvi.shah");
    await render("the hire can view the certificate", Certificate({ params: Promise.resolve({ id: join.id }) }), /certif/i);

    section("2c. Buddies, orientation and milestones");
    await as("priya.sharma");
    refused("a hire cannot be their own buddy", await onb.assignBuddyAction({}, fd({ employeeId: tanvi.id, buddyEmployeeId: tanvi.id })));
    ok("HR proposes a buddy before joining", await onb.assignBuddyAction({}, fd({ employeeId: tanvi.id, buddyEmployeeId: divya.id, goals: "Lunch on day one" })));
    const bud = await prisma.onboardingBuddy.findFirstOrThrow({ where: { tenantId: t, employeeId: tanvi.id } });
    check("the buddy is asked to accept", bud.status === "PROPOSED");
    check("the buddy accepts in their inbox", (await decide("BUDDY_ASSIGNMENT", bud.id, true)) === "APPROVED");
    check("the pairing is active", (await prisma.onboardingBuddy.findUniqueOrThrow({ where: { id: bud.id } })).status === "ACTIVE");
    await as("divya.pillai");
    ok("the buddy logs a check-in", await onb.buddyOpAction({}, fd({ id: bud.id, op: "checkin", note: "Coffee chat" })));
    await as("tanvi.shah");
    ok("the hire rates the buddy", await onb.buddyOpAction({}, fd({ id: bud.id, op: "feedback", rating: 5, note: "Great" })));
    await as("priya.sharma");
    ok("HR closes the buddy period", await onb.buddyOpAction({}, fd({ id: bud.id, op: "complete" })));
    const start = new Date(Date.now() + 3 * DAY + 330 * 60_000).toISOString().slice(0, 11);
    ok("HR drafts an orientation session", await onb.saveOrientationSessionAction({}, multi({ title: `${TAG} orientation`, kind: "ORIENTATION", startsAt: `${start}10:00`, endsAt: `${start}12:00`, capacity: 5, location: "Room 1", attendeeIds: [tanvi.id] })));
    const ses = await prisma.orientationSession.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} orientation` } });
    ok("submits it", await onb.orientationOpAction({}, fd({ id: ses.id, op: "submit" })));
    check("it is approved", (await decide("ORIENTATION_SESSION", ses.id, true)) === "APPROVED");
    check("the session is scheduled and invitations sent", (await prisma.orientationSession.findUniqueOrThrow({ where: { id: ses.id } })).status === "SCHEDULED"
      && (await prisma.notification.count({ where: { tenantId: t, title: { contains: `${TAG} orientation` } } })) > 0);
    await as("tanvi.shah");
    ok("the hire accepts the invitation", await onb.rsvpOrientationAction({}, fd({ sessionId: ses.id, response: "CONFIRMED" })));
    await as("priya.sharma");
    ok("HR invites another attendee", await onb.orientationOpAction({}, fd({ id: ses.id, op: "invite", employeeId: sanjay.id })));
    ok("marks attendance", await onb.orientationOpAction({}, fd({ id: ses.id, op: "attend", employeeId: tanvi.id, status: "ATTENDED" })));
    ok("completes the session", await onb.orientationOpAction({}, fd({ id: ses.id, op: "complete" })));
    check("the unmarked invitee is a no-show", (await prisma.orientationAttendee.findFirstOrThrow({ where: { sessionId: ses.id, employeeId: sanjay.id } })).status === "NO_SHOW");
    await as("sneha.reddy");
    refused("a manager cannot schedule orientation", await onb.saveOrientationSessionAction({}, multi({ title: "x", kind: "ORIENTATION", startsAt: `${start}10:00`, endsAt: `${start}11:00` })), /Managers/);
    await as("priya.sharma");
    ok("HR sets up week-one and 30/60/90-day milestones", await onb.generateMilestonesAction({}, fd({ employeeId: tanvi.id })));
    const ms = await prisma.onboardingMilestone.findMany({ where: { tenantId: t, employeeId: tanvi.id }, orderBy: { dueDate: "asc" } });
    check("four milestones exist", ms.map((m) => m.kind).join(",") === "WEEK_1,DAY_30,DAY_60,DAY_90", ms.map((m) => m.kind).join(","));
    ok("sets objectives for day 30", await onb.reviewMilestoneAction({}, fd({ id: ms[1]!.id, op: "objectives", objectives: "Ship one change" })));
    ok("reviews day 30", await onb.reviewMilestoneAction({}, fd({ id: ms[1]!.id, op: "review", rating: 4, note: "Good start" })));
    await as("tanvi.shah");
    ok("the hire gives checkpoint feedback", await onb.milestoneFeedbackAction({}, fd({ id: ms[1]!.id, rating: 5, comment: "Welcoming team" })));
    check("the checkpoint is complete with both sides", (await prisma.onboardingMilestone.findUniqueOrThrow({ where: { id: ms[1]!.id } })).status === "COMPLETED");
    await render("the welcome center shows sessions, buddy and checkpoints", Welcome(), "You rated it 5/5");
    await as("priya.sharma");
    for (const tab of ["buddies", "sessions", "milestones"]) await render(`buddies & milestones renders: ${tab}`, People({ searchParams: sp({ tab }) }));
    for (const tab of ["dayone", "firstweek", "blockers", "scorecard", "cohorts", "reports"]) await render(`onboarding insights renders: ${tab}`, Insights({ searchParams: sp({ tab }) }));
    for (const k of ["journeys", "orientation", "buddies", "milestones"]) {
      const r = await csvOnb(`kind=${k}`);
      check(`export ${k}`, r.status === 200 && r.body.split("\n").length > 1, `${r.status}`);
    }

    // -----------------------------------------------------------------------
    section("3. Background verification");
    await as("priya.sharma");
    ok("HR adds a vendor with per-check costs and stages", await bgv.saveBgvVendorAction({}, multi({ name: `${TAG} vendor`, contactEmail: "ops@vendor.test", slaDays: 7, checkTypes: ["IDENTITY", "EMPLOYMENT", "EDUCATION"], cost_IDENTITY: 300, cost_EMPLOYMENT: 900, cost_EDUCATION: 700, stages: "Initiated, Field visit, Report", isActive: "true" })));
    const vendor = await prisma.bgvVendor.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} vendor` } });
    ok("defines a package", await bgv.saveBgvPackageAction({}, multi({ name: `${TAG} package`, checkTypes: ["IDENTITY", "EMPLOYMENT", "EDUCATION"], vendorId: vendor.id, slaDays: 6, isActive: "true" })));
    const pkg = await prisma.bgvPackage.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} package` } });
    ok("opens a case from the package plus address, reference and criminal checks", await bgv.startBgvCaseAction({}, multi({ employeeId: tanvi.id, packageId: pkg.id, priority: "HIGH", checks: ["ADDRESS", "REFERENCE", "CRIMINAL"] })));
    refused("one open case per person", await bgv.startBgvCaseAction({}, fd({ employeeId: tanvi.id, packageId: pkg.id })), /already/);
    const cs = await prisma.bgvCheck.findFirstOrThrow({ where: { tenantId: t, employeeId: tanvi.id }, include: { items: true } });
    check("six checks were created; the vendor's checks carry its costs", cs.items.length === 6 && cs.items.filter((i) => ["IDENTITY", "EMPLOYMENT", "EDUCATION"].includes(i.checkType)).every((i) => Number(i.cost) > 0), cs.items.map((i) => `${i.checkType}:${i.cost}`).join(" "));
    check("the hire was asked for consent", (await prisma.notification.count({ where: { tenantId: t, title: { contains: "consent" }, createdAt: { gte: startedAt } } })) > 0);
    await as("tanvi.shah");
    refused("consent needs the box ticked", await bgv.giveBgvConsentAction({}, fd({ id: cs.id })), /Tick/);
    ok("the hire gives consent", await bgv.giveBgvConsentAction({}, fd({ id: cs.id, agree: true })));
    check("consent has an expiry", !!(await prisma.bgvCheck.findUniqueOrThrow({ where: { id: cs.id } })).consentExpiresAt);
    await render("the hire sees the verification status", Welcome(), /verification/i);
    await as("priya.sharma");
    const item = (k: string) => cs.items.find((i) => i.checkType === k)!;
    ok("identity check captured and verified", await bgv.updateBgvItemAction({}, fd({ id: item("IDENTITY").id, status: "VERIFIED", d_documentType: "PAN", d_documentRef: "1234", vendorStage: "Report" })));
    refused("an adverse outcome needs a reason code", await bgv.updateBgvItemAction({}, fd({ id: item("EMPLOYMENT").id, status: "DISCREPANCY" })), /reason code/);
    ok("employment discrepancy is flagged with a reason code", await bgv.updateBgvItemAction({}, fd({ id: item("EMPLOYMENT").id, status: "DISCREPANCY", reasonCode: "TENURE_MISMATCH", d_employer: "Acme Old", d_period: "2019-2022", findings: "Dates differ by 3 months" })));
    check("it waits for review", (await prisma.bgvCheckItem.findUniqueOrThrow({ where: { id: item("EMPLOYMENT").id } })).status === "PENDING_REVIEW");
    check("a reviewer confirms the discrepancy", (await decide("BGV_CHECK_ITEM", item("EMPLOYMENT").id, true)) === "APPROVED");
    check("the check is a discrepancy (minor)", (await prisma.bgvCheckItem.findUniqueOrThrow({ where: { id: item("EMPLOYMENT").id } })).status === "DISCREPANCY");
    await as("priya.sharma");
    ok("a critical education finding is flagged", await bgv.updateBgvItemAction({}, fd({ id: item("EDUCATION").id, status: "FAILED", reasonCode: "INSTITUTION_UNRECOGNISED", d_institution: "Nowhere U", d_degree: "BSc" })));
    check("a critical finding escalates the case", (await prisma.bgvCheck.findUniqueOrThrow({ where: { id: cs.id } })).escalationLevel > 0);
    check("the reviewer sends it back", (await decide("BGV_CHECK_ITEM", item("EDUCATION").id, false)) === "REJECTED");
    check("the check is back in progress", (await prisma.bgvCheckItem.findUniqueOrThrow({ where: { id: item("EDUCATION").id } })).status === "IN_PROGRESS");
    await as("priya.sharma");
    ok("education verified after the institution replied", await bgv.updateBgvItemAction({}, fd({ id: item("EDUCATION").id, status: "VERIFIED", d_year: "2018" })));
    ok("address verification captured and verified", await bgv.updateBgvItemAction({}, fd({ id: item("ADDRESS").id, status: "VERIFIED", d_address: "12 MG Road, Bengaluru", d_since: "2020" })));
    ok("reference check verified", await bgv.updateBgvItemAction({}, fd({ id: item("REFERENCE").id, status: "VERIFIED", d_referee: "A. Manager", d_contact: "ref@old.test", d_relationship: "Manager" })));
    ok("criminal-record check moves through its status", await bgv.updateBgvItemAction({}, fd({ id: item("CRIMINAL").id, status: "IN_PROGRESS", d_jurisdiction: "Indiranagar PS" })));
    ok("and clears", await bgv.updateBgvItemAction({}, fd({ id: item("CRIMINAL").id, status: "VERIFIED" })));
    check("check-specific details are stored", ((await prisma.bgvCheckItem.findUniqueOrThrow({ where: { id: item("ADDRESS").id } })).details as Record<string, string>).address === "12 MG Road, Bengaluru");
    refused("a recheck needs a reason", await bgv.recheckBgvItemAction({}, fd({ id: item("IDENTITY").id })), /reason|why/i);
    ok("the employment check is run again", await bgv.recheckBgvItemAction({}, fd({ id: item("EMPLOYMENT").id, reason: "Candidate sent a relieving letter" })));
    const re = await prisma.bgvCheckItem.findFirstOrThrow({ where: { tenantId: t, recheckOfId: item("EMPLOYMENT").id } });
    ok("the recheck verifies", await bgv.updateBgvItemAction({}, fd({ id: re.id, status: "VERIFIED" })));
    const pdf = new File([Buffer.from("%PDF-1.4\n% smoke evidence\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")], "relieving-letter.pdf", { type: "application/pdf" });
    const ev = new FormData(); ev.set("caseId", cs.id); ev.set("itemId", re.id); ev.set("label", `${TAG} relieving letter`); ev.set("file", pdf);
    ok("evidence is added to the repository", await bgv.uploadBgvEvidenceAction({}, ev));
    const deepakUser = await prisma.user.findFirstOrThrow({ where: { email: "deepak.chauhan@acme.test" } });
    ok("the case is reassigned", await bgv.bgvCaseOpAction({}, fd({ id: cs.id, op: "reassign", assigneeUserId: deepakUser.id })));
    ok("and reprioritised", await bgv.bgvCaseOpAction({}, fd({ id: cs.id, op: "priority", priority: "URGENT" })));
    ok("HR proposes the result", await bgv.proposeBgvResultAction({}, fd({ id: cs.id, findings: "All checks verified" })));
    check("the result is approved", (await decide("BGV_RESULT", cs.id, true)) === "APPROVED");
    check("the case is clear", (await prisma.bgvCheck.findUniqueOrThrow({ where: { id: cs.id } })).status === "CLEAR");
    await as("priya.sharma");
    refused("an amendment needs a reason", await bgv.amendBgvResultAction({}, fd({ id: cs.id, status: "FAILED" })), /reason/);
    ok("HR proposes amending the result", await bgv.amendBgvResultAction({}, fd({ id: cs.id, status: "FAILED", reason: "Forged letter found later" })));
    check("the amendment is approved", (await decide("BGV_RESULT", cs.id, true)) === "APPROVED");
    check("the result is now failed", (await prisma.bgvCheck.findUniqueOrThrow({ where: { id: cs.id } })).status === "FAILED");
    check("verification HR is notified of the failed check", (await prisma.notification.count({ where: { tenantId: t, title: { startsWith: "Background check failed" }, createdAt: { gte: startedAt } } })) > 0);
    const trail = await prisma.bgvCaseEvent.findMany({ where: { tenantId: t, bgvCheckId: cs.id } });
    check("the audit trail has every step", ["OPENED", "CONSENT_GIVEN", "CHECK_FLAGGED", "CHECK_CONFIRMED", "RECHECK", "EVIDENCE", "REASSIGNED", "RESULT_APPROVED", "AMENDMENT"].every((k) => trail.some((e) => e.kind === k)), trail.map((e) => e.kind).join(","));
    await as("priya.sharma");
    for (const tab of ["queue", "dashboard", "vendors", "packages", "settings"]) await render(`verification renders: ${tab}`, Verification({ searchParams: sp({ tab }) }));
    await render("the vendor comparison lists the vendor", Verification({ searchParams: sp({ tab: "vendors" }) }), `${TAG} vendor`);
    await render("the case page shows the trail and evidence", CasePage({ params: Promise.resolve({ id: cs.id }) }), `${TAG} relieving letter`);
    for (const k of ["bgv", "bgv-checks", "bgv-vendors"]) {
      const r = await csvOnb(`kind=${k}`);
      check(`export ${k}`, r.status === 200 && (r.body.includes(tanvi.displayName ?? "~") || r.body.includes(`${TAG} vendor`)), `${r.status}`);
    }
    await as("sneha.reddy");
    refused("a manager without verification rights cannot open cases", await bgv.startBgvCaseAction({}, fd({ employeeId: divya.id, checks: "IDENTITY" })).catch((e: Error) => ({ ok: false, message: e.message })));

    // -----------------------------------------------------------------------
    section("4. Shifts & roster: swaps, marketplace, open shifts, publishing");
    const D = new Date(rosterFrom.getTime() + 2 * DAY), D2 = new Date(rosterFrom.getTime() + 4 * DAY), D3 = new Date(rosterFrom.getTime() + 6 * DAY);
    await as("priya.sharma");
    ok("the roster is set for the two colleagues", await rosterAct.saveRosterAction({}, fd({ [`cell:${divya.id}:${iso(D)}`]: GEN.id, [`cell:${sanjay.id}:${iso(D)}`]: EARLY.id, [`cell:${divya.id}:${iso(D2)}`]: GEN.id, [`cell:${sanjay.id}:${iso(D2)}`]: "OFF", [`cell:${divya.id}:${iso(D3)}`]: "OFF" })));
    check("roster changes notify the people affected", (await prisma.notification.count({ where: { tenantId: t, title: "Your roster has changed", createdAt: { gte: startedAt } } })) >= 2);
    await as("divya.pillai");
    ok("an employee asks a colleague to swap", await ros.requestShiftSwapAction({}, fd({ date: iso(D), counterpartId: sanjay.id, counterpartDate: iso(D), reason: `${TAG} doctor visit` })));
    const sw = await prisma.shiftSwapRequest.findFirstOrThrow({ where: { tenantId: t, requesterId: divya.id, requesterDate: D } });
    check("it waits for the colleague", sw.status === "PENDING_PEER");
    await as("sanjay.gupta");
    ok("the colleague accepts", await ros.respondShiftSwapAction({}, fd({ id: sw.id, response: "accept" })));
    check("the swap goes to the manager", (await prisma.shiftSwapRequest.findUniqueOrThrow({ where: { id: sw.id } })).status === "PENDING_APPROVAL");
    check("the manager approves", (await decide("SHIFT_SWAP", sw.id, true)) === "APPROVED");
    const grid = await svc.rosterGrid([divya.id, sanjay.id], D, 1);
    check("the roster now has the shifts swapped", grid.get(divya.id)?.[0]?.shiftId === EARLY.id && grid.get(sanjay.id)?.[0]?.shiftId === GEN.id);
    await as("divya.pillai");
    ok("posts a shift to the marketplace", await ros.requestShiftSwapAction({}, fd({ date: iso(D2), marketplace: true, reason: `${TAG} family event` })));
    const mk = await prisma.shiftSwapRequest.findFirstOrThrow({ where: { tenantId: t, requesterId: divya.id, requesterDate: D2 } });
    check("it is open in the marketplace", mk.status === "OPEN" && mk.isMarketplace);
    await render("the marketplace tab lists it for colleagues", (async () => { await as("sanjay.gupta"); return MyShifts({ searchParams: sp({ tab: "marketplace" }) }); })(), iso(D2));
    ok("a colleague who is off picks it up", await ros.claimShiftSwapAction({}, fd({ id: mk.id })));
    check("the manager rejects the pick-up", (await decide("SHIFT_SWAP", mk.id, false)) === "REJECTED");
    await as("divya.pillai");
    ok("another request", await ros.requestShiftSwapAction({}, fd({ date: iso(new Date(D.getTime() + DAY)), counterpartId: sanjay.id, reason: "x" })).then((r) => r.ok ? r : { ok: true, message: `not rostered: ${r.message}` }));
    const cancelMe = await prisma.shiftSwapRequest.findFirst({ where: { tenantId: t, requesterId: divya.id, status: "PENDING_PEER" } });
    if (cancelMe) ok("the requester cancels it", await ros.cancelShiftSwapAction({}, fd({ id: cancelMe.id })));
    await as("ramesh.iyer");
    refused("swaps are limited to the same department", await ros.requestShiftSwapAction({}, fd({ date: iso(D), counterpartId: divya.id, counterpartDate: iso(D) })));
    await as("divya.pillai");
    ok("records shift preferences", await ros.saveShiftPreferenceAction({}, multi({ preferredShiftIds: [GEN.id], avoidWeekdays: ["0"], maxNightsPerWeek: 1, note: "Mornings please" })));
    check("the preference is saved", (await prisma.shiftPreference.findFirstOrThrow({ where: { tenantId: t, employeeId: divya.id } })).maxNightsPerWeek === 1);
    await as("priya.sharma");
    ok("posts an open shift (vacancy alert)", await ros.saveOpenShiftAction({}, fd({ shiftId: GEN.id, date: iso(D3), slots: 1, departmentId: divya.departmentId ?? "", note: TAG })));
    const os = await prisma.openShift.findFirstOrThrow({ where: { tenantId: t, date: D3, note: TAG } });
    check("eligible people were alerted", (await prisma.notification.count({ where: { tenantId: t, title: { startsWith: "Open shift" }, createdAt: { gte: startedAt } } })) > 0);
    await as("divya.pillai");
    ok("an employee who is off bids", await ros.bidOpenShiftAction({}, fd({ id: os.id, note: "Happy to" })));
    const bid = await prisma.openShiftBid.findFirstOrThrow({ where: { openShiftId: os.id, employeeId: divya.id } });
    await as("priya.sharma");
    ok("the planner awards it", await ros.openShiftOpAction({}, fd({ id: os.id, op: "award", bidId: bid.id })));
    check("the shift is filled and on the roster", (await prisma.openShift.findUniqueOrThrow({ where: { id: os.id } })).status === "FILLED" && (await svc.rosterGrid([divya.id], D3, 1)).get(divya.id)?.[0]?.shiftId === GEN.id);
    ok("adds a minimum staffing rule", await ros.saveStaffingRuleAction({}, multi({ name: `${TAG} min`, shiftId: GEN.id, departmentId: divya.departmentId ?? "", minStaff: 5, maxStaff: 9, weekdays: ["1", "2", "3", "4", "5"] })));
    const rule = await prisma.staffingRule.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} min` } });
    await render("conflicts list understaffing against the rule", RosterOps({ searchParams: sp({ tab: "rules", from: iso(D), dept: divya.departmentId ?? "" }) }), /nderstaff/);
    ok("deletes the rule", await ros.saveStaffingRuleAction({}, fd({ id: rule.id, op: "delete" })));
    ok("submits the roster for publication", await ros.submitRosterPublicationAction({}, fd({ title: `${TAG} roster`, fromDate: iso(D), toDate: iso(D3), departmentId: divya.departmentId ?? "" })));
    const pub = await prisma.rosterPublication.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} roster` } });
    check("a roster approver publishes it", (await decide("ROSTER_PUBLISH", pub.id, true)) === "APPROVED");
    check("the roster is published with a version", (await prisma.rosterPublication.findUniqueOrThrow({ where: { id: pub.id } })).status === "PUBLISHED");
    await as("priya.sharma");
    ok("adds a shift from the template library", await ros.addShiftFromLibraryAction({}, fd({ code: "SPL", newCode: "SMKSPL" })));
    const spl = await prisma.shift.findFirstOrThrow({ where: { tenantId: t, code: "SMKSPL" } });
    ok("configures a split shift", await ros.saveSplitShiftAction({}, fd({ shiftId: spl.id, segments: "16:00-20:00" })));
    refused("overlapping segments are rejected", await ros.saveSplitShiftAction({}, fd({ shiftId: spl.id, segments: "11:00-13:00" })));
    ok("proposes a regional workweek", await ros.proposeTimeConfigChangeAction({}, fd({ kind: "WORKWEEK", name: `${TAG} workweek`, rule_SUN: "ALL", rule_SAT: "ALT_2_4", reason: "Plant" })));
    const ww = await prisma.timeConfigChange.findFirstOrThrow({ where: { tenantId: t, kind: "WORKWEEK", summary: { contains: TAG } } });
    check("a time administrator approves it", (await decide("TIME_CONFIG_CHANGE", ww.id, true)) === "APPROVED");
    check("the workweek exists", !!(await prisma.weeklyOffPolicy.findFirst({ where: { tenantId: t, name: `${TAG} workweek` } })));
    await as("priya.sharma");
    ok("proposes a shift cycle", await ros.proposeTimeConfigChangeAction({}, fd({ kind: "SHIFT_CYCLE", name: `${TAG} cycle`, steps: "GEN GEN EARLY OFF" })));
    const cyc = await prisma.timeConfigChange.findFirstOrThrow({ where: { tenantId: t, kind: "SHIFT_CYCLE", summary: { contains: TAG } } });
    check("the cycle change is rejected", (await decide("TIME_CONFIG_CHANGE", cyc.id, false)) === "REJECTED");
    check("no cycle was created", !(await prisma.rosterPattern.findFirst({ where: { tenantId: t, name: `${TAG} cycle` } })));
    await as("priya.sharma");
    ok("roster swap rules are configured", await pre.saveJoinSettingsAction({}, fd({ scope: "roster", swapRequiresApproval: true, swapMinNoticeHours: 24, swapSameDepartmentOnly: true, swapMaxPerMonth: 4, minRestHours: 11 })));
    for (const tab of ["swaps", "open", "rules", "coverage", "publish", "cost", "adherence", "library", "changes", "settings", "reports"]) await render(`roster operations renders: ${tab}`, RosterOps({ searchParams: sp({ tab, from: iso(D) }) }));
    await as("divya.pillai");
    for (const tab of ["roster", "swaps", "marketplace", "open", "requests", "preferences"]) await render(`my shifts renders: ${tab}`, MyShifts({ searchParams: sp({ tab }) }));
    await as("priya.sharma");
    const rl = await csvOps(`kind=roster&locationId=${divya.locationId}&from=${iso(D)}`);
    check("the roster exports by location", rl.status === 200 && rl.body.includes(divya.displayName ?? "~") && !rl.body.includes(ramesh.displayName ?? "~"), `${rl.status}`);
    for (const k of ["shifts", "swaps", "shift-requests", "cycles", "workweeks", "time-changes", "roster-audit"]) {
      const r = await csvOps(`kind=${k}`);
      check(`export ${k}`, r.status === 200 && r.body.includes(",") && (["shift-requests", "cycles"].includes(k) || r.body.split("\n").length > 2), `${r.status}`);
    }

    // -----------------------------------------------------------------------
    section("5. Holidays & calendars");
    await as("priya.sharma");
    const year = new Date().getUTCFullYear() + 3;
    ok("adds a custom event day type", await hol.saveDayTypeAction({}, fd({ code: "SMKFEST", name: `${TAG} festival`, color: "#aa3300" })));
    ok("starts a state-level regional calendar", await hol.createCalendarRevisionAction({}, multi({ name: `${TAG} Karnataka`, year, country: "IN", state: "Karnataka", locationIds: [divya.locationId ?? ""] })));
    const rev = await prisma.holidayCalendarRevision.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Karnataka` } });
    ok("adds a holiday", await hol.editCalendarRevisionAction({}, fd({ id: rev.id, op: "add", name: "Rajyotsava", date: `${year}-11-01`, dayType: "SMKFEST" })));
    refused("a date outside the year is refused", await hol.editCalendarRevisionAction({}, fd({ id: rev.id, op: "add", name: "Wrong", date: `${year + 1}-01-01` })), /fall in/);
    ok("imports holidays from CSV", await hol.editCalendarRevisionAction({}, fd({ id: rev.id, op: "import", csv: `Name,Date,Optional,DayType\nRepublic Day,${year}-01-26,No,\nUgadi,${year}-03-20,Yes,\nWeekend Fest,${year}-02-${String(1 + ((7 - new Date(Date.UTC(year, 1, 1)).getUTCDay()) % 7)).padStart(2, "0")},No,` })));
    ok("removes one", await hol.editCalendarRevisionAction({}, fd({ id: rev.id, op: "remove", key: `${year}-03-20|Ugadi` })));
    ok("sets effective dating", await hol.editCalendarRevisionAction({}, multi({ id: rev.id, op: "meta", country: "IN", state: "Karnataka", effectiveFrom: `${year}-01-01`, locationIds: [divya.locationId ?? ""] })));
    ok("count validation is configured", await pre.saveJoinSettingsAction({}, fd({ scope: "holiday", holidayMinCount: 5, holidayMaxCount: 0 })));
    refused("too few holidays cannot be submitted", await hol.submitCalendarRevisionAction({}, fd({ id: rev.id })), /at least|minimum|fewer/i);
    ok("relaxes the limit", await pre.saveJoinSettingsAction({}, fd({ scope: "holiday", holidayMinCount: 2, holidayMaxCount: 30 })));
    await render("the calendar tab compares the version with the live calendar", Holidays({ searchParams: sp({ tab: "calendars", rev: rev.id }) }), "Rajyotsava");
    ok("submits it for approval", await hol.submitCalendarRevisionAction({}, fd({ id: rev.id })));
    check("a holiday administrator approves it", (await decide("HOLIDAY_CALENDAR", rev.id, true)) === "APPROVED");
    const cal = await prisma.holidayCalendar.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Karnataka` }, include: { holidays: true } });
    createdCalendarIds.push(cal.id);
    check("the calendar is published with its region and holidays", cal.state === "Karnataka" && cal.holidays.length === 3, `${cal.holidays.length}`);
    check("a notification campaign went out", (await prisma.notification.count({ where: { tenantId: t, title: { contains: `${TAG} Karnataka` } } })) > 0);
    await as("priya.sharma");
    ok("starts a revision of the live calendar", await hol.createCalendarRevisionAction({}, fd({ calendarId: cal.id })));
    const rev2 = await prisma.holidayCalendarRevision.findFirstOrThrow({ where: { tenantId: t, calendarId: cal.id, status: "DRAFT" } });
    ok("adds a holiday to it", await hol.editCalendarRevisionAction({}, fd({ id: rev2.id, op: "add", name: "Extra", date: `${year}-12-24` })));
    ok("submits it", await hol.submitCalendarRevisionAction({}, fd({ id: rev2.id })));
    check("the approver rejects it", (await decide("HOLIDAY_CALENDAR", rev2.id, false)) === "REJECTED");
    check("the live calendar is unchanged", (await prisma.holiday.count({ where: { calendarId: cal.id } })) === 3);
    await as("priya.sharma");
    ok("proposes a weekend substitution rule", await hol.saveHolidayRuleAction({}, fd({ kind: "SUBSTITUTE_WEEKEND", name: `${TAG} substitute`, calendarId: cal.id, direction: "NEXT" })));
    const hr = await prisma.holidayRule.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} substitute` } });
    check("the rule is approved", (await decide("HOLIDAY_RULE", hr.id, true)) === "APPROVED");
    await as("priya.sharma");
    ok("applying it adds substitute days", await hol.holidayRuleOpAction({}, fd({ id: hr.id, op: "apply" })));
    check("a substitute holiday was added for the weekend festival", (await prisma.holiday.count({ where: { calendarId: cal.id, dayType: "SUBSTITUTE" } })) >= 1);
    ok("retires the rule", await hol.holidayRuleOpAction({}, fd({ id: hr.id, op: "retire" })));
    ok("proposes a count-limit rule", await hol.saveHolidayRuleAction({}, fd({ kind: "COUNT_LIMIT", name: `${TAG} limits`, min: 1, max: 20 })));
    const hr2 = await prisma.holidayRule.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} limits` } });
    check("it is rejected", (await decide("HOLIDAY_RULE", hr2.id, false)) === "REJECTED");
    await as("priya.sharma");
    ok("plans a shutdown", await hol.saveShutdownAction({}, fd({ name: `${TAG} shutdown`, calendarId: cal.id, fromDate: `${year}-12-28`, toDate: `${year}-12-31`, reason: "Year end" })));
    const sd = await prisma.shutdownPeriod.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} shutdown` } });
    ok("applies it", await hol.shutdownOpAction({}, fd({ id: sd.id, op: "apply" })));
    check("the shutdown working days are on the calendar", (await prisma.holiday.count({ where: { calendarId: cal.id, dayType: "SHUTDOWN" } })) >= 2);
    ok("cancels it, removing those days", await hol.shutdownOpAction({}, fd({ id: sd.id, op: "cancel" })));
    check("the days are gone", (await prisma.holiday.count({ where: { calendarId: cal.id, dayType: "SHUTDOWN" } })) === 0);
    ok("runs the calendar checks", await hol.syncCalendarExceptionsAction({}, fd({ year })));
    const exc = await prisma.calendarException.findFirst({ where: { tenantId: t, status: "OPEN", summary: { contains: TAG } } });
    check("conflicts are queued (holiday on a weekly off / overlapping region)", !!exc);
    if (exc) {
      refused("dismissing needs a reason", await hol.calendarExceptionOpAction({}, fd({ id: exc.id, op: "dismiss" })), /why/);
      ok("dismisses one with a reason", await hol.calendarExceptionOpAction({}, fd({ id: exc.id, op: "dismiss", note: "Accepted" })));
      ok("reopens it", await hol.calendarExceptionOpAction({}, fd({ id: exc.id, op: "reopen" })));
    }
    ok("proposes assigning the calendar", await hol.proposeCalendarAssignmentAction({}, multi({ calendarId: cal.id, employeeIds: [divya.id], effectiveFrom: iso(utcToday()), reason: "Moved to Bengaluru" })));
    const asg = await prisma.timeConfigChange.findFirstOrThrow({ where: { tenantId: t, kind: "CALENDAR_ASSIGNMENT", targetId: cal.id } });
    check("the assignment is approved", (await decide("TIME_CONFIG_CHANGE", asg.id, true)) === "APPROVED");
    check("the employee resolves to the calendar by assignment", (await svc.calendarResolution(t)).find((r) => r.employeeId === divya.id)?.how === "ASSIGNED");
    await as("priya.sharma");
    for (const tab of ["upcoming", "calendars", "rules", "daytypes", "shutdowns", "exceptions", "assignment", "history", "settings", "reports"]) await render(`holidays renders: ${tab}`, Holidays({ searchParams: sp({ tab }) }));
    await render("the history tab shows calendar changes", Holidays({ searchParams: sp({ tab: "history" }) }), "Karnataka");
    const hc = await csvOps(`kind=holidays&calendarId=${cal.id}`);
    check("the calendar exports", hc.status === 200 && hc.body.includes("Rajyotsava") && hc.body.includes("Karnataka"));
    for (const k of ["calendars", "holiday-rules", "calendar-assignments", "calendar-history"]) {
      const r = await csvOps(`kind=${k}`);
      check(`export ${k}`, r.status === 200 && r.body.split("\n").length > 1, `${r.status}`);
    }
    await as("divya.pillai");
    check("an employee cannot download calendar exports", (await csvOps("kind=calendars")).status === 403);

    // -----------------------------------------------------------------------
    section("6. Overtime rules, caps, exceptions and alerts");
    await as("priya.sharma");
    const grades = await prisma.payGrade.findMany({ where: { tenantId: t }, take: 1 });
    ok("drafts a rule with tiers, windows, caps and eligibility", await ot.saveOvertimeRuleAction({}, multi({ name: `${TAG} plant OT`, priority: 99, tiers_WORKDAY: "60:1.5, :2", tiers_WEEKLY_OFF: ":2", tiers_HOLIDAY: ":3", windows: "22:00-06:00:0.5", dailyCapHours: 2, monthlyCapHours: 10, alertMonthlyHours: 1, minMinutes: 15, requirePreApproval: true, locationIds: [divya.locationId ?? ""] })));
    refused("a malformed tier is refused", await ot.saveOvertimeRuleAction({}, fd({ name: "bad", tiers_WORKDAY: "abc" })));
    const rule1 = await prisma.overtimeRule.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} plant OT` } });
    ok("submits it", await ot.overtimeRuleOpAction({}, fd({ id: rule1.id, op: "submit" })));
    check("it is approved", (await decide("OVERTIME_RULE", rule1.id, true)) === "APPROVED");
    check("the rule is active", (await prisma.overtimeRule.findUniqueOrThrow({ where: { id: rule1.id } })).status === "ACTIVE");
    check("eligibility: it covers an employee at the location", (await svc.overtimeRuleForEmployee(t, divya.id, new Date()))?.id === rule1.id);
    check("and not one elsewhere", (await svc.overtimeRuleForEmployee(t, ramesh.id, new Date()))?.id !== rule1.id);
    if (grades[0]) check("grade eligibility filters", svc.overtimeRuleFor([{ ...rule1, status: "ACTIVE", payGradeIds: [grades[0].id], locationIds: [] }], { bandId: null, payGradeId: "other", shiftId: null, locationId: null }) === null);
    await as("divya.pillai");
    refused("pre-approval: overtime for a past day is refused", await tr.raiseOvertimeAction({}, fd({ fromDate: iso(new Date(utcToday().getTime() - DAY)), hours: "02:00", note: TAG })), /advance/);
    await as("priya.sharma");
    ok("copies the rule as a draft", await ot.overtimeRuleOpAction({}, fd({ id: rule1.id, op: "copy" })));
    const copy = await prisma.overtimeRule.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} plant OT (copy)` } });
    ok("edits the copy into a post-facto rule", await ot.saveOvertimeRuleAction({}, multi({ id: copy.id, name: `${TAG} claim window`, priority: 100, tiers_WORKDAY: ":1.5", postFactoDays: 2, locationIds: [divya.locationId ?? ""] })));
    ok("submits it", await ot.overtimeRuleOpAction({}, fd({ id: copy.id, op: "submit" })));
    check("approved", (await decide("OVERTIME_RULE", copy.id, true)) === "APPROVED");
    await as("divya.pillai");
    refused("post-approval: a claim outside the window is refused", await tr.raiseOvertimeAction({}, fd({ fromDate: iso(new Date(utcToday().getTime() - 5 * DAY)), hours: "01:00", note: TAG })), /2 day/);
    await as("priya.sharma");
    ok("retires the claim-window rule", await ot.overtimeRuleOpAction({}, fd({ id: copy.id, op: "retire" })));
    // A month of logged overtime: five 3-hour days and one 7-hour day in Feb 2024.
    const days = ["2024-02-05", "2024-02-06", "2024-02-07", "2024-02-08", "2024-02-09", "2024-02-12"];
    for (const d of days) {
      const exists = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: divya.id, date: new Date(`${d}T00:00:00Z`) } } });
      if (exists) continue;
      const r = await prisma.attendanceRecord.create({ data: { tenantId: t, employeeId: divya.id, date: new Date(`${d}T00:00:00Z`), status: "PRESENT", effectiveHours: d === "2024-02-12" ? 15 : 11, overtimeHours: d === "2024-02-12" ? 7 : 3, lastOut: new Date(`${d}T17:30:00Z`) } });
      createdAttendance.push(r.id);
    }
    const res = await svc.employeeOvertime(t, divya.id, 2024, 2);
    check("caps: payable hours are capped at the monthly cap", res?.result.payableMinutes === 600, `${res?.result.payableMinutes}`);
    check("the excess above the caps is measured", (res?.result.excessMinutes ?? 0) === 720, `${res?.result.excessMinutes}`);
    check("multiplier tiers and the night window weight the hours", (res?.result.weightedMinutes ?? 0) > 600, `${res?.result.weightedMinutes}`);
    ok("HR asks to pay the excess", await ot.raiseOvertimeExceptionAction({}, fd({ employeeId: divya.id, year: 2024, month: 2, reason: `${TAG} plant shutdown work` })));
    const ex = await prisma.overtimeException.findFirstOrThrow({ where: { tenantId: t, employeeId: divya.id, year: 2024, month: 2 } });
    check("the manager and a time administrator approve it", (await decide("OVERTIME_EXCEPTION", ex.id, true)) === "APPROVED");
    const exAfter = await prisma.overtimeException.findUniqueOrThrow({ where: { id: ex.id } });
    if (exAfter.overtimeEntryId) createdOtEntries.push(exAfter.overtimeEntryId);
    check("the approved hours went to payroll", exAfter.status === "APPROVED" && !!exAfter.overtimeEntryId);
    await as("priya.sharma");
    refused("nothing above the cap is left to approve", await ot.raiseOvertimeExceptionAction({}, fd({ employeeId: divya.id, year: 2024, month: 2, reason: "again" })), /Nothing/);
    ok("runs the alert checks for the month", await ot.runOvertimeAlertsAction({}, fd({ year: 2024, month: 2 })));
    const alerts = await prisma.overtimeAlert.findMany({ where: { tenantId: t, employeeId: divya.id, createdAt: { gte: startedAt } } });
    check("threshold and anomaly alerts were raised", alerts.some((a) => a.kind === "THRESHOLD") && alerts.some((a) => a.kind === "ANOMALY_DAILY") && alerts.some((a) => a.kind === "ANOMALY_NO_REQUEST"), alerts.map((a) => a.kind).join(","));
    ok("acknowledges one", await ot.overtimeAlertOpAction({}, fd({ id: alerts[0]!.id })));
    // Comp-off credit about to lapse.
    const types = await prisma.leaveType.findMany({ where: { tenantId: t }, select: { id: true } });
    let typeId: string | null = null;
    for (const lt of types) {
      const bal = await prisma.leaveBalance.findFirst({ where: { employeeId: divya.id, leaveTypeId: lt.id }, orderBy: { yearStart: "desc" } });
      if (!bal || Number(bal.available) > 0) { typeId = lt.id; break; }
    }
    if (typeId) {
      const le = await prisma.leaveLedgerEntry.create({ data: { tenantId: t, employeeId: divya.id, leaveTypeId: typeId, yearStart: new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)), kind: "COMP_OFF_CREDIT", days: 1, periodKey: `${TAG}-${Date.now()}`, expiresOn: new Date(utcToday().getTime() + 3 * DAY), note: TAG } });
      createdLedger.push(le.id);
      ok("comp-off expiry reminders run", await ot.runCompOffRemindersAction({}, fd({})));
      check("the employee was reminded once", (await prisma.overtimeAlert.count({ where: { tenantId: t, employeeId: divya.id, kind: "COMPOFF_EXPIRY", periodKey: `CREDIT:${le.id}` } })) === 1);
      ok("a second run does not repeat it", await ot.runCompOffRemindersAction({}, fd({})));
      check("still one reminder", (await prisma.overtimeAlert.count({ where: { tenantId: t, employeeId: divya.id, kind: "COMPOFF_EXPIRY", periodKey: `CREDIT:${le.id}` } })) === 1);
    }
    ok("overtime settings save", await pre.saveJoinSettingsAction({}, fd({ scope: "overtime", compOffReminderDays: 5, otAnomalyDailyMinutes: 300 })));
    for (const tab of ["rules", "exceptions", "alerts", "reconcile", "cost", "compoff", "settings", "reports"]) await render(`overtime rules renders: ${tab}`, OtRules({ searchParams: sp({ tab, ym: "2024-02", emp: divya.id }) }));
    await render("reconciliation compares logged and paid hours", OtRules({ searchParams: sp({ tab: "reconcile", ym: "2024-02" }) }), divya.displayName ?? "~");
    await render("the cost dashboard totals by department", OtRules({ searchParams: sp({ tab: "cost", ym: "2024-02" }) }), /department/i);
    for (const k of ["overtime-rules", "overtime-requests", "overtime-history", "overtime-alerts"]) {
      const r = await csvOps(`kind=${k}`);
      check(`export ${k}`, r.status === 200 && r.body.includes(",") && (k === "overtime-requests" || r.body.split("\n").filter(Boolean).length > 1), `${r.status}`);
    }
    check("the overtime history export includes the paid excess", (await csvOps("kind=overtime-history")).body.includes("2024-02"));
    await as("priya.sharma");
    ok("retires the plant rule", await ot.overtimeRuleOpAction({}, fd({ id: rule1.id, op: "retire" })));

    // -----------------------------------------------------------------------
    section("7. Nightly job and tenant isolation");
    const nightly = await svc.runJoinDaily(t);
    check("the nightly sweep runs every part", typeof nightly.calendarExceptions === "number" && typeof nightly.bgvSla === "number", JSON.stringify(nightly));
    const otherTenant = await prisma.tenant.findFirst({ where: { id: { not: t } } });
    if (otherTenant) check("another tenant sees none of this run's rows", (await prisma.preboardingTask.count({ where: { tenantId: otherTenant.id, title: { contains: TAG } } })) === 0 && (await prisma.overtimeRule.count({ where: { tenantId: otherTenant.id, name: { contains: TAG } } })) === 0);
  } finally {
    section("Cleanup");
    const since = { gte: startedAt };
    await prisma.employee.update({ where: { id: tanvi.id }, data: tanviBefore });
    const joinWf = Object.keys(svc.JOIN_WORKFLOW_TYPES);
    await prisma.workflowRequest.deleteMany({ where: { tenantId: t, entityType: { in: joinWf }, createdAt: since } });
    // Seeded time policies and roster cells for the people used.
    const keep = new Set(policyBefore.map((p) => p.id));
    await prisma.employeeTimePolicy.deleteMany({ where: { employeeId: { in: [divya.id, sanjay.id] }, id: { notIn: [...keep] } } });
    for (const p of policyBefore) await prisma.employeeTimePolicy.update({ where: { id: p.id }, data: { effectiveTo: p.effectiveTo, holidayCalendarId: p.holidayCalendarId } });
    await prisma.shiftAssignment.deleteMany({ where: { employeeId: { in: [divya.id, sanjay.id] }, date: { gte: rosterFrom, lte: rosterTo } } });
    if (rosterBefore.length) await prisma.shiftAssignment.createMany({ data: rosterBefore });
    await prisma.shiftAssignment.deleteMany({ where: { shift: { tenantId: t, code: "SMKSPL" } } });
    await prisma.shift.deleteMany({ where: { tenantId: t, code: "SMKSPL" } });
    // Join-area rows created by this run.
    await prisma.preboardingTask.deleteMany({ where: { tenantId: t, employeeId: tanvi.id } });
    await prisma.preboardingProvision.deleteMany({ where: { tenantId: t, employeeId: tanvi.id } });
    await prisma.preboardingTemplate.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.newHireFormSubmission.deleteMany({ where: { tenantId: t, form: { name: { startsWith: TAG } } } });
    await prisma.newHireForm.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.prejoinMessageLog.deleteMany({ where: { tenantId: t, employeeId: tanvi.id } });
    await prisma.prejoinMessage.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.onboardingBuddy.deleteMany({ where: { tenantId: t, employeeId: tanvi.id } });
    await prisma.orientationSession.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } });
    await prisma.onboardingMilestone.deleteMany({ where: { tenantId: t, employeeId: tanvi.id } });
    await prisma.journey.deleteMany({ where: { id: { in: createdJourneyIds } } });
    await prisma.journeyTemplateRevision.deleteMany({ where: { tenantId: t, templateId: { in: createdTemplateIds } } });
    await prisma.journeyTemplate.deleteMany({ where: { id: { in: createdTemplateIds } } });
    if (enrolmentCreated) await prisma.courseEnrolment.deleteMany({ where: { courseId: enrolmentCreated.courseId, employeeId: enrolmentCreated.employeeId } });
    const cases = await prisma.bgvCheck.findMany({ where: { tenantId: t, employeeId: tanvi.id, initiatedAt: since }, select: { id: true } });
    await prisma.bgvCaseEvent.deleteMany({ where: { tenantId: t, bgvCheckId: { in: cases.map((c) => c.id) } } });
    await prisma.bgvCheckItem.deleteMany({ where: { tenantId: t, bgvCheckId: { in: cases.map((c) => c.id) } } });
    await prisma.bgvCheck.deleteMany({ where: { id: { in: cases.map((c) => c.id) } } });
    await prisma.storedFile.deleteMany({ where: { tenantId: t, relatedType: "BgvReport", createdAt: since } });
    await prisma.bgvPackage.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.bgvVendor.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.shiftSwapRequest.deleteMany({ where: { tenantId: t, createdAt: since } });
    await prisma.openShift.deleteMany({ where: { tenantId: t, note: TAG } });
    await prisma.shiftPreference.deleteMany({ where: { tenantId: t, employeeId: divya.id } });
    await prisma.staffingRule.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.rosterPublication.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } });
    await prisma.timeConfigChange.deleteMany({ where: { tenantId: t, createdAt: since } });
    await prisma.weeklyOffPolicy.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.rosterPattern.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.holidayCalendarRevision.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.holidayRule.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.shutdownPeriod.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.calendarException.deleteMany({ where: { tenantId: t, firstSeenAt: since } });
    await prisma.holidayCalendar.deleteMany({ where: { tenantId: t, OR: [{ id: { in: createdCalendarIds } }, { name: { startsWith: TAG } }] } });
    await prisma.holidayDayType.deleteMany({ where: { tenantId: t, code: "SMKFEST" } });
    await prisma.overtimeAlert.deleteMany({ where: { tenantId: t, createdAt: since } });
    await prisma.overtimeException.deleteMany({ where: { tenantId: t, createdAt: since } });
    await prisma.overtimeEntry.deleteMany({ where: { id: { in: createdOtEntries } } });
    await prisma.overtimeRule.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } });
    await prisma.overtimeRequest.deleteMany({ where: { tenantId: t, note: TAG } });
    await prisma.attendanceRecord.deleteMany({ where: { id: { in: createdAttendance } } });
    await prisma.leaveLedgerEntry.deleteMany({ where: { id: { in: createdLedger } } });
    await prisma.notification.deleteMany({ where: { tenantId: t, createdAt: since } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: t, createdAt: since } }).catch(() => undefined);
    if (settingsBefore) { const { id: _i, tenantId: _t, updatedAt: _u, ...rest } = settingsBefore; await prisma.joinSetting.update({ where: { tenantId: t }, data: rest }); }
    else await prisma.joinSetting.deleteMany({ where: { tenantId: t } });
    check("cleanup finished", true);
    await prisma.$disconnect();
  }
  report("smoke-join-depth");
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
