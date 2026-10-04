/**
 * Workflow & automation, security & IAM, and compliance & audit, through the
 * actions, services, pages and exports:
 *   1. Access: who reaches Admin › Workflows / Security / Compliance.
 *   2. Workflow definitions: validation, conditions, parallel-all steps,
 *      versioning, simulation.
 *   3. General requests: approve, skip by condition, parallel approval,
 *      reject (with a reason), withdraw, maker-checker, inbox.
 *   4. Delegation, SLA escalation and reminders.
 *   5. Automation rules: draft → approval → active; request, event, date
 *      triggers; email, notification, task, webhook actions; dedupe; test,
 *      failure and retry; pause and delete.
 *   6. Webhook endpoint approval.
 *   7. Access requests with expiry and auto-revoke; temporary access;
 *      access review campaigns; inactive/orphan accounts and bulk disable.
 *   8. IP allowlist at sign-in; role, permission and policy change approval;
 *      MFA report; security alerts.
 *   9. Retention: dry run, approved purge, legal hold; deletion blocked by hold.
 *  10. Consent (versioned), compliance checklist with evidence and roll-over,
 *      policy acknowledgement campaigns, findings with escalation.
 *  11. Audit hash-chain sealing, verification and tamper detection.
 *  12. Every page and tab renders; CSV exports are permission-checked.
 *
 * Everything it creates is tagged "Smoke gov" and removed at the end, and
 * every setting it changes is restored.
 */
import { signInAs, setTestHeaders, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { PERMISSIONS as P } from "@keka/rbac";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TAG = "Smoke gov";

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}

function multi(values: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}

async function main() {
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");

  /** Resolve async server components (as Next does) so the tree renders statically. */
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
    // Spread static children back, as JSX passed them, so React does not ask for keys.
    if (children === undefined) return React.cloneElement(el, props as never);
    return Array.isArray(children) ? React.cloneElement(el, props as never, ...(children as React.ReactNode[])) : React.cloneElement(el, props as never, children as React.ReactNode);
  }
  const html = async (page: Promise<unknown>) => renderToStaticMarkup((await resolve(await page)) as Parameters<typeof renderToStaticMarkup>[0]);
  const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

  const wfAct = await import("../apps/web/src/app/actions/workflows");
  const secAct = await import("../apps/web/src/app/actions/security");
  const compAct = await import("../apps/web/src/app/actions/compliance");
  const rolesAct = await import("../apps/web/src/app/actions/roles");
  const settingsAct = await import("../apps/web/src/app/actions/settings");
  const integ = await import("../apps/web/src/app/actions/integrations");
  const employeeAct = await import("../apps/web/src/app/actions/employee");
  const auth = await import("../apps/web/src/app/actions/auth");
  const svc = await import("@keka/services");
  const { viewerForUser, requireViewer } = await import("../apps/web/src/lib/context");
  const { workflowSources } = await import("../apps/web/src/app/(app)/inbox/_take/workflows");
  const WorkflowsPage = (await import("../apps/web/src/app/(app)/admin/workflows/page")).default;
  const WorkflowDefPage = (await import("../apps/web/src/app/(app)/admin/workflows/[id]/page")).default;
  const RulePage = (await import("../apps/web/src/app/(app)/admin/workflows/rules/[id]/page")).default;
  const SecurityPage = (await import("../apps/web/src/app/(app)/admin/security/page")).default;
  const CompliancePage = (await import("../apps/web/src/app/(app)/admin/compliance/page")).default;
  const MyRequestsPage = (await import("../apps/web/src/app/(app)/me/requests/page")).default;
  const RequestDetailPage = (await import("../apps/web/src/app/(app)/me/requests/[id]/page")).default;
  const MyPoliciesPage = (await import("../apps/web/src/app/(app)/me/policies/page")).default;
  const exportRoute = await import("../apps/web/src/app/(app)/admin/governance/export/route");
  const { NextRequest } = await import("next/server");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { tenantId: t, email }, include: { employee: true } });
  const vikram = await user("vikram.menon@acme.test");
  const priya = await user("priya.sharma@acme.test");
  const meera = await user("meera.krishnan@acme.test");
  const ananya = await user("ananya.ghosh@acme.test");
  const sneha = await user("sneha.reddy@acme.test");
  const deepak = await user("deepak.chauhan@acme.test");
  const harish = await user("harish.prasad@acme.test");
  const hrExec = await prisma.role.findFirstOrThrow({ where: { tenantId: t, key: "HR_EXECUTIVE" } });
  const settingsBefore = await prisma.governanceSetting.findUnique({ where: { tenantId: t } });
  const securityBefore = await prisma.tenantSecuritySetting.findUnique({ where: { tenantId: t } });
  const startedAt = new Date();
  const task = (requestId: string, approverUserId: string) => prisma.workflowTask.findFirst({ where: { requestId, approverUserId, status: "PENDING" } });
  const reqStatus = async (id: string) => (await prisma.workflowRequest.findUniqueOrThrow({ where: { id } })).status;
  const decide = async (email: string, requestId: string, userId: string, approve: boolean, comment = "") => {
    await signInAs(email);
    const tk = await task(requestId, userId);
    return tk ? wfAct.decideWorkflowTaskAction({}, fd({ taskId: tk.id, decision: approve ? "approve" : "reject", comment })) : { ok: false, message: `no task for ${email}` };
  };
  const latestRequest = (entityType: string, entityId?: string) => prisma.workflowRequest.findFirst({ where: { tenantId: t, entityType, ...(entityId ? { entityId } : {}) }, orderBy: { createdAt: "desc" } });
  const csv = async (q: string) => {
    const res = await exportRoute.GET(new NextRequest(`http://acme.localhost/admin/governance/export?${q}`));
    return { status: res.status, body: res.status === 200 ? await res.text() : "" };
  };

  /** Remove everything the suite creates (tagged, or made since `since`); each step runs even if another fails. */
  async function cleanup(since: Date) {
    const steps: Array<() => Promise<unknown>> = [
      async () => {
        const reqs = await prisma.workflowRequest.findMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { title: { contains: TAG } }, { definition: { name: { startsWith: TAG } } }] }, select: { id: true } });
        await prisma.workflowRequest.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } });
      },
      () => prisma.notification.deleteMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since }, kind: { in: ["WORKFLOW", "AUTOMATION", "TASK", "ACCESS", "ACCESS_REVIEW", "SECURITY", "COMPLIANCE", "POLICY", "CONSENT"] } }, { title: { contains: TAG } }] } }),
      () => prisma.emailOutbox.deleteMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { subject: { contains: TAG } }] } }),
      () => prisma.workflowDefinition.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.approverDelegation.deleteMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { reason: { startsWith: TAG } }] } }),
      () => prisma.automationRule.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.workTask.deleteMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { title: { contains: TAG } }] } }),
      async () => {
        const eps = await prisma.webhookEndpoint.findMany({ where: { tenantId: t, url: "https://8.8.4.4/smoke-gov" }, select: { id: true } });
        await prisma.webhookDelivery.deleteMany({ where: { endpointId: { in: eps.map((x) => x.id) } } });
        await prisma.webhookEndpoint.deleteMany({ where: { id: { in: eps.map((x) => x.id) } } });
      },
      () => prisma.accessRequest.deleteMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { justification: { in: ["Covering onboarding for two weeks", "Changed my mind about this one"] } }] } }),
      () => prisma.userRoleAssignment.deleteMany({ where: { roleId: hrExec.id, userId: { in: [meera.id, harish.id] } } }),
      () => prisma.accessReviewCampaign.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.changeRequest.deleteMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { summary: { contains: TAG } }] } }),
      () => prisma.role.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.user.deleteMany({ where: { tenantId: t, email: "smoke-gov-orphan@acme.test" } }),
      () => prisma.ipAllowRule.deleteMany({ where: { tenantId: t, label: TAG } }),
      () => prisma.securityAlert.deleteMany({ where: { tenantId: t, OR: [{ createdAt: { gte: since } }, { summary: { contains: "smoke-gov" } }] } }),
      () => prisma.loginEvent.deleteMany({ where: { tenantId: t, OR: [{ email: { in: ["smoke-gov-target@acme.test", "smoke-gov-old@acme.test"] } }, { outcome: "IP_BLOCKED", ipAddress: "198.51.100.77" }] } }),
      () => prisma.retentionRule.deleteMany({ where: { tenantId: t, description: TAG } }),
      () => prisma.legalHold.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.consentPurpose.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } }),
      async () => {
        const items = await prisma.complianceItem.findMany({ where: { tenantId: t, title: { startsWith: TAG } }, select: { evidenceFileIds: true } });
        await prisma.storedFile.deleteMany({ where: { tenantId: t, id: { in: items.flatMap((i) => i.evidenceFileIds) } } });
        await prisma.auditFinding.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } });
        await prisma.complianceItem.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } });
      },
      async () => {
        const docs = await prisma.orgDocument.findMany({ where: { tenantId: t, title: { startsWith: TAG } }, select: { id: true } });
        await prisma.policyCampaign.deleteMany({ where: { tenantId: t, documentId: { in: docs.map((x) => x.id) } } });
        await prisma.orgDocument.deleteMany({ where: { id: { in: docs.map((x) => x.id) } } });
      },
      async () => {
        if (settingsBefore) { const { id: _id, tenantId: _t, ...rest } = settingsBefore as typeof settingsBefore & { id?: string }; await prisma.governanceSetting.update({ where: { tenantId: t }, data: rest }); }
        else await prisma.governanceSetting.deleteMany({ where: { tenantId: t } });
      },
      async () => {
        if (securityBefore) await prisma.tenantSecuritySetting.update({ where: { tenantId: t }, data: { twoFactorPolicy: securityBefore.twoFactorPolicy } });
        else await prisma.tenantSecuritySetting.deleteMany({ where: { tenantId: t } });
      },
    ];
    for (const step of steps) await step().catch((err) => console.error("  cleanup:", err instanceof Error ? err.message.split("\n").slice(-2).join(" ") : err));
  }
  // A crashed earlier run leaves tagged rows behind; clear them first.
  await cleanup(new Date());

  console.log("\nGovernance: workflow, security, compliance\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------------
    section("Access to the admin pages");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot open Workflows", await denied(() => html(WorkflowsPage({ searchParams: sp() }))));
    check("…Security", await denied(() => html(SecurityPage({ searchParams: sp() }))));
    check("…or Compliance", await denied(() => html(CompliancePage({ searchParams: sp() }))));
    check("…nor save a workflow", await denied(() => wfAct.saveWorkflowAction({}, fd({ name: "x" }))));
    check("…nor grant temporary access", await denied(() => secAct.grantTemporaryAccessAction({}, fd({}))));
    check("…nor set a retention rule", await denied(() => compAct.saveRetentionRuleAction({}, fd({}))));
    await signInAs("deepak.chauhan@acme.test");
    check("An HR executive can view Compliance", (await html(CompliancePage({ searchParams: sp() }))).includes("Compliance score"));
    check("…but not manage it", await denied(() => compAct.saveRetentionRuleAction({}, fd({ dataType: "LOGIN_EVENTS", retentionDays: 90 }))));
    await signInAs("priya.sharma@acme.test");
    check("An HR manager can open Workflows", (await html(WorkflowsPage({ searchParams: sp() }))).includes("Workflows"));
    check("…but not Security (Global Admin only)", await denied(() => html(SecurityPage({ searchParams: sp() }))));

    // -----------------------------------------------------------------------
    section("Workflow definitions");
    await signInAs("vikram.menon@acme.test");
    const badDef = await wfAct.saveWorkflowAction({}, multi({ entityType: "GENERIC_REQUEST", name: `${TAG} general`, step_name: ["Manager"], step_approverType: ["ROLE"] }));
    check("A role step without a role is refused", badDef.ok === false, badDef.message);
    const defForm = (extra: Record<string, string | string[]> = {}) => multi({
      entityType: "GENERIC_REQUEST", name: `${TAG} general`, isActive: "on", maxAmount: "500000", minDetails: "10",
      step_name: ["Manager", "Finance sign-off"], step_approverType: ["REPORTING_MANAGER", "PERMISSION"], step_approverRoleId: ["", ""], step_approverUserId: ["", ""],
      step_approverPermission: ["", "admin.workflow.manage"], step_mode: ["ANY", "ALL"], step_conditionField: ["", "amount"], step_conditionOp: ["", "GT"], step_conditionValue: ["", "50000"],
      step_slaHours: ["24", ""], step_escalateTo: ["MANAGER_OF_APPROVER", ""], step_escalateUserId: ["", ""], ...extra,
    });
    const created = await wfAct.saveWorkflowAction({}, defForm());
    let def = await prisma.workflowDefinition.findFirst({ where: { tenantId: t, name: `${TAG} general`, isCurrent: true }, include: { steps: { orderBy: { order: "asc" } } } });
    check("A two-step workflow with a condition and a parallel step is created", created.ok === true && def?.steps.length === 2 && def.steps[1]!.mode === "ALL" && def.steps[1]!.conditionValue === "50000", created.message);
    const sim = await svc.simulateWorkflow({ tenantId: t, entityType: "GENERIC_REQUEST", requesterUserId: meera.id, subjectEmployeeId: meera.employee!.id, amount: 60000 });
    check("Simulation: manager first, then both workflow admins in parallel", sim.definition?.id === def!.id && sim.steps[0]!.approvers.map((a) => a.userId).join() === ananya.id && sim.steps[1]!.applies && sim.steps[1]!.approvers.length === 2);
    const simSmall = await svc.simulateWorkflow({ tenantId: t, entityType: "GENERIC_REQUEST", requesterUserId: meera.id, subjectEmployeeId: meera.employee!.id, amount: 100 });
    check("…and the finance step is skipped under the threshold", simSmall.steps[1]!.applies === false);
    check("The designer and simulation page renders", (await html(WorkflowDefPage({ params: Promise.resolve({ id: def!.id }), searchParams: sp({ simulate: "1", employeeId: meera.employee!.id, amount: "60000" }) }))).includes("Finance sign-off"));

    // -----------------------------------------------------------------------
    section("General requests");
    await signInAs("meera.krishnan@acme.test");
    const short = await wfAct.submitGeneralRequestAction({}, fd({ category: "LETTER", title: `${TAG} letter`, details: "need it!!", amount: 100 }));
    check("Submission rules apply (details too short)", short.ok === false && /at least 10/.test(short.message ?? ""), short.message);
    const big = await wfAct.submitGeneralRequestAction({}, fd({ category: "OTHER", title: `${TAG} big`, details: "a very large request", amount: 900000 }));
    check("…and the amount ceiling", big.ok === false && /cannot exceed/.test(big.message ?? ""), big.message);
    const submit = async (title: string, amount: number) => {
      await signInAs("meera.krishnan@acme.test");
      const r = await wfAct.submitGeneralRequestAction({}, fd({ category: "OTHER", title: `${TAG} ${title}`, details: "Smoke test request details", amount }));
      return { r, req: await prisma.workflowRequest.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} ${title}` } }) };
    };
    const a = await submit("small", 1000);
    check("A request goes to the requester's manager", a.r.ok === true && a.req.status === "PENDING" && !!(await task(a.req.id, ananya.id)) && a.req.definitionId === def!.id, a.r.message);
    const ananyaViewer = await viewerForUser(ananya.id);
    const [wfSource] = await workflowSources(ananyaViewer!);
    check("It shows in the manager's inbox", (await wfSource!.count()) >= 1 && (await wfSource!.list()).some((x) => x.title === `${TAG} small`));
    const tA = await task(a.req.id, ananya.id);
    check("…with a detail pane", !!(await wfSource!.detail(tA!.id)));
    await signInAs("meera.krishnan@acme.test");
    const self = await wfAct.decideWorkflowTaskAction({}, fd({ taskId: tA!.id, decision: "approve" }));
    check("The requester cannot decide it", self.ok === false, self.message);
    const appA = await decide("ananya.ghosh@acme.test", a.req.id, ananya.id, true, "fine");
    const evA = await prisma.workflowEvent.findMany({ where: { requestId: a.req.id } });
    check("Approved by the manager; the finance step is skipped by its condition", appA.ok === true && (await reqStatus(a.req.id)) === "APPROVED" && evA.some((e) => e.kind === "SKIPPED"), appA.message);
    check("The requester is notified", (await prisma.notification.count({ where: { userId: meera.id, title: `${TAG} small: approved` } })) === 1);

    const b = await submit("large", 60000);
    await decide("ananya.ghosh@acme.test", b.req.id, ananya.id, true);
    const parallel = await prisma.workflowTask.findMany({ where: { requestId: b.req.id, stepOrder: 1 } });
    check("Above the threshold, both workflow admins must approve", parallel.length === 2 && (await reqStatus(b.req.id)) === "PENDING");
    const v1 = await decide("vikram.menon@acme.test", b.req.id, vikram.id, true);
    check("One approval is not enough", v1.ok === true && (await reqStatus(b.req.id)) === "PENDING", v1.message);
    await decide("priya.sharma@acme.test", b.req.id, priya.id, true);
    check("Both approvals complete it", (await reqStatus(b.req.id)) === "APPROVED");

    const c = await submit("rejected", 500);
    const noReason = await decide("ananya.ghosh@acme.test", c.req.id, ananya.id, false);
    check("Rejecting needs a reason", noReason.ok === false, noReason.message);
    await decide("ananya.ghosh@acme.test", c.req.id, ananya.id, false, "Not needed");
    check("Rejected with the reason recorded", (await reqStatus(c.req.id)) === "REJECTED" && (await prisma.workflowTask.findFirst({ where: { requestId: c.req.id, status: "REJECTED" } }))?.comment === "Not needed");

    const d = await submit("withdrawn", 500);
    await signInAs("ananya.ghosh@acme.test");
    check("Only the requester can withdraw", (await wfAct.withdrawWorkflowAction({}, fd({ requestId: d.req.id }))).ok === false);
    await signInAs("meera.krishnan@acme.test");
    await wfAct.withdrawWorkflowAction({}, fd({ requestId: d.req.id }));
    check("Withdrawn; its open task is cancelled", (await reqStatus(d.req.id)) === "WITHDRAWN" && (await prisma.workflowTask.count({ where: { requestId: d.req.id, status: "PENDING" } })) === 0);
    check("The request detail page renders its history", (await html(RequestDetailPage({ params: Promise.resolve({ id: b.req.id }) }))).includes("History"));
    await signInAs("sneha.reddy@acme.test");
    check("Someone uninvolved cannot open it", await denied(() => html(RequestDetailPage({ params: Promise.resolve({ id: b.req.id }) }))));

    section("Versioning");
    await signInAs("vikram.menon@acme.test");
    const v2 = await wfAct.saveWorkflowAction({}, defForm({ id: def!.id, maxAmount: "400000" }));
    const versions = await prisma.workflowDefinition.findMany({ where: { tenantId: t, family: def!.family }, orderBy: { version: "asc" } });
    check("Editing a used workflow publishes version 2", v2.ok === true && versions.length === 2 && !versions[0]!.isCurrent && versions[1]!.isCurrent && versions[1]!.version === 2, v2.message);
    check("Requests already decided stay on version 1", (await prisma.workflowRequest.findUniqueOrThrow({ where: { id: a.req.id } })).definitionId === versions[0]!.id);
    const v2b = await wfAct.saveWorkflowAction({}, defForm({ id: versions[1]!.id, maxAmount: "450000" }));
    check("An unused version is edited in place", v2b.ok === true && (await prisma.workflowDefinition.count({ where: { family: def!.family } })) === 2, v2b.message);
    def = await prisma.workflowDefinition.findFirstOrThrow({ where: { id: versions[1]!.id }, include: { steps: true } });

    // -----------------------------------------------------------------------
    section("Delegation, escalation and reminders");
    const e = await submit("delegated", 100);
    await signInAs("ananya.ghosh@acme.test");
    const today = iso(new Date());
    const del = await wfAct.createDelegationAction({}, fd({ delegateUserId: sneha.id, startsOn: today, endsOn: iso(new Date(Date.now() + 3 * DAY)), handOver: true, reason: `${TAG} leave` }));
    check("An approver delegates while away; waiting approvals are handed over", del.ok === true && !!(await task(e.req.id, sneha.id)) && (await prisma.workflowTask.findFirst({ where: { requestId: e.req.id, approverUserId: sneha.id } }))?.delegatedFromUserId === ananya.id, del.message);
    const f2 = await submit("routed to delegate", 100);
    check("New approvals go straight to the delegate", !!(await task(f2.req.id, sneha.id)) && !(await task(f2.req.id, ananya.id)));
    const delegation = await prisma.approverDelegation.findFirstOrThrow({ where: { tenantId: t, delegatorUserId: ananya.id, revokedAt: null } });
    await signInAs("ananya.ghosh@acme.test");
    await wfAct.revokeDelegationAction({}, fd({ id: delegation.id }));
    const g = await submit("escalated", 100);
    check("After the delegation ends, approvals come back", !!(await task(g.req.id, ananya.id)));
    const gTask = (await task(g.req.id, ananya.id))!;
    check("The step's 24h SLA sets a due time", !!gTask.dueAt && Math.abs(gTask.dueAt.getTime() - gTask.createdAt.getTime() - 24 * 3_600_000) < 60_000);
    const timers = await svc.runWorkflowTimers(t, new Date(Date.now() + 25 * 3_600_000));
    const escalatedTo = await task(g.req.id, sneha.id);
    check("Past its SLA it escalates to the approver's manager", timers.escalated >= 1 && !!escalatedTo && (await prisma.workflowTask.findUniqueOrThrow({ where: { id: gTask.id } })).status === "ESCALATED");
    check("…and stale approvals get a reminder", timers.reminded >= 1 && (await prisma.workflowEvent.count({ where: { requestId: { in: [e.req.id, f2.req.id] }, kind: "REMINDED" } })) >= 1);
    const again = await svc.runWorkflowTimers(t, new Date(Date.now() + 25 * 3_600_000));
    check("Timers do not escalate or remind twice", (await prisma.workflowTask.count({ where: { requestId: g.req.id, approverUserId: sneha.id } })) === 1 && again.escalated === 0);
    const escApp = await decide("sneha.reddy@acme.test", g.req.id, sneha.id, true);
    check("The escalation target can decide it", escApp.ok === true && (await reqStatus(g.req.id)) === "APPROVED", escApp.message);
    for (const r of [e, f2]) { await signInAs("meera.krishnan@acme.test"); await wfAct.withdrawWorkflowAction({}, fd({ requestId: r.req.id })); }

    // -----------------------------------------------------------------------
    section("Webhook endpoint approval");
    await signInAs("vikram.menon@acme.test");
    setTestHeaders({ "x-forwarded-for": "203.0.113.9" });
    const govForm = (o: Record<string, string | boolean>) => fd({ inactiveDays: 90, failedLoginAlert: 5, reminderHours: 24, ...o });
    await secAct.saveGovernanceSettingsAction({}, govForm({ webhookApproval: true }));
    const hook = await integ.createWebhookAction({}, multi({ url: "https://8.8.4.4/smoke-gov", events: ["automation.triggered", "workflow.completed"], description: TAG }));
    const ep = await prisma.webhookEndpoint.findFirstOrThrow({ where: { tenantId: t, url: "https://8.8.4.4/smoke-gov" } });
    check("A new endpoint waits for approval, inactive", hook.ok === true && ep.approvalStatus === "PENDING_APPROVAL" && !ep.isActive, hook.message);
    check("It cannot be resumed or pinged before approval", (await integ.webhookOpAction({}, fd({ id: ep.id, op: "ping" }))).ok === false);
    const epReq = (await latestRequest("WEBHOOK_ENDPOINT", ep.id))!;
    await decide("priya.sharma@acme.test", epReq.id, priya.id, true);
    const epAfter = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
    check("Approved by another administrator, it goes live", epAfter.approvalStatus === "APPROVED" && epAfter.isActive);

    // -----------------------------------------------------------------------
    section("Automation rules");
    await signInAs("vikram.menon@acme.test");
    const noAct = await wfAct.saveAutomationRuleAction({}, fd({ name: `${TAG} rule`, trigger: "REQUEST_APPROVED" }));
    check("A rule needs an action", noAct.ok === false, noAct.message);
    const badTo = await wfAct.saveAutomationRuleAction({}, multi({ name: `${TAG} rule`, trigger: "REQUEST_APPROVED", act_type: ["NOTIFY"], act_to: ["nobody"], act_subject: ["x"], act_body: [""], act_endpointId: [""], act_templateId: [""], act_dueInDays: [""] }));
    check("…with a valid recipient", badTo.ok === false, badTo.message);
    const ruleForm = (name: string, trigger: string, acts: Array<Partial<Record<"type" | "to" | "subject" | "body" | "endpointId" | "templateId" | "dueInDays", string>>>, extra: Record<string, string> = {}) => multi({
      name: `${TAG} ${name}`, trigger, ...extra,
      act_type: acts.map((x) => x.type ?? "NOTIFY"), act_to: acts.map((x) => x.to ?? ""), act_subject: acts.map((x) => x.subject ?? ""), act_body: acts.map((x) => x.body ?? ""),
      act_endpointId: acts.map((x) => x.endpointId ?? ""), act_templateId: acts.map((x) => x.templateId ?? ""), act_dueInDays: acts.map((x) => x.dueInDays ?? ""),
    });
    const saved = await wfAct.saveAutomationRuleAction({}, ruleForm("on approval", "REQUEST_APPROVED", [
      { type: "EMAIL", to: "EMPLOYEE", subject: "Approved: {{title}}", body: "Hello {{first_name}}, {{title}} was approved." },
      { type: "TASK", to: `USER:${priya.id}`, subject: "Follow up {{title}}", dueInDays: "2" },
      { type: "WEBHOOK", endpointId: ep.id },
    ], { entityType: "GENERIC_REQUEST" }));
    const rule = await prisma.automationRule.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} on approval` } });
    check("A rule is saved as a draft", saved.ok === true && rule.status === "DRAFT", saved.message);
    const sub = await wfAct.automationRuleOpAction({}, fd({ id: rule.id, op: "submit" }));
    check("Submitting sends it for activation approval", sub.ok === true && (await prisma.automationRule.findUniqueOrThrow({ where: { id: rule.id } })).status === "PENDING_APPROVAL", sub.message);
    const ruleReq = (await latestRequest("AUTOMATION_RULE", rule.id))!;
    await decide("priya.sharma@acme.test", ruleReq.id, priya.id, true);
    check("Another workflow administrator activates it", (await prisma.automationRule.findUniqueOrThrow({ where: { id: rule.id } })).status === "ACTIVE");
    const h = await submit("fires automation", 200);
    await decide("ananya.ghosh@acme.test", h.req.id, ananya.id, true);
    const run = await prisma.automationRun.findFirst({ where: { ruleId: rule.id, subjectId: h.req.id } });
    const mail = await prisma.emailOutbox.findFirst({ where: { tenantId: t, relatedId: rule.id, toAddress: meera.email.toLowerCase() }, orderBy: { createdAt: "desc" } });
    const wt = await prisma.workTask.findFirst({ where: { tenantId: t, sourceId: rule.id, assigneeUserId: priya.id }, orderBy: { createdAt: "desc" } });
    const delivery = await prisma.webhookDelivery.findFirst({ where: { endpointId: ep.id, event: "automation.triggered" } });
    check("On approval the rule emails the employee through the outbox", run?.status === "SUCCESS" && !!mail && mail.subject === `Approved: ${TAG} fires automation`, run?.error ?? "");
    check("…creates a task for HR", !!wt && !!wt.dueOn);
    check("…and queues a signed webhook", !!delivery);
    const priyaViewer = await viewerForUser(priya.id);
    const taskSource = (await workflowSources(priyaViewer!))[1]!;
    check("The task shows in the assignee's inbox", (await taskSource.list()).some((x) => x.id === wt!.id) && !!(await taskSource.detail(wt!.id)));
    await signInAs("priya.sharma@acme.test");
    await wfAct.completeWorkTaskAction({}, fd({ id: wt!.id }));
    check("…and can be marked done", (await prisma.workTask.findUniqueOrThrow({ where: { id: wt!.id } })).status === "DONE");

    await signInAs("vikram.menon@acme.test");
    await wfAct.saveAutomationRuleAction({}, ruleForm("on update", "EMPLOYEE_UPDATED", [{ type: "NOTIFY", to: "MANAGER", subject: "{{name}}'s profile changed" }]));
    const evRule = await prisma.automationRule.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} on update` } });
    await wfAct.automationRuleOpAction({}, fd({ id: evRule.id, op: "submit" }));
    await decide("priya.sharma@acme.test", (await latestRequest("AUTOMATION_RULE", evRule.id))!.id, priya.id, true);
    await new Promise((r) => setTimeout(r, 20));
    await prisma.employee.update({ where: { id: meera.employee!.id }, data: { aboutMe: meera.employee!.aboutMe } });
    const ev1 = await svc.runEventAutomations(t);
    const ev2 = await svc.runEventAutomations(t);
    check("An event rule fires for a changed employee, once", ev1.fired >= 1 && (await prisma.automationRun.count({ where: { ruleId: evRule.id, subjectId: meera.employee!.id } })) === 1 && ev2.fired === 0);
    check("…notifying their manager", (await prisma.notification.count({ where: { userId: ananya.id, kind: "AUTOMATION", createdAt: { gte: startedAt } } })) >= 1);

    await signInAs("vikram.menon@acme.test");
    await wfAct.saveAutomationRuleAction({}, ruleForm("anniversary", "WORK_ANNIVERSARY", [{ type: "NOTIFY", to: "EMPLOYEE", subject: "Happy work anniversary, {{first_name}}" }], { offsetDays: "0" }));
    const dateRule = await prisma.automationRule.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} anniversary` } });
    await prisma.automationRule.update({ where: { id: dateRule.id }, data: { status: "ACTIVE" } });
    const doj = meera.employee!.dateOfJoining;
    const annDay = new Date(Date.UTC(new Date().getUTCFullYear() + 1, doj.getUTCMonth(), Math.min(doj.getUTCDate(), 28)));
    if (doj.getUTCDate() > 28) await prisma.employee.update({ where: { id: meera.employee!.id }, data: { dateOfJoining: new Date(Date.UTC(doj.getUTCFullYear(), doj.getUTCMonth(), 28)) } });
    const dr1 = await svc.runDateAutomations(t, annDay);
    const dr2 = await svc.runDateAutomations(t, annDay);
    check("A date rule fires on the work anniversary, once", dr1.fired >= 1 && (await prisma.automationRun.count({ where: { ruleId: dateRule.id, subjectId: meera.employee!.id } })) === 1 && dr2.fired === 0);
    if (doj.getUTCDate() > 28) await prisma.employee.update({ where: { id: meera.employee!.id }, data: { dateOfJoining: doj } });

    const tested = await wfAct.automationRuleOpAction({}, fd({ id: evRule.id, op: "test", employeeId: vikram.employee!.id }));
    const failedRun = await prisma.automationRun.findFirst({ where: { ruleId: evRule.id, status: "FAILED" } });
    check("Testing a rule on someone with no manager records a failed run", tested.ok === false && !!failedRun?.error, tested.message);
    const retried = await wfAct.retryAutomationRunAction({}, fd({ id: failedRun!.id }));
    check("A failed run can be retried (and fails again, logged)", retried.ok === false && (await prisma.automationRun.count({ where: { ruleId: evRule.id, status: "FAILED" } })) === 1, retried.message);
    const okTest = await wfAct.automationRuleOpAction({}, fd({ id: evRule.id, op: "test", employeeId: meera.employee!.id }));
    check("A test on an employee with a manager succeeds", okTest.ok === true, okTest.message);
    await wfAct.automationRuleOpAction({}, fd({ id: evRule.id, op: "pause" }));
    check("A rule can be paused", (await prisma.automationRule.findUniqueOrThrow({ where: { id: evRule.id } })).status === "PAUSED");
    await wfAct.saveAutomationRuleAction({}, ruleForm("on update", "EMPLOYEE_UPDATED", [{ type: "NOTIFY", to: "HR", subject: "Changed" }], { id: evRule.id }));
    check("Editing puts it back to draft", (await prisma.automationRule.findUniqueOrThrow({ where: { id: evRule.id } })).status === "DRAFT");
    check("The rule page renders with its run log", (await html(RulePage({ params: Promise.resolve({ id: evRule.id }) }))).includes("Run log"));

    // -----------------------------------------------------------------------
    section("Access requests and time-bound access");
    await signInAs("meera.krishnan@acme.test");
    const vague = await secAct.requestAccessAction({}, fd({ roleId: hrExec.id, justification: "need", durationDays: 7 }));
    check("An access request needs a justification", vague.ok === false, vague.message);
    const ar = await secAct.requestAccessAction({}, fd({ roleId: hrExec.id, justification: "Covering onboarding for two weeks", durationDays: 7 }));
    const accessReq = await prisma.accessRequest.findFirstOrThrow({ where: { tenantId: t, targetUserId: meera.id, roleId: hrExec.id, status: "PENDING" } });
    check("Meera asks for HR Executive for 7 days", ar.ok === true && !!accessReq.workflowRequestId, ar.message);
    const dup = await secAct.requestAccessAction({}, fd({ roleId: hrExec.id, justification: "Covering onboarding for two weeks", durationDays: 7 }));
    check("…not twice", dup.ok === false, dup.message);
    await decide("ananya.ghosh@acme.test", accessReq.workflowRequestId!, ananya.id, true);
    check("Her manager approves, then it waits on a security administrator", (await prisma.accessRequest.findUniqueOrThrow({ where: { id: accessReq.id } })).status === "PENDING" && !!(await task(accessReq.workflowRequestId!, vikram.id)));
    await decide("vikram.menon@acme.test", accessReq.workflowRequestId!, vikram.id, true);
    const granted = await prisma.accessRequest.findUniqueOrThrow({ where: { id: accessReq.id } });
    const assignment = await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: meera.id, roleId: hrExec.id } } });
    check("Approved: the role is granted with an expiry", granted.status === "APPROVED" && !!assignment?.expiresAt && Math.abs(assignment.expiresAt.getTime() - Date.now() - 7 * DAY) < 120_000);
    await signInAs("meera.krishnan@acme.test");
    check("Her permissions include it", (await requireViewer()).roleNames.includes(hrExec.name));
    await prisma.userRoleAssignment.update({ where: { id: assignment!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await signInAs("meera.krishnan@acme.test");
    check("An expired grant stops working at once", !(await requireViewer()).roleNames.includes(hrExec.name));
    const revoked = await svc.revokeExpiredGrants(t);
    check("…and the nightly job removes it", revoked.revoked >= 1 && !(await prisma.userRoleAssignment.findUnique({ where: { id: assignment!.id } })) && (await prisma.accessRequest.findUniqueOrThrow({ where: { id: accessReq.id } })).status === "EXPIRED");
    await signInAs("meera.krishnan@acme.test");
    await secAct.requestAccessAction({}, fd({ roleId: hrExec.id, justification: "Changed my mind about this one", durationDays: "" }));
    const ar2 = await prisma.accessRequest.findFirstOrThrow({ where: { tenantId: t, targetUserId: meera.id, status: "PENDING" } });
    await secAct.withdrawAccessRequestAction({}, fd({ id: ar2.id }));
    check("A pending access request can be withdrawn", (await prisma.accessRequest.findUniqueOrThrow({ where: { id: ar2.id } })).status === "WITHDRAWN" && (await reqStatus(ar2.workflowRequestId!)) === "WITHDRAWN");
    check("My requests › Access renders", (await html(MyRequestsPage({ searchParams: sp({ tab: "access" }) }))).includes("Request access"));

    await signInAs("vikram.menon@acme.test");
    const tooLong = await secAct.grantTemporaryAccessAction({}, fd({ userId: harish.id, roleId: hrExec.id, days: 120, reason: "Cover" }));
    check("Temporary access is limited to 90 days", tooLong.ok === false, tooLong.message);
    const temp = await secAct.grantTemporaryAccessAction({}, fd({ userId: harish.id, roleId: hrExec.id, days: 3, reason: `${TAG} cover` }));
    const tempA = await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: harish.id, roleId: hrExec.id } } });
    check("An administrator grants 3 days of elevated access", temp.ok === true && !!tempA?.expiresAt, temp.message);
    await secAct.endTemporaryGrantAction({}, fd({ id: tempA!.id }));
    check("…and can end it early", !(await prisma.userRoleAssignment.findUnique({ where: { id: tempA!.id } })));

    section("Access reviews");
    const reviewRole = await prisma.role.create({ data: { tenantId: t, name: `${TAG} reviewed role`, permissions: { create: [{ permission: P.EMPLOYEE_VIEW_ALL }] } } });
    await svc.grantRole({ tenantId: t, userId: meera.id, roleId: reviewRole.id, expiresAt: null, note: TAG, grantedBy: vikram.id });
    await svc.grantRole({ tenantId: t, userId: harish.id, roleId: reviewRole.id, expiresAt: null, note: TAG, grantedBy: vikram.id });
    const rv = await secAct.createAccessReviewAction({}, multi({ name: `${TAG} review`, reviewerMode: "MANAGER", reviewerUserId: vikram.id, roleIds: [reviewRole.id], dueOn: iso(new Date(Date.now() + 7 * DAY)), closeAction: "KEEP" }));
    const camp = await prisma.accessReviewCampaign.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} review` }, include: { items: true } });
    check("A review snapshots each grant, routed to each person's manager", rv.ok === true && camp.items.length === 2 && camp.items.every((i) => i.reviewerUserId === ananya.id), rv.message);
    const meeraItem = camp.items.find((i) => i.userId === meera.id)!, harishItem = camp.items.find((i) => i.userId === harish.id)!;
    await signInAs("sneha.reddy@acme.test");
    check("Someone else cannot decide an item", (await secAct.decideAccessReviewAction({}, fd({ itemId: meeraItem.id, decision: "CONFIRMED" }))).ok === false);
    await signInAs("ananya.ghosh@acme.test");
    check("The reviewer sees them under My requests › Access reviews", (await html(MyRequestsPage({ searchParams: sp({ tab: "reviews" }) }))).includes(`${TAG} reviewed role`));
    await secAct.decideAccessReviewAction({}, fd({ itemId: meeraItem.id, decision: "CONFIRMED" }));
    await secAct.decideAccessReviewAction({}, fd({ itemId: harishItem.id, decision: "REVOKED" }));
    check("Confirm keeps the role; revoke removes it", !!(await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: meera.id, roleId: reviewRole.id } } })) && !(await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: harish.id, roleId: reviewRole.id } } })));
    await signInAs("vikram.menon@acme.test");
    await secAct.createAccessReviewAction({}, multi({ name: `${TAG} review 2`, reviewerMode: "USER", reviewerUserId: priya.id, roleIds: [reviewRole.id], dueOn: iso(new Date(Date.now() + 7 * DAY)), closeAction: "REVOKE" }));
    const camp2 = await prisma.accessReviewCampaign.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} review 2` } });
    const closed = await secAct.closeAccessReviewAction({}, fd({ id: camp2.id }));
    check("Closing a revoke-on-close review removes what nobody certified", closed.ok === true && !(await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: meera.id, roleId: reviewRole.id } } })), closed.message);
    const rvCsv = await csv(`report=access-review&id=${camp.id}`);
    check("The review exports as CSV", rvCsv.status === 200 && rvCsv.body.includes("Reviewer") && rvCsv.body.includes("REVOKED"));

    section("Inactive and orphan accounts");
    const orphan = await prisma.user.create({ data: { tenantId: t, email: "smoke-gov-orphan@acme.test", passwordHash: "x", createdAt: new Date(Date.now() - 200 * DAY) } });
    const hygiene = await svc.accountHygiene(t);
    const orphanRow = hygiene.find((r) => r.userId === orphan.id);
    check("A login unused for 200 days with no employee is flagged inactive and orphan", !!orphanRow?.inactive && !!orphanRow.orphan);
    const selfDisable = await secAct.bulkDisableAction({}, multi({ userIds: [vikram.id] }));
    check("An administrator cannot bulk-disable themselves", selfDisable.ok === false, selfDisable.message);
    const bulk = await secAct.bulkDisableAction({}, multi({ userIds: [orphan.id] }));
    const orphanAfter = await prisma.user.findUniqueOrThrow({ where: { id: orphan.id } });
    check("Bulk disable signs the account out", bulk.ok === true && orphanAfter.loginDisabled && orphanAfter.sessionVersion === orphan.sessionVersion + 1, bulk.message);

    // -----------------------------------------------------------------------
    section("IP allowlist at sign-in");
    check("An invalid range is refused", (await secAct.addIpRuleAction({}, fd({ cidr: "office" }))).ok === false);
    await secAct.addIpRuleAction({}, fd({ cidr: "203.0.113.0/24", label: TAG }));
    setTestHeaders({ "x-forwarded-for": "198.51.100.1" });
    const lockout = await secAct.saveGovernanceSettingsAction({}, govForm({ ipAllowlistEnforced: true }));
    check("Enforcing from an address outside the list is refused (no self lock-out)", lockout.ok === false && /not on the list/.test(lockout.message ?? ""), lockout.message);
    setTestHeaders({ "x-forwarded-for": "203.0.113.9" });
    const enforce = await secAct.saveGovernanceSettingsAction({}, govForm({ ipAllowlistEnforced: true }));
    check("Enforced from an allowed address", enforce.ok === true, enforce.message);
    setTestHeaders({ "x-forwarded-for": "198.51.100.77" });
    const blocked = await auth.signIn({}, fd({ email: "meera.krishnan@acme.test", password: "Keka@2026", subdomain: "acme" }));
    check("Sign-in from outside the list is refused and logged", /approved networks/.test(blocked.error ?? "") && (await prisma.loginEvent.count({ where: { tenantId: t, outcome: "IP_BLOCKED", ipAddress: "198.51.100.77" } })) >= 1, blocked.error);
    check("…while an address on the list passes the check", await svc.signInIpAllowed(t, "203.0.113.50"));
    setTestHeaders({ "x-forwarded-for": "203.0.113.9" });
    await signInAs("vikram.menon@acme.test");
    check("Security › IP allowlist renders", (await html(SecurityPage({ searchParams: sp({ tab: "network" }) }))).includes("203.0.113.0/24"));
    const lastRule = await prisma.ipAllowRule.findFirstOrThrow({ where: { tenantId: t, cidr: "203.0.113.0/24" } });
    check("The last range cannot be removed while enforced", (await secAct.removeIpRuleAction({}, fd({ id: lastRule.id }))).ok === false);
    await secAct.saveGovernanceSettingsAction({}, govForm({ webhookApproval: true }));
    await secAct.removeIpRuleAction({}, fd({ id: lastRule.id }));

    section("Security alerts");
    await prisma.loginEvent.createMany({ data: Array.from({ length: 6 }, () => ({ tenantId: t, email: "smoke-gov-target@acme.test", ipAddress: "198.51.100.5", success: false, outcome: "BAD_CREDENTIALS" })) });
    await secAct.scanSecurityNowAction({}, fd({}));
    const alert = await prisma.securityAlert.findFirst({ where: { tenantId: t, kind: "FAILED_LOGINS", summary: { contains: "smoke-gov-target" } } });
    check("Repeated failed sign-ins raise an alert", !!alert && alert.status === "OPEN");
    check("…and an alert for the refused address", (await prisma.securityAlert.count({ where: { tenantId: t, kind: "IP_BLOCKED", createdAt: { gte: startedAt } } })) >= 1);
    const rescan = await svc.securityScan(t);
    check("Scanning again raises nothing new", rescan.raised === 0);
    await secAct.acknowledgeAlertAction({}, fd({ id: alert!.id }));
    check("An alert is acknowledged", (await prisma.securityAlert.findUniqueOrThrow({ where: { id: alert!.id } })).status === "ACKNOWLEDGED");
    check("A privileged access grant raises an alert (and only then)", (await prisma.securityAlert.count({ where: { tenantId: t, kind: "PRIVILEGED_GRANT", dedupeKey: `PRIVILEGED_GRANT:${accessReq.id}` } })) === (granted.privileged ? 1 : 0));

    section("Change approval (maker-checker)");
    await secAct.saveGovernanceSettingsAction({}, govForm({ webhookApproval: true, roleChangeApproval: true, policyChangeApproval: true }));
    const grantReq = await rolesAct.assignRoleAction({}, multi({ roleId: reviewRole.id, employeeId: harish.employee!.id }));
    const cr = await prisma.changeRequest.findFirst({ where: { tenantId: t, kind: "ROLE_GRANT", requestedBy: vikram.id }, orderBy: { createdAt: "desc" } });
    check("A role grant waits for a second administrator", grantReq.ok === true && cr?.status === "PENDING" && !(await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: harish.id, roleId: reviewRole.id } } })), grantReq.message);
    await decide("priya.sharma@acme.test", cr!.workflowRequestId!, priya.id, true);
    check("…and applies once approved", (await prisma.changeRequest.findUniqueOrThrow({ where: { id: cr!.id } })).status === "APPLIED" && !!(await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: harish.id, roleId: reviewRole.id } } })));
    await signInAs("vikram.menon@acme.test");
    const permReq = await rolesAct.saveCustomRoleAction({}, multi({ id: reviewRole.id, name: reviewRole.name, permission: [P.EMPLOYEE_VIEW, P.EMPLOYEE_VIEW_ALL] }));
    const cr2 = await prisma.changeRequest.findFirstOrThrow({ where: { tenantId: t, kind: "ROLE_PERMISSIONS" }, orderBy: { createdAt: "desc" } });
    check("A permission change waits too", permReq.ok === true && cr2.status === "PENDING" && (await prisma.rolePermission.count({ where: { roleId: reviewRole.id } })) === 1, permReq.message);
    await decide("priya.sharma@acme.test", cr2.workflowRequestId!, priya.id, false, "Not now");
    check("…and a rejection leaves the role unchanged", (await prisma.changeRequest.findUniqueOrThrow({ where: { id: cr2.id } })).status === "REJECTED" && (await prisma.rolePermission.count({ where: { roleId: reviewRole.id } })) === 1);
    await signInAs("vikram.menon@acme.test");
    const sec = securityBefore ?? { minPasswordLength: 8, requireMixedCase: false, requireNumber: false, requireSymbol: false, passwordExpiryDays: null, passwordHistoryCount: 0, maxFailedAttempts: 5, lockoutMinutes: 15, sessionHours: 12, twoFactorPolicy: "OFF" };
    const policyReq = await settingsAct.saveSecurityPolicy({}, fd({ ...sec, passwordExpiryDays: sec.passwordExpiryDays ?? "", requireMixedCase: sec.requireMixedCase, requireNumber: sec.requireNumber, requireSymbol: sec.requireSymbol, twoFactorPolicy: "ADMINS" }));
    const cr3 = await prisma.changeRequest.findFirst({ where: { tenantId: t, kind: "SECURITY_POLICY" }, orderBy: { createdAt: "desc" } });
    check("A security policy change waits for approval", policyReq.ok === true && cr3?.status === "PENDING" && (await prisma.tenantSecuritySetting.findUnique({ where: { tenantId: t } }))?.twoFactorPolicy === (securityBefore?.twoFactorPolicy ?? undefined), policyReq.message);
    await decide("priya.sharma@acme.test", cr3!.workflowRequestId!, priya.id, true);
    check("…and applies once approved", (await prisma.tenantSecuritySetting.findUnique({ where: { tenantId: t } }))?.twoFactorPolicy === "ADMINS");
    const mfa = await svc.mfaReport(t);
    check("The MFA report shows role holders now required to use 2FA", mfa.policy === "ADMINS" && mfa.rows.some((r) => r.userId === vikram.id && r.required) && mfa.adminsWithout === 0);
    if (securityBefore) await prisma.tenantSecuritySetting.update({ where: { tenantId: t }, data: { twoFactorPolicy: securityBefore.twoFactorPolicy } });
    else await prisma.tenantSecuritySetting.deleteMany({ where: { tenantId: t } });
    const mfaOff = await svc.mfaReport(t);
    check("With 2FA off, the report lists role holders without it", mfaOff.policy !== "OFF" || mfaOff.adminsWithout > 0);
    await signInAs("vikram.menon@acme.test");
    await secAct.saveGovernanceSettingsAction({}, govForm({}));

    // -----------------------------------------------------------------------
    section("Retention and legal hold");
    const tooShort = await compAct.saveRetentionRuleAction({}, fd({ dataType: "LOGIN_EVENTS", retentionDays: 10 }));
    check("Retention below the minimum is refused", tooShort.ok === false, tooShort.message);
    await compAct.saveRetentionRuleAction({}, fd({ dataType: "LOGIN_EVENTS", retentionDays: 30, description: TAG }));
    const rRule = await prisma.retentionRule.findFirstOrThrow({ where: { tenantId: t, dataType: "LOGIN_EVENTS" } });
    await prisma.loginEvent.createMany({ data: Array.from({ length: 3 }, () => ({ tenantId: t, email: "smoke-gov-old@acme.test", success: true, outcome: "OK", createdAt: new Date(Date.now() - 60 * DAY) })) });
    const early = await compAct.retentionOpAction({}, fd({ id: rRule.id, op: "purge" }));
    check("A purge needs a dry run first", early.ok === false && /dry run/i.test(early.message ?? ""), early.message);
    const hold = await compAct.createLegalHoldAction({}, fd({ name: `${TAG} hold`, reason: "Pending litigation", dataType: "LOGIN_EVENTS" }));
    const dry = await compAct.retentionOpAction({}, fd({ id: rRule.id, op: "dry-run" }));
    const dryRun = await prisma.retentionRun.findFirstOrThrow({ where: { ruleId: rRule.id, status: "DRY_RUN" }, orderBy: { createdAt: "desc" } });
    check("Under a tenant-wide hold, a dry run counts but holds everything back", hold.ok === true && dryRun.matched >= 3 && dryRun.heldBack === dryRun.matched && (await prisma.loginEvent.count({ where: { email: "smoke-gov-old@acme.test" } })) === 3, dry.message);
    const heldHold = await prisma.legalHold.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} hold` } });
    await compAct.releaseLegalHoldAction({}, fd({ id: heldHold.id }));
    await compAct.retentionOpAction({}, fd({ id: rRule.id, op: "dry-run" }));
    const purge = await compAct.retentionOpAction({}, fd({ id: rRule.id, op: "purge" }));
    const pending = await prisma.retentionRun.findFirstOrThrow({ where: { ruleId: rRule.id, status: "PENDING_APPROVAL" } });
    check("After release, the purge goes for approval and changes nothing yet", purge.ok === true && (await prisma.loginEvent.count({ where: { email: "smoke-gov-old@acme.test" } })) === 3, purge.message);
    await decide("priya.sharma@acme.test", pending.workflowRequestId!, priya.id, true);
    const applied = await prisma.retentionRun.findUniqueOrThrow({ where: { id: pending.id } });
    check("Approved: the old sign-in records are purged on the same run", applied.status === "APPLIED" && applied.affected >= 3 && (await prisma.loginEvent.count({ where: { email: "smoke-gov-old@acme.test" } })) === 0);
    await signInAs("vikram.menon@acme.test");
    await compAct.createLegalHoldAction({}, fd({ name: `${TAG} person hold`, reason: "Internal investigation", employeeId: meera.employee!.id }));
    const contact = await prisma.emergencyContact.create({ data: { employeeId: meera.employee!.id, name: `${TAG} contact`, relationship: "Sibling", phone: "9000000000" } }).catch(() => null);
    if (contact) {
      const blockedDelete = await employeeAct.deleteSubRecord({}, fd({ kind: "emergency", id: contact.id, employeeId: meera.employee!.id }));
      check("An employee's records under hold cannot be deleted", blockedDelete.ok === false && /legal hold/.test(blockedDelete.message ?? "") && !!(await prisma.emergencyContact.findUnique({ where: { id: contact.id } })), blockedDelete.message);
      await prisma.emergencyContact.delete({ where: { id: contact.id } });
    } else check("An employee's records under hold cannot be deleted", await svc.employeeOnHold(t, meera.employee!.id));

    // -----------------------------------------------------------------------
    section("Consent");
    await compAct.saveConsentPurposeAction({}, fd({ title: `${TAG} background check`, description: "Verify employment history with previous employers." }));
    const purpose = await prisma.consentPurpose.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} background check` } });
    await compAct.submitConsentPurposeAction({}, fd({ id: purpose.id }));
    check("A consent purpose waits for approval before employees see it", (await prisma.consentPurpose.findUniqueOrThrow({ where: { id: purpose.id } })).status === "PENDING_APPROVAL");
    await decide("priya.sharma@acme.test", (await latestRequest("CONSENT_PURPOSE", purpose.id))!.id, priya.id, true);
    check("…then is published", (await prisma.consentPurpose.findUniqueOrThrow({ where: { id: purpose.id } })).status === "PUBLISHED");
    await signInAs("meera.krishnan@acme.test");
    check("The employee sees it on My policies", (await html(MyPoliciesPage())).includes(`${TAG} background check`));
    await compAct.recordConsentAction({}, fd({ purposeId: purpose.id, decision: "GRANTED" }));
    const rec = await prisma.consentRecord.findFirst({ where: { purposeId: purpose.id, employeeId: meera.employee!.id } });
    check("Consent is recorded with its version", rec?.decision === "GRANTED" && rec.version === 1);
    await compAct.recordConsentAction({}, fd({ purposeId: purpose.id, decision: "WITHDRAWN" }));
    check("…and can be withdrawn", (await prisma.consentRecord.findFirst({ where: { purposeId: purpose.id, employeeId: meera.employee!.id } }))?.decision === "WITHDRAWN");
    await signInAs("vikram.menon@acme.test");
    await compAct.saveConsentPurposeAction({}, fd({ fromId: purpose.id, title: `${TAG} background check`, description: "Verify employment history and education.", mandatory: true }));
    const purpose2 = await prisma.consentPurpose.findFirstOrThrow({ where: { tenantId: t, key: purpose.key, version: 2 } });
    await compAct.submitConsentPurposeAction({}, fd({ id: purpose2.id }));
    await decide("priya.sharma@acme.test", (await latestRequest("CONSENT_PURPOSE", purpose2.id))!.id, priya.id, true);
    check("A new version replaces the old", (await prisma.consentPurpose.findUniqueOrThrow({ where: { id: purpose.id } })).status === "RETIRED" && (await prisma.consentPurpose.findUniqueOrThrow({ where: { id: purpose2.id } })).status === "PUBLISHED");
    await signInAs("meera.krishnan@acme.test");
    check("A mandatory purpose cannot be declined", (await compAct.recordConsentAction({}, fd({ purposeId: purpose2.id, decision: "DECLINED" }))).ok === false);

    // -----------------------------------------------------------------------
    section("Compliance checklist");
    await signInAs("vikram.menon@acme.test");
    const sameReviewer = await compAct.saveComplianceItemAction({}, fd({ title: `${TAG} PF ECR`, dueOn: today, category: "STATUTORY", frequency: "MONTHLY", ownerUserId: deepak.id, reviewerUserId: deepak.id }));
    check("The reviewer must differ from the owner", sameReviewer.ok === false, sameReviewer.message);
    await compAct.saveComplianceItemAction({}, fd({ title: `${TAG} PF ECR`, dueOn: "2026-01-31", category: "STATUTORY", frequency: "MONTHLY", ownerUserId: deepak.id, reviewerUserId: priya.id, regulation: "EPF Act para 38" }));
    const item = await prisma.complianceItem.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} PF ECR` } });
    await signInAs("deepak.chauhan@acme.test");
    const noEvidence = await compAct.complianceItemOpAction({}, fd({ id: item.id, op: "submit" }));
    check("Submission needs evidence", noEvidence.ok === false, noEvidence.message);
    const up = new FormData();
    up.set("id", item.id);
    up.set("file", new File([Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")], "ecr.pdf", { type: "application/pdf" }));
    const upRes = await compAct.uploadEvidenceAction({}, up);
    const withEv = await prisma.complianceItem.findUniqueOrThrow({ where: { id: item.id } });
    check("The owner attaches evidence", upRes.ok === true && withEv.evidenceFileIds.length === 1 && withEv.status === "IN_PROGRESS", upRes.message);
    check("Exceptions are for compliance managers only", (await compAct.complianceItemOpAction({}, fd({ id: item.id, op: "exception", reason: "Not applicable" }))).ok === false);
    await compAct.complianceItemOpAction({}, fd({ id: item.id, op: "submit", notes: "Filed" }));
    const submitted = await prisma.complianceItem.findUniqueOrThrow({ where: { id: item.id } });
    check("Submitted, it waits on the reviewer", submitted.status === "SUBMITTED" && !!(await task(submitted.workflowRequestId!, priya.id)));
    await decide("priya.sharma@acme.test", submitted.workflowRequestId!, priya.id, true);
    const rolled = await prisma.complianceItem.findFirst({ where: { tenantId: t, previousId: item.id } });
    check("Signed off; the monthly item rolls forward to the next month-end", (await prisma.complianceItem.findUniqueOrThrow({ where: { id: item.id } })).status === "COMPLETED" && iso(rolled!.dueOn) === "2026-02-28");
    check("The rolled item shows overdue on the dashboard", svc.complianceStatus(rolled!.status, rolled!.dueOn, new Date()) === "OVERDUE");
    await signInAs("vikram.menon@acme.test");
    await compAct.complianceItemOpAction({}, fd({ id: rolled!.id, op: "exception", reason: `${TAG}: establishment closed` }));
    check("A compliance manager records an exception", (await prisma.complianceItem.findUniqueOrThrow({ where: { id: rolled!.id } })).status === "EXCEPTION");
    await signInAs("deepak.chauhan@acme.test");
    const evRes = await (await import("../apps/web/src/app/files/[id]/route")).GET(new NextRequest(`http://acme.localhost/files/${withEv.evidenceFileIds[0]}`), { params: Promise.resolve({ id: withEv.evidenceFileIds[0]! }) } as never);
    check("Evidence downloads for compliance viewers", evRes.status === 200);
    await signInAs("meera.krishnan@acme.test");
    const evDenied = await (await import("../apps/web/src/app/files/[id]/route")).GET(new NextRequest(`http://acme.localhost/files/${withEv.evidenceFileIds[0]}`), { params: Promise.resolve({ id: withEv.evidenceFileIds[0]! }) } as never);
    check("…but not for other employees", evDenied.status === 403 || evDenied.status === 404);

    section("Policy acknowledgement campaigns");
    await signInAs("vikram.menon@acme.test");
    await compAct.createPolicyDocumentAction({}, fd({ title: `${TAG} code of conduct`, version: "v1", description: "How we work" }));
    const doc = await prisma.orgDocument.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} code of conduct` } });
    check("A policy is saved unpublished", doc.requireAck && !doc.isPublished);
    const launch = await compAct.launchPolicyCampaignAction({}, multi({ documentId: doc.id, name: `${TAG} campaign`, dueOn: iso(new Date(Date.now() + 14 * DAY)), departmentIds: [meera.employee!.departmentId!] }));
    const policyCamp = await prisma.policyCampaign.findFirstOrThrow({ where: { tenantId: t, documentId: doc.id } });
    check("Launching a campaign goes for approval", launch.ok === true && policyCamp.status === "PENDING_APPROVAL", launch.message);
    await decide("priya.sharma@acme.test", policyCamp.workflowRequestId!, priya.id, true);
    check("Approved: the policy is published and the department is asked", (await prisma.policyCampaign.findUniqueOrThrow({ where: { id: policyCamp.id } })).status === "ACTIVE" && (await prisma.orgDocument.findUniqueOrThrow({ where: { id: doc.id } })).isPublished && (await prisma.notification.count({ where: { userId: meera.id, kind: "POLICY", title: { contains: `${TAG} code of conduct` } } })) === 1);
    await signInAs("meera.krishnan@acme.test");
    check("Unconfirmed acknowledgement is refused", (await compAct.acknowledgePolicyAction({}, fd({ documentId: doc.id }))).ok === false);
    await compAct.acknowledgePolicyAction({}, fd({ documentId: doc.id, confirm: true }));
    const st = await svc.policyCampaignStatus(t, policyCamp.id);
    check("Tracking shows Meera acknowledged", !!st && st.rows.find((r) => r.employeeId === meera.employee!.id)?.acknowledgedAt !== null && st.acknowledged >= 1);
    const remind = await svc.remindPolicyCampaigns(t);
    check("Reminders go to those who have not acknowledged", remind.reminded === st!.total - st!.acknowledged);
    await signInAs("vikram.menon@acme.test");
    const ackCsv = await csv(`report=policy-acks&id=${policyCamp.id}`);
    check("The tracking report exports", ackCsv.status === 200 && ackCsv.body.includes(meera.employee!.employeeNumber));

    section("Findings");
    await compAct.saveFindingAction({}, fd({ title: `${TAG} finding`, severity: "HIGH", source: "INTERNAL_AUDIT", ownerUserId: deepak.id, dueOn: iso(new Date(Date.now() - 2 * DAY)), complianceItemId: item.id }));
    const finding = await prisma.auditFinding.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} finding` } });
    const esc = await svc.escalateFindings(t);
    check("An overdue finding is escalated once", esc.escalated >= 1 && !!(await prisma.auditFinding.findUniqueOrThrow({ where: { id: finding.id } })).escalatedAt && (await svc.escalateFindings(t)).escalated === 0);
    await signInAs("deepak.chauhan@acme.test");
    await compAct.findingOpAction({}, fd({ id: finding.id, op: "remediate", note: "Reconciled the challans" }));
    check("The owner records the corrective action", (await prisma.auditFinding.findUniqueOrThrow({ where: { id: finding.id } })).status === "IN_REMEDIATION");
    check("…but cannot close it", (await compAct.findingOpAction({}, fd({ id: finding.id, op: "close", note: "Done done" }))).ok === false);
    await signInAs("vikram.menon@acme.test");
    await compAct.findingOpAction({}, fd({ id: finding.id, op: "close", note: "Verified against EPFO portal" }));
    check("A compliance manager closes it", (await prisma.auditFinding.findUniqueOrThrow({ where: { id: finding.id } })).status === "CLOSED");

    // -----------------------------------------------------------------------
    section("Audit log integrity");
    const sealed = await compAct.sealAuditLogAction({}, fd({}));
    let ver = await svc.verifyAuditLog(t);
    check("Sealing chains every audit entry and verifies intact", sealed.ok === true && ver.problems.length === 0 && ver.checked > 0, sealed.message);
    const victim = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: t, summary: { contains: `${TAG} finding` } }, orderBy: { createdAt: "asc" } });
    await prisma.auditLog.update({ where: { id: victim.id }, data: { summary: "tampered" } });
    ver = await svc.verifyAuditLog(t);
    check("Editing a sealed entry is detected", ver.problems.some((p) => p.auditLogId === victim.id && p.problem === "ALTERED"));
    await prisma.auditLog.update({ where: { id: victim.id }, data: { summary: victim.summary } });
    check("Restoring it verifies again", (await svc.verifyAuditLog(t)).problems.length === 0);
    const second = await svc.sealAuditLog(t);
    check("Sealing again only seals new entries", second.sealed <= 3);

    // -----------------------------------------------------------------------
    section("Pages, reports and the nightly job");
    for (const tab of ["definitions", "requests", "automation", "notifications", "runs", "delegations", "report"]) {
      check(`Workflows › ${tab} renders`, (await html(WorkflowsPage({ searchParams: sp({ tab }) }))).length > 500);
    }
    for (const tab of ["access", "temporary", "reviews", "accounts", "mfa", "network", "changes", "alerts", "report"]) {
      check(`Security › ${tab} renders`, (await html(SecurityPage({ searchParams: sp({ tab, ...(tab === "reviews" ? { id: camp.id } : {}) }) }))).length > 500);
    }
    for (const tab of ["dashboard", "checklist", "policies", "consent", "retention", "holds", "findings", "integrity"]) {
      check(`Compliance › ${tab} renders`, (await html(CompliancePage({ searchParams: sp({ tab, ...(tab === "policies" ? { id: policyCamp.id } : {}) }) }))).length > 500);
    }
    check("The new-rule page renders", (await html(RulePage({ params: Promise.resolve({ id: "new" }) }))).includes("New automation rule"));
    check("The new-workflow page renders", (await html(WorkflowDefPage({ params: Promise.resolve({ id: "new" }), searchParams: sp() }))).length > 500);
    await signInAs("meera.krishnan@acme.test");
    for (const tab of ["requests", "access", "tasks", "reviews", "away"]) check(`My requests › ${tab} renders`, (await html(MyRequestsPage({ searchParams: sp({ tab }) }))).length > 300);
    const navMod = await import("../apps/web/src/lib/nav");
    const qa = (navMod as unknown as { quickActions: (v: unknown) => Array<{ href: string }> }).quickActions(await requireViewer());
    check("Quick actions offer Requests to employees", qa.some((x) => x.href === "/me/requests"));
    check("An employee cannot export governance reports", (await csv("report=accounts")).status === 403);
    await signInAs("vikram.menon@acme.test");
    check("An unknown report is a 404", (await csv("report=nope")).status === 404);
    for (const r of ["workflow-requests", "workflow-events", "automation-runs", "access-requests", "role-grants", "accounts", "mfa", "security-alerts", "sign-ins", "consents", "compliance-items", "retention-runs", "findings", "audit-integrity", "audit-sample&seed=smoke"]) {
      const res = await csv(`report=${r}`);
      check(`Export ${r.split("&")[0]}`, res.status === 200 && res.body.split("\n").length >= 2, String(res.status));
    }
    check("Exports are audited", (await prisma.auditLog.count({ where: { tenantId: t, action: "EXPORT", entityType: "Report", createdAt: { gte: startedAt } } })) >= 15);
    const job = await svc.runGovernanceJob(t);
    check("The nightly governance job runs end to end", typeof job.sealed === "number" && typeof job.expiredGrants === "number", JSON.stringify(job));
  } finally {
    setTestHeaders({});
    await cleanup(startedAt);
  }
  report("governance");
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
