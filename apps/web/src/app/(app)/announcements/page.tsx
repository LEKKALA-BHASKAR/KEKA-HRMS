import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { announcementAudience, engageSettings, inAudience, reachStats, type Audience } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { departmentOptions, locationOptions } from "@/lib/governance";
import { employeeNames, fmtTime, fmtDay, matches, pretty, toLocalInput } from "@/lib/engage-depth";
import { PageHead, Card, Badge, Empty, Progress, Stat, Callout } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { saveAnnouncementAction, announcementOpAction, acknowledgeAnnouncementAction } from "@/app/actions/engage-comms";
import { withdrawWorkflowAction } from "@/app/actions/workflows";
import { saveEngageSettingsAction } from "@/app/actions/engage-surveys";

const P = PERMISSIONS;
const ALL_TABS = { live: "Live", manage: "Manage", compose: "Compose", archive: "Archive", report: "Reach & acknowledgement" };
type Tab = keyof typeof ALL_TABS;
const CATS = ["GENERAL", "POLICY", "LEADERSHIP", "EVENT", "IT", "HR"];
const LANGS: Record<string, string> = { hi: "Hindi", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam", mr: "Marathi", bn: "Bengali", gu: "Gujarati", fr: "French", de: "German", es: "Spanish", ar: "Arabic" };

/** Announcements: the live feed with acknowledgement for everyone, and authoring (audience, schedule, approval, translations, emergency broadcast), archive and reach reports for communications. */
export default async function AnnouncementsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireAuth(P.ANNOUNCEMENT_VIEW);
  const sp = await searchParams;
  const canManage = can(viewer, P.ANNOUNCEMENT_MANAGE);
  const tabs = Object.fromEntries(Object.entries(ALL_TABS).filter(([k]) => canManage || k === "live")) as Record<string, string>;
  const tab: Tab = (sp.tab ?? "") in tabs ? (sp.tab as Tab) : "live";
  return (
    <>
      <PageHead title="Announcements" subtitle="Company news, policies and urgent notices" actions={canManage ? <Link className="btn primary" href="/announcements?tab=compose">New announcement</Link> : undefined} />
      <Tabs base="/announcements" tabs={tabs} active={tab} />
      {tab === "live" ? <Live tenantId={viewer.tenantId} employeeId={viewer.employee?.id ?? null} q={sp.q} cat={sp.cat} lang={sp.lang} /> : null}
      {tab === "manage" && canManage ? <Manage tenantId={viewer.tenantId} q={sp.q} status={sp.status} /> : null}
      {tab === "compose" && canManage ? <Compose tenantId={viewer.tenantId} editId={sp.edit} /> : null}
      {tab === "archive" && canManage ? <Archive tenantId={viewer.tenantId} q={sp.q} /> : null}
      {tab === "report" && canManage ? <Report tenantId={viewer.tenantId} id={sp.id} /> : null}
    </>
  );
}

async function Live({ tenantId, employeeId, q, cat, lang }: { tenantId: string; employeeId: string | null; q?: string; cat?: string; lang?: string }) {
  const me = employeeId ? await prisma.employee.findUnique({ where: { id: employeeId }, select: { departmentId: true, locationId: true, businessUnitId: true, status: true } }) : null;
  const all = await prisma.announcement.findMany({
    where: { tenantId, status: "PUBLISHED", ...(cat && CATS.includes(cat) ? { category: cat } : {}) },
    orderBy: [{ isEmergency: "desc" }, { isPinned: "desc" }, { publishAt: "desc" }, { createdAt: "desc" }],
    include: { reads: { where: { employeeId: employeeId ?? "__none__" }, select: { acknowledgedAt: true } } },
  });
  const shown = all.filter((a) => (!me || inAudience(a.audience as Audience | null, me)) && matches(q, a.title, a.body));
  // Record that the viewer has seen what is on screen (reach statistics).
  if (employeeId && shown.length) await prisma.announcementRead.createMany({ data: shown.map((a) => ({ announcementId: a.id, employeeId })), skipDuplicates: true });
  const langs = [...new Set(shown.flatMap((a) => Object.keys((a.translations ?? {}) as Record<string, unknown>)))];
  const pending = shown.filter((a) => a.requireAck && !a.reads[0]?.acknowledgedAt).length;
  return (
    <div className="stack gap-3">
      <form method="get" className="row gap-2 wrap">
        <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search announcements…" />
        <select className="select" name="cat" defaultValue={cat ?? ""} style={{ width: 160 }}><option value="">All categories</option>{CATS.map((c) => <option key={c} value={c}>{pretty(c)}</option>)}</select>
        {langs.length ? <select className="select" name="lang" defaultValue={lang ?? ""} style={{ width: 160 }}><option value="">English</option>{langs.map((l) => <option key={l} value={l}>{LANGS[l] ?? l}</option>)}</select> : null}
        <button className="btn sm">Apply</button>
      </form>
      {pending ? <Callout tone="warning" title={`${pending} announcement${pending === 1 ? "" : "s"} need your acknowledgement`}>Please read and confirm below.</Callout> : null}
      {shown.length === 0 ? <Card><Empty title="Nothing to show" /></Card> : shown.map((a) => {
        const tr = lang ? ((a.translations ?? {}) as Record<string, { title: string; body: string }>)[lang] : undefined;
        const acked = a.reads[0]?.acknowledgedAt;
        const needsAck = a.requireAck && !acked;
        return (
          <div key={a.id} className="card" style={a.isEmergency ? { borderColor: "var(--danger)" } : needsAck ? { borderColor: "var(--warning)" } : undefined}>
            <div className="card-head"><div style={{ minWidth: 0 }}>
              <div className="row gap-2 wrap">
                <span className="card-title">{tr?.title ?? a.title}</span>
                {a.isEmergency ? <Badge tone="danger">Emergency</Badge> : null}
                {a.isPinned && !a.isEmergency ? <Badge tone="brand">Pinned</Badge> : null}
                {a.category ? <Badge>{pretty(a.category)}</Badge> : null}
                {a.requireAck ? <Badge tone="warning">Acknowledgement required</Badge> : null}
              </div>
              <div className="card-desc">Published {fmtTime(a.publishAt ?? a.createdAt)}{a.expiresAt ? ` · until ${fmtDay(a.expiresAt)}` : ""}</div>
            </div></div>
            <div className="card-body">
              <p style={{ whiteSpace: "pre-wrap", marginBottom: 12 }}>{tr?.body ?? a.body}</p>
              {needsAck && employeeId ? <ActButton action={acknowledgeAnnouncementAction} hidden={{ announcementId: a.id }} label="I have read and understood this" variant="primary" /> : acked ? <Badge tone="success" dot>Acknowledged {fmtDay(acked)}</Badge> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

async function Manage({ tenantId, q, status }: { tenantId: string; q?: string; status?: string }) {
  const rows = await prisma.announcement.findMany({
    where: { tenantId, status: status && ["DRAFT", "SCHEDULED", "PUBLISHED", "EXPIRED"].includes(status) ? (status as "DRAFT") : { not: "ARCHIVED" } },
    orderBy: [{ updatedAt: "desc" }],
    include: { _count: { select: { reads: true } } },
  });
  const shown = rows.filter((a) => matches(q, a.title, a.body, a.category));
  const settings = await engageSettings(tenantId);
  return (
    <div className="stack gap-4">
      <Card tight title="Announcements" action={<a className="btn sm" href="/engage/export?report=announcements">Export CSV</a>}>
        <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="manage" />
          <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search…" />
          <select className="select" name="status" defaultValue={status ?? ""} style={{ width: 170 }}><option value="">All but archived</option>{["DRAFT", "SCHEDULED", "PUBLISHED", "EXPIRED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select>
          <button className="btn sm">Filter</button></form>
        <Table head={["Title", "Category", "Audience", "Publishes", "Status", "Views", ""]} empty={shown.length === 0}>
          {shown.map((a) => {
            const aud = a.audience as Audience | null;
            return (
              <tr key={a.id}>
                <td><strong>{a.title}</strong>{a.isEmergency ? <> <Badge tone="danger">Emergency</Badge></> : null}{a.requireAck ? <div className="text-xs muted">Acknowledgement required</div> : null}</td>
                <td>{pretty(a.category ?? "GENERAL")}</td>
                <td className="text-xs">{aud ? [aud.departmentIds?.length ? `${aud.departmentIds.length} dept` : "", aud.locationIds?.length ? `${aud.locationIds.length} location` : "", aud.excludeOnNotice ? "excl. notice period" : ""].filter(Boolean).join(", ") || "Everyone" : "Everyone"}</td>
                <td className="text-xs">{a.publishAt ? fmtTime(a.publishAt) : "On publish"}</td>
                <td><Pill s={a.status} />{a.approvalStatus ? <div className="text-xs muted">Approval: {pretty(a.approvalStatus)}</div> : null}</td>
                <td>{a._count.reads}</td>
                <td className="row gap-2 wrap">
                  {a.status === "DRAFT" && a.approvalStatus !== "PENDING" ? <ActButton action={announcementOpAction} hidden={{ id: a.id, op: "publish" }} label={settings.announcementApproval && a.approvalStatus !== "APPROVED" ? "Submit for approval" : a.publishAt && a.publishAt > new Date() ? "Schedule" : "Publish"} variant="primary" /> : null}
                  {a.approvalStatus === "PENDING" && a.workflowRequestId ? <ActButton action={withdrawWorkflowAction} hidden={{ requestId: a.workflowRequestId }} label="Withdraw request" variant="ghost" /> : null}
                  {a.status === "SCHEDULED" ? <ActButton action={announcementOpAction} hidden={{ id: a.id, op: "unschedule" }} label="Unschedule" variant="ghost" /> : null}
                  {a.status === "PUBLISHED" && a.requireAck ? <ActButton action={announcementOpAction} hidden={{ id: a.id, op: "remind" }} label="Remind" /> : null}
                  {["PUBLISHED", "EXPIRED", "SCHEDULED"].includes(a.status) ? <ActButton action={announcementOpAction} hidden={{ id: a.id, op: "archive" }} label="Archive" variant="ghost" /> : null}
                  {a.status === "DRAFT" && a.approvalStatus !== "PENDING" ? <ActButton action={announcementOpAction} hidden={{ id: a.id, op: "delete" }} label="Delete" variant="danger" confirmText="Delete this draft?" /> : null}
                  {a.approvalStatus !== "PENDING" && !["EXPIRED"].includes(a.status) ? <Link className="btn sm ghost" href={`/announcements?tab=compose&edit=${a.id}`}>Edit</Link> : null}
                  {a.status === "PUBLISHED" ? <Link className="btn sm ghost" href={`/announcements?tab=report&id=${a.id}`}>Reach</Link> : null}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <Card title="Approval">
        <SpecForm action={saveEngageSettingsAction} hidden={{ scope: "announcements" }} submitLabel="Save" columns={1} fields={[
          { name: "announcementApproval", label: "Approval before publishing", type: "checkbox", defaultValue: settings.announcementApproval, placeholder: "Announcements need approval (Inbox › Approvals) before they go live. Emergency broadcasts skip it." },
        ]} />
      </Card>
    </div>
  );
}

async function Compose({ tenantId, editId }: { tenantId: string; editId?: string }) {
  const [depts, locs, a] = await Promise.all([
    departmentOptions(tenantId), locationOptions(tenantId),
    editId ? prisma.announcement.findFirst({ where: { id: editId, tenantId } }) : Promise.resolve(null),
  ]);
  const aud = (a?.audience ?? null) as Audience | null;
  const tr = Object.entries((a?.translations ?? {}) as Record<string, { title: string; body: string }>)[0];
  return (
    <div className="stack gap-4">
      <Callout title="Emergency broadcast">Tick Emergency for urgent safety notices: it skips approval, is emailed to everyone, and shows as a banner across the app until archived.</Callout>
      <Card key={a?.id ?? "new"} title={a ? `Edit "${a.title}"` : "New announcement"} description="Leave the audience empty to reach everyone. Times are IST.">
        <SpecForm action={saveAnnouncementAction} hidden={a ? { id: a.id } : undefined} submitLabel={a ? "Save" : "Save"} fields={[
          { name: "title", label: "Title", required: true, defaultValue: a?.title, wide: true },
          { name: "body", label: "Message", type: "textarea", required: true, defaultValue: a?.body, wide: true },
          { name: "category", label: "Category", type: "select", required: true, defaultValue: a?.category ?? "GENERAL", options: CATS.map((c) => ({ value: c, label: pretty(c) })) },
          { name: "intent", label: "After saving", type: "select", required: true, defaultValue: "draft", options: [{ value: "draft", label: "Keep as draft" }, { value: "publish", label: "Publish / schedule (or submit for approval)" }] },
          { name: "publishAt", label: "Publish at (optional)", type: "datetime-local", defaultValue: toLocalInput(a?.publishAt), hint: "Future time = scheduled" },
          { name: "expiresAt", label: "Expires on", type: "date", defaultValue: a?.expiresAt ? fmtDay(a.expiresAt) : "" },
          { name: "requireAck", label: "Acknowledgement", type: "checkbox", defaultValue: a?.requireAck ?? false, placeholder: "Require employees to acknowledge" },
          { name: "isPinned", label: "Pin", type: "checkbox", defaultValue: a?.isPinned ?? false, placeholder: "Pin to the top" },
          { name: "notifyByEmail", label: "Email", type: "checkbox", defaultValue: a?.notifyByEmail ?? false, placeholder: "Also email the audience" },
          { name: "isEmergency", label: "Emergency", type: "checkbox", defaultValue: a?.isEmergency ?? false, placeholder: "Emergency broadcast" },
          { name: "departmentIds", label: "Departments", type: "multiselect", options: depts, defaultValue: aud?.departmentIds ?? [] },
          { name: "locationIds", label: "Locations", type: "multiselect", options: locs, defaultValue: aud?.locationIds ?? [] },
          { name: "excludeOnNotice", label: "Exclude", type: "checkbox", defaultValue: aud?.excludeOnNotice ?? false, placeholder: "Leave out people serving notice" },
          { name: "lang", label: "Translation language", type: "select", defaultValue: tr?.[0] ?? "", options: Object.entries(LANGS).map(([value, label]) => ({ value, label })), placeholder: "No translation" },
          { name: "langTitle", label: "Translated title", defaultValue: tr?.[1].title },
          { name: "langBody", label: "Translated message", type: "textarea", defaultValue: tr?.[1].body },
        ]} />
      </Card>
    </div>
  );
}

async function Archive({ tenantId, q }: { tenantId: string; q?: string }) {
  const rows = (await prisma.announcement.findMany({ where: { tenantId, status: { in: ["ARCHIVED", "EXPIRED"] } }, orderBy: { updatedAt: "desc" }, take: 200 })).filter((a) => matches(q, a.title, a.body));
  return (
    <Card tight title="Archived and expired">
      <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="archive" /><input className="input" name="q" defaultValue={q ?? ""} placeholder="Search the archive…" /><button className="btn sm">Search</button></form>
      <Table head={["Title", "Category", "Published", "Status", ""]} empty={rows.length === 0}>
        {rows.map((a) => <tr key={a.id}><td><strong>{a.title}</strong><div className="text-xs muted">{a.body.slice(0, 140)}</div></td><td>{pretty(a.category ?? "GENERAL")}</td><td>{fmtDay(a.publishAt ?? a.createdAt)}</td><td><Pill s={a.status} /></td><td>{a.status === "ARCHIVED" ? <ActButton action={announcementOpAction} hidden={{ id: a.id, op: "unarchive" }} label="Restore" variant="ghost" /> : null}</td></tr>)}
      </Table>
    </Card>
  );
}

async function Report({ tenantId, id }: { tenantId: string; id?: string }) {
  const rows = await prisma.announcement.findMany({ where: { tenantId, status: { in: ["PUBLISHED", "EXPIRED", "ARCHIVED"] } }, orderBy: { publishAt: "desc" }, take: 50 });
  const stats = await Promise.all(rows.map(async (a) => {
    const audience = await announcementAudience(tenantId, a.audience as Prisma.JsonValue);
    const ids = audience.map((e) => e.id);
    const [viewed, acked] = await Promise.all([
      prisma.announcementRead.count({ where: { announcementId: a.id, employeeId: { in: ids } } }),
      prisma.announcementRead.count({ where: { announcementId: a.id, employeeId: { in: ids }, acknowledgedAt: { not: null } } }),
    ]);
    return { a, ids, s: reachStats(ids.length, viewed, acked) };
  }));
  const focus = id ? stats.find((x) => x.a.id === id) : undefined;
  let pendingNames: string[] = [];
  if (focus?.a.requireAck) {
    const done = new Set((await prisma.announcementRead.findMany({ where: { announcementId: focus.a.id, acknowledgedAt: { not: null } }, select: { employeeId: true } })).map((r) => r.employeeId));
    const left = focus.ids.filter((x) => !done.has(x));
    pendingNames = [...(await employeeNames(tenantId, left.slice(0, 200))).values()].sort();
  }
  const ack = stats.filter((x) => x.a.requireAck);
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Published (last 50)" value={stats.length} />
        <Stat label="Average reach" value={stats.length ? `${Math.round(stats.reduce((s, x) => s + x.s.viewedPct, 0) / stats.length)}%` : "—"} />
        <Stat label="Average acknowledgement" value={ack.length ? `${Math.round(ack.reduce((s, x) => s + x.s.ackPct, 0) / ack.length)}%` : "—"} meta={`${ack.length} required acknowledgement`} />
      </div>
      {focus ? (
        <Card title={`"${focus.a.title}"`} description={`${focus.s.audience} in audience · ${focus.s.viewed} viewed · ${focus.s.acknowledged} acknowledged`} action={<a className="btn sm" href={`/engage/export?report=announcement-acks&id=${focus.a.id}`}>Acknowledgement CSV</a>}>
          {focus.a.requireAck ? (
            <>
              <div className="row gap-2" style={{ marginBottom: 8 }}>{focus.a.status === "PUBLISHED" ? <ActButton action={announcementOpAction} hidden={{ id: focus.a.id, op: "remind" }} label={`Remind ${focus.s.pending} who have not acknowledged`} variant="primary" /> : null}{focus.a.lastReminderAt ? <span className="text-xs muted">Last reminder {fmtTime(focus.a.lastReminderAt)}</span> : null}</div>
              <div className="text-sm">{pendingNames.length ? `Still to acknowledge: ${pendingNames.join(", ")}` : "Everyone has acknowledged."}</div>
            </>
          ) : <div className="text-sm muted">This announcement does not require acknowledgement.</div>}
        </Card>
      ) : null}
      <Card tight title="Reach by announcement">
        <Table head={["Announcement", "Published", "Audience", "Viewed", "Acknowledged", ""]} empty={stats.length === 0}>
          {stats.map(({ a, s }) => (
            <tr key={a.id}>
              <td><strong>{a.title}</strong></td><td>{fmtDay(a.publishAt ?? a.createdAt)}</td><td>{s.audience}</td>
              <td style={{ minWidth: 120 }}><div className="text-xs">{s.viewed} ({s.viewedPct}%)</div><Progress value={s.viewedPct} /></td>
              <td style={{ minWidth: 120 }}>{a.requireAck ? <><div className="text-xs">{s.acknowledged} ({s.ackPct}%)</div><Progress value={s.ackPct} tone={s.ackPct >= 100 ? "success" : "warning"} /></> : <span className="text-xs muted">Not required</span>}</td>
              <td><Link className="btn sm ghost" href={`/announcements?tab=report&id=${a.id}`}>Details</Link></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
