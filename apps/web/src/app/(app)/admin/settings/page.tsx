import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";
import { forbidden } from "next/navigation";
import { securityPolicy } from "@/lib/auth-policy";
import { MAIL_DIR } from "@/lib/mail";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { ProfileForm, VisibilityForm, SecurityForm, UserSecurityForm, DeliverMailButton } from "./forms";
import { CustomFieldForm, CustomFieldRow } from "./custom-fields";
import { NoticePolicyForm, NoticePolicyRow, ExitReasonForm, ExitReasonRow, FolderForm, FolderHeader, DocTypeForm, DocTypeRow } from "./workplace";

const P = PERMISSIONS;
const TABS = { org: "Organisation", fields: "Custom fields", documents: "Documents", exits: "Notice & exits", security: "Security", log: "Sign-in log", mail: "Email", jobs: "Scheduled jobs" } as const;
type Tab = keyof typeof TABS;
const when = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  // Each tab needs its own permission, so document and exit administrators can reach theirs.
  const allowed: Record<Tab, boolean> = {
    org: can(viewer, P.ORG_SETTINGS_MANAGE), fields: can(viewer, P.ORG_SETTINGS_MANAGE),
    documents: can(viewer, P.DOCUMENT_MANAGE), exits: can(viewer, P.EXIT_MANAGE),
    security: can(viewer, P.AUTH_SETTINGS_MANAGE), log: can(viewer, P.AUTH_SETTINGS_MANAGE),
    mail: can(viewer, P.ORG_SETTINGS_MANAGE), jobs: can(viewer, P.ORG_SETTINGS_MANAGE),
  };
  const tabs = (Object.keys(TABS) as Tab[]).filter((t) => allowed[t]);
  if (!tabs.length) forbidden();
  const tab: Tab = tabs.includes(sp.tab as Tab) ? (sp.tab as Tab) : tabs[0];

  return (
    <>
      <PageHead title="Settings" subtitle="Organisation, access and security" />
      <div className="tabs">
        {tabs.map((t) => <Link key={t} href={`/admin/settings?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>{TABS[t]}</Link>)}
      </div>
      {tab === "org" ? <Org tenantId={viewer.tenantId} /> : null}
      {tab === "fields" ? <Fields tenantId={viewer.tenantId} /> : null}
      {tab === "documents" ? <Documents tenantId={viewer.tenantId} /> : null}
      {tab === "exits" ? <Exits tenantId={viewer.tenantId} /> : null}
      {tab === "security" ? <Security tenantId={viewer.tenantId} /> : null}
      {tab === "log" ? <Log tenantId={viewer.tenantId} /> : null}
      {tab === "mail" ? <Mail tenantId={viewer.tenantId} /> : null}
      {tab === "jobs" ? <Jobs /> : null}
    </>
  );
}

async function Org({ tenantId }: { tenantId: string }) {
  const [tenant, vis, finalised] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    prisma.tenantVisibilitySetting.findUnique({ where: { tenantId } }),
    prisma.payrollRun.count({ where: { tenantId, status: "FINALIZED" } }),
  ]);
  return (
    <div className="stack gap-4">
      <Card title="Organisation" description={`${tenant.subdomain}.keka.local · ${tenant.plan.toLowerCase()} plan · ${tenant.currency}`}>
        <ProfileForm name={tenant.name} timezone={tenant.timezone} fyStartMonth={tenant.fyStartMonth} locked={finalised > 0} />
      </Card>
      <Card title="Directory visibility" description="Who can find whom in the employee directory and org chart.">
        <VisibilityForm v={vis ?? { restrictByLegalEntity: false, restrictByBusinessUnit: false, managerReporteeOverride: true }} />
      </Card>
    </div>
  );
}

async function Fields({ tenantId }: { tenantId: string }) {
  const defs = await prisma.customFieldDefinition.findMany({
    where: { tenantId, entity: "EMPLOYEE" }, orderBy: [{ isActive: "desc" }, { displayOrder: "asc" }, { label: "asc" }],
    include: { _count: { select: { values: { where: { value: { not: null } } } } } },
  });
  return (
    <div className="stack gap-4">
      <Card tight title={`Employee fields (${defs.length})`} description="Extra details your organisation records about each person, shown on the Profile tab and edited by anyone who can edit the profile.">
        {defs.length === 0 ? <Empty title="No custom fields yet">Add one below, for example T-shirt size or a previous employee ID.</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Label</th><th>Type</th><th>Profile card</th><th className="num">Filled in</th><th>Status</th><th /></tr></thead>
              <tbody>
                {defs.map((d) => (
                  <CustomFieldRow key={d.id} used={d._count.values} def={{
                    id: d.id, label: d.label, section: d.section, type: d.type, options: (d.options as string[] | null) ?? [],
                    isMandatory: d.isMandatory, isActive: d.isActive, displayOrder: d.displayOrder,
                  }} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Add a field"><CustomFieldForm /></Card>
    </div>
  );
}

async function Documents({ tenantId }: { tenantId: string }) {
  const folders = await prisma.documentFolder.findMany({
    where: { tenantId }, orderBy: [{ scope: "asc" }, { name: "asc" }],
    include: { types: { orderBy: { name: "asc" } } },
  });
  const counts = await prisma.employeeDocument.groupBy({
    by: ["documentTypeId", "status"], where: { tenantId, documentTypeId: { not: null }, employee: { status: { not: "EXITED" } } }, _count: { _all: true },
  });
  const tally = (typeId: string, pending: boolean) => counts.filter((c) => c.documentTypeId === typeId && (c.status === "PENDING_ON_EMPLOYEE") === pending).reduce((a, c) => a + c._count._all, 0);
  const folderData = folders.map((f) => ({ id: f.id, name: f.name, description: f.description, scope: f.scope, isConfidential: f.isConfidential }));
  return (
    <div className="stack gap-4">
      {folders.length === 0 ? <Card><Empty title="No document folders yet">Add a folder, then the documents you collect in it.</Empty></Card> : null}
      {folders.map((f) => (
        <Card key={f.id} tight title={<>{f.name}{f.isConfidential ? <> <Badge tone="danger">confidential</Badge></> : null}</>}
          description={`${f.scope === "EMPLOYEE" ? "Each employee's documents" : "Organisation policies"}${f.description ? ` · ${f.description}` : ""}`}
          action={<FolderHeader f={folderData.find((x) => x.id === f.id)!} />}>
          {f.types.length === 0 ? <Empty title="No document types in this folder" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Document</th><th>Rules</th><th>Employees</th><th /></tr></thead>
                <tbody>
                  {f.types.map((t) => (
                    <DocTypeRow key={t.id} folders={folderData} employeeFolder={f.scope === "EMPLOYEE"} t={{
                      id: t.id, folderId: t.folderId, name: t.name, allowMultiple: t.allowMultiple, isMandatory: t.isMandatory,
                      requireVerification: t.requireVerification, trackExpiry: t.trackExpiry, allowNotApplicable: t.allowNotApplicable,
                      requested: tally(t.id, true), provided: tally(t.id, false),
                    }} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        {folders.length ? <Card title="Add a document type"><DocTypeForm folders={folderData} /></Card> : null}
        <Card title="Add a folder"><FolderForm /></Card>
      </div>
    </div>
  );
}

async function Exits({ tenantId }: { tenantId: string }) {
  const [policies, reasons] = await Promise.all([
    prisma.noticePeriodPolicy.findMany({ where: { tenantId }, orderBy: [{ isDefault: "desc" }, { isActive: "desc" }, { name: "asc" }], include: { _count: { select: { employees: true } } } }),
    prisma.exitReason.findMany({ where: { tenantId }, orderBy: [{ isActive: "desc" }, { displayOrder: "asc" }, { name: "asc" }], include: { _count: { select: { exits: true } } } }),
  ]);
  return (
    <div className="stack gap-4">
      <Card tight title="Notice periods" description="How much notice each side gives. Employees follow the default unless their job details name another policy.">
        {policies.length === 0 ? <Empty title="No notice policy yet">Until one exists, resignations need 60 days, terminations 30 and probation 15.</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Policy</th><th>Resignation</th><th>Termination</th><th>In probation</th><th>Buyout</th><th /></tr></thead>
              <tbody>
                {policies.map((p) => (
                  <NoticePolicyRow key={p.id} p={{
                    id: p.id, name: p.name, resignationDays: p.resignationDays, terminationDays: p.terminationDays, probationDays: p.probationDays,
                    allowBuyout: p.allowBuyout, buyoutBasis: p.buyoutBasis, isDefault: p.isDefault, isActive: p.isActive, employees: p._count.employees,
                  }} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}><NoticePolicyForm /></div>
      </Card>
      <Card tight title="Exit reasons" description="Offered when someone resigns or HR records an exit, and used in attrition reports. Involuntary reasons are hidden from employees resigning.">
        {reasons.length === 0 ? <Empty title="No exit reasons yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Reason</th><th>Kind</th><th className="num">Exits</th><th /></tr></thead>
              <tbody>
                {reasons.map((r) => <ExitReasonRow key={r.id} r={{ id: r.id, name: r.name, kind: r.kind, displayOrder: r.displayOrder, isActive: r.isActive, exits: r._count.exits }} />)}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}><ExitReasonForm /></div>
      </Card>
    </div>
  );
}

async function Security({ tenantId }: { tenantId: string }) {
  const s = await securityPolicy(tenantId);
  const [locked, mustChange, users] = await Promise.all([
    prisma.user.count({ where: { tenantId, lockedUntil: { gt: new Date() } } }),
    prisma.user.count({ where: { tenantId, mustChangePassword: true } }),
    prisma.user.count({ where: { tenantId, loginDisabled: false, isDeactivated: false } }),
  ]);
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Active logins" value={String(users)} meta="can sign in" />
        <Stat label="Locked now" value={String(locked)} meta="after failed attempts" />
        <Stat label="Must change password" value={String(mustChange)} meta="at next sign-in" />
      </div>
      <Card title="Policy"><SecurityForm s={s} /></Card>
      <Card title="Act on a user" description="Unlock an account, end its sessions, or require a new password. Every action is audited.">
        <UserSecurityForm />
      </Card>
    </div>
  );
}

async function Log({ tenantId }: { tenantId: string }) {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [events, failures, byIp] = await Promise.all([
    prisma.loginEvent.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.loginEvent.count({ where: { tenantId, success: false, outcome: "BAD_CREDENTIALS", createdAt: { gte: since } } }),
    prisma.loginEvent.groupBy({ by: ["ipAddress"], where: { tenantId, success: false, createdAt: { gte: since } }, _count: { _all: true }, orderBy: { _count: { ipAddress: "desc" } }, take: 3 }),
  ]);
  const tone = (o: string) => o === "OK" ? "success" : o === "OTP_SENT" || o === "RESET_REQUESTED" || o === "UNLOCKED" ? "info" : "danger";
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Failed sign-ins, 7 days" value={String(failures)} meta="wrong password" />
        <Stat label="Noisiest address" value={byIp[0]?.ipAddress ?? "—"} meta={byIp[0] ? `${byIp[0]._count._all} failures` : "no failures"} />
        <Stat label="Events shown" value={String(events.length)} meta="most recent first" />
      </div>
      <Card tight title="Sign-in events">
        {events.length === 0 ? <Empty title="No sign-ins recorded yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Email</th><th>Outcome</th><th>Address</th><th>Device</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap text-sm">{when(e.createdAt)}</td>
                    <td className="text-sm">{e.email}</td>
                    <td><Badge tone={tone(e.outcome)}>{e.outcome.replace(/_/g, " ").toLowerCase()}</Badge></td>
                    <td className="mono text-xs">{e.ipAddress ?? "—"}</td>
                    <td className="text-xs subtle" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.userAgent ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function Mail({ tenantId }: { tenantId: string }) {
  const [counts, recent] = await Promise.all([
    prisma.emailOutbox.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
    prisma.emailOutbox.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const c = (s: string) => counts.find((x) => x.status === s)?._count._all ?? 0;
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Queued" value={String(c("QUEUED"))} meta="waiting for delivery" />
        <Stat label="Sent" value={String(c("SENT"))} meta="delivered" />
        <Stat label="Failed" value={String(c("FAILED"))} meta="retried up to 5 times" />
      </div>
      <Card tight title="Outbox" description={`Development delivery writes each message as an .eml file in ${MAIL_DIR}. Configure a provider transport for real delivery.`}
        action={<DeliverMailButton />}>
        {recent.length === 0 ? <Empty title="No email yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Queued</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
              <tbody>
                {recent.map((m) => (
                  <tr key={m.id}>
                    <td className="nowrap text-sm">{when(m.createdAt)}</td>
                    <td className="text-sm">{m.toAddress}</td>
                    <td className="text-sm">{/sign-in code/.test(m.subject) ? "Sign-in code (hidden)" : m.subject}</td>
                    <td><Badge tone={m.status === "SENT" ? "success" : m.status === "FAILED" ? "danger" : "warning"}>{m.status.toLowerCase()}</Badge>{m.lastError ? <div className="text-xs neg">{m.lastError}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

const JOBS: Array<[string, string, number]> = [
  ["deliver-mail", "Deliver queued email", 15 * 60_000],
  ["process-attendance", "Process the last three days of attendance", 26 * 3_600_000],
  ["journeys", "Close journey tasks the system can verify", 26 * 3_600_000],
  ["invoices", "Mark unpaid invoices past their due date overdue", 26 * 3_600_000],
  ["ledger-check", "Check every tenant's books balance", 26 * 3_600_000],
  ["accrue", "Credit the month's leave", 32 * 86_400_000],
];

async function Jobs() {
  const runs = await prisma.jobRun.findMany({ orderBy: { startedAt: "desc" }, take: 60 });
  return (
    <div className="stack gap-4">
      <Card tight title="Schedule" description="Run by cron with `npm run jobs -- nightly` (and `deliver-mail` every few minutes). Every job is idempotent — a late or repeated run never double-counts.">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Job</th><th>What it does</th><th>Last run</th><th>Result</th></tr></thead>
            <tbody>
              {JOBS.map(([key, what, staleAfter]) => {
                const last = runs.find((r) => r.job === key);
                const stale = !last || Date.now() - last.startedAt.getTime() > staleAfter;
                return (
                  <tr key={key}>
                    <td className="mono text-sm">{key}</td>
                    <td className="text-sm">{what}</td>
                    <td className="text-sm nowrap">{last ? when(last.startedAt) : "never"}</td>
                    <td>
                      {!last ? <Badge tone="warning">not scheduled</Badge>
                        : last.ok === false ? <Badge tone="danger">failed</Badge>
                        : stale ? <Badge tone="warning">overdue</Badge>
                        : <Badge tone="success">ok</Badge>}
                      {last?.error ? <div className="text-xs neg">{last.error.slice(0, 120)}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card tight title="Recent runs">
        {runs.length === 0 ? <Empty title="No job has run yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Started</th><th>Job</th><th>Took</th><th>Summary</th></tr></thead>
              <tbody>
                {runs.slice(0, 25).map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap text-sm">{when(r.startedAt)}</td>
                    <td className="mono text-xs">{r.job}</td>
                    <td className="num text-sm">{r.finishedAt ? `${r.finishedAt.getTime() - r.startedAt.getTime()} ms` : "running"}</td>
                    <td className="text-xs muted">{r.ok === false ? r.error : r.summary ? Object.entries(r.summary as Record<string, unknown>).map(([k, v]) => `${k} ${v}`).join(" · ") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
