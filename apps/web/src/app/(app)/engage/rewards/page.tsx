import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { budgetCheck, engageSettings, pointsBalanceOf, programPointsUsed, recognitionFairness } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { departmentOptions, employeeOptions } from "@/lib/governance";
import { employeeNames, fmtDay, matches, pretty } from "@/lib/engage-depth";
import { PageHead, Card, Callout, Stat, Badge, Progress } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import {
  saveProgramAction, programOpAction, saveAwardTypeAction, toggleAwardTypeAction, saveBadgeAction, toggleBadgeAction, nominateAction,
  revokeAwardAction, updateAwardAction, adjustPointsAction, saveRewardItemAction, toggleRewardItemAction, redeemAction, fulfilRedemptionAction,
} from "@/app/actions/engage-rewards";
import { withdrawWorkflowAction } from "@/app/actions/workflows";
import { saveEngageSettingsAction } from "@/app/actions/engage-surveys";

const P = PERMISSIONS;
const ALL_TABS = { wallet: "My rewards", nominate: "Nominate", catalog: "Reward catalog", programs: "Programmes", awards: "Awards", redemptions: "Fulfilment", setup: "Setup", reports: "Reports" };
type Tab = keyof typeof ALL_TABS;
const ADMIN_TABS: Tab[] = ["awards", "redemptions", "setup", "reports"];

/** Recognition & rewards: points wallet, nominations, catalog and redemptions, programmes with budgets, and their administration. */
export default async function RewardsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireAuth(P.AWARD_VIEW);
  const sp = await searchParams;
  const admin = can(viewer, P.AWARD_MANAGE);
  const tabs = Object.fromEntries(Object.entries(ALL_TABS).filter(([k]) => admin || !ADMIN_TABS.includes(k as Tab))) as Record<string, string>;
  const tab: Tab = (sp.tab ?? "") in tabs ? (sp.tab as Tab) : "wallet";
  const t = viewer.tenantId;
  const me = viewer.employee?.id ?? null;
  return (
    <>
      <PageHead title="Rewards & Recognition" subtitle="Earn points from praise and awards, nominate colleagues, and redeem rewards" actions={<Link className="btn" href="/awards">Praise & awards wall</Link>} />
      <Tabs base="/engage/rewards" tabs={tabs} active={tab} />
      {tab === "wallet" ? <Wallet tenantId={t} me={me} /> : null}
      {tab === "nominate" ? <Nominate tenantId={t} me={me} /> : null}
      {tab === "catalog" ? <Catalog tenantId={t} me={me} q={sp.q} /> : null}
      {tab === "programs" ? <Programs tenantId={t} admin={admin} editId={sp.edit} /> : null}
      {tab === "awards" && admin ? <Awards tenantId={t} q={sp.q} /> : null}
      {tab === "redemptions" && admin ? <Redemptions tenantId={t} status={sp.status} /> : null}
      {tab === "setup" && admin ? <Setup tenantId={t} /> : null}
      {tab === "reports" && admin ? <Reports tenantId={t} /> : null}
    </>
  );
}

async function Wallet({ tenantId, me }: { tenantId: string; me: string | null }) {
  if (!me) return <Callout title="No employee record">Points and rewards belong to employees.</Callout>;
  const [balance, ledger, awards, redemptions, nominations] = await Promise.all([
    pointsBalanceOf(tenantId, me),
    prisma.rewardPointEntry.findMany({ where: { tenantId, employeeId: me }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.employeeAward.findMany({ where: { tenantId, employeeId: me, revokedAt: null }, orderBy: { awardedOn: "desc" }, include: { awardType: { select: { name: true } } } }),
    prisma.rewardRedemption.findMany({ where: { tenantId, employeeId: me }, orderBy: { createdAt: "desc" } }),
    prisma.awardNomination.findMany({ where: { tenantId, nominatorId: me }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const earned = ledger.filter((l) => l.delta > 0).reduce((s, l) => s + l.delta, 0);
  const names = await employeeNames(tenantId, nominations.map((n) => n.nomineeId));
  const types = new Map((await prisma.awardType.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Points balance" value={balance} meta={<Link href="/engage/rewards?tab=catalog">Redeem in the catalog</Link>} />
        <Stat label="Earned (recent)" value={earned} meta="From praise, awards, wellness and milestones" />
        <Stat label="Awards" value={awards.length} meta="Certificates below" />
      </div>
      <Card tight title="My awards">
        <Table head={["Award", "Awarded", "Points", "Citation", ""]} empty={awards.length === 0}>
          {awards.map((a) => <tr key={a.id}><td><strong>{a.awardType.name}</strong></td><td>{fmtDay(a.awardedOn)}</td><td>{a.points ?? "—"}</td><td className="text-xs">{a.citation ?? ""}</td><td><a className="btn sm" href={`/engage/rewards/certificate/${a.id}`}>Certificate (PDF)</a></td></tr>)}
        </Table>
      </Card>
      <Card tight title="My redemptions">
        <Table head={["Reward", "Points", "Requested", "Status", "Fulfilment", ""]} empty={redemptions.length === 0}>
          {redemptions.map((r) => (
            <tr key={r.id}>
              <td>{r.quantity} × {r.itemName}</td><td>{r.points}</td><td>{fmtDay(r.createdAt)}</td><td><Pill s={r.status} /></td><td className="text-xs">{r.fulfilmentNote ?? ""}</td>
              <td>{r.status === "PENDING" && r.workflowRequestId ? <ActButton action={withdrawWorkflowAction} hidden={{ requestId: r.workflowRequestId }} label="Cancel" variant="ghost" /> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card tight title="Points history">
        <Table head={["When", "Points", "Source", "Note"]} empty={ledger.length === 0}>
          {ledger.map((l) => <tr key={l.id}><td>{fmtDay(l.createdAt)}</td><td className={l.delta > 0 ? "pos" : "neg"}>{l.delta > 0 ? `+${l.delta}` : l.delta}</td><td>{pretty(l.source)}</td><td className="text-xs">{l.note ?? ""}</td></tr>)}
        </Table>
      </Card>
      <Card tight title="Nominations I made">
        <Table head={["Nominee", "Award", "Submitted", "Status", ""]} empty={nominations.length === 0}>
          {nominations.map((n) => (
            <tr key={n.id}>
              <td>{names.get(n.nomineeId)}</td><td>{types.get(n.awardTypeId)}</td><td>{fmtDay(n.createdAt)}</td><td><Pill s={n.status} /></td>
              <td>{n.status === "PENDING" && n.workflowRequestId ? <ActButton action={withdrawWorkflowAction} hidden={{ requestId: n.workflowRequestId }} label="Withdraw" variant="ghost" /> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function Nominate({ tenantId, me }: { tenantId: string; me: string | null }) {
  const [programs, types, people] = await Promise.all([
    prisma.recognitionProgram.findMany({ where: { tenantId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.awardType.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } }),
    employeeOptions(tenantId),
  ]);
  return (
    <div className="stack gap-4">
      <Callout title="How nominations are decided">The nominee&apos;s manager and the awards panel approve each nomination (Inbox › Approvals). Approved nominations become awards, with points from the programme and a downloadable certificate.</Callout>
      <Card title="Nominate a colleague">
        <SpecForm action={nominateAction} submitLabel="Send nomination" fields={[
          { name: "nomineeId", label: "Colleague", type: "select", required: true, options: people.filter((p) => p.value !== me) },
          { name: "programId", label: "Programme", type: "select", options: programs.map((p) => ({ value: p.id, label: `${p.name} (${pretty(p.kind)})` })), placeholder: "No programme — spot award" },
          { name: "awardTypeId", label: "Award", type: "select", options: types.map((x) => ({ value: x.id, label: `${x.name}${x.cashAmount ? ` · ₹${Number(x.cashAmount)}` : ""}${x.points ? ` · ${x.points} pts` : ""}` })), placeholder: "The programme's award", hint: "Required for a spot award" },
          { name: "citation", label: "What did they do?", type: "textarea", required: true, wide: true, placeholder: "Be specific: the situation, what they did, the impact." },
        ]} />
      </Card>
    </div>
  );
}

async function Catalog({ tenantId, me, q }: { tenantId: string; me: string | null; q?: string }) {
  const [items, balance] = await Promise.all([
    prisma.rewardItem.findMany({ where: { tenantId, isActive: true }, orderBy: [{ category: "asc" }, { pointsCost: "asc" }] }),
    me ? pointsBalanceOf(tenantId, me) : Promise.resolve(0),
  ]);
  const shown = items.filter((i) => matches(q, i.name, i.description, i.category));
  return (
    <div className="stack gap-4">
      <div className="row gap-3 wrap" style={{ alignItems: "center", justifyContent: "space-between" }}>
        <form method="get" className="row gap-2"><input type="hidden" name="tab" value="catalog" /><input className="input" name="q" defaultValue={q ?? ""} placeholder="Search rewards…" /><button className="btn sm">Search</button></form>
        <Badge tone="brand">Your balance: {balance} points</Badge>
      </div>
      {shown.length === 0 ? <Callout title="No rewards listed">The rewards team has not added anything matching yet.</Callout> : (
        <div className="grid grid-3">
          {shown.map((i) => (
            <div key={i.id} className="card"><div className="card-body">
              <div className="row gap-2" style={{ marginBottom: 6 }}><Badge>{pretty(i.category)}</Badge>{i.stock !== null ? <span className="text-xs muted">{i.stock} left</span> : null}</div>
              <div className="strong">{i.name}</div>
              {i.description ? <div className="text-sm muted" style={{ margin: "4px 0 8px" }}>{i.description}</div> : null}
              <div className="strong" style={{ marginBottom: 8 }}>{i.pointsCost} points</div>
              {me ? <ActButton action={redeemAction} hidden={{ itemId: i.id, quantity: "1" }} label={balance >= i.pointsCost && i.stock !== 0 ? "Redeem" : "Not enough points"} variant="primary" input={{ name: "deliveryNote", placeholder: "Delivery note (optional)" }} /> : null}
            </div></div>
          ))}
        </div>
      )}
    </div>
  );
}

async function Programs({ tenantId, admin, editId }: { tenantId: string; admin: boolean; editId?: string }) {
  const [rows, types, depts] = await Promise.all([
    prisma.recognitionProgram.findMany({ where: { tenantId, ...(admin ? {} : { status: "ACTIVE" }) }, orderBy: [{ status: "asc" }, { startsOn: "desc" }] }),
    prisma.awardType.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    departmentOptions(tenantId),
  ]);
  const used = new Map<string, number>();
  for (const p of rows) used.set(p.id, await programPointsUsed(tenantId, p.id));
  const deptName = new Map(depts.map((d) => [d.value, d.label]));
  const editing = admin && editId ? rows.find((p) => p.id === editId && p.status !== "PENDING_APPROVAL") : undefined;
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
  return (
    <div className="stack gap-4">
      <Card tight title="Recognition programmes" description={admin ? "Programmes launch after approval. Eligibility and budgets are enforced on every nomination." : "Programmes you can nominate colleagues under"}>
        <Table head={["Programme", "Kind", "Eligibility", "Points per award", "Budget used", "Status", admin ? "" : " "]} empty={rows.length === 0}>
          {rows.map((p) => {
            const b = budgetCheck(p.budgetPoints, used.get(p.id) ?? 0, 0);
            return (
              <tr key={p.id}>
                <td><strong>{p.name}</strong><div className="text-xs muted">{fmtDay(p.startsOn)} – {p.endsOn ? fmtDay(p.endsOn) : "open-ended"}</div></td>
                <td>{pretty(p.kind)}</td>
                <td className="text-xs">{p.departmentIds.length ? p.departmentIds.map((d) => deptName.get(d) ?? "?").join(", ") : "Everyone"}{p.minTenureDays ? ` · ${p.minTenureDays}+ days service` : ""}{p.cooldownDays ? ` · once per ${p.cooldownDays} days` : ""}</td>
                <td>{p.pointsPerAward}</td>
                <td style={{ minWidth: 140 }}>{p.budgetPoints === null ? <span className="text-xs">{used.get(p.id) ?? 0} pts · no cap</span> : <><div className="text-xs">{used.get(p.id) ?? 0} / {p.budgetPoints} pts</div><Progress value={used.get(p.id) ?? 0} max={Math.max(1, p.budgetPoints)} tone={(b.utilisation ?? 0) > 90 ? "warning" : "success"} /></>}</td>
                <td><Pill s={p.status} /></td>
                <td className="row gap-2">{admin ? (
                  <>
                    {["DRAFT", "REJECTED"].includes(p.status) ? <ActButton action={programOpAction} hidden={{ id: p.id, op: "submit" }} label="Submit for approval" variant="primary" /> : null}
                    {p.status === "ACTIVE" ? <ActButton action={programOpAction} hidden={{ id: p.id, op: "close" }} label="Close" variant="ghost" confirmText="Close this programme?" /> : null}
                    {["DRAFT", "REJECTED"].includes(p.status) ? <ActButton action={programOpAction} hidden={{ id: p.id, op: "delete" }} label="Delete" variant="danger" confirmText="Delete this draft?" /> : null}
                    {p.status !== "PENDING_APPROVAL" ? <Link className="btn sm ghost" href={`/engage/rewards?tab=programs&edit=${p.id}`}>Edit</Link> : null}
                    <ActButton action={programOpAction} hidden={{ id: p.id, op: "duplicate" }} label="Duplicate" variant="ghost" />
                  </>
                ) : p.status === "ACTIVE" ? <Link className="btn sm" href="/engage/rewards?tab=nominate">Nominate</Link> : null}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
      {admin ? (
        <Card key={editing?.id ?? "new"} title={editing ? `Edit "${editing.name}"` : "New programme"} description="Peer, manager, spot, team or anniversary recognition, with a points (and optional cash) budget and eligibility." action={editing ? <Link className="btn sm ghost" href="/engage/rewards?tab=programs">New instead</Link> : undefined}>
          <SpecForm action={saveProgramAction} hidden={editing ? { id: editing.id } : undefined} submitLabel={editing ? "Save changes" : "Save draft"} fields={[
            { name: "name", label: "Name", required: true, placeholder: "Q4 Spot Awards", defaultValue: editing?.name },
            { name: "kind", label: "Kind", type: "select", required: true, defaultValue: editing?.kind ?? "SPOT", options: ["SPOT", "PEER", "MANAGER", "TEAM", "ANNIVERSARY"].map((v) => ({ value: v, label: pretty(v) })) },
            { name: "awardTypeId", label: "Award given", type: "select", defaultValue: editing?.awardTypeId, options: types.map((x) => ({ value: x.id, label: x.name })) },
            { name: "pointsPerAward", label: "Points per award", type: "number", defaultValue: editing?.pointsPerAward ?? 100 },
            { name: "budgetPoints", label: "Points budget", type: "number", hint: "Blank = no cap", defaultValue: editing?.budgetPoints },
            { name: "budgetAmount", label: "Cash budget (₹)", type: "number", hint: "Blank = no cap", defaultValue: editing?.budgetAmount ? Number(editing.budgetAmount) : null },
            { name: "startsOn", label: "Starts", type: "date", required: true, defaultValue: iso(editing?.startsOn ?? null) },
            { name: "endsOn", label: "Ends", type: "date", defaultValue: iso(editing?.endsOn ?? null) },
            { name: "minTenureDays", label: "Minimum service (days)", type: "number", defaultValue: editing?.minTenureDays ?? 0 },
            { name: "cooldownDays", label: "Once per person every (days)", type: "number", defaultValue: editing?.cooldownDays ?? 0 },
            { name: "departmentIds", label: "Eligible departments (none = all)", type: "multiselect", options: depts, wide: true, defaultValue: editing?.departmentIds ?? [] },
            { name: "description", label: "Description", type: "textarea", wide: true, defaultValue: editing?.description },
          ]} />
        </Card>
      ) : null}
    </div>
  );
}

async function Awards({ tenantId, q }: { tenantId: string; q?: string }) {
  const rows = await prisma.employeeAward.findMany({ where: { tenantId }, orderBy: { awardedOn: "desc" }, take: 200, include: { awardType: { select: { name: true } }, employee: { select: { displayName: true, employeeNumber: true } } } });
  const shown = rows.filter((a) => matches(q, a.awardType.name, a.employee.displayName, a.employee.employeeNumber, a.citation));
  return (
    <Card tight title="Granted awards" description="Edit a citation, download the certificate, or revoke an award (its points are reversed)." action={<a className="btn sm" href="/engage/export?report=awards">Export CSV</a>}>
      <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="awards" /><input className="input" name="q" defaultValue={q ?? ""} placeholder="Search by person or award…" /><button className="btn sm">Search</button></form>
      <Table head={["Award", "Employee", "Awarded", "Points", "Status", "Citation", ""]} empty={shown.length === 0}>
        {shown.map((a) => (
          <tr key={a.id}>
            <td><strong>{a.awardType.name}</strong></td><td>{a.employee.displayName} <span className="text-xs muted">{a.employee.employeeNumber}</span></td><td>{fmtDay(a.awardedOn)}</td><td>{a.points ?? "—"}</td>
            <td>{a.revokedAt ? <><Pill s="REVOKED" /><div className="text-xs muted">{a.revokeReason}</div></> : <Pill s="GRANTED" />}</td>
            <td><ActButton action={updateAwardAction} hidden={{ awardId: a.id }} label="Save" input={{ name: "citation", placeholder: (a.citation ?? "Citation").slice(0, 40) }} /></td>
            <td className="row gap-2">{!a.revokedAt ? <><a className="btn sm" href={`/engage/rewards/certificate/${a.id}`}>PDF</a><ActButton action={revokeAwardAction} hidden={{ awardId: a.id }} label="Revoke" variant="danger" input={{ name: "reason", placeholder: "Reason", required: true }} confirmText="Revoke this award?" /></> : null}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Redemptions({ tenantId, status }: { tenantId: string; status?: string }) {
  const rows = await prisma.rewardRedemption.findMany({ where: { tenantId, ...(status ? { status } : { status: { in: ["PENDING", "APPROVED"] } }) }, orderBy: { createdAt: "asc" } });
  const names = await employeeNames(tenantId, rows.map((r) => r.employeeId));
  return (
    <Card tight title="Redemption fulfilment" description="Approve in Inbox › Approvals; fulfil approved rewards here with the voucher code or delivery reference." action={<a className="btn sm" href="/engage/export?report=redemptions">Export CSV</a>}>
      <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="redemptions" />
        <select className="select" name="status" defaultValue={status ?? ""} style={{ width: 200 }}><option value="">Waiting (pending or approved)</option>{["PENDING", "APPROVED", "FULFILLED", "REJECTED", "CANCELLED"].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select>
        <button className="btn sm">Filter</button></form>
      <Table head={["Requested", "Employee", "Reward", "Points", "Note", "Status", ""]} empty={rows.length === 0}>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{fmtDay(r.createdAt)}</td><td>{names.get(r.employeeId)}</td><td>{r.quantity} × {r.itemName}</td><td>{r.points}</td><td className="text-xs">{r.deliveryNote ?? ""}{r.fulfilmentNote ? <div>{r.fulfilmentNote}</div> : null}</td><td><Pill s={r.status} /></td>
            <td>{r.status === "APPROVED" ? <ActButton action={fulfilRedemptionAction} hidden={{ id: r.id }} label="Mark fulfilled" variant="primary" input={{ name: "note", placeholder: "Voucher code / courier ref", required: true }} /> : null}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Setup({ tenantId }: { tenantId: string }) {
  const [types, badges, items, people, settings] = await Promise.all([
    prisma.awardType.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.praiseBadge.findMany({ where: { tenantId }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
    prisma.rewardItem.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    employeeOptions(tenantId),
    engageSettings(tenantId),
  ]);
  return (
    <div className="stack gap-4">
      <Card tight title="Award categories">
        <Table head={["Award", "Cadence", "Cash", "Points", "Status", ""]} empty={types.length === 0}>
          {types.map((x) => <tr key={x.id}><td><strong>{x.name}</strong><div className="text-xs muted">{x.description ?? ""}</div></td><td>{pretty(x.cadence)}</td><td>{x.cashAmount ? `₹${Number(x.cashAmount)}` : "—"}</td><td>{x.points ?? "—"}</td><td><Pill s={x.isActive ? "ACTIVE" : "RETIRED"} /></td><td><ActButton action={toggleAwardTypeAction} hidden={{ id: x.id }} label={x.isActive ? "Retire" : "Reactivate"} variant="ghost" /></td></tr>)}
        </Table>
        <div style={{ marginTop: 12 }}>
          <SpecForm action={saveAwardTypeAction} submitLabel="Add award category" columns={3} fields={[
            { name: "name", label: "Name", required: true }, { name: "cadence", label: "Cadence", type: "select", defaultValue: "SPOT", options: ["SPOT", "MONTHLY", "QUARTERLY", "ANNUAL"].map((v) => ({ value: v, label: pretty(v) })) },
            { name: "cashAmount", label: "Cash (₹, via payroll)", type: "number" }, { name: "points", label: "Points", type: "number" }, { name: "description", label: "Description", wide: true },
          ]} />
        </div>
      </Card>
      <Card tight title="Praise badges" description="The badge picker in the praise composer.">
        <Table head={["Badge", "Description", "Colour", "Order", "Status", ""]} empty={badges.length === 0}>
          {badges.map((b) => <tr key={b.id}><td><strong>{b.name}</strong></td><td className="text-xs">{b.description ?? ""}</td><td><span style={{ display: "inline-block", width: 14, height: 14, borderRadius: 3, background: b.color }} /> {b.color}</td><td>{b.position}</td><td><Pill s={b.isActive ? "ACTIVE" : "RETIRED"} /></td><td><ActButton action={toggleBadgeAction} hidden={{ id: b.id }} label={b.isActive ? "Hide" : "Restore"} variant="ghost" /></td></tr>)}
        </Table>
        <div style={{ marginTop: 12 }}>
          <SpecForm action={saveBadgeAction} submitLabel="Add badge" columns={3} fields={[
            { name: "name", label: "Name", required: true }, { name: "color", label: "Colour", defaultValue: "#F5B83D" }, { name: "position", label: "Order", type: "number", defaultValue: 0 },
            { name: "icon", label: "Icon", type: "select", defaultValue: "star", options: ["star", "trophy", "heart", "rocket", "bulb", "handshake", "shield"].map((v) => ({ value: v, label: pretty(v) })) },
            { name: "description", label: "Description", wide: true },
          ]} />
        </div>
      </Card>
      <Card tight title="Reward catalog">
        <Table head={["Reward", "Category", "Cost", "Stock", "Status", ""]} empty={items.length === 0}>
          {items.map((i) => <tr key={i.id}><td><strong>{i.name}</strong><div className="text-xs muted">{i.description ?? ""}</div></td><td>{pretty(i.category)}</td><td>{i.pointsCost}</td><td>{i.stock ?? "∞"}</td><td><Pill s={i.isActive ? "ACTIVE" : "RETIRED"} /></td><td><ActButton action={toggleRewardItemAction} hidden={{ id: i.id }} label={i.isActive ? "Withdraw" : "Re-list"} variant="ghost" /></td></tr>)}
        </Table>
        <div style={{ marginTop: 12 }}>
          <SpecForm action={saveRewardItemAction} submitLabel="Add reward" columns={3} fields={[
            { name: "name", label: "Name", required: true }, { name: "category", label: "Category", type: "select", defaultValue: "VOUCHER", options: ["VOUCHER", "MERCHANDISE", "EXPERIENCE", "CHARITY", "TIME_OFF"].map((v) => ({ value: v, label: pretty(v) })) },
            { name: "pointsCost", label: "Cost (points)", type: "number", required: true }, { name: "stock", label: "Stock", type: "number", hint: "Blank = unlimited" }, { name: "description", label: "Description", wide: true },
          ]} />
        </div>
      </Card>
      <div className="grid grid-2">
        <Card title="Adjust points" description="Manual credit or debit, recorded in the ledger with your reason.">
          <SpecForm action={adjustPointsAction} submitLabel="Post adjustment" columns={1} fields={[
            { name: "employeeId", label: "Employee", type: "select", required: true, options: people },
            { name: "delta", label: "Points (+/-)", type: "number", required: true }, { name: "note", label: "Reason", required: true },
          ]} />
        </Card>
        <Card title="Points rules">
          <SpecForm action={saveEngageSettingsAction} hidden={{ scope: "rewards" }} submitLabel="Save" columns={1} fields={[
            { name: "pointsPerPraise", label: "Points the recipient earns per praise", type: "number", defaultValue: settings.pointsPerPraise },
            { name: "anniversaryPoints", label: "Points per year of service on the work anniversary (0 = off)", type: "number", defaultValue: settings.anniversaryPoints },
          ]} />
        </Card>
      </div>
    </div>
  );
}

async function Reports({ tenantId }: { tenantId: string }) {
  const since = new Date(Date.now() - 365 * 86_400_000);
  const [praise, awards, nominations, redemptions, ledger, depts, headcounts, people] = await Promise.all([
    prisma.praise.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { toEmployeeId: true, badge: true } }),
    prisma.employeeAward.findMany({ where: { tenantId, awardedOn: { gte: since }, revokedAt: null }, select: { employeeId: true, cashAmount: true } }),
    prisma.awardNomination.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
    prisma.rewardRedemption.findMany({ where: { tenantId }, select: { status: true, points: true } }),
    prisma.rewardPointEntry.aggregate({ where: { tenantId, delta: { gt: 0 } }, _sum: { delta: true } }),
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.employee.groupBy({ by: ["departmentId"], where: { tenantId, status: { notIn: ["EXITED", "INACTIVE"] } }, _count: true }),
    prisma.employee.findMany({ where: { tenantId }, select: { id: true, departmentId: true } }),
  ]);
  const deptOf = new Map(people.map((p) => [p.id, p.departmentId ?? ""]));
  const per = new Map<string, number>();
  for (const id of [...praise.map((p) => p.toEmployeeId), ...awards.map((a) => a.employeeId)]) per.set(deptOf.get(id) ?? "", (per.get(deptOf.get(id) ?? "") ?? 0) + 1);
  const fair = recognitionFairness(headcounts.map((h) => ({ group: depts.find((d) => d.id === h.departmentId)?.name ?? "No department", headcount: h._count, recognitions: per.get(h.departmentId ?? "") ?? 0 })));
  const top = new Map<string, number>();
  for (const p of praise) top.set(p.toEmployeeId, (top.get(p.toEmployeeId) ?? 0) + 1);
  const topList = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topNames = await employeeNames(tenantId, topList.map(([id]) => id));
  const badgeCounts = new Map<string, number>();
  for (const p of praise) if (p.badge) badgeCounts.set(p.badge, (badgeCounts.get(p.badge) ?? 0) + 1);
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Praise (12 months)" value={praise.length} />
        <Stat label="Awards (12 months)" value={awards.length} meta={`₹${awards.reduce((s, a) => s + Number(a.cashAmount ?? 0), 0)} cash`} />
        <Stat label="Points issued" value={ledger._sum.delta ?? 0} />
        <Stat label="Points redeemed" value={redemptions.filter((r) => r.status === "APPROVED" || r.status === "FULFILLED").reduce((s, r) => s + r.points, 0)} />
      </div>
      <Card tight title="Exports">
        <div className="row gap-2 wrap">
          {[["awards", "Awards"], ["nominations", "Nominations"], ["praise", "Praise (kudos)"], ["points-ledger", "Points ledger"], ["redemptions", "Redemptions"], ["program-budgets", "Programme budgets"], ["fairness", "Fairness by department"]].map(([k, l]) => <a key={k} className="btn sm" href={`/engage/export?report=${k}`}>{l} CSV</a>)}
        </div>
      </Card>
      <Card tight title="Recognition fairness" description={`Recognitions (praise + awards) per 10 people over 12 months; the organisation averages ${fair.orgRate}. Departments under half that rate are flagged.`}>
        <Table head={["Department", "Headcount", "Recognitions", "Per 10 people", "Index", ""]} empty={fair.rows.length === 0}>
          {fair.rows.map((r) => <tr key={r.group}><td>{r.group}</td><td>{r.headcount}</td><td>{r.recognitions}</td><td>{r.rate}</td><td>{r.index ?? "—"}</td><td>{r.underRecognised ? <Badge tone="warning">Under-recognised</Badge> : null}</td></tr>)}
        </Table>
      </Card>
      <div className="grid grid-2">
        <Card tight title="Most praised (12 months)">
          <Table head={["Employee", "Praise"]} empty={topList.length === 0}>{topList.map(([id, n]) => <tr key={id}><td>{topNames.get(id)}</td><td>{n}</td></tr>)}</Table>
        </Card>
        <Card tight title="Nominations and badges">
          <Table head={["Measure", "Count"]}>
            {nominations.map((n) => <tr key={n.status}><td>Nominations {pretty(n.status).toLowerCase()}</td><td>{n._count}</td></tr>)}
            {[...badgeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([b, n]) => <tr key={b}><td>Badge: {b}</td><td>{n}</td></tr>)}
          </Table>
        </Card>
      </div>
    </div>
  );
}
