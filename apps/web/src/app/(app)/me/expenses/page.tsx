import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@keka/db";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer, type Viewer } from "@/lib/context";
import { SubTabs } from "@/components/subtabs";
import { Panel, SectionTitle, Notice, EmptyState } from "@/components/keka";
import { IconFile, IconReceipt } from "@/components/icons";
import { ClaimForm, ClaimOps, AdvanceForm, TripForm, TripOps } from "../../expenses/forms";
import { SheetButton } from "./sheet";
import { RowMenu } from "./row-menu";
import s from "./expenses.module.css";

/**
 * Me → Expenses & Travel: the employee's own claims, cash advances and trips.
 * Forms and row operations are the ones the finance workspace uses
 * (`/expenses`), so the rules — policy limits, receipts, who may withdraw —
 * live in one place. A claim opens on its existing detail page.
 */

type View = "pending" | "past" | "advances" | "travel";
type SP = { view?: string; page?: string; spage?: string; new?: string };

const PAGE_SIZE = 10;
const DAY = 86_400_000;
/** A rejected claim stays in the in-process list this long, so its reason is seen. */
const REJECTED_VISIBLE_DAYS = 30;

const IN_PROCESS = ["SUBMITTED", "PARTIALLY_APPROVED", "APPROVED", "PAYMENT_PENDING"] as const;
const CLOSED = ["PAID", "REJECTED", "CANCELLED"] as const;

const CLAIM_STATUS: Record<string, string> = {
  DRAFT: "Draft", SUBMITTED: "Waiting for approval", PARTIALLY_APPROVED: "In approval process", APPROVED: "Approved",
  PAYMENT_PENDING: "Payment pending", PAID: "Paid", REJECTED: "Rejected", CANCELLED: "Withdrawn",
};
const ADVANCE_STATUS: Record<string, string> = {
  REQUESTED: "Waiting for approval", APPROVED: "Approved, to be disbursed", REJECTED: "Rejected", DISBURSED: "Disbursed",
  PARTIALLY_SETTLED: "Partially settled", SETTLED: "Settled", RECOVERED: "Recovered from salary",
};
const TRIP_STATUS: Record<string, string> = {
  REQUESTED: "Waiting for approval", APPROVED: "Approved, to be booked", REJECTED: "Rejected", BOOKED: "Booked",
  IN_PROGRESS: "In progress", COMPLETED: "Completed", CANCELLED: "Cancelled",
};
const TONE: Record<string, string> = {
  PAID: "ok", SETTLED: "ok", RECOVERED: "ok", COMPLETED: "ok", BOOKED: "ok",
  REJECTED: "bad", CANCELLED: "muted",
};

/** "2,069" — the shared rupee formatter without the symbol or empty paise. */
const amt = (v: unknown) => formatINR(Number(v ?? 0), false).replace(/\.00$/, "");
const pageOf = (raw: string | undefined, total: number) => {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, pages) : 1;
};

export default async function MyExpensesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const view: View = (["past", "advances", "travel"] as const).find((v) => v === sp.view) ?? "pending";
  return (
    <>
      <SubTabs items={[
        { label: "Pending Expenses", href: "/me/expenses" },
        { label: "Past Claims", href: "/me/expenses?view=past" },
        { label: "Advance Requests", href: "/me/expenses?view=advances" },
        { label: "Travel", href: "/me/expenses?view=travel" },
      ]} />
      {!viewer.employee ? (
        <Panel><EmptyState icon={<IconReceipt />} title="No employee record">This login is not linked to an employee, so there are no expenses to show.</EmptyState></Panel>
      ) : view === "pending" ? <Pending viewer={viewer} sp={sp} />
        : view === "past" ? <Past viewer={viewer} sp={sp} />
        : view === "advances" ? <Advances viewer={viewer} sp={sp} />
        : <Travel viewer={viewer} sp={sp} />}
    </>
  );
}

// ---------------------------------------------------------------------------
//  Shared pieces
// ---------------------------------------------------------------------------

function href(sp: SP, patch: Partial<SP>): string {
  const q = new URLSearchParams();
  const merged = { ...sp, ...patch, new: undefined };
  for (const [k, v] of Object.entries(merged)) if (v && !(k.endsWith("page") && v === "1")) q.set(k, v);
  const qs = q.toString();
  return qs ? `/me/expenses?${qs}` : "/me/expenses";
}

function Chevron({ dir, double }: { dir: "left" | "right"; double?: boolean }) {
  const d = dir === "left" ? "M14.5 6 8.5 12l6 6" : "M9.5 6l6 6-6 6";
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
      {double ? <path d={dir === "left" ? "M7 6v12" : "M17 6v12"} /> : null}
    </svg>
  );
}

/** "1 to 4 of 4 · Page 1 of 1", with first / previous / next / last. */
function Pager({ total, page, link }: { total: number; page: number; link: (p: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(total, page * PAGE_SIZE);
  const step = (p: number, label: string, icon: ReactNode, off: boolean) => off
    ? <span className={s.pageBtn} aria-disabled="true" aria-label={label}>{icon}</span>
    : <Link className={s.pageBtn} href={link(p)} aria-label={label} scroll={false}>{icon}</Link>;
  return (
    <nav className={s.pager} aria-label="Pagination">
      <span>{from} to {to} of {total}</span>
      <span className={s.pagerNav}>
        {step(1, "First page", <Chevron dir="left" double />, page <= 1)}
        {step(page - 1, "Previous page", <Chevron dir="left" />, page <= 1)}
        <span>Page {page} of {pages}</span>
        {step(page + 1, "Next page", <Chevron dir="right" />, page >= pages)}
        {step(pages, "Last page", <Chevron dir="right" double />, page >= pages)}
      </span>
    </nav>
  );
}

function Status({ code, labels, note }: { code: string; labels: Record<string, string>; note?: string | null }) {
  const tone = TONE[code];
  return (
    <>
      <div className={tone === "bad" ? s.bad : tone === "ok" ? s.ok : tone === "muted" ? s.mutedStatus : undefined}>{labels[code] ?? code}</div>
      {note ? <div className={s.reason} title={note}>{note}</div> : null}
    </>
  );
}

const EmptyNotice = ({ children }: { children: ReactNode }) => <Panel><Notice>{children}</Notice></Panel>;

// ---------------------------------------------------------------------------
//  Pending expenses
// ---------------------------------------------------------------------------

type ClaimRow = {
  id: string; claimNumber: string; title: string; stage: string; currency: string; claimedTotal: unknown; approvedTotal: unknown;
  submittedAt: Date | null; createdAt: Date; updatedAt: Date; paidAt: Date | null; rejectReason: string | null; approvedBy: string | null; approvedAt: Date | null;
  advanceId: string | null; payViaPayroll: boolean; paidInRunId: string | null; _count: { lines: number };
};

async function Pending({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const me = viewer.employee!;
  const since = new Date(Date.now() - REJECTED_VISIBLE_DAYS * DAY);
  const [claims, self, cats, policy, openAdvances] = await Promise.all([
    prisma.expenseClaim.findMany({
      where: { tenantId: viewer.tenantId, employeeId: me.id, OR: [{ stage: { in: ["DRAFT", ...IN_PROCESS] } }, { stage: "REJECTED", updatedAt: { gte: since } }] },
      include: { _count: { select: { lines: true } } },
      orderBy: [{ submittedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
    }),
    prisma.employee.findFirst({ where: { id: me.id, tenantId: viewer.tenantId }, select: { reportingManager: { select: { displayName: true, firstName: true, lastName: true } } } }),
    prisma.expenseCategory.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.expensePolicy.findFirst({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { isDefault: "desc" }, include: { categories: true } }),
    prisma.cashAdvance.findMany({ where: { tenantId: viewer.tenantId, employeeId: me.id, status: { in: ["DISBURSED", "PARTIALLY_SETTLED"] } }, orderBy: { createdAt: "desc" } }),
  ]);

  const drafts = claims.filter((c) => c.stage === "DRAFT");
  const active = claims.filter((c) => c.stage !== "DRAFT");
  const ownClaims = active.filter((c) => !c.advanceId);
  const settlements = active.filter((c) => c.advanceId);

  // Who acted last on each claim: the approval or rejection in the audit
  // trail, else the approver recorded on the claim.
  const audits = active.length ? await prisma.auditLog.findMany({
    where: { tenantId: viewer.tenantId, entityType: "ExpenseClaim", entityId: { in: active.map((c) => c.id) }, action: { in: ["APPROVE", "REJECT"] } },
    orderBy: { createdAt: "desc" }, select: { entityId: true, actorId: true, createdAt: true },
  }) : [];
  const lastAction = new Map<string, { userId: string | null; at: Date }>();
  // A rejection records its decider on the claim; older ones only in the audit trail.
  for (const c of active) if (c.stage === "REJECTED" && c.rejectedBy && c.rejectedAt) lastAction.set(c.id, { userId: c.rejectedBy, at: c.rejectedAt });
  for (const a of audits) if (a.entityId && !lastAction.has(a.entityId)) lastAction.set(a.entityId, { userId: a.actorId, at: a.createdAt });
  for (const c of active) if (!lastAction.has(c.id) && c.approvedBy && c.approvedAt) lastAction.set(c.id, { userId: c.approvedBy, at: c.approvedAt });
  const actorIds = [...new Set([...lastAction.values()].map((v) => v.userId).filter((x): x is string => !!x))];
  const actors = actorIds.length ? await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, userId: { in: actorIds } }, select: { userId: true, displayName: true, firstName: true, lastName: true } }) : [];
  const actorName = new Map(actors.map((a) => [a.userId!, a.displayName ?? `${a.firstName} ${a.lastName}`]));
  const advancePurpose = new Map(
    (settlements.length ? await prisma.cashAdvance.findMany({ where: { tenantId: viewer.tenantId, employeeId: me.id, id: { in: settlements.map((c) => c.advanceId!) } }, select: { id: true, purpose: true } }) : [])
      .map((a) => [a.id, a.purpose]),
  );

  const manager = self?.reportingManager ? self.reportingManager.displayName ?? `${self.reportingManager.firstName} ${self.reportingManager.lastName}` : null;
  const waitingOn = (stage: string) => ({
    SUBMITTED: manager ?? "Expense approver", PARTIALLY_APPROVED: "Finance team", APPROVED: "Finance team", PAYMENT_PENDING: "Payroll",
  } as Record<string, string>)[stage] ?? null;

  const cap = (c: (typeof cats)[number]) => {
    const p = policy?.categories.find((x) => x.categoryId === c.id)?.maxAmount;
    const caps = [c.maxAmount, p].filter((v) => v !== null && v !== undefined).map(Number);
    return caps.length ? Math.min(...caps) : null;
  };
  const claimForm = (
    <ClaimForm
      categories={cats.map((c) => ({ value: c.id, label: c.name, cap: cap(c), receiptAbove: c.receiptRequiredAbove === null ? null : Number(c.receiptRequiredAbove) }))}
      advances={openAdvances.map((a) => ({ value: a.id, label: `${a.purpose} — ₹${amt(a.outstanding)} open` }))}
    />
  );

  const page = pageOf(sp.page, ownClaims.length);
  const spage = pageOf(sp.spage, settlements.length);

  return (
    <div className={s.stack}>
      <section className={s.section} aria-labelledby="to-claim">
        <SectionTitle
          sub="The following are the expenses that you are yet to claim"
          action={
            <SheetButton label="+ Add an Expense" title="Add an expense" subtitle="Limits and receipt rules are checked as you enter each expense. Save a draft to finish later." openParam="new" className={`btn primary ${s.addBtn}`}>
              {cats.length ? claimForm : <Notice>No expense categories are set up yet. Ask your finance team to add them.</Notice>}
            </SheetButton>
          }
        >
          <span id="to-claim" className={s.titleWithIcon}>Expenses to be Claimed <IconFile className={s.titleIcon} aria-hidden="true" /></span>
        </SectionTitle>
        <Panel pad={drafts.length === 0}>
          {drafts.length === 0 ? <Notice>No saved expenses to show.</Notice> : (
            <div className="table-wrap">
              <table className={`data ${s.table}`}>
                <thead><tr><th>Claim number</th><th>Claim</th><th>Expenses</th><th className="num">Amount</th><th>Saved on</th><th className={s.actionsCol}>Actions</th></tr></thead>
                <tbody>
                  {drafts.map((c) => (
                    <tr key={c.id}>
                      <td><Link className={s.link} href={`/expenses/${c.id}`}>#{c.claimNumber}</Link></td>
                      <td className={s.claimCell}><Link className={s.link} href={`/expenses/${c.id}`}>{c.title}</Link></td>
                      <td className="nowrap">{c._count.lines} {c._count.lines === 1 ? "Expense" : "Expenses"}</td>
                      <td className="num nowrap">{c.currency} {amt(c.claimedTotal)}</td>
                      <td className="nowrap">{formatDate(c.createdAt)}</td>
                      <td className={s.actionsCol}>
                        <RowMenu label={`Actions for ${c.claimNumber}`}>
                          <Link className={s.menuItem} href={`/expenses/${c.id}`}>Open draft</Link>
                          <div className={s.menuOps}><ClaimOps claimId={c.id} ops={["submit", "cancel"]} /></div>
                        </RowMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>

      <section className={s.section} aria-labelledby="in-process">
        <SectionTitle sub="The following are the expense claims that are yet to be approved or yet to be paid are shown here">
          <span id="in-process">Expense claims in process</span>
        </SectionTitle>
        {ownClaims.length === 0 ? <EmptyNotice>No expense claims in process.</EmptyNotice> : (
          <Panel pad={false}>
            <ClaimsTable rows={ownClaims.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)} lastAction={lastAction} actorName={actorName} waitingOn={waitingOn} />
            <Pager total={ownClaims.length} page={page} link={(p) => href(sp, { page: String(p) })} />
          </Panel>
        )}
      </section>

      <section className={s.section} aria-labelledby="settlements">
        <SectionTitle sub="The following are the advance settlements that are yet to be approved or yet to be paid are shown here">
          <span id="settlements">Advance settlements in process</span>
        </SectionTitle>
        {settlements.length === 0 ? <EmptyNotice>No pending advance settlements to show.</EmptyNotice> : (
          <Panel pad={false}>
            <ClaimsTable rows={settlements.slice((spage - 1) * PAGE_SIZE, spage * PAGE_SIZE)} lastAction={lastAction} actorName={actorName} waitingOn={waitingOn} advancePurpose={advancePurpose} />
            <Pager total={settlements.length} page={spage} link={(p) => href(sp, { spage: String(p) })} />
          </Panel>
        )}
      </section>
    </div>
  );
}

function ClaimsTable({ rows, lastAction, actorName, waitingOn, advancePurpose }: {
  rows: ClaimRow[];
  lastAction: Map<string, { userId: string | null; at: Date }>;
  actorName: Map<string, string>;
  waitingOn: (stage: string) => string | null;
  advancePurpose?: Map<string, string>;
}) {
  return (
    <div className="table-wrap">
      <table className={`data ${s.table}`}>
        <thead>
          <tr>
            <th>Claim number</th><th>Claim</th><th>Expenses</th><th>Approved amount</th><th>Claim status</th><th>Action taken by</th><th>Waiting on</th><th className={s.actionsCol}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const last = lastAction.get(c.id);
            const who = last?.userId ? actorName.get(last.userId) ?? "Finance team" : null;
            const waiting = c.stage === "REJECTED" ? null : waitingOn(c.stage);
            const purpose = c.advanceId ? advancePurpose?.get(c.advanceId) : null;
            return (
              <tr key={c.id}>
                <td><Link className={s.link} href={`/expenses/${c.id}`}>#{c.claimNumber}</Link></td>
                <td className={s.claimCell}>
                  <Link className={s.link} href={`/expenses/${c.id}`} title={c.title}>{c.title}</Link>
                  <div className={s.sub}>On {formatDate(c.submittedAt ?? c.createdAt)}{purpose ? ` · against “${purpose}”` : ""}</div>
                </td>
                <td className="nowrap">{c._count.lines} {c._count.lines === 1 ? "Expense" : "Expenses"}</td>
                <td className="nowrap">{c.currency} {amt(c.approvedTotal)} of {amt(c.claimedTotal)}</td>
                <td className={s.statusCell}>
                  <Status code={c.stage} labels={CLAIM_STATUS} note={c.stage === "REJECTED" ? c.rejectReason : c.stage === "PAYMENT_PENDING" && c.payViaPayroll ? "With your next salary" : null} />
                </td>
                <td className={s.personCell}>
                  {who && last ? <><div className={s.ellipsis} title={who}>{who}</div><div className={s.sub}>On {formatDate(last.at)}</div></> : <span className="subtle">—</span>}
                </td>
                <td className={s.personCell}>{waiting ? <div className={s.ellipsis} title={waiting}>{waiting}</div> : <span className="subtle">—</span>}</td>
                <td className={s.actionsCol}>
                  <RowMenu label={`Actions for ${c.claimNumber}`}>
                    <Link className={s.menuItem} href={`/expenses/${c.id}`}>View claim</Link>
                    {c.stage === "SUBMITTED" ? <div className={s.menuOps}><ClaimOps claimId={c.id} ops={["cancel"]} /></div> : null}
                  </RowMenu>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Past claims
// ---------------------------------------------------------------------------

async function Past({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const me = viewer.employee!;
  const claims = await prisma.expenseClaim.findMany({
    where: { tenantId: viewer.tenantId, employeeId: me.id, stage: { in: [...CLOSED] } },
    include: { _count: { select: { lines: true } } },
    orderBy: { updatedAt: "desc" },
  });
  const page = pageOf(sp.page, claims.length);
  const paidTotal = claims.filter((c) => c.stage === "PAID").reduce((t, c) => t + Number(c.approvedTotal), 0);
  return (
    <section className={s.section} aria-labelledby="past">
      <SectionTitle sub={claims.length ? `Claims that have been paid, rejected or withdrawn · ₹${amt(paidTotal)} reimbursed in all` : "Claims that have been paid, rejected or withdrawn"}>
        <span id="past">Past Claims</span>
      </SectionTitle>
      {claims.length === 0 ? <EmptyNotice>No past claims to show.</EmptyNotice> : (
        <Panel pad={false}>
          <div className="table-wrap">
            <table className={`data ${s.table}`}>
              <thead><tr><th>Claim number</th><th>Claim</th><th>Expenses</th><th>Approved amount</th><th>Claim status</th><th>Closed on</th><th className={s.actionsCol}>Actions</th></tr></thead>
              <tbody>
                {claims.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((c) => (
                  <tr key={c.id}>
                    <td><Link className={s.link} href={`/expenses/${c.id}`}>#{c.claimNumber}</Link></td>
                    <td className={s.claimCell}>
                      <Link className={s.link} href={`/expenses/${c.id}`} title={c.title}>{c.title}</Link>
                      <div className={s.sub}>On {formatDate(c.submittedAt ?? c.createdAt)}</div>
                    </td>
                    <td className="nowrap">{c._count.lines} {c._count.lines === 1 ? "Expense" : "Expenses"}</td>
                    <td className="nowrap">{c.currency} {amt(c.approvedTotal)} of {amt(c.claimedTotal)}</td>
                    <td className={s.statusCell}>
                      <Status code={c.stage} labels={CLAIM_STATUS} note={c.stage === "REJECTED" ? c.rejectReason : c.stage === "PAID" ? (c.paidInRunId ? "Paid with salary" : c.advanceId ? "Settled against advance" : "Paid by transfer") : null} />
                    </td>
                    <td className="nowrap">{formatDate(c.stage === "PAID" ? c.paidAt ?? c.updatedAt : c.updatedAt)}</td>
                    <td className={s.actionsCol}>
                      <RowMenu label={`Actions for ${c.claimNumber}`}>
                        <Link className={s.menuItem} href={`/expenses/${c.id}`}>View claim</Link>
                      </RowMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager total={claims.length} page={page} link={(p) => href(sp, { page: String(p) })} />
        </Panel>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
//  Advance requests
// ---------------------------------------------------------------------------

async function Advances({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const me = viewer.employee!;
  const advances = await prisma.cashAdvance.findMany({ where: { tenantId: viewer.tenantId, employeeId: me.id }, orderBy: { createdAt: "desc" } });
  const open = advances.find((a) => ["REQUESTED", "APPROVED", "DISBURSED", "PARTIALLY_SETTLED"].includes(a.status));
  const page = pageOf(sp.page, advances.length);
  return (
    <section className={s.section} aria-labelledby="advances">
      <SectionTitle
        sub="Cash you have asked for ahead of spending it. Settle it with expense claims; anything left unclaimed is recovered from your salary."
        action={open ? <span className={s.hint}>Settle your open advance before requesting another.</span> : (
          <SheetButton label="+ Request an Advance" title="Request a cash advance" subtitle="Your approver is notified. Once disbursed, settle it by raising claims against it." side={false} className={`btn primary ${s.addBtn}`}>
            <AdvanceForm />
          </SheetButton>
        )}
      >
        <span id="advances">Advance Requests</span>
      </SectionTitle>
      {advances.length === 0 ? <EmptyNotice>No advance requests to show.</EmptyNotice> : (
        <Panel pad={false}>
          <div className="table-wrap">
            <table className={`data ${s.table}`}>
              <thead><tr><th>Purpose</th><th>Requested on</th><th>Needed by</th><th className="num">Amount</th><th className="num">Settled</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
              <tbody>
                {advances.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((a) => (
                  <tr key={a.id}>
                    <td className={s.claimCell}><div className={s.ellipsis} title={a.purpose}>{a.purpose}</div></td>
                    <td className="nowrap">{formatDate(a.createdAt)}</td>
                    <td className="nowrap">{a.neededBy ? formatDate(a.neededBy) : <span className="subtle">—</span>}</td>
                    <td className="num nowrap">INR {amt(a.amount)}</td>
                    <td className="num nowrap">INR {amt(a.settledAmount)}</td>
                    <td className="num nowrap">{Number(a.outstanding) ? `INR ${amt(a.outstanding)}` : <span className="subtle">—</span>}</td>
                    <td className={s.statusCell}><Status code={a.status} labels={ADVANCE_STATUS} note={a.disbursedAt && ["DISBURSED", "PARTIALLY_SETTLED"].includes(a.status) ? `Disbursed on ${formatDate(a.disbursedAt)}` : null} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager total={advances.length} page={page} link={(p) => href(sp, { page: String(p) })} />
        </Panel>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
//  Travel
// ---------------------------------------------------------------------------

async function Travel({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const me = viewer.employee!;
  const trips = await prisma.travelRequest.findMany({ where: { tenantId: viewer.tenantId, employeeId: me.id }, orderBy: { departDate: "desc" } });
  const page = pageOf(sp.page, trips.length);
  return (
    <section className={s.section} aria-labelledby="travel">
      <SectionTitle
        sub="Trips you have requested. Your manager approves; the travel desk books tickets and hotels."
        action={
          <SheetButton label="+ New Travel Request" title="Request a trip" subtitle="Your manager approves it, then the travel desk books it." className={`btn primary ${s.addBtn}`}>
            <TripForm />
          </SheetButton>
        }
      >
        <span id="travel">Travel Requests</span>
      </SectionTitle>
      {trips.length === 0 ? <EmptyNotice>No travel requests to show.</EmptyNotice> : (
        <Panel pad={false}>
          <div className="table-wrap">
            <table className={`data ${s.table}`}>
              <thead><tr><th>Request number</th><th>Trip</th><th>Travel dates</th><th>Type</th><th className="num">Cost</th><th>Status</th><th className={s.actionsCol}>Actions</th></tr></thead>
              <tbody>
                {trips.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((t) => {
                  const ops = [
                    ...(["BOOKED", "IN_PROGRESS"].includes(t.status) ? ["complete"] : []),
                    ...(["REQUESTED", "APPROVED", "BOOKED"].includes(t.status) ? ["cancel"] : []),
                  ];
                  return (
                    <tr key={t.id}>
                      <td className="nowrap">#{t.requestNumber}</td>
                      <td className={s.claimCell}>
                        <div className={s.strong}>{t.fromCity} → {t.toCity}</div>
                        <div className={`${s.sub} ${s.ellipsis}`} title={t.purpose}>{t.purpose}</div>
                      </td>
                      <td className="nowrap">{formatDate(t.departDate)}{t.returnDate ? <div className={s.sub}>to {formatDate(t.returnDate)}</div> : null}</td>
                      <td className="nowrap">{t.travelType === "INTERNATIONAL" ? "International" : "Domestic"}{t.needsAccommodation ? <div className={s.sub}>Hotel needed</div> : null}</td>
                      <td className="num nowrap">
                        {t.actualCost ? `INR ${amt(t.actualCost)}` : t.estimatedCost ? `~INR ${amt(t.estimatedCost)}` : <span className="subtle">—</span>}
                        {t.actualCost ? <div className={s.sub}>actual</div> : t.estimatedCost ? <div className={s.sub}>estimated</div> : null}
                      </td>
                      <td className={s.statusCell}><Status code={t.status} labels={TRIP_STATUS} note={t.status === "REJECTED" ? t.rejectReason : t.bookingRef ? `Ref ${t.bookingRef}` : null} /></td>
                      <td className={s.actionsCol}>
                        {ops.length ? (
                          <RowMenu label={`Actions for ${t.requestNumber}`}>
                            <div className={s.menuOps}><TripOps tripId={t.id} ops={ops} /></div>
                          </RowMenu>
                        ) : <span className="subtle">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager total={trips.length} page={page} link={(p) => href(sp, { page: String(p) })} />
        </Panel>
      )}
    </section>
  );
}
