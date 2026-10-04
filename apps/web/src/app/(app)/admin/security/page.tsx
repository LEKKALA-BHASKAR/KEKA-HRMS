import Link from "next/link";
import { headers } from "next/headers";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { accountHygiene, mfaReport, governanceSettings, ipAllowed } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { roleOptions, userOptions, userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Stat, Callout } from "@/components/ui";
import { Pill, Tabs, SearchBar, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import {
  grantTemporaryAccessAction, revokeAccessGrantAction, endTemporaryGrantAction, createAccessReviewAction, decideAccessReviewAction, closeAccessReviewAction,
  bulkDisableAction, addIpRuleAction, removeIpRuleAction, saveGovernanceSettingsAction, acknowledgeAlertAction, scanSecurityNowAction,
} from "@/app/actions/security";

const TABS = { access: "Access requests", temporary: "Time-bound access", reviews: "Access reviews", accounts: "Inactive & orphan accounts", mfa: "MFA", network: "IP allowlist & approvals", changes: "Change approvals", alerts: "Alerts", report: "Report" };
type Tab = keyof typeof TABS;

export default async function SecurityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireAuth(PERMISSIONS.SECURITY_GOVERN);
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "access";
  const t = viewer.tenantId;
  return (
    <>
      <PageHead title="Security & access" subtitle="Who can do what, for how long, and whether they still should" actions={<Link className="btn" href="/admin/roles">Roles</Link>} />
      <Tabs base="/admin/security" tabs={TABS} active={tab} />
      {tab === "access" ? <AccessRequests tenantId={t} q={sp.q} status={sp.status} /> : null}
      {tab === "temporary" ? <Temporary tenantId={t} /> : null}
      {tab === "reviews" ? <Reviews tenantId={t} id={sp.id} /> : null}
      {tab === "accounts" ? <Accounts tenantId={t} filter={sp.filter} /> : null}
      {tab === "mfa" ? <Mfa tenantId={t} /> : null}
      {tab === "network" ? <Network tenantId={t} canEdit={can(viewer, PERMISSIONS.AUTH_SETTINGS_MANAGE)} /> : null}
      {tab === "changes" ? <Changes tenantId={t} /> : null}
      {tab === "alerts" ? <Alerts tenantId={t} /> : null}
      {tab === "report" ? <Report tenantId={t} /> : null}
    </>
  );
}

async function AccessRequests({ tenantId, q, status }: { tenantId: string; q?: string; status?: string }) {
  const rows = await prisma.accessRequest.findMany({ where: { tenantId, ...(status ? { status } : {}), ...(q ? { justification: { contains: q, mode: "insensitive" } } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
  const roles = new Map((await roleOptions(tenantId)).map((r) => [r.value, r.label]));
  const names = await userNames(tenantId, rows.flatMap((r) => [r.requesterUserId, r.targetUserId]));
  return (
    <Card tight title={`Access requests (${rows.length})`} description="Employees ask from Requests › Access; the access-request workflow decides; approved time-bound grants are revoked when they end." action={<a className="btn sm" href={`/admin/governance/export?report=access-requests${status ? `&status=${status}` : ""}`}>Export CSV</a>}>
      <SearchBar action="/admin/security" tab="access" q={q}><select className="select" name="status" defaultValue={status ?? ""}><option value="">Any status</option>{["PENDING", "APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED", "REVOKED"].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</select></SearchBar>
      <Table head={["Person", "Role", "Why", "Duration", "Status", "Expires", ""]} empty={rows.length === 0}>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{names.get(r.targetUserId)}{r.requesterUserId !== r.targetUserId ? <div className="text-xs muted">asked by {names.get(r.requesterUserId)}</div> : null}</td>
            <td>{roles.get(r.roleId) ?? "Removed role"}{r.privileged ? <> <Pill s="HIGH" /></> : null}</td>
            <td className="text-xs">{r.justification}</td><td>{r.durationDays ? `${r.durationDays} d` : "Permanent"}</td><td><Pill s={r.status} /></td><td className="text-xs">{fmtDate(r.expiresAt)}</td>
            <td className="row gap-2">{r.workflowRequestId ? <Link className="btn sm ghost" href={`/me/requests/${r.workflowRequestId}`}>Route</Link> : null}{r.status === "APPROVED" ? <ActButton action={revokeAccessGrantAction} hidden={{ id: r.id }} label="Revoke" variant="ghost" confirmText="Revoke this access now?" /> : null}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Temporary({ tenantId }: { tenantId: string }) {
  const [grants, roles, users] = await Promise.all([
    prisma.userRoleAssignment.findMany({ where: { role: { tenantId }, expiresAt: { not: null } }, include: { role: { select: { name: true } }, user: { select: { email: true } } }, orderBy: { expiresAt: "asc" } }),
    roleOptions(tenantId), userOptions(tenantId),
  ]);
  return (
    <div className="stack gap-4">
      <Card tight title="Time-bound grants" description="Expired grants stop working immediately and are removed by the nightly job.">
        <Table head={["Person", "Role", "Expires", "Why", ""]} empty={grants.length === 0}>
          {grants.map((g) => <tr key={g.id}><td>{g.user.email}</td><td>{g.role.name}</td><td><Pill s={g.expiresAt! > new Date() ? "ACTIVE" : "EXPIRED"} /> {fmtWhen(g.expiresAt)}</td><td className="text-xs">{g.grantNote}</td><td><ActButton action={endTemporaryGrantAction} hidden={{ id: g.id }} label="End now" variant="ghost" /></td></tr>)}
        </Table>
      </Card>
      <Card title="Grant temporary elevated access">
        <SpecForm action={grantTemporaryAccessAction} submitLabel="Grant" fields={[
          { name: "userId", label: "Person", type: "select", options: users, required: true }, { name: "roleId", label: "Role", type: "select", options: roles, required: true },
          { name: "days", label: "Days (1–90)", type: "number", required: true, defaultValue: 7 }, { name: "reason", label: "Reason", required: true, placeholder: "Year-end payroll cover" },
        ]} />
      </Card>
    </div>
  );
}

async function Reviews({ tenantId, id }: { tenantId: string; id?: string }) {
  const [camps, roles, users] = await Promise.all([
    prisma.accessReviewCampaign.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, include: { items: { select: { decision: true } } } }),
    roleOptions(tenantId), userOptions(tenantId),
  ]);
  const open = id ? await prisma.accessReviewCampaign.findFirst({ where: { id, tenantId }, include: { items: { orderBy: [{ decision: "asc" }, { roleName: "asc" }] } } }) : null;
  const names = open ? await userNames(tenantId, open.items.flatMap((i) => [i.userId, i.reviewerUserId, i.decidedBy])) : new Map<string, string>();
  return (
    <div className="stack gap-4">
      <Card tight title="Certification campaigns">
        <Table head={["Review", "Due", "Progress", "Revoked", "Status", ""]} empty={camps.length === 0}>
          {camps.map((c) => {
            const done = c.items.filter((i) => i.decision !== "PENDING").length;
            return <tr key={c.id}><td><Link href={`/admin/security?tab=reviews&id=${c.id}`}>{c.name}</Link></td><td>{fmtDate(c.dueOn)}</td><td>{done} / {c.items.length}</td><td className="num">{c.items.filter((i) => i.decision === "REVOKED").length}</td><td><Pill s={c.status} /></td>
              <td className="row gap-2"><a className="btn sm ghost" href={`/admin/governance/export?report=access-review&id=${c.id}`}>CSV</a>{c.status === "ACTIVE" ? <ActButton action={closeAccessReviewAction} hidden={{ id: c.id }} label="Close" variant="ghost" confirmText={c.closeAction === "REVOKE" ? "Close and revoke everything undecided?" : "Close the review?"} /> : null}</td></tr>;
          })}
        </Table>
      </Card>
      {open ? (
        <Card tight title={`${open.name} — items`}>
          <Table head={["Person", "Role", "Reviewer", "Decision", "By", ""]}>
            {open.items.map((i) => <tr key={i.id}><td>{names.get(i.userId)}</td><td>{i.roleName}</td><td>{names.get(i.reviewerUserId)}</td><td><Pill s={i.decision} /></td><td className="text-xs">{i.decidedBy ? `${names.get(i.decidedBy)} · ${fmtWhen(i.decidedAt)}` : ""}</td>
              <td className="row gap-2">{i.decision === "PENDING" && open.status === "ACTIVE" ? <><ActButton action={decideAccessReviewAction} hidden={{ itemId: i.id, decision: "CONFIRMED" }} label="Confirm" /><ActButton action={decideAccessReviewAction} hidden={{ itemId: i.id, decision: "REVOKED" }} label="Revoke" variant="danger" /></> : null}</td></tr>)}
          </Table>
        </Card>
      ) : null}
      <Card title="Start an access review" description="Snapshots every matching role grant and asks reviewers to confirm or revoke each one.">
        <SpecForm action={createAccessReviewAction} submitLabel="Start review" fields={[
          { name: "name", label: "Name", required: true, placeholder: "Q4 privileged access review" }, { name: "dueOn", label: "Due", type: "date", required: true },
          { name: "reviewerMode", label: "Reviewer", type: "select", required: true, options: [{ value: "MANAGER", label: "Each person's reporting manager" }, { value: "USER", label: "One reviewer" }] },
          { name: "reviewerUserId", label: "Reviewer / fallback", type: "select", options: users },
          { name: "closeAction", label: "Undecided at close", type: "select", required: true, options: [{ value: "KEEP", label: "Keep the access" }, { value: "REVOKE", label: "Revoke the access" }] },
          { name: "roleIds", label: "Roles (none: all)", type: "multiselect", options: roles },
        ]} />
      </Card>
    </div>
  );
}

async function Accounts({ tenantId, filter }: { tenantId: string; filter?: string }) {
  const all = await accountHygiene(tenantId);
  const rows = all.filter((r) => (filter === "orphan" ? !!r.orphan : filter === "all" ? true : r.inactive || !!r.orphan));
  const inactive = all.filter((r) => r.inactive).length, orphan = all.filter((r) => r.orphan).length;
  return (
    <div className="stack gap-4">
      <div className="grid grid-3"><Stat label={`Inactive (${all[0]?.inactiveDays ?? 90}+ days)`} value={inactive} tone={inactive ? "neg" : undefined} /><Stat label="Orphan accounts" value={orphan} tone={orphan ? "neg" : undefined} /><Stat label="Logins" value={all.length} /></div>
      <Card tight title="Accounts needing attention" action={<div className="row gap-2"><a className="btn sm" href="/admin/governance/export?report=accounts">Export CSV</a>
        <ActButton action={bulkDisableAction} hidden={{ which: "inactive" }} label={`Disable all inactive (${inactive})`} variant="danger" confirmText="Disable every inactive login?" />
        <ActButton action={bulkDisableAction} hidden={{ which: "orphan" }} label={`Disable all orphans (${orphan})`} variant="danger" confirmText="Disable every orphan login?" /></div>}>
        <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="accounts" /><select className="select" name="filter" defaultValue={filter ?? ""}><option value="">Inactive or orphan</option><option value="orphan">Orphan only</option><option value="all">Every login</option></select><button className="btn sm">Show</button></form>
        <Table head={["Login", "Name", "Last sign-in", "Roles", "Flags", "Status"]} empty={rows.length === 0}>
          {rows.map((r) => <tr key={r.userId}><td className="text-sm">{r.email}</td><td>{r.name ?? "—"}</td><td className="text-xs">{fmtWhen(r.lastLoginAt)}</td><td className="num">{r.roleCount}</td>
            <td className="text-xs">{[r.inactive ? "Inactive" : null, r.orphan].filter(Boolean).join(" · ")}</td><td><Pill s={r.loginDisabled ? "REVOKED" : "ACTIVE"} /></td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Mfa({ tenantId }: { tenantId: string }) {
  const r = await mfaReport(tenantId);
  return (
    <div className="stack gap-4">
      <div className="grid grid-3"><Stat label="Two-factor policy" value={r.policy.toLowerCase()} /><Stat label="Logins required to use 2FA" value={`${r.required} / ${r.rows.length}`} /><Stat label="Role holders without 2FA" value={r.adminsWithout} tone={r.adminsWithout ? "neg" : undefined} /></div>
      {r.adminsWithout ? <Callout tone="warning" title="Enforce MFA">People holding roles can sign in with a password alone. Set the policy to “admins” or “everyone” under <Link href="/admin/settings?tab=security">Settings › Security</Link>.</Callout> : null}
      <Card tight title="MFA enforcement" action={<a className="btn sm" href="/admin/governance/export?report=mfa">Export CSV</a>}>
        <Table head={["Login", "Holds roles", "2FA required", "Method", "Last second factor (90 d)", "Last sign-in"]}>
          {r.rows.map((x) => <tr key={x.userId}><td className="text-sm">{x.email}</td><td>{x.admin ? "Yes" : "No"}</td><td>{x.required ? <Pill s="ACTIVE" /> : x.gap ? <Pill s="HIGH" /> : "No"}</td><td>{x.method}</td><td className="text-xs">{fmtWhen(x.lastSecondFactor)}</td><td className="text-xs">{fmtWhen(x.lastLoginAt)}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Network({ tenantId, canEdit }: { tenantId: string; canEdit: boolean }) {
  const [rules, s] = await Promise.all([prisma.ipAllowRule.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }), governanceSettings(tenantId)]);
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || h.get("x-real-ip") || null;
  const covered = ip ? ipAllowed(ip, rules.map((r) => r.cidr), true) : null;
  return (
    <div className="stack gap-4">
      <Callout tone={s.ipAllowlistEnforced ? "success" : "info"} title={s.ipAllowlistEnforced ? "Allowlist enforced" : "Allowlist not enforced"}>
        Password and single sign-on are refused from addresses outside the list while it is enforced. Your address: <span className="mono">{ip ?? "unknown"}</span>{covered === null ? "" : covered ? " (on the list)" : " (not on the list)"}.
      </Callout>
      <Card tight title="Allowed addresses">
        <Table head={["Range", "Label", "Added", ""]} empty={rules.length === 0}>
          {rules.map((r) => <tr key={r.id}><td className="mono">{r.cidr}</td><td>{r.label}</td><td className="text-xs">{fmtDate(r.createdAt)}</td><td>{canEdit ? <ActButton action={removeIpRuleAction} hidden={{ id: r.id }} label="Remove" variant="ghost" /> : null}</td></tr>)}
        </Table>
        {canEdit ? <div style={{ padding: 14 }}><SpecForm action={addIpRuleAction} submitLabel="Add" fields={[{ name: "cidr", label: "IP or CIDR", required: true, placeholder: "203.0.113.0/24" }, { name: "label", label: "Label", placeholder: "Bengaluru office" }]} /></div> : null}
      </Card>
      {canEdit ? (
        <Card title="Governance settings">
          <SpecForm action={saveGovernanceSettingsAction} submitLabel="Save settings" fields={[
            { name: "ipAllowlistEnforced", label: "IP allowlist", type: "checkbox", placeholder: "Enforce at sign-in", defaultValue: s.ipAllowlistEnforced },
            { name: "roleChangeApproval", label: "Role changes", type: "checkbox", placeholder: "Role grants and role edits need a second administrator", defaultValue: s.roleChangeApproval },
            { name: "policyChangeApproval", label: "Security policy", type: "checkbox", placeholder: "Password, lockout and 2FA changes need a second administrator", defaultValue: s.policyChangeApproval },
            { name: "webhookApproval", label: "Webhooks", type: "checkbox", placeholder: "New webhook endpoints need approval", defaultValue: s.webhookApproval },
            { name: "inactiveDays", label: "Inactive after (days)", type: "number", defaultValue: s.inactiveDays },
            { name: "failedLoginAlert", label: "Alert after failed sign-ins (per hour)", type: "number", defaultValue: s.failedLoginAlert },
            { name: "reminderHours", label: "Remind approvers after (hours)", type: "number", defaultValue: s.reminderHours },
          ]} />
        </Card>
      ) : null}
    </div>
  );
}

async function Changes({ tenantId }: { tenantId: string }) {
  const rows = await prisma.changeRequest.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100 });
  const names = await userNames(tenantId, rows.map((r) => r.requestedBy));
  return (
    <Card tight title="Role, permission and policy changes" description="With approval switched on, these wait for a second administrator in their inbox and apply once approved.">
      <Table head={["Change", "Kind", "Proposed by", "Status", "When", ""]} empty={rows.length === 0}>
        {rows.map((r) => <tr key={r.id}><td>{r.summary}{r.error ? <div className="text-xs neg">{r.error}</div> : null}</td><td className="text-xs">{r.kind}</td><td>{names.get(r.requestedBy)}</td><td><Pill s={r.status} /></td><td className="text-xs">{fmtWhen(r.createdAt)}</td><td>{r.workflowRequestId ? <Link className="btn sm ghost" href={`/me/requests/${r.workflowRequestId}`}>Route</Link> : null}</td></tr>)}
      </Table>
    </Card>
  );
}

async function Alerts({ tenantId }: { tenantId: string }) {
  const rows = await prisma.securityAlert.findMany({ where: { tenantId }, orderBy: [{ status: "desc" }, { createdAt: "desc" }], take: 200 });
  return (
    <Card tight title="Security alerts" description="Raised from the sign-in log (repeated failures, refused addresses) and privileged grants." action={<div className="row gap-2"><ActButton action={scanSecurityNowAction} hidden={{}} label="Scan now" /><ActButton action={acknowledgeAlertAction} hidden={{ id: "all" }} label="Acknowledge all" variant="ghost" /></div>}>
      <Table head={["When", "Alert", "Severity", "Status", ""]} empty={rows.length === 0}>
        {rows.map((a) => <tr key={a.id}><td className="text-xs">{fmtWhen(a.createdAt)}</td><td>{a.summary}</td><td><Pill s={a.severity} /></td><td><Pill s={a.status} /></td><td>{a.status === "OPEN" ? <ActButton action={acknowledgeAlertAction} hidden={{ id: a.id }} label="Acknowledge" variant="ghost" /> : null}</td></tr>)}
      </Table>
    </Card>
  );
}

async function Report({ tenantId }: { tenantId: string }) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [logins, failures, blocked, pendingAccess, temp, openAlerts, reviews, hygiene] = await Promise.all([
    prisma.loginEvent.count({ where: { tenantId, success: true, createdAt: { gte: since } } }),
    prisma.loginEvent.count({ where: { tenantId, success: false, createdAt: { gte: since } } }),
    prisma.loginEvent.count({ where: { tenantId, outcome: "IP_BLOCKED", createdAt: { gte: since } } }),
    prisma.accessRequest.count({ where: { tenantId, status: "PENDING" } }),
    prisma.userRoleAssignment.count({ where: { role: { tenantId }, expiresAt: { gt: new Date() } } }),
    prisma.securityAlert.count({ where: { tenantId, status: "OPEN" } }),
    prisma.accessReviewCampaign.count({ where: { tenantId, status: "ACTIVE" } }),
    accountHygiene(tenantId),
  ]);
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Sign-ins (30 d)" value={logins} /><Stat label="Failed sign-ins (30 d)" value={failures} /><Stat label="Refused by allowlist (30 d)" value={blocked} /><Stat label="Open alerts" value={openAlerts} tone={openAlerts ? "neg" : undefined} />
        <Stat label="Access requests waiting" value={pendingAccess} /><Stat label="Time-bound grants live" value={temp} /><Stat label="Reviews running" value={reviews} /><Stat label="Inactive / orphan logins" value={`${hygiene.filter((h) => h.inactive).length} / ${hygiene.filter((h) => h.orphan).length}`} />
      </div>
      <Card title="Exports">
        <div className="row gap-2 wrap">
          <a className="btn" href="/admin/governance/export?report=access-requests">Access requests</a><a className="btn" href="/admin/governance/export?report=role-grants">Role grants</a>
          <a className="btn" href="/admin/governance/export?report=accounts">Accounts</a><a className="btn" href="/admin/governance/export?report=mfa">MFA</a>
          <a className="btn" href="/admin/governance/export?report=security-alerts">Alerts</a><a className="btn" href="/admin/governance/export?report=sign-ins">Sign-in log (30 d)</a>
        </div>
      </Card>
    </div>
  );
}
