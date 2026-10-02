/**
 * Core HR workflows, through the actions and pages:
 *   1. A promotion goes through the job-change approval chain: it waits,
 *      shows in the approver's inbox, cannot be approved by its requester,
 *      and is applied on approval — or on its effective date when that is
 *      ahead (the nightly job applies it). Rejection and withdrawal close it.
 *   2. The job-details CSV import checks every row, then writes future-dated
 *      rows on their date and current ones now (or sends them for approval).
 *   3. Email notification settings switch an event's email off, re-target
 *      it, copy a custom address, and reset to the default.
 *   4. The exit survey: set up, answered on /me/exit, read on the exit and in
 *      the roll-up, and kept out of the engagement surveys.
 *   5. Scheduled reports (standard, custom and asset) are emailed through
 *      the outbox when due, recording the last run, exactly once.
 *   6. The audit log downloads as CSV, for auditors only.
 *
 * Works on its own employee and pay group (with a JOB_CHANGE rule), and
 * removes everything it created at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TAG = `smoke-chw-${Date.now()}`;

async function render(fn: () => Promise<unknown>): Promise<"ok" | "denied"> {
  try { await fn(); return "ok"; } catch (err) {
    const e = err as { digest?: string; message?: string };
    if (/HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`)) return "denied";
    throw err;
  }
}

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);

  const employee = await import("../apps/web/src/app/actions/employee");
  const approvals = await import("../apps/web/src/app/actions/payroll-approvals");
  const imports = await import("../apps/web/src/app/actions/import");
  const chw = await import("../apps/web/src/app/actions/core-hr-workflows");
  const svc = await import("@keka/services");
  const { viewerForUser } = await import("../apps/web/src/lib/context");
  const { jobChangeSources } = await import("../apps/web/src/app/(app)/inbox/_take/job-changes");
  const { Notifications } = await import("../apps/web/src/app/(app)/admin/settings/notifications");
  const { runScheduledReports } = await import("../apps/web/src/lib/scheduled-reports");
  const { resolveSpec } = await import("../apps/web/src/lib/report-builder");
  const { ReportSchedules } = await import("../apps/web/src/app/(app)/reports/schedules");
  const exitSurveyPage = (await import("../apps/web/src/app/(app)/exits/survey/page")).default;
  const myExitPage = (await import("../apps/web/src/app/(app)/me/exit/page")).default;
  const exitDetailPage = (await import("../apps/web/src/app/(app)/exits/[id]/page")).default;
  const auditExport = await import("../apps/web/src/app/(app)/admin/audit/export/route");
  const { NextRequest } = await import("next/server");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const user = async (email: string) => prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email } });
  const vikram = await user("vikram.menon@acme.test");
  const vikramEmp = await prisma.employee.findFirstOrThrow({ where: { userId: vikram.id } });
  const priya = await user("priya.sharma@acme.test");
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "meera.krishnan@acme.test" } }, include: { user: true, reportingManager: { include: { user: true } } } });
  const adminRole = await prisma.role.findFirstOrThrow({ where: { tenantId: tenant.id, key: "GLOBAL_ADMIN" } });
  const entity = await prisma.legalEntity.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const location = await prisma.location.findFirstOrThrow({ where: { tenantId: tenant.id, stateCode: { not: null } } });
  const [deptA, deptB] = await prisma.department.findMany({ where: { tenantId: tenant.id }, orderBy: { name: "asc" }, take: 2 });
  const [titleA, titleB] = await prisma.jobTitle.findMany({ where: { tenantId: tenant.id }, orderBy: { name: "asc" }, take: 2 });
  const seriesBefore = await prisma.employeeNumberSeries.findFirstOrThrow({ where: { tenantId: tenant.id, isDefault: true } });
  const settingBefore = await prisma.notificationSetting.findUnique({ where: { tenantId_event: { tenantId: tenant.id, event: "LOAN_APPROVED" } } });
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const later = new Date(today.getTime() + 30 * DAY);
  const email = `${TAG}@acme.test`;

  const made = { payGroupId: "", employeeId: "", userId: "", surveyId: "", exitId: "", savedReportId: "", scheduleIds: [] as string[] };
  try {
    // -----------------------------------------------------------------
    section("Setup: an employee in a pay group with a job-change approval rule");
    await signInAs("vikram.menon@acme.test");
    const pg = await prisma.payGroup.create({ data: { tenantId: tenant.id, legalEntityId: entity.id, name: `Smoke core HR ${TAG}`, approvalWorkflowEnabled: true } });
    made.payGroupId = pg.id;
    await prisma.payrollApprovalRule.create({ data: { payGroupId: pg.id, name: "Job changes — Global Admin", action: "JOB_CHANGE", approverRoleIds: [adminRole.id] } });
    const created = await employee.createEmployee({}, fd({
      firstName: "Smoke", lastName: "Corehr", workEmail: email, dateOfJoining: "2026-04-01", legalEntityId: entity.id,
      locationId: location.id, departmentId: deptA.id, jobTitleId: titleA.id, reportingManagerId: meera.id, status: "CONFIRMED", inviteToPortal: true,
    }));
    check("Created the test employee", created.ok === true, created.message);
    const emp = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, workEmail: email } });
    made.employeeId = emp.id;
    made.userId = emp.userId ?? "";
    await prisma.employee.update({ where: { id: emp.id }, data: { payGroupId: pg.id } });
    const records = () => prisma.employeeJobRecord.count({ where: { employeeId: emp.id } });
    const recordsBefore = await records();
    const latestChange = () => prisma.jobChange.findFirstOrThrow({ where: { employeeId: emp.id }, orderBy: { createdAt: "desc" } });
    const requestOf = async (jobChangeId: string) => prisma.payrollApprovalRequest.findFirstOrThrow({ where: { action: "JOB_CHANGE", payload: { path: ["jobChangeId"], equals: jobChangeId } } });

    // -----------------------------------------------------------------
    section("1. A promotion waits for its approval chain");
    await signInAs("priya.sharma@acme.test");
    const promo = await employee.recordJobChange({}, fd({ employeeId: emp.id, effectiveFrom: iso(today), reason: "PROMOTION", jobTitleId: titleB.id, note: "Smoke promotion", logActivity: true }));
    check("Recording it sends it for approval", promo.ok === true && /approval/i.test(promo.message ?? ""), promo.message);
    let change = await latestChange();
    check("The change is pending, not applied", change.status === "PENDING_APPROVAL" && !change.jobRecordId);
    check("No job record was written yet", (await records()) === recordsBefore);
    check("The designation is unchanged", (await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).jobTitleName === emp.jobTitleName);
    check("The request was audited", (await prisma.auditLog.count({ where: { tenantId: tenant.id, entityType: "JobChange", entityId: change.id, summary: { contains: "sent for approval" } } })) === 1);
    const again = await employee.recordJobChange({}, fd({ employeeId: emp.id, effectiveFrom: iso(today), reason: "MANAGER_CHANGE", reportingManagerId: vikramEmp.id }));
    check("A second change waits until the first is decided", again.ok !== true && /already waiting/i.test(again.message ?? ""), again.message);

    const req = await requestOf(change.id);
    const vikramViewer = (await viewerForUser(vikram.id))!;
    const [inbox] = await jobChangeSources(vikramViewer);
    check("It is in the approver's inbox", (await inbox.count()) >= 1 && (await inbox.list()).some((i) => i.id === req.id));
    // (The inbox panes' CSS module does not load outside Next, so the detail is checked, not rendered.)
    check("The inbox has a detail for it", !!(await inbox.detail(req.id)));
    const [priyaInbox] = await jobChangeSources((await viewerForUser(priya.id))!);
    check("…but not in the requester's", !(await priyaInbox.list()).some((i) => i.id === req.id));
    const own = await approvals.decideApprovalAction({}, fd({ requestId: req.id, decision: "approve" }));
    check("The requester cannot approve it", own.ok !== true, own.message);

    await signInAs("vikram.menon@acme.test");
    const ok = await approvals.decideApprovalAction({}, fd({ requestId: req.id, decision: "approve" }));
    check("The approver approves; it is applied", ok.ok === true && /applied/i.test(ok.message ?? ""), ok.message);
    change = await latestChange();
    check("The change is applied with its job record", change.status === "APPLIED" && !!change.jobRecordId);
    check("A job record was written", (await records()) === recordsBefore + 1);
    check("The designation changed", (await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).jobTitleName === titleB.name);
    check("The approval was audited", (await prisma.auditLog.count({ where: { tenantId: tenant.id, action: "APPROVE", entityType: "JobChange", entityId: change.id } })) === 1);
    check("The promotion is on the activity timeline", (await prisma.hrActivity.count({ where: { employeeId: emp.id, type: "PROMOTION", jobRecordId: change.jobRecordId } })) === 1);
    check("No email for the new 'takes effect' event until it is switched on", (await prisma.emailOutbox.count({ where: { relatedType: "JobChange", relatedId: change.id } })) === 0);

    section("1b. A future-dated transfer is applied on its date");
    await signInAs("priya.sharma@acme.test");
    await employee.recordJobChange({}, fd({ employeeId: emp.id, effectiveFrom: iso(later), reason: "DEPARTMENT_CHANGE", departmentId: deptB.id }));
    const transfer = await latestChange();
    await signInAs("vikram.menon@acme.test");
    const ok2 = await approvals.decideApprovalAction({}, fd({ requestId: (await requestOf(transfer.id)).id, decision: "approve" }));
    check("Approved, it waits for its effective date", ok2.ok === true && /effective date/i.test(ok2.message ?? ""), ok2.message);
    check("Its status is scheduled", (await prisma.jobChange.findUniqueOrThrow({ where: { id: transfer.id } })).status === "SCHEDULED");
    check("The department is unchanged for now", (await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).departmentId === deptA.id);
    await svc.applyDueJobChanges(today);
    check("The nightly job leaves it alone before the date", (await prisma.jobChange.findUniqueOrThrow({ where: { id: transfer.id } })).status === "SCHEDULED");
    const due = await svc.applyDueJobChanges(later);
    check("On the date the nightly job applies it", due.applied >= 1 && (await prisma.jobChange.findUniqueOrThrow({ where: { id: transfer.id } })).status === "APPLIED", JSON.stringify(due));
    check("…and the department changed", (await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).departmentId === deptB.id);
    const rec = await prisma.employeeJobRecord.findFirstOrThrow({ where: { employeeId: emp.id, effectiveTo: null } });
    check("The new job record starts on the effective date", iso(rec.effectiveFrom) === iso(later));

    section("1c. Rejection and withdrawal close a change");
    await signInAs("priya.sharma@acme.test");
    await employee.recordJobChange({}, fd({ employeeId: emp.id, effectiveFrom: iso(today), reason: "MANAGER_CHANGE", reportingManagerId: vikramEmp.id }));
    const toReject = await latestChange();
    await signInAs("vikram.menon@acme.test");
    const noReason = await approvals.decideApprovalAction({}, fd({ requestId: (await requestOf(toReject.id)).id, decision: "reject" }));
    check("A rejection needs a reason", noReason.ok !== true, noReason.message);
    await approvals.decideApprovalAction({}, fd({ requestId: (await requestOf(toReject.id)).id, decision: "reject", comment: "Not this quarter" }));
    check("Rejected, it is closed and nothing changes", (await prisma.jobChange.findUniqueOrThrow({ where: { id: toReject.id } })).status === "REJECTED"
      && (await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).reportingManagerId === meera.id);
    await signInAs("priya.sharma@acme.test");
    await employee.recordJobChange({}, fd({ employeeId: emp.id, effectiveFrom: iso(today), reason: "PROMOTION", jobTitleId: titleA.id }));
    const toWithdraw = await latestChange();
    const wd = await approvals.withdrawApprovalAction({}, fd({ requestId: (await requestOf(toWithdraw.id)).id }));
    check("The requester can withdraw it", wd.ok === true && (await prisma.jobChange.findUniqueOrThrow({ where: { id: toWithdraw.id } })).status === "WITHDRAWN", wd.message);

    // -----------------------------------------------------------------
    section("2. Job-details CSV import");
    const csv = (rows: string[][]) => [["Employee number", "Effective from", "Designation", "Department", "Location", "Reporting manager", "Grade", "Reason", "Note"], ...rows].map((r) => r.join(",")).join("\n");
    const num = emp.employeeNumber;
    const bad = await imports.runImportAction({}, fd({ kind: "job-details", mode: "check", file: csv([[num, iso(later), "No Such Title", "", "", "", "", "", ""], [num, "31/02/2026", "", "", "", "", "", "", ""]]) }));
    check("The check reports every bad row by line", bad.ok !== true && bad.rowErrors?.length === 2 && bad.rowErrors[0].line === 2 && /designation/i.test(bad.rowErrors[0].message), JSON.stringify(bad.rowErrors));
    const good = csv([[num, iso(later), titleA.name, "", "", "", "", "", "Bulk promo"]]);
    const checked = await imports.runImportAction({}, fd({ kind: "job-details", mode: "check", file: good }));
    check("A clean file passes the check and changes nothing", checked.ok === true && (await prisma.jobChange.count({ where: { employeeId: emp.id, source: "IMPORT" } })) === 0, checked.message);
    const imported = await imports.runImportAction({}, fd({ kind: "job-details", mode: "import", file: good }));
    const viaImport = await latestChange();
    check("Importing with the approval rule on sends the row for approval", imported.ok === true && viaImport.source === "IMPORT" && viaImport.status === "PENDING_APPROVAL", `${imported.message} ${viaImport.status}`);
    await approvals.withdrawApprovalAction({}, fd({ requestId: (await requestOf(viaImport.id)).id }));

    await prisma.payrollApprovalRule.updateMany({ where: { payGroupId: pg.id }, data: { isActive: false } });
    const beforeImport = await records();
    const mixed = csv([[num, iso(later), titleA.name, "", "", "", "", "", "Future"], [num, iso(today), "", deptA.name, "", "", "", "", "Today"]]);
    const imp2 = await imports.runImportAction({}, fd({ kind: "job-details", mode: "import", file: mixed }));
    check("Without approval both rows import", imp2.ok === true && imp2.imported === 2, imp2.message);
    const fromImport = await prisma.jobChange.findMany({ where: { employeeId: emp.id, source: "IMPORT", status: { in: ["SCHEDULED", "APPLIED"] } }, orderBy: { effectiveFrom: "asc" } });
    check("Today's row is written now", fromImport.some((c) => c.status === "APPLIED" && iso(c.effectiveFrom) === iso(today)) && (await records()) === beforeImport + 1);
    check("The future row waits for its date", fromImport.some((c) => c.status === "SCHEDULED" && iso(c.effectiveFrom) === iso(later)));
    check("The import was audited", (await prisma.auditLog.count({ where: { tenantId: tenant.id, entityType: "BulkImport", summary: { contains: "job details" } } })) >= 1);

    // -----------------------------------------------------------------
    section("3. Email notification settings");
    await signInAs("vikram.menon@acme.test");
    const subject = (n: number) => `${TAG} loan ${n}`;
    const send = (n: number) => svc.notify({ tenantId: tenant.id, userIds: [meera.userId], kind: "LOAN", title: subject(n), email: true, event: "LOAN_APPROVED", employeeIds: [meera.id] });
    const outbox = (n: number) => prisma.emailOutbox.findMany({ where: { tenantId: tenant.id, subject: subject(n) }, select: { toAddress: true } });
    if (settingBefore) await prisma.notificationSetting.delete({ where: { id: settingBefore.id } });
    await send(1);
    check("By default the event emails who it always did", (await outbox(1)).map((o) => o.toAddress).join() === meera.user!.email.toLowerCase());
    const off = await chw.saveNotificationSettingAction({}, fd({ event: "LOAN_APPROVED", recipients: "EMPLOYEE" }));
    check("An admin switches the email off", off.ok === true, off.message);
    await send(2);
    check("…and no email is queued", (await outbox(2)).length === 0);
    check("…while the in-app notification still arrives", (await prisma.notification.count({ where: { title: subject(2) } })) === 1);
    const badEmail = await chw.saveNotificationSettingAction({}, fd({ event: "LOAN_APPROVED", emailEnabled: true, recipients: "EMPLOYEE", customEmails: "not-an-address" }));
    check("A bad custom address is refused", badEmail.ok !== true && !!badEmail.errors?.customEmails, badEmail.message);
    const f = fd({ event: "LOAN_APPROVED", emailEnabled: true, customEmails: "payroll-desk@acme.test" });
    f.append("recipients", "MANAGER");
    const retarget = await chw.saveNotificationSettingAction({}, f);
    check("Re-targeted to the manager with a custom copy", retarget.ok === true, retarget.message);
    await send(3);
    const to3 = (await outbox(3)).map((o) => o.toAddress).sort();
    const mgrEmail = meera.reportingManager?.user?.email.toLowerCase();
    check("The email goes to the manager and the custom address, not the employee", to3.includes("payroll-desk@acme.test") && (!mgrEmail || to3.includes(mgrEmail)) && !to3.includes(meera.user!.email.toLowerCase()), to3.join(", "));
    const settingsHtml = html(await Notifications({ tenantId: tenant.id }));
    check("The settings table lists every event", settingsHtml.includes("Loan approved") && settingsHtml.includes("Resignation accepted") && settingsHtml.includes("payroll-desk@acme.test"));
    check("The change was audited", (await prisma.auditLog.count({ where: { tenantId: tenant.id, entityType: "NotificationSetting", entityId: "LOAN_APPROVED" } })) >= 2);
    await chw.resetNotificationSettingAction({}, fd({ event: "LOAN_APPROVED" }));
    await send(4);
    check("Reset puts it back to the default", (await outbox(4)).map((o) => o.toAddress).join() === meera.user!.email.toLowerCase());
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot change notification settings", (await render(() => chw.saveNotificationSettingAction({}, fd({ event: "LOAN_APPROVED" })))) === "denied");

    // -----------------------------------------------------------------
    section("4. Exit survey");
    await signInAs("vikram.menon@acme.test");
    await prisma.survey.deleteMany({ where: { tenantId: tenant.id, kind: "EXIT", title: "Exit survey", createdBy: vikram.id, responses: { none: {} } } });
    const preexisting = await prisma.survey.findFirst({ where: { tenantId: tenant.id, kind: "EXIT", status: "ACTIVE" } });
    if (!preexisting) check("Without a survey the page offers to set one up", html(await exitSurveyPage()).includes("Set up the exit survey"));
    const setup = await chw.setupExitSurveyAction({}, fd({}));
    check("An exit admin sets up the exit survey", setup.ok === true, setup.message);
    const survey = await prisma.survey.findFirstOrThrow({ where: { tenantId: tenant.id, kind: "EXIT", status: "ACTIVE" }, include: { questions: { orderBy: { sequence: "asc" } } }, orderBy: { createdAt: "desc" } });
    if (!preexisting) made.surveyId = survey.id;
    check("It is not anonymous and has the standard questions", !survey.isAnonymous && survey.questions.length >= 5);
    const exit = await prisma.exitRecord.create({ data: { employeeId: emp.id, type: "RESIGNATION", status: "APPROVED", noticeDate: today, lastWorkingDay: later, reason: "Smoke" } });
    made.exitId = exit.id;

    await signInAs(email);
    check("The leaver sees the survey on My exit", html(await myExitPage()).includes(survey.questions[0].prompt));
    const answers: Record<string, string> = { exitId: exit.id };
    for (const q of survey.questions) {
      if (q.type === "SINGLE_CHOICE") answers[`q_${q.id}`] = "1";
      else if (q.type === "RATING") answers[`q_${q.id}`] = "4";
      else if (q.type === "NPS") answers[`q_${q.id}`] = "9";
      else answers[`q_${q.id}`] = "More growth, please";
    }
    const firstQ = `q_${survey.questions[0].id}`;
    const missing = await chw.submitExitSurveyAction({}, fd({ ...answers, [firstQ]: undefined as unknown as string }));
    check("A required question left blank is flagged", missing.ok !== true && !!missing.errors?.[firstQ], missing.message);
    const submitted = await chw.submitExitSurveyAction({}, fd(answers));
    check("The leaver submits the survey", submitted.ok === true, submitted.message);
    check("The exit records which survey it answered", (await prisma.exitRecord.findUniqueOrThrow({ where: { id: exit.id } })).exitSurveyId === survey.id);
    const twice = await chw.submitExitSurveyAction({}, fd(answers));
    check("…and cannot answer twice", twice.ok !== true, twice.message);
    check("My exit now thanks them instead", html(await myExitPage()).includes("You completed the exit survey"));

    await signInAs("vikram.menon@acme.test");
    const exitHtml = html(await exitDetailPage({ params: Promise.resolve({ id: exit.id }) }));
    check("HR sees the answers on the exit", exitHtml.includes("More growth, please") && exitHtml.includes("4 / 5"));
    const agg = await svc.exitSurveyAggregate(survey.id, [exit.id]);
    const nps = agg.questions.find((q) => q.type === "NPS");
    check("The roll-up counts the response", agg.responses === 1 && nps?.type === "NPS" && nps.nps === 100, JSON.stringify(nps));
    const aggHtml = html(await exitSurveyPage());
    check("The exit survey page shows the roll-up", aggHtml.includes("Leaver eNPS") && aggHtml.includes("Smoke Corehr"));
    const engage = await prisma.survey.findMany({ where: { tenantId: tenant.id, kind: { not: "EXIT" } }, select: { id: true } });
    check("The exit survey is kept out of the engagement survey lists", !engage.some((s) => s.id === survey.id));
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot open the roll-up", (await render(() => exitSurveyPage())) === "denied");

    // -----------------------------------------------------------------
    section("5. Scheduled report delivery");
    await signInAs("vikram.menon@acme.test");
    const sched = await chw.scheduleReportAction({}, fd({ reportKey: "headcount", name: `${TAG} headcount`, recipients: "ops@acme.test, HR@acme.test", frequency: "WEEKLY", dayOfWeek: 1 }));
    check("Schedule a standard report", sched.ok === true, sched.message);
    const badSched = await chw.scheduleReportAction({}, fd({ reportKey: "headcount", name: "x bad", recipients: "nobody", frequency: "DAILY" }));
    check("Bad recipients are refused", badSched.ok !== true, badSched.message);
    const saved = await prisma.savedReport.create({ data: { tenantId: tenant.id, name: `${TAG} custom`, dataset: "employees", spec: resolveSpec(undefined, null, "employees") as never, createdBy: vikram.id } });
    made.savedReportId = saved.id;
    const sched2 = await chw.scheduleReportAction({}, fd({ reportKey: `saved:${saved.id}`, name: `${TAG} custom`, recipients: "ops@acme.test", frequency: "MONTHLY", dayOfMonth: 5 }));
    check("Schedule a saved custom report", sched2.ok === true, sched2.message);
    const asset = await prisma.scheduledReport.create({ data: { tenantId: tenant.id, reportKey: "asset-inventory", name: `${TAG} assets`, recipients: ["it@acme.test"], frequency: "DAILY", nextRunAt: new Date(), createdBy: vikram.id } });
    const orphan = await prisma.scheduledReport.create({ data: { tenantId: tenant.id, reportKey: "headcount", name: `${TAG} orphan`, recipients: ["it@acme.test"], frequency: "DAILY", nextRunAt: new Date(), createdBy: "no-such-user" } });
    const mine = await prisma.scheduledReport.findMany({ where: { tenantId: tenant.id, name: { startsWith: TAG } } });
    made.scheduleIds = mine.map((s) => s.id);
    const schedHtml = html(await ReportSchedules({ viewer: (await viewerForUser(vikram.id))!, reportKey: "headcount", title: "Headcount" }));
    check("The report page lists its schedules", schedHtml.includes(`${TAG} headcount`) && schedHtml.includes("Email this report"));
    await prisma.scheduledReport.updateMany({ where: { id: { in: made.scheduleIds } }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    const now = new Date();
    const run = await runScheduledReports(now, { ids: made.scheduleIds });
    check("Every due schedule ran", run.due === 4 && run.sent === 3 && run.failed === 1, JSON.stringify(run));
    const mails = await prisma.emailOutbox.findMany({ where: { relatedType: "ScheduledReport", relatedId: { in: made.scheduleIds } } });
    check("One email per recipient went to the outbox", mails.length === 4, `${mails.length}`);
    const head = mails.find((m) => m.subject.startsWith(`${TAG} headcount`));
    check("The headcount email carries its CSV", !!head && /Department,/.test(head.textBody), head?.textBody.slice(0, 120));
    check("The asset report CSV is there too", mails.some((m) => m.relatedId === asset.id && m.textBody.includes("Asset ID")));
    const after = await prisma.scheduledReport.findMany({ where: { id: { in: made.scheduleIds } } });
    check("Each records its last run and moves its next run forward", after.every((s) => s.lastRunAt?.getTime() === now.getTime() && s.nextRunAt > now));
    check("A schedule whose owner is gone records why it failed", /Failed: .*active login/.test(after.find((s) => s.id === orphan.id)?.lastStatus ?? ""), after.find((s) => s.id === orphan.id)?.lastStatus ?? "");
    const rerun = await runScheduledReports(now, { ids: made.scheduleIds });
    check("Running again sends nothing twice", rerun.due === 0, JSON.stringify(rerun));
    await signInAs("priya.sharma@acme.test");
    const stopOther = await chw.deleteScheduledReportAction({}, fd({ id: after.find((s) => s.reportKey === "headcount" && s.createdBy === vikram.id)!.id }));
    check("Someone else cannot stop your schedule", stopOther.ok !== true, stopOther.message);
    await signInAs("vikram.menon@acme.test");
    const stop = await chw.deleteScheduledReportAction({}, fd({ id: after.find((s) => s.reportKey === "headcount" && s.createdBy === vikram.id)!.id }));
    check("The owner can stop it", stop.ok === true, stop.message);

    // -----------------------------------------------------------------
    section("6. Audit log CSV export");
    const res = await auditExport.GET(new NextRequest("http://acme.localhost/admin/audit/export?module=EMPLOYEE&q=promotion"));
    const body = await res.text();
    check("Downloads as CSV", res.status === 200 && /text\/csv/.test(res.headers.get("content-type") ?? ""));
    check("With a header row and the filtered entries", body.includes("When (UTC),Module,Action") && body.includes(emp.employeeNumber), body.split("\r\n")[1]?.slice(0, 120));
    check("Only the filtered module", body.split("\r\n").slice(1).filter(Boolean).every((l) => l.split(",")[1] === "EMPLOYEE"));
    check("The export itself is audited", (await prisma.auditLog.count({ where: { tenantId: tenant.id, action: "EXPORT", entityType: "AuditLog", actorId: vikram.id } })) >= 1);
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot download it", (await auditExport.GET(new NextRequest("http://acme.localhost/admin/audit/export"))).status === 403);
  } finally {
    // -----------------------------------------------------------------
    //  Clean up so repeat runs stay deterministic.
    if (made.employeeId) {
      const changes = await prisma.jobChange.findMany({ where: { employeeId: made.employeeId }, select: { id: true } });
      await prisma.payrollApprovalRequest.deleteMany({ where: { action: "JOB_CHANGE", payload: { path: ["employeeId"], equals: made.employeeId } } });
      await prisma.jobChange.deleteMany({ where: { id: { in: changes.map((c) => c.id) } } });
      await prisma.emailOutbox.deleteMany({ where: { relatedType: "JobChange", relatedId: { in: changes.map((c) => c.id) } } });
      await prisma.surveyResponse.deleteMany({ where: { exitRecordId: made.exitId || "-" } });
      await prisma.surveyParticipant.deleteMany({ where: { employeeId: made.employeeId } });
      await prisma.employee.update({ where: { id: made.employeeId }, data: { reportingManagerId: null } }).catch(() => null);
      await prisma.employee.delete({ where: { id: made.employeeId } });
      if (made.userId) await prisma.user.delete({ where: { id: made.userId } }).catch(() => null);
      await prisma.employeeNumberSeries.update({ where: { id: seriesBefore.id }, data: { nextNumber: seriesBefore.nextNumber } });
    }
    if (made.surveyId) await prisma.survey.delete({ where: { id: made.surveyId } }).catch(() => null);
    if (made.payGroupId) await prisma.payGroup.delete({ where: { id: made.payGroupId } });
    await prisma.scheduledReport.deleteMany({ where: { tenantId: tenant.id, name: { startsWith: TAG } } });
    await prisma.emailOutbox.deleteMany({ where: { OR: [{ subject: { startsWith: TAG } }, { relatedType: "ScheduledReport", relatedId: { in: made.scheduleIds } }] } });
    await prisma.notification.deleteMany({ where: { title: { startsWith: TAG } } });
    if (made.savedReportId) await prisma.savedReport.delete({ where: { id: made.savedReportId } });
    await prisma.notificationSetting.deleteMany({ where: { tenantId: tenant.id, event: "LOAN_APPROVED" } });
    if (settingBefore) {
      const { id: _id, updatedAt: _u, ...rest } = settingBefore;
      await prisma.notificationSetting.create({ data: rest });
    }
  }
  report("Core HR workflows");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
