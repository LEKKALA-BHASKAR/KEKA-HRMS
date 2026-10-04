import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { challengeProgress, engageSettings, isoWeekStart, wellbeingSummary } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { departmentOptions } from "@/lib/governance";
import { employeeNames, fmtDay, matches, pretty } from "@/lib/engage-depth";
import { PageHead, Card, Callout, Stat, Badge, Progress } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import {
  saveWellnessProgramAction, wellnessProgramOpAction, enrolAction, withdrawEnrolmentAction, logProgressAction, checkInAction, saveResourceAction, resourceOpAction,
} from "@/app/actions/engage-wellness";
import { saveEngageSettingsAction } from "@/app/actions/engage-surveys";

const P = PERMISSIONS;
const ALL_TABS = { programs: "Programmes & challenges", checkin: "Wellbeing check-in", support: "Support & benefits", manage: "Manage", reports: "Reports" };
type Tab = keyof typeof ALL_TABS;
const CATEGORIES = ["FITNESS", "MENTAL", "NUTRITION", "SLEEP", "FINANCIAL", "SCREENING"];
const RES_KINDS = ["EAP", "HELPLINE", "PROVIDER", "BENEFIT", "ARTICLE"];

/** Wellness: programmes and challenges with enrolment and progress, the anonymous weekly check-in, the EAP / support directory, and their administration. */
export default async function WellnessPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const admin = can(viewer, P.WELLNESS_MANAGE);
  const tabs = Object.fromEntries(Object.entries(ALL_TABS).filter(([k]) => admin || !["manage", "reports"].includes(k))) as Record<string, string>;
  const tab: Tab = (sp.tab ?? "") in tabs ? (sp.tab as Tab) : "programs";
  const t = viewer.tenantId;
  const me = viewer.employee?.id ?? null;
  return (
    <>
      <PageHead title="Wellness" subtitle="Programmes, challenges, a private weekly check-in and where to get support" actions={<Link className="btn" href="/engage/services">Employee services</Link>} />
      <Tabs base="/engage/wellness" tabs={tabs} active={tab} />
      {tab === "programs" ? <Programs tenantId={t} me={me} /> : null}
      {tab === "checkin" ? <CheckIn tenantId={t} me={me} /> : null}
      {tab === "support" ? <Support tenantId={t} q={sp.q} kind={sp.kind} /> : null}
      {tab === "manage" && admin ? <Manage tenantId={t} editId={sp.edit} editResource={sp.resource} /> : null}
      {tab === "reports" && admin ? <Reports tenantId={t} /> : null}
    </>
  );
}

async function Programs({ tenantId, me }: { tenantId: string; me: string | null }) {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const [programs, mine, emp] = await Promise.all([
    prisma.wellnessProgram.findMany({ where: { tenantId, status: "ACTIVE", endsOn: { gte: today } }, orderBy: { startsOn: "asc" }, include: { _count: { select: { enrollments: { where: { status: { not: "WITHDRAWN" } } } } } } }),
    me ? prisma.wellnessEnrollment.findMany({ where: { employeeId: me, program: { tenantId }, status: { not: "WITHDRAWN" } }, include: { program: true, logs: { orderBy: { loggedOn: "desc" }, take: 5 } } }) : Promise.resolve([]),
    me ? prisma.employee.findUnique({ where: { id: me }, select: { departmentId: true } }) : Promise.resolve(null),
  ]);
  const enrolledIds = new Set(mine.map((e) => e.programId));
  const open = programs.filter((p) => !enrolledIds.has(p.id) && (!p.departmentIds.length || p.departmentIds.includes(emp?.departmentId ?? "")));
  const boards = new Map<string, Array<{ employeeId: string; progress: number }>>();
  for (const e of mine) {
    if (e.program.kind !== "CHALLENGE") continue;
    boards.set(e.programId, (await prisma.wellnessEnrollment.findMany({ where: { programId: e.programId, status: { not: "WITHDRAWN" }, showOnBoard: true }, orderBy: { progress: "desc" }, take: 5, select: { employeeId: true, progress: true } })));
  }
  const names = await employeeNames(tenantId, [...boards.values()].flat().map((b) => b.employeeId));
  return (
    <div className="stack gap-4">
      {mine.length ? (
        <div className="grid grid-2">
          {mine.map((e) => {
            const pr = challengeProgress(e.progress, e.program.goalValue);
            return (
              <Card key={e.id} title={e.program.title} description={`${pretty(e.program.category)} ${e.program.kind.toLowerCase()} · ends ${fmtDay(e.program.endsOn)}`} action={<Pill s={e.status} />}>
                {e.program.goalValue ? <><div className="text-sm" style={{ marginBottom: 4 }}>{e.progress} / {e.program.goalValue} {e.program.goalUnit ?? ""} ({pr.pct}%)</div><Progress value={pr.pct} tone={pr.completed ? "success" : undefined} /></> : null}
                {e.status === "ENROLLED" && e.program.kind === "CHALLENGE" ? (
                  <div style={{ marginTop: 10 }}>
                    <SpecForm action={logProgressAction} hidden={{ enrollmentId: e.id }} submitLabel="Log progress" columns={3} fields={[
                      { name: "value", label: e.program.goalUnit ?? "Amount", type: "number", required: true },
                      { name: "loggedOn", label: "Day", type: "date" },
                      { name: "note", label: "Note" },
                    ]} />
                  </div>
                ) : null}
                {e.logs.length ? <div className="text-xs muted" style={{ marginTop: 8 }}>Recent: {e.logs.map((l) => `${fmtDay(l.loggedOn)} +${l.value}`).join(" · ")}</div> : null}
                {boards.get(e.programId)?.length ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="text-xs strong">Leaderboard (opted-in)</div>
                    {boards.get(e.programId)!.map((b, i) => <div key={b.employeeId} className="text-xs">{i + 1}. {names.get(b.employeeId)} — {b.progress}</div>)}
                  </div>
                ) : null}
                {e.status === "ENROLLED" ? <div style={{ marginTop: 10 }}><ActButton action={withdrawEnrolmentAction} hidden={{ id: e.id }} label="Leave" variant="ghost" confirmText="Leave this programme?" /></div> : null}
              </Card>
            );
          })}
        </div>
      ) : null}
      <Card tight title="Open for enrolment">
        {open.length === 0 ? <div className="muted text-sm">Nothing open right now.</div> : (
          <Table head={["Programme", "Category", "Dates", "Goal", "Places", "Points", ""]}>
            {open.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.title}</strong><div className="text-xs muted">{p.description ?? ""}{p.providerName ? ` · with ${p.providerName}` : ""}</div></td>
                <td>{pretty(p.category)} <span className="text-xs muted">{p.kind.toLowerCase()}</span></td>
                <td className="text-xs">{fmtDay(p.startsOn)} – {fmtDay(p.endsOn)}</td>
                <td>{p.goalValue ? `${p.goalValue} ${p.goalUnit ?? ""}` : "—"}</td>
                <td>{p.capacity ? `${p._count.enrollments} / ${p.capacity}` : p._count.enrollments}</td>
                <td>{p.pointsReward || "—"}</td>
                <td style={{ minWidth: 260 }}>{me ? (
                  <SpecForm action={enrolAction} hidden={{ programId: p.id }} submitLabel="Enrol" columns={1} fields={[
                    ...(p.requireConsent ? [{ name: "consent", label: "Consent", type: "checkbox" as const, placeholder: "I agree my participation data is used for this programme" }] : []),
                    ...(p.kind === "CHALLENGE" ? [{ name: "showOnBoard", label: "Leaderboard", type: "checkbox" as const, defaultValue: true, placeholder: "Show my name on the leaderboard" }] : []),
                  ]} />
                ) : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

async function CheckIn({ tenantId, me }: { tenantId: string; me: string | null }) {
  if (!me) return <Callout title="No employee record">Check-ins are for employees.</Callout>;
  const week = isoWeekStart(new Date());
  const done = await prisma.wellbeingCheckInMark.findUnique({ where: { employeeId_week: { employeeId: me, week } } });
  const history = await prisma.wellbeingCheckInMark.count({ where: { tenantId, employeeId: me } });
  const scale = (labels: string[]) => labels.map((l, i) => ({ value: String(i + 1), label: `${i + 1} — ${l}` }));
  return (
    <div className="grid grid-2">
      <Card title={`This week (from ${fmtDay(week)})`} description="Your answers are stored without your name. HR only sees totals for groups large enough to keep you anonymous.">
        {done ? <Callout tone="success" title="You have checked in this week">Thank you. You have checked in {history} week{history === 1 ? "" : "s"} in total.</Callout> : (
          <SpecForm action={checkInAction} submitLabel="Check in" columns={1} fields={[
            { name: "mood", label: "How are you feeling?", type: "select", required: true, options: scale(["Very low", "Low", "Okay", "Good", "Great"]) },
            { name: "stress", label: "How stressed are you?", type: "select", required: true, options: scale(["Not at all", "A little", "Somewhat", "Quite", "Very"]) },
            { name: "wantsSupport", label: "Support", type: "checkbox", placeholder: "I would like to know about support options" },
            { name: "note", label: "Anything you want to share (anonymous)", type: "textarea" },
          ]} />
        )}
      </Card>
      <Card title="Need to talk to someone?">
        <p className="text-sm">The Employee Assistance Programme and helplines are confidential and free.</p>
        <Link className="btn" href="/engage/wellness?tab=support">See support options</Link>
      </Card>
    </div>
  );
}

async function Support({ tenantId, q, kind }: { tenantId: string; q?: string; kind?: string }) {
  const rows = await prisma.supportResource.findMany({ where: { tenantId, status: "PUBLISHED", ...(kind && RES_KINDS.includes(kind) ? { kind } : {}) }, orderBy: [{ kind: "asc" }, { title: "asc" }] });
  const shown = rows.filter((r) => matches(q, r.title, r.description, r.tags.join(" ")));
  const eap = shown.filter((r) => r.kind === "EAP" || r.kind === "HELPLINE");
  const rest = shown.filter((r) => !(r.kind === "EAP" || r.kind === "HELPLINE"));
  const tile = (r: (typeof rows)[number]) => (
    <div key={r.id} className="card"><div className="card-body">
      <div className="row gap-2" style={{ marginBottom: 4 }}><Badge tone={r.kind === "EAP" || r.kind === "HELPLINE" ? "brand" : "neutral"}>{pretty(r.kind)}</Badge>{r.tags.map((x) => <span key={x} className="text-xs muted">#{x}</span>)}</div>
      <div className="strong">{r.title}</div>
      {r.description ? <div className="text-sm muted" style={{ margin: "4px 0" }}>{r.description}</div> : null}
      <div className="text-sm">{r.phone ? <div>Phone: {r.phone}</div> : null}{r.email ? <div>Email: <a href={`mailto:${r.email}`}>{r.email}</a></div> : null}{r.url ? <a href={r.url} target="_blank" rel="noreferrer">Open link</a> : null}</div>
    </div></div>
  );
  return (
    <div className="stack gap-4">
      <form method="get" className="row gap-2"><input type="hidden" name="tab" value="support" />
        <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search support and benefits…" />
        <select className="select" name="kind" defaultValue={kind ?? ""} style={{ width: 180 }}><option value="">All kinds</option>{RES_KINDS.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}</select>
        <button className="btn sm">Search</button></form>
      {eap.length ? <><h3 className="h3">Employee Assistance & helplines</h3><div className="grid grid-3">{eap.map(tile)}</div></> : null}
      {rest.length ? <><h3 className="h3">Benefits, providers & guides</h3><div className="grid grid-3">{rest.map(tile)}</div></> : null}
      {shown.length === 0 ? <Callout title="Nothing published yet">HR has not published support resources matching this search.</Callout> : null}
      <div className="text-sm">Need something done for you (ID card, parking, a letter)? <Link href="/engage/services">Request an employee service</Link>.</div>
    </div>
  );
}

async function Manage({ tenantId, editId, editResource }: { tenantId: string; editId?: string; editResource?: string }) {
  const [programs, resources, depts, settings] = await Promise.all([
    prisma.wellnessProgram.findMany({ where: { tenantId }, orderBy: [{ status: "asc" }, { startsOn: "desc" }], include: { _count: { select: { enrollments: { where: { status: { not: "WITHDRAWN" } } } } } } }),
    prisma.supportResource.findMany({ where: { tenantId }, orderBy: [{ status: "asc" }, { title: "asc" }] }),
    departmentOptions(tenantId),
    engageSettings(tenantId),
  ]);
  const ep = editId ? programs.find((p) => p.id === editId && p.status !== "PENDING_APPROVAL") : undefined;
  const er = editResource ? resources.find((r) => r.id === editResource && r.status !== "PENDING_APPROVAL") : undefined;
  const iso = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
  return (
    <div className="stack gap-4">
      <Card tight title="Programmes" description="Programmes open for enrolment once approved (Inbox › Approvals).">
        <Table head={["Programme", "Kind", "Dates", "Enrolled", "Status", ""]} empty={programs.length === 0}>
          {programs.map((p) => (
            <tr key={p.id}>
              <td><strong>{p.title}</strong><div className="text-xs muted">{pretty(p.category)}</div></td><td>{pretty(p.kind)}</td><td className="text-xs">{fmtDay(p.startsOn)} – {fmtDay(p.endsOn)}</td>
              <td>{p._count.enrollments}{p.capacity ? ` / ${p.capacity}` : ""}</td><td><Pill s={p.status} /></td>
              <td className="row gap-2">
                {["DRAFT", "REJECTED"].includes(p.status) ? <ActButton action={wellnessProgramOpAction} hidden={{ id: p.id, op: "submit" }} label="Submit for approval" variant="primary" /> : null}
                {p.status === "ACTIVE" ? <ActButton action={wellnessProgramOpAction} hidden={{ id: p.id, op: "close" }} label="Close" variant="ghost" confirmText="Close this programme?" /> : null}
                {["DRAFT", "REJECTED"].includes(p.status) ? <ActButton action={wellnessProgramOpAction} hidden={{ id: p.id, op: "delete" }} label="Delete" variant="danger" confirmText="Delete this draft?" /> : null}
                {p.status !== "PENDING_APPROVAL" ? <Link className="btn sm ghost" href={`/engage/wellness?tab=manage&edit=${p.id}`}>Edit</Link> : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card key={ep?.id ?? "new"} title={ep ? `Edit "${ep.title}"` : "New programme or challenge"}>
        <SpecForm action={saveWellnessProgramAction} hidden={ep ? { id: ep.id } : undefined} submitLabel={ep ? "Save changes" : "Save draft"} fields={[
          { name: "title", label: "Title", required: true, defaultValue: ep?.title },
          { name: "kind", label: "Kind", type: "select", required: true, defaultValue: ep?.kind ?? "CHALLENGE", options: ["CHALLENGE", "PROGRAM", "EVENT"].map((v) => ({ value: v, label: pretty(v) })) },
          { name: "category", label: "Category", type: "select", required: true, defaultValue: ep?.category ?? "FITNESS", options: CATEGORIES.map((v) => ({ value: v, label: pretty(v) })) },
          { name: "providerName", label: "Provider / partner", defaultValue: ep?.providerName },
          { name: "startsOn", label: "Starts", type: "date", required: true, defaultValue: iso(ep?.startsOn) },
          { name: "endsOn", label: "Ends", type: "date", required: true, defaultValue: iso(ep?.endsOn) },
          { name: "goalValue", label: "Goal (challenges)", type: "number", defaultValue: ep?.goalValue },
          { name: "goalUnit", label: "Unit", placeholder: "steps, km, sessions", defaultValue: ep?.goalUnit },
          { name: "capacity", label: "Places", type: "number", hint: "Blank = unlimited", defaultValue: ep?.capacity },
          { name: "pointsReward", label: "Reward points on completion", type: "number", defaultValue: ep?.pointsReward ?? 0 },
          { name: "requireConsent", label: "Consent", type: "checkbox", defaultValue: ep ? ep.requireConsent : true, placeholder: "Ask for consent to use participation data" },
          { name: "departmentIds", label: "Open to departments (none = all)", type: "multiselect", options: depts, wide: true, defaultValue: ep?.departmentIds ?? [] },
          { name: "description", label: "Description", type: "textarea", wide: true, defaultValue: ep?.description },
        ]} />
      </Card>
      <Card tight title="Support resources (EAP, helplines, benefits directory)" description="Published after review. Editing a published resource sends it back to review.">
        <Table head={["Resource", "Kind", "Contact", "Status", ""]} empty={resources.length === 0}>
          {resources.map((r) => (
            <tr key={r.id}>
              <td><strong>{r.title}</strong><div className="text-xs muted">{r.tags.join(", ")}</div></td><td>{pretty(r.kind)}</td><td className="text-xs">{[r.phone, r.email, r.url].filter(Boolean).join(" · ")}</td><td><Pill s={r.status} /></td>
              <td className="row gap-2">
                {["DRAFT", "REJECTED", "ARCHIVED"].includes(r.status) ? <ActButton action={resourceOpAction} hidden={{ id: r.id, op: "submit" }} label="Submit to publish" variant="primary" /> : null}
                {r.status === "PUBLISHED" ? <ActButton action={resourceOpAction} hidden={{ id: r.id, op: "archive" }} label="Archive" variant="ghost" /> : null}
                {["DRAFT", "REJECTED", "ARCHIVED"].includes(r.status) ? <ActButton action={resourceOpAction} hidden={{ id: r.id, op: "delete" }} label="Delete" variant="danger" confirmText="Delete this resource?" /> : null}
                {r.status !== "PENDING_APPROVAL" ? <Link className="btn sm ghost" href={`/engage/wellness?tab=manage&resource=${r.id}`}>Edit</Link> : null}
              </td>
            </tr>
          ))}
        </Table>
        <div style={{ marginTop: 12 }} key={er?.id ?? "new-res"}>
          <SpecForm action={saveResourceAction} hidden={er ? { id: er.id } : undefined} submitLabel={er ? "Save resource" : "Add resource"} columns={3} fields={[
            { name: "title", label: "Title", required: true, defaultValue: er?.title },
            { name: "kind", label: "Kind", type: "select", required: true, defaultValue: er?.kind ?? "EAP", options: RES_KINDS.map((v) => ({ value: v, label: pretty(v) })) },
            { name: "tags", label: "Tags (comma separated)", defaultValue: er?.tags.join(", ") },
            { name: "phone", label: "Phone", defaultValue: er?.phone }, { name: "email", label: "Email", type: "email", defaultValue: er?.email }, { name: "url", label: "Link (https://)", defaultValue: er?.url },
            { name: "description", label: "Description", type: "textarea", wide: true, defaultValue: er?.description },
          ]} />
        </div>
      </Card>
      <Card title="Check-in privacy">
        <SpecForm action={saveEngageSettingsAction} hidden={{ scope: "wellness" }} submitLabel="Save" columns={1} fields={[
          { name: "checkInMinGroup", label: "Hide check-in results for groups smaller than", type: "number", defaultValue: settings.checkInMinGroup },
        ]} />
      </Card>
    </div>
  );
}

async function Reports({ tenantId }: { tenantId: string }) {
  const since = new Date(Date.now() - 12 * 7 * 86_400_000);
  const [programs, checkins, depts, settings] = await Promise.all([
    prisma.wellnessProgram.findMany({ where: { tenantId, status: { in: ["ACTIVE", "CLOSED"] } }, orderBy: { startsOn: "desc" }, include: { enrollments: { select: { status: true, progress: true } } } }),
    prisma.wellbeingCheckIn.findMany({ where: { tenantId, week: { gte: since } }, select: { week: true, departmentId: true, mood: true, stress: true, wantsSupport: true } }),
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    engageSettings(tenantId),
  ]);
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const byDept = wellbeingSummary(checkins.map((c) => ({ group: deptName.get(c.departmentId ?? "") ?? "No department", mood: c.mood, stress: c.stress, wantsSupport: c.wantsSupport })), settings.checkInMinGroup);
  const byWeek = wellbeingSummary(checkins.map((c) => ({ group: c.week.toISOString().slice(0, 10), mood: c.mood, stress: c.stress, wantsSupport: c.wantsSupport })), settings.checkInMinGroup);
  const enrolled = programs.reduce((s, p) => s + p.enrollments.filter((e) => e.status !== "WITHDRAWN").length, 0);
  const completed = programs.reduce((s, p) => s + p.enrollments.filter((e) => e.status === "COMPLETED").length, 0);
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Programmes" value={programs.length} />
        <Stat label="Enrolments" value={enrolled} meta={`${completed} completed`} />
        <Stat label="Check-ins (12 weeks)" value={checkins.length} />
        <Stat label="Average mood" value={byDept.overall ? `${byDept.overall.avgMood} / 5` : "Hidden"} meta={byDept.overall ? `${byDept.overall.supportRequests} asked about support` : `Fewer than ${settings.checkInMinGroup} responses`} />
      </div>
      <Card tight title="Exports"><div className="row gap-2"><a className="btn sm" href="/engage/export?report=wellness">Programme participation CSV</a><a className="btn sm" href="/engage/export?report=wellbeing">Wellbeing by department CSV</a></div></Card>
      <Card tight title="Programme participation">
        <Table head={["Programme", "Status", "Enrolled", "Completed", "Completion rate"]} empty={programs.length === 0}>
          {programs.map((p) => { const e = p.enrollments.filter((x) => x.status !== "WITHDRAWN"); const c = e.filter((x) => x.status === "COMPLETED").length; return <tr key={p.id}><td>{p.title}</td><td><Pill s={p.status} /></td><td>{e.length}</td><td>{c}</td><td>{e.length ? `${Math.round((c / e.length) * 100)}%` : "—"}</td></tr>; })}
        </Table>
      </Card>
      <Card tight title="Wellbeing by department (last 12 weeks)" description={`Groups with fewer than ${settings.checkInMinGroup} check-ins are hidden to protect anonymity.`}>
        <Table head={["Department", "Check-ins", "Mood", "Stress", "Low mood", "High stress", "Asked for support"]} empty={byDept.groups.length === 0}>
          {byDept.groups.map((g) => g.hidden ? <tr key={g.group}><td>{g.group}</td><td colSpan={6} className="muted text-xs">Too few responses to show</td></tr> : <tr key={g.group}><td>{g.group}</td><td>{g.n}</td><td>{g.avgMood}</td><td>{g.avgStress}</td><td>{g.lowMoodPct}%</td><td>{g.highStressPct}%</td><td>{g.supportRequests}</td></tr>)}
        </Table>
      </Card>
      <Card tight title="Trend by week">
        <Table head={["Week of", "Check-ins", "Mood", "Stress"]} empty={byWeek.groups.length === 0}>
          {byWeek.groups.sort((a, b) => a.group.localeCompare(b.group)).map((g) => g.hidden ? <tr key={g.group}><td>{g.group}</td><td colSpan={3} className="muted text-xs">Too few responses</td></tr> : <tr key={g.group}><td>{g.group}</td><td>{g.n}</td><td>{g.avgMood}</td><td>{g.avgStress}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}
