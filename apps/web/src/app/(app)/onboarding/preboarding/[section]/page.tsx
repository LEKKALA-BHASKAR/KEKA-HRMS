import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  preboardingReadiness, preboardingScore, preboardingExceptions, joinSettings, newHireFieldsText,
  PREBOARDING_KINDS, PREBOARDING_OPEN, type NewHireField,
} from "@keka/services";
import { requireAuth, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Progress, Stat } from "@/components/ui";
import { Tabs, Table, SearchBar, Pill } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { fmtDay, fmtTime, pretty, opts, matches } from "@/lib/engage-depth";
import { peopleIndex } from "@/lib/join-depth";
import { OnboardingNav } from "../../_join/nav";
import {
  savePreboardingTemplateAction, addPreboardingItemAction, deletePreboardingItemAction, generatePreboardingPlanAction, addPreboardingTaskAction,
  preboardingTaskOpAction, saveNewHireFormAction, savePrejoinMessageAction, prejoinMessageOpAction, runPrejoinDispatchAction, sendManagerIntroAction,
  saveProvisionAction, provisionOpAction, saveJoinSettingsAction,
} from "@/app/actions/join-preboarding";

const P = PERMISSIONS;
const DAY = 86_400_000;
const SECTIONS = { tasks: "Hire tasks", exceptions: "Exceptions & readiness", forms: "New-hire forms", comms: "Communications", provisioning: "Provisioning", templates: "Templates", settings: "Settings" } as const;
type Section = keyof typeof SECTIONS;

/** The preboarding desk: everything HR runs for hires before day one. */
export default async function PreboardingDeskPage({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ q?: string; status?: string }> }) {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const { section } = await params;
  if (!(section in SECTIONS)) notFound();
  const sp = await searchParams;
  const s = section as Section;
  return (
    <>
      <PageHead title="Preboarding desk" subtitle="Tasks, forms, messages and provisioning for hires who have not joined yet"
        actions={<a className="btn" href="/onboarding/export?kind=preboarding">Export tasks (CSV)</a>} />
      <OnboardingNav viewer={viewer} active="desk" />
      <div className="tabs">
        {Object.entries(SECTIONS).map(([k, v]) => <Link key={k} href={`/onboarding/preboarding/${k}`} className={`tab${k === s ? " active" : ""}`}>{v}</Link>)}
      </div>
      {s === "tasks" ? <TasksSection viewer={viewer} q={sp.q} status={sp.status} /> : null}
      {s === "exceptions" ? <ExceptionsSection viewer={viewer} /> : null}
      {s === "forms" ? <FormsSection viewer={viewer} q={sp.q} /> : null}
      {s === "comms" ? <CommsSection viewer={viewer} q={sp.q} /> : null}
      {s === "provisioning" ? <ProvisioningSection viewer={viewer} status={sp.status} /> : null}
      {s === "templates" ? <TemplatesSection viewer={viewer} /> : null}
      {s === "settings" ? <SettingsSection viewer={viewer} /> : null}
    </>
  );
}

async function hires(viewer: Viewer) {
  return prisma.employee.findMany({
    where: { AND: [scopedEmployeeWhere(viewer, P.ONBOARDING_MANAGE), { status: "PREBOARDING" }] },
    select: { id: true, displayName: true, employeeNumber: true, dateOfJoining: true, jobTitleName: true, department: { select: { name: true } }, user: { select: { lastLoginAt: true } } },
    orderBy: { dateOfJoining: "asc" },
  });
}

const hireOpts = (rows: Array<{ id: string; displayName: string | null; employeeNumber: string }>) => rows.map((h) => ({ value: h.id, label: `${h.employeeNumber} · ${h.displayName ?? ""}` }));
const today = () => new Date(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) + "T00:00:00Z");

async function TasksSection({ viewer, q, status }: { viewer: Viewer; q?: string; status?: string }) {
  const people = await hires(viewer);
  const [tasks, templates] = await Promise.all([
    prisma.preboardingTask.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: people.map((p) => p.id) }, ...(status ? { status } : {}) }, orderBy: [{ dueDate: "asc" }] }),
    prisma.preboardingTemplate.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true } }),
  ]);
  const name = new Map(people.map((p) => [p.id, p.displayName]));
  const shown = tasks.filter((t) => matches(q, t.title, t.kind, name.get(t.employeeId)));
  const t0 = today();
  return (
    <div className="stack gap-4">
      <div className="grid grid-2">
        <Card title="Generate a hire's plan" description="Picks the most specific template (job title, then department, then location) unless you choose one.">
          <SpecForm action={generatePreboardingPlanAction} submitLabel="Generate" fields={[
            { name: "employeeId", label: "Hire", type: "select", required: true, options: hireOpts(people) },
            { name: "templateId", label: "Template", type: "select", options: templates.map((t) => ({ value: t.id, label: t.name })), placeholder: "Best match" },
          ]} />
        </Card>
        <Card title="Add a one-off task">
          <SpecForm action={addPreboardingTaskAction} submitLabel="Add task" fields={[
            { name: "employeeId", label: "Hire", type: "select", required: true, options: hireOpts(people) },
            { name: "title", label: "Task", required: true },
            { name: "kind", label: "Type", type: "select", options: opts(PREBOARDING_KINDS), defaultValue: "CUSTOM" },
            { name: "dueDate", label: "Due", type: "date", required: true },
            { name: "requiresApproval", label: "HR review", type: "checkbox", placeholder: "Review before it counts as done" },
            { name: "description", label: "Instructions", type: "textarea", wide: true },
          ]} />
        </Card>
      </div>
      <Card tight title={`Preboarding tasks (${shown.length})`}>
        <div style={{ padding: "12px 16px 0" }}>
          <SearchBar action="/onboarding/preboarding/tasks" tab="" q={q}>
            <select className="select" name="status" defaultValue={status ?? ""} style={{ width: 160 }}>
              <option value="">Any status</option>
              {["PENDING", "SUBMITTED", "DONE", "APPROVED", "REJECTED", "WAIVED"].map((x) => <option key={x} value={x}>{pretty(x)}</option>)}
            </select>
          </SearchBar>
        </div>
        <Table head={["Hire", "Task", "Due", "Status", "Reminders", ""]} empty={!shown.length}>
          {shown.map((t) => (
            <tr key={t.id}>
              <td className="text-sm"><strong>{name.get(t.employeeId)}</strong></td>
              <td className="text-sm">{t.title}<div className="text-xs subtle">{pretty(t.kind)}{t.requiresApproval ? " · reviewed" : ""}{t.decisionNote ? ` · ${t.decisionNote}` : ""}</div></td>
              <td className={`text-sm ${PREBOARDING_OPEN.includes(t.status) && t.dueDate < t0 ? "neg strong" : ""}`}>{fmtDay(t.dueDate)}</td>
              <td><Pill s={t.status} /></td>
              <td className="text-xs">{t.remindersSent}{t.lastRemindedAt ? ` · last ${fmtDay(t.lastRemindedAt)}` : ""}</td>
              <td className="right">
                <div className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
                  {PREBOARDING_OPEN.includes(t.status) ? <ActButton action={preboardingTaskOpAction} hidden={{ id: t.id, op: "remind" }} label="Remind" /> : null}
                  {PREBOARDING_OPEN.includes(t.status) ? <ActButton action={preboardingTaskOpAction} hidden={{ id: t.id, op: "waive" }} label="Waive" input={{ name: "note", placeholder: "Why", required: true }} /> : null}
                  {["DONE", "APPROVED", "WAIVED", "REJECTED"].includes(t.status) ? <ActButton action={preboardingTaskOpAction} hidden={{ id: t.id, op: "reopen" }} label="Reopen" variant="ghost" /> : null}
                  <ActButton action={preboardingTaskOpAction} hidden={{ id: t.id, op: "delete" }} label="Remove" variant="ghost" confirmText="Remove this task?" />
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function ExceptionsSection({ viewer }: { viewer: Viewer }) {
  const people = await hires(viewer);
  const t0 = today();
  const rows = [];
  for (const p of people) {
    const [readiness, tasks, bgv] = await Promise.all([
      preboardingReadiness(viewer.tenantId, p.id),
      prisma.preboardingTask.findMany({ where: { tenantId: viewer.tenantId, employeeId: p.id }, select: { status: true, dueDate: true } }),
      prisma.bgvCheck.findFirst({ where: { tenantId: viewer.tenantId, employeeId: p.id }, orderBy: { initiatedAt: "desc" }, select: { status: true } }),
    ]);
    const score = preboardingScore(tasks, readiness);
    const daysToJoin = Math.round((p.dateOfJoining.getTime() - t0.getTime()) / DAY);
    const issues = preboardingExceptions({
      daysToJoin, overdueTasks: tasks.filter((t) => PREBOARDING_OPEN.includes(t.status) && t.dueDate < t0).length, rejectedItems: tasks.filter((t) => t.status === "REJECTED").length,
      bgvStatus: bgv?.status ?? null, signedIn: !!p.user?.lastLoginAt, readinessGaps: readiness.filter((r) => !r.ok).map((r) => r.label.toLowerCase()), score: score.pct,
    });
    rows.push({ p, readiness, score, daysToJoin, issues });
  }
  const flagged = rows.filter((r) => r.issues.length);
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Hires preboarding" value={rows.length} />
        <Stat label="Need attention" value={flagged.length} tone={flagged.length ? "neg" : undefined} />
        <Stat label="Joining in 7 days" value={rows.filter((r) => r.daysToJoin >= 0 && r.daysToJoin <= 7).length} />
        <Stat label="Average completion" value={`${rows.length ? Math.round(rows.reduce((s, r) => s + r.score.pct, 0) / rows.length) : 100}%`} />
      </div>
      <Card tight title="Exception dashboard" description="Hires with something that needs HR before day one">
        <Table head={["Hire", "Joins", "Issues"]} empty={!flagged.length}>
          {flagged.map((r) => (
            <tr key={r.p.id}>
              <td className="text-sm"><Link href={`/employees/${r.p.id}`}><strong>{r.p.displayName}</strong></Link></td>
              <td className="text-sm">{fmtDay(r.p.dateOfJoining)}<div className="text-xs subtle">{r.daysToJoin >= 0 ? `in ${r.daysToJoin} day(s)` : `${-r.daysToJoin} day(s) ago`}</div></td>
              <td className="text-sm">{r.issues.map((i) => <div key={i}>• {i}</div>)}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card tight title="Readiness and payroll setup" description="Completion score counts finished tasks plus each readiness item">
        <Table head={["Hire", "Score", ...(rows[0]?.readiness.map((x) => x.label) ?? [])]} empty={!rows.length}>
          {rows.map((r) => (
            <tr key={r.p.id}>
              <td className="text-sm"><strong>{r.p.displayName}</strong></td>
              <td style={{ minWidth: 120 }}><div className="text-xs strong">{r.score.pct}%</div><Progress value={r.score.pct} tone={r.score.pct >= 80 ? "success" : "warning"} /></td>
              {r.readiness.map((x) => <td key={x.key} className="text-sm">{x.ok ? <span className="pos">✓</span> : <span className="neg">✗</span>}</td>)}
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function FormsSection({ viewer, q }: { viewer: Viewer; q?: string }) {
  const [forms, subs] = await Promise.all([
    prisma.newHireForm.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" }, include: { _count: { select: { submissions: true } } } }),
    prisma.newHireFormSubmission.findMany({ where: { tenantId: viewer.tenantId }, include: { form: { select: { name: true, fields: true } } }, orderBy: { submittedAt: "desc" }, take: 300 }),
  ]);
  const ppl = await peopleIndex(viewer.tenantId, subs.map((x) => x.employeeId));
  const scoped = new Set((await prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, P.ONBOARDING_MANAGE), { id: { in: subs.map((x) => x.employeeId) } }] }, select: { id: true } })).map((e) => e.id));
  const shown = subs.filter((x) => scoped.has(x.employeeId) && matches(q, x.form.name, ppl.name(x.employeeId), JSON.stringify(x.answers)));
  const fieldHelp = "One field per line: Label | TEXT, NUMBER, DATE, SELECT or YESNO | required | options (for SELECT, comma separated)";
  return (
    <div className="stack gap-4">
      <div className="grid grid-2">
        {forms.map((f) => (
          <Card key={f.id} title={f.name} description={`v${f.version} · ${f._count.submissions} submission(s)${f.isActive ? "" : " · inactive"}`}>
            <SpecForm action={saveNewHireFormAction} hidden={{ id: f.id }} columns={1} fields={[
              { name: "name", label: "Name", required: true, defaultValue: f.name },
              { name: "description", label: "Description", defaultValue: f.description },
              { name: "fields", label: "Fields", type: "textarea", required: true, defaultValue: newHireFieldsText(f.fields as unknown as NewHireField[]), hint: fieldHelp },
              { name: "isActive", label: "Active", type: "checkbox", defaultValue: f.isActive },
            ]} />
          </Card>
        ))}
        <Card title="New form">
          <SpecForm action={saveNewHireFormAction} columns={1} submitLabel="Create form" fields={[
            { name: "name", label: "Name", required: true },
            { name: "description", label: "Description" },
            { name: "fields", label: "Fields", type: "textarea", required: true, placeholder: "T-shirt size | SELECT | required | S, M, L, XL", hint: fieldHelp },
          ]} />
        </Card>
      </div>
      <Card tight title={`Submissions (${shown.length})`}>
        <div style={{ padding: "12px 16px 0" }}><SearchBar action="/onboarding/preboarding/forms" tab="" q={q} /></div>
        <Table head={["Hire", "Form", "Answers", "Submitted", "Status"]} empty={!shown.length}>
          {shown.map((x) => (
            <tr key={x.id}>
              <td className="text-sm"><strong>{ppl.name(x.employeeId)}</strong></td>
              <td className="text-sm">{x.form.name}<div className="text-xs subtle">v{x.formVersion}</div></td>
              <td className="text-xs">{Object.entries(x.answers as Record<string, string>).map(([k, v]) => <div key={k}><span className="subtle">{(x.form.fields as unknown as NewHireField[]).find((fl) => fl.key === k)?.label ?? k}:</span> {v}</div>)}</td>
              <td className="text-sm">{fmtTime(x.submittedAt)}</td>
              <td><Pill s={x.status} />{x.decisionNote ? <div className="text-xs subtle">{x.decisionNote}</div> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function CommsSection({ viewer, q }: { viewer: Viewer; q?: string }) {
  const people = await hires(viewer);
  const [msgs, logs] = await Promise.all([
    prisma.prejoinMessage.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { daysBeforeJoining: "desc" } }),
    prisma.prejoinMessageLog.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: (await prisma.employee.findMany({ where: scopedEmployeeWhere(viewer, P.ONBOARDING_MANAGE), select: { id: true } })).map((e) => e.id) } }, orderBy: { sentAt: "desc" }, take: 300 }),
  ]);
  const ppl = await peopleIndex(viewer.tenantId, logs.map((l) => l.employeeId));
  const shown = logs.filter((l) => matches(q, l.subject, l.kind, ppl.name(l.employeeId), l.toAddress));
  const vars = "Placeholders: {{first_name}}, {{name}}, {{joining_date}}, {{manager}}, {{location}}";
  return (
    <div className="stack gap-4">
      <Card title="Scheduled pre-joining messages" description="Each message is approved before it goes out, then sent automatically when a hire is within its window." action={<ActButton action={runPrejoinDispatchAction} hidden={{}} label="Send what is due now" />}>
        <Table head={["Message", "When", "Status", ""]} empty={!msgs.length}>
          {msgs.map((m) => (
            <tr key={m.id}>
              <td className="text-sm"><strong>{m.name}</strong><div className="text-xs subtle">{m.subject}</div></td>
              <td className="text-sm">{m.daysBeforeJoining} day(s) before joining<div className="text-xs subtle">{pretty(m.kind)}</div></td>
              <td><Pill s={m.status} /></td>
              <td className="right">
                <div className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
                  {["DRAFT", "REJECTED"].includes(m.status) ? <ActButton action={prejoinMessageOpAction} hidden={{ id: m.id, op: "submit" }} label="Submit for approval" variant="primary" /> : null}
                  {m.status === "ACTIVE" && people.length ? <SpecFormInline id={m.id} people={hireOpts(people)} /> : null}
                  {m.status !== "ARCHIVED" ? <ActButton action={prejoinMessageOpAction} hidden={{ id: m.id, op: "archive" }} label="Archive" variant="ghost" /> : null}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <div className="grid grid-2">
        <Card title="New or edit message" description={vars}>
          <SpecForm action={savePrejoinMessageAction} columns={1} fields={[
            { name: "id", label: "Edit existing", type: "select", options: msgs.map((m) => ({ value: m.id, label: m.name })), placeholder: "New message" },
            { name: "name", label: "Name", required: true },
            { name: "kind", label: "Type", type: "select", options: opts(["WELCOME", "INFO", "REMINDER"]), defaultValue: "WELCOME" },
            { name: "daysBeforeJoining", label: "Days before joining", type: "number", defaultValue: 7 },
            { name: "subject", label: "Subject", required: true },
            { name: "body", label: "Message", type: "textarea", required: true },
          ]} />
        </Card>
        <Card title="Manager introduction" description="A personal hello from the manager (or HR) before day one.">
          <SpecForm action={sendManagerIntroAction} columns={1} submitLabel="Send introduction" fields={[
            { name: "employeeId", label: "Hire", type: "select", required: true, options: hireOpts(people) },
            { name: "message", label: "Message", type: "textarea", required: true },
          ]} />
        </Card>
      </div>
      <Card tight title={`Communications log (${shown.length})`}>
        <div style={{ padding: "12px 16px 0" }}><SearchBar action="/onboarding/preboarding/comms" tab="" q={q} /></div>
        <Table head={["Sent", "Hire", "Type", "Subject", "To"]} empty={!shown.length}>
          {shown.map((l) => (
            <tr key={l.id}>
              <td className="text-sm nowrap">{fmtTime(l.sentAt)}</td>
              <td className="text-sm">{ppl.name(l.employeeId)}</td>
              <td><Badge>{pretty(l.kind)}</Badge></td>
              <td className="text-sm">{l.subject}</td>
              <td className="text-xs">{l.toAddress ?? "in-app only"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

function SpecFormInline({ id, people }: { id: string; people: Array<{ value: string; label: string }> }) {
  return (
    <div style={{ minWidth: 260 }}>
      <SpecForm action={prejoinMessageOpAction} hidden={{ id, op: "send" }} columns={1} submitLabel="Send now" fields={[{ name: "employeeId", label: "To hire", type: "select", required: true, options: people }]} />
    </div>
  );
}

async function ProvisioningSection({ viewer, status }: { viewer: Viewer; status?: string }) {
  const people = await prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, P.ONBOARDING_MANAGE), { status: { notIn: ["EXITED"] } }, { dateOfJoining: { gte: new Date(Date.now() - 30 * DAY) } }] }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { dateOfJoining: "asc" } });
  const [rows, assets] = await Promise.all([
    prisma.preboardingProvision.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: people.map((p) => p.id) }, ...(status ? { status } : {}) }, orderBy: { neededBy: "asc" } }),
    prisma.asset.findMany({ where: { tenantId: viewer.tenantId, status: "AVAILABLE" }, include: { assetType: { select: { name: true } } }, orderBy: { assetTag: "asc" }, take: 300 }),
  ]);
  const name = new Map(people.map((p) => [p.id, p.displayName]));
  const open = rows.filter((r) => !["FULFILLED", "CANCELLED"].includes(r.status));
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        {["IT_ACCOUNT", "ACCESS", "ASSET", "EQUIPMENT"].map((k) => <Stat key={k} label={`Open ${pretty(k).toLowerCase()} requests`} value={open.filter((r) => r.kind === k).length} />)}
      </div>
      <Card title="New request" description="IT accounts, system access, equipment, or reserve a specific asset from the inventory.">
        <SpecForm action={saveProvisionAction} submitLabel="Request" fields={[
          { name: "employeeId", label: "Hire", type: "select", required: true, options: hireOpts(people) },
          { name: "kind", label: "Type", type: "select", required: true, options: opts(["IT_ACCOUNT", "ACCESS", "ASSET", "EQUIPMENT"]) },
          { name: "item", label: "What", placeholder: "e.g. Google Workspace account, VPN, Jira" },
          { name: "assetId", label: "Reserve asset", type: "select", options: assets.map((a) => ({ value: a.id, label: `${a.assetTag} · ${a.name ?? a.assetType.name}` })), placeholder: "None" },
          { name: "ownerTeam", label: "Team", type: "select", options: opts(["IT", "ADMIN", "FINANCE", "HR"]), placeholder: "Default" },
          { name: "neededBy", label: "Needed by", type: "date", hint: "Defaults to the joining date" },
          { name: "details", label: "Details", type: "textarea", wide: true },
        ]} />
      </Card>
      <Card tight title="Access & provisioning queue">
        <div style={{ padding: "12px 16px 0" }}>
          <SearchBar action="/onboarding/preboarding/provisioning" tab="" q="">
            <select className="select" name="status" defaultValue={status ?? ""} style={{ width: 160 }}>
              <option value="">Any status</option>
              {["REQUESTED", "IN_PROGRESS", "RESERVED", "FULFILLED", "CANCELLED"].map((x) => <option key={x} value={x}>{pretty(x)}</option>)}
            </select>
          </SearchBar>
        </div>
        <Table head={["Needed by", "Hire", "Request", "Team", "Status", ""]} empty={!rows.length}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="text-sm">{fmtDay(r.neededBy)}</td>
              <td className="text-sm">{name.get(r.employeeId)}</td>
              <td className="text-sm">{r.item}<div className="text-xs subtle">{pretty(r.kind)}{r.assetId ? " · asset reserved" : ""}{r.note ? ` · ${r.note}` : ""}</div></td>
              <td className="text-sm">{r.ownerTeam}</td>
              <td><Pill s={r.status} /></td>
              <td className="right">
                {!["FULFILLED", "CANCELLED"].includes(r.status) ? (
                  <div className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
                    {r.status === "REQUESTED" ? <ActButton action={provisionOpAction} hidden={{ id: r.id, op: "start" }} label="Start" /> : null}
                    <ActButton action={provisionOpAction} hidden={{ id: r.id, op: "fulfil" }} label="Fulfilled" variant="primary" />
                    <ActButton action={provisionOpAction} hidden={{ id: r.id, op: "cancel" }} label="Cancel" variant="ghost" />
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function TemplatesSection({ viewer }: { viewer: Viewer }) {
  const [templates, depts, locs, forms, docs, courses] = await Promise.all([
    prisma.preboardingTemplate.findMany({ where: { tenantId: viewer.tenantId }, include: { items: { orderBy: { sortOrder: "asc" } } }, orderBy: { name: "asc" } }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.newHireForm.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true } }),
    prisma.orgDocument.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, title: true }, take: 200 }),
    prisma.course.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, title: true }, take: 200 }),
  ]);
  const dName = new Map(depts.map((d) => [d.id, d.name])), lName = new Map(locs.map((l) => [l.id, l.name]));
  const refs = [...forms.map((f) => ({ value: f.id, label: `Form: ${f.name}` })), ...docs.map((d) => ({ value: d.id, label: `Policy: ${d.title}` })), ...courses.map((c) => ({ value: c.id, label: `Course: ${c.title}` }))];
  const scopeFields = (t?: (typeof templates)[number]) => [
    { name: "name", label: "Name", required: true, defaultValue: t?.name },
    { name: "jobTitle", label: "Only for job title", defaultValue: t?.jobTitle },
    { name: "departmentId", label: "Only for department", type: "select" as const, options: depts.map((d) => ({ value: d.id, label: d.name })), placeholder: "Any", defaultValue: t?.departmentId },
    { name: "locationId", label: "Only for location", type: "select" as const, options: locs.map((l) => ({ value: l.id, label: l.name })), placeholder: "Any", defaultValue: t?.locationId },
    { name: "description", label: "Description", defaultValue: t?.description, wide: true },
    ...(t ? [{ name: "isActive", label: "Active", type: "checkbox" as const, defaultValue: t.isActive }] : []),
  ];
  return (
    <div className="stack gap-4">
      {templates.map((t) => (
        <Card key={t.id} title={t.name} description={[t.jobTitle && `role ${t.jobTitle}`, t.departmentId && dName.get(t.departmentId), t.locationId && lName.get(t.locationId), !t.isActive && "inactive"].filter(Boolean).join(" · ") || "Any hire"}>
          <Table head={["Days before", "Item", "Type", "Review", ""]} empty={!t.items.length}>
            {t.items.map((i) => (
              <tr key={i.id}>
                <td className="num">{i.daysBeforeJoining}</td>
                <td className="text-sm">{i.title}{i.description ? <div className="text-xs subtle">{i.description}</div> : null}</td>
                <td><Badge>{pretty(i.kind)}</Badge></td>
                <td className="text-xs">{i.requiresApproval ? "HR review" : "—"}</td>
                <td className="right"><ActButton action={deletePreboardingItemAction} hidden={{ id: i.id }} label="Remove" variant="ghost" /></td>
              </tr>
            ))}
          </Table>
          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <SpecForm action={addPreboardingItemAction} hidden={{ templateId: t.id }} submitLabel="Add item" fields={[
              { name: "title", label: "Item", required: true },
              { name: "kind", label: "Type", type: "select", options: opts(PREBOARDING_KINDS), defaultValue: "CUSTOM" },
              { name: "refId", label: "Form / policy / course", type: "select", options: refs, placeholder: "None" },
              { name: "daysBeforeJoining", label: "Days before joining", type: "number", defaultValue: 7 },
              { name: "requiresApproval", label: "HR review", type: "checkbox", placeholder: "Review before done" },
              { name: "description", label: "Instructions" },
            ]} />
            <SpecForm action={savePreboardingTemplateAction} hidden={{ id: t.id }} submitLabel="Save template" fields={scopeFields(t)} />
          </div>
        </Card>
      ))}
      <Card title="New preboarding template" description="Role-, department- or location-specific; the most specific match is used for each hire.">
        <SpecForm action={savePreboardingTemplateAction} submitLabel="Create template" fields={scopeFields()} />
      </Card>
    </div>
  );
}

async function SettingsSection({ viewer }: { viewer: Viewer }) {
  const s = await joinSettings(viewer.tenantId);
  return (
    <Card title="Reminder cadence and escalation">
      <SpecForm action={saveJoinSettingsAction} hidden={{ scope: "preboarding" }} fields={[
        { name: "preboardingReminderDays", label: "Remind hires every (days)", type: "number", defaultValue: s.preboardingReminderDays, hint: "0 turns reminders off" },
        { name: "preboardingReminderMax", label: "At most (reminders per task)", type: "number", defaultValue: s.preboardingReminderMax },
        { name: "journeyEscalationDays", label: "Escalate overdue onboarding tasks every (days)", type: "number", defaultValue: s.journeyEscalationDays },
      ]} />
    </Card>
  );
}
