import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { trialBalance, financialStatements, accountLedger, ensureChart } from "@keka/services";
import { requireAuth, can, type Viewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat, Callout } from "@/components/ui";
import { Disclosure } from "../org/forms";
import { JournalForm, ReverseButton, AccountForm, AccountToggle, PeriodToggle, PostPayrollButton, SalaryPaymentForm, RemitForm } from "./forms";

const P = PERMISSIONS;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string | undefined, fallback: Date) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? "") ? new Date(`${s}T00:00:00Z`) : fallback);
const endOf = (d: Date) => new Date(d.getTime() + 86_399_999);
const money = (n: number) => (n === 0 ? "—" : formatINR(n));
const SOURCE: Record<string, "info" | "success" | "warning" | "neutral"> = { PAYROLL: "info", PAYMENT: "success", INVOICE: "warning", MANUAL: "neutral", OPENING_BALANCE: "neutral", EXPENSE: "info", LOAN: "info" };
const TABS = { overview: "Overview", journal: "Journal", accounts: "Chart of accounts", ledger: "Ledger", trial: "Trial balance", statements: "Statements", periods: "Periods" } as const;
const DUE_CODES = ["2200", "2210", "2220", "2230", "2240", "2300", "2310", "2320"];

/** The Indian financial year containing a date: 1 April to 31 March. */
function fyStart(d = new Date()) {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return new Date(Date.UTC(y, 3, 1));
}

type SP = { tab?: string; account?: string; from?: string; to?: string; source?: string };

export default async function AccountingPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireAuth(P.LEDGER_VIEW);
  await ensureChart(viewer.tenantId);
  const sp = await searchParams;
  // Statements are a report in their own right; the ledger alone does not open them.
  const tabs = (Object.keys(TABS) as Array<keyof typeof TABS>).filter((k) => k !== "statements" || can(viewer, P.FINANCIAL_REPORT_VIEW));
  const tab = tabs.includes(sp.tab as keyof typeof TABS) ? (sp.tab as keyof typeof TABS) : "overview";
  return (
    <>
      <PageHead title="Accounting" subtitle="A double-entry ledger that payroll, salary payments, invoices and receipts post to on their own" />
      <div className="tabs">
        {tabs.map((k) => <Link key={k} href={`/accounting?tab=${k}`} className={`tab${tab === k ? " active" : ""}`}>{TABS[k]}</Link>)}
      </div>
      {tab === "overview" ? <Overview viewer={viewer} /> : null}
      {tab === "journal" ? <Journal viewer={viewer} source={sp.source} /> : null}
      {tab === "accounts" ? <Accounts viewer={viewer} /> : null}
      {tab === "ledger" ? <Ledger viewer={viewer} sp={sp} /> : null}
      {tab === "trial" ? <Trial viewer={viewer} sp={sp} /> : null}
      {tab === "statements" ? <Statements viewer={viewer} sp={sp} /> : null}
      {tab === "periods" ? <Periods viewer={viewer} /> : null}
    </>
  );
}

async function Overview({ viewer }: { viewer: Viewer }) {
  const post = can(viewer, P.LEDGER_POST);
  const [accounts, runs, recent] = await Promise.all([
    prisma.account.findMany({ where: { tenantId: viewer.tenantId, isGroup: false }, orderBy: { code: "asc" } }),
    prisma.payrollRun.findMany({ where: { tenantId: viewer.tenantId, status: "FINALIZED" }, include: { payGroup: { select: { name: true } } }, orderBy: [{ year: "desc" }, { month: "desc" }], take: 12 }),
    prisma.ledgerEntry.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);
  const posted = await prisma.ledgerEntry.findMany({ where: { tenantId: viewer.tenantId, status: "POSTED", sourceRefType: { in: ["PayrollRun", "PayrollRunPayment"] }, sourceRefId: { in: runs.map((r) => r.id) } }, select: { sourceRefType: true, sourceRefId: true, entryNumber: true } });
  const entryFor = (type: string, id: string) => posted.find((p) => p.sourceRefType === type && p.sourceRefId === id);
  const bal = (code: string) => Number(accounts.find((a) => a.code === code)?.currentBalance ?? 0);
  const dues = accounts.filter((a) => DUE_CODES.includes(a.code) && Number(a.currentBalance) > 0);
  const pending = runs.filter((r) => !entryFor("PayrollRun", r.id) || !entryFor("PayrollRunPayment", r.id));
  // The stored running balances must agree with the lines they summarise.
  const tb = await trialBalance(viewer.tenantId);
  const drift = accounts.filter((a) => Math.abs(Number(a.currentBalance) - (a.normalSide === "DEBIT" ? 1 : -1) * (tb.rows.find((r) => r.id === a.id)?.balance ?? 0)) > 0.005);
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Bank" value={formatINR(bal("1100"))} meta="current account" />
        <Stat label="Receivables" value={formatINR(bal("1200"))} meta={<Link href="/projects?tab=billing">open invoices</Link>} />
        <Stat label="Salaries payable" value={formatINR(bal("2100"))} meta="accrued, not yet paid" tone={bal("2100") > 0 ? "neg" : undefined} />
        <Stat label="Statutory dues" value={formatINR(dues.reduce((s, a) => s + Number(a.currentBalance), 0))} meta="PF, ESI, PT, TDS, GST" />
      </div>
      {tb.debit !== tb.credit || drift.length ? <Callout tone="danger" title="The books do not agree">{tb.debit !== tb.credit ? `Debits ${formatINR(tb.debit)} against credits ${formatINR(tb.credit)}. ` : ""}{drift.length ? `${drift.map((a) => a.name).join(", ")}: the stored balance differs from the ledger.` : ""}</Callout> : null}
      <Card tight title="Payroll months" description="Each finalised month posts its accrual automatically; record the bank transfer when salaries go out">
        {runs.length === 0 ? <Empty title="No finalised payroll yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Month</th><th className="num">Net pay</th><th>Accrual</th><th>Payment</th><th /></tr></thead>
            <tbody>{runs.map((r) => {
              const acc = entryFor("PayrollRun", r.id), paid = entryFor("PayrollRunPayment", r.id);
              return (
                <tr key={r.id}>
                  <td><Link href={`/payroll/runs/${r.id}`} className="strong text-sm">{new Date(Date.UTC(r.year, r.month - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}</Link><div className="text-xs subtle">{r.payGroup.name}</div></td>
                  <td className="num">{formatINR(Number(r.totalNetPay))}</td>
                  <td className="text-sm">{acc ? <span className="mono">{acc.entryNumber}</span> : <Badge tone="warning">not posted</Badge>}</td>
                  <td className="text-sm">{paid ? <span className="mono">{paid.entryNumber}</span> : acc ? <Badge tone="warning">unpaid</Badge> : "—"}</td>
                  <td>{post ? (!acc ? <PostPayrollButton runId={r.id} /> : !paid ? <SalaryPaymentForm runId={r.id} payDate={iso(r.payDate ?? r.periodEnd)} /> : null) : null}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        {pending.length === 0 && runs.length ? <div className="text-xs subtle" style={{ padding: "8px 16px" }}>Every finalised month is posted and paid.</div> : null}
      </Card>
      <Card tight title="Statutory dues" description="Collected through payroll and invoices, owed to the government until paid">
        {dues.length === 0 ? <Empty title="Nothing owed" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Due</th><th className="num">Owed</th><th /></tr></thead>
            <tbody>{dues.map((a) => (
              <tr key={a.id}>
                <td><Link href={`/accounting?tab=ledger&account=${a.id}`} className="text-sm strong">{a.name}</Link><div className="text-xs subtle mono">{a.code}</div></td>
                <td className="num">{formatINR(Number(a.currentBalance))}</td>
                <td>{post ? <RemitForm accountCode={a.code} owed={Number(a.currentBalance)} /> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Card tight title="Latest entries" action={<Link className="btn sm" href="/accounting?tab=journal">Journal</Link>}>
        {recent.length === 0 ? <Empty title="Nothing posted yet" /> : <EntryTable entries={recent} />}
      </Card>
    </div>
  );
}

function EntryTable({ entries }: { entries: Array<{ id: string; entryNumber: string; entryDate: Date; narration: string | null; source: string; status: string; totalDebit: unknown }> }) {
  return (
    <div className="table-wrap"><table className="data">
      <thead><tr><th>Entry</th><th>Date</th><th>Narration</th><th>Source</th><th className="num">Amount</th></tr></thead>
      <tbody>{entries.map((e) => (
        <tr key={e.id}>
          <td className="mono text-sm">{e.entryNumber}{e.status === "REVERSED" ? <div><Badge tone="danger">reversed</Badge></div> : null}</td>
          <td className="text-sm nowrap">{formatDate(e.entryDate)}</td>
          <td className="text-sm">{e.narration}</td>
          <td><Badge tone={SOURCE[e.source]}>{e.source.replace("_", " ").toLowerCase()}</Badge></td>
          <td className="num">{formatINR(Number(e.totalDebit))}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

async function Journal({ viewer, source }: { viewer: Viewer; source?: string }) {
  const sources = ["PAYROLL", "PAYMENT", "INVOICE", "MANUAL", "OPENING_BALANCE"];
  const filter = sources.includes(source ?? "") ? source : undefined;
  const [entries, accounts] = await Promise.all([
    prisma.ledgerEntry.findMany({ where: { tenantId: viewer.tenantId, ...(filter ? { source: filter as never } : {}) }, include: { lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { sequence: "asc" } } }, orderBy: [{ entryDate: "desc" }, { entryNumber: "desc" }], take: 60 }),
    can(viewer, P.LEDGER_POST) ? prisma.account.findMany({ where: { tenantId: viewer.tenantId, isGroup: false, isActive: true }, orderBy: { code: "asc" } }) : [],
  ]);
  return (
    <div className="stack gap-4">
      {can(viewer, P.LEDGER_POST) ? (
        <Card title="Manual journal entry" description="Posted entries are final. A mistake is corrected by reversing it, which leaves both on the record.">
          <Disclosure label="New entry"><JournalForm accounts={accounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))} /></Disclosure>
        </Card>
      ) : null}
      <div className="row gap-2 wrap">
        <Link href="/accounting?tab=journal" className={`btn sm${!filter ? " primary" : ""}`}>All</Link>
        {sources.map((s) => <Link key={s} href={`/accounting?tab=journal&source=${s}`} className={`btn sm${filter === s ? " primary" : ""}`}>{s.replace("_", " ").toLowerCase()}</Link>)}
      </div>
      <Card tight title={`Entries (${entries.length})`}>
        {entries.length === 0 ? <Empty title="No entries" /> : (
          <div className="stack">
            {entries.map((e) => (
              <details key={e.id} style={{ borderTop: "1px solid var(--border)" }}>
                <summary className="row gap-3 wrap" style={{ padding: "10px 16px", cursor: "pointer", justifyContent: "space-between" }}>
                  <span className="row gap-3 wrap">
                    <span className="mono text-sm strong">{e.entryNumber}</span>
                    <span className="text-sm subtle nowrap">{formatDate(e.entryDate)}</span>
                    <span className="text-sm">{e.narration}</span>
                  </span>
                  <span className="row gap-2">
                    <Badge tone={SOURCE[e.source]}>{e.source.replace("_", " ").toLowerCase()}</Badge>
                    {e.status === "REVERSED" ? <Badge tone="danger">reversed</Badge> : null}
                    <span className="num strong">{formatINR(Number(e.totalDebit))}</span>
                  </span>
                </summary>
                <div style={{ padding: "0 16px 12px" }}>
                  <table className="data">
                    <thead><tr><th>Account</th><th>Note</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
                    <tbody>{e.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="text-sm"><Link href={`/accounting?tab=ledger&account=${l.accountId}`}><span className="mono">{l.account.code}</span> {l.account.name}</Link></td>
                        <td className="text-xs subtle">{l.narration}</td>
                        <td className="num">{money(Number(l.debit))}</td>
                        <td className="num">{money(Number(l.credit))}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                  {e.reversalReason ? <div className="text-xs subtle" style={{ marginTop: 6 }}>Reversed: {e.reversalReason}</div> : null}
                  {e.status === "POSTED" && e.sourceRefType !== "Reversal" && can(viewer, P.LEDGER_REVERSE) ? <div style={{ marginTop: 8 }}><ReverseButton entryId={e.id} /></div> : null}
                </div>
              </details>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

async function Accounts({ viewer }: { viewer: Viewer }) {
  const accounts = await prisma.account.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { code: "asc" } });
  const groups = accounts.filter((a) => a.isGroup);
  const manage = can(viewer, P.ACCOUNT_MANAGE);
  return (
    <div className="stack gap-4">
      {manage ? <Card title="New account" description="Accounts sit under a group and take its class."><Disclosure label="Add account"><AccountForm groups={groups.map((g) => ({ value: g.id, label: `${g.code} · ${g.name}` }))} /></Disclosure></Card> : null}
      {groups.map((g) => {
        const kids = accounts.filter((a) => a.parentId === g.id);
        const total = kids.reduce((s, a) => s + Number(a.currentBalance), 0);
        return (
          <Card key={g.id} tight title={<>{g.name} <span className="subtle mono text-sm">{g.code}</span></>} action={<span className="strong">{formatINR(total)}</span>}>
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Code</th><th>Account</th><th className="num">Balance</th>{manage ? <th /> : null}</tr></thead>
              <tbody>{kids.map((a) => (
                <tr key={a.id} style={a.isActive ? undefined : { opacity: 0.55 }}>
                  <td className="mono text-sm">{a.code}</td>
                  <td className="text-sm"><Link href={`/accounting?tab=ledger&account=${a.id}`}>{a.name}</Link>{a.isBankAccount ? <span className="subtle text-xs"> · bank</span> : null}{a.isSystem ? <span className="subtle text-xs"> · system</span> : null}</td>
                  <td className="num">{money(Number(a.currentBalance))}</td>
                  {manage ? <td>{a.isSystem ? null : <AccountToggle accountId={a.id} active={a.isActive} />}</td> : null}
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
        );
      })}
    </div>
  );
}

async function Ledger({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const accounts = await prisma.account.findMany({ where: { tenantId: viewer.tenantId, isGroup: false }, orderBy: { code: "asc" } });
  const accountId = accounts.some((a) => a.id === sp.account) ? sp.account! : accounts.find((a) => a.code === "1100")?.id ?? accounts[0]?.id;
  const from = day(sp.from, fyStart()), to = day(sp.to, new Date());
  const l = accountId ? await accountLedger(viewer.tenantId, accountId, from, endOf(to)) : null;
  return (
    <div className="stack gap-4">
      <Card>
        <form className="row gap-2 wrap" style={{ alignItems: "flex-end" }}>
          <input type="hidden" name="tab" value="ledger" />
          <div className="field" style={{ minWidth: 260 }}><label className="label" htmlFor="lg-acc">Account</label>
            <select id="lg-acc" className="select" name="account" defaultValue={accountId}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></div>
          <div className="field"><label className="label" htmlFor="lg-from">From</label><input id="lg-from" className="input" type="date" name="from" defaultValue={iso(from)} /></div>
          <div className="field"><label className="label" htmlFor="lg-to">To</label><input id="lg-to" className="input" type="date" name="to" defaultValue={iso(to)} /></div>
          <button className="btn sm primary">Show</button>
        </form>
      </Card>
      {!l ? <Card><Empty title="No accounts yet" /></Card> : (
        <Card tight title={`${l.account.code} · ${l.account.name}`} description={`${formatDate(from)} – ${formatDate(to)}`} action={<span className="text-sm">Closing <span className="strong">{formatINR(l.closing)}</span></span>}>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Date</th><th>Entry</th><th>Narration</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
            <tbody>
              <tr><td colSpan={5} className="text-sm subtle">Opening balance</td><td className="num">{formatINR(l.opening)}</td></tr>
              {l.rows.map((r) => (
                <tr key={r.id}>
                  <td className="text-sm nowrap">{formatDate(r.entry.entryDate)}</td>
                  <td className="mono text-xs">{r.entry.entryNumber}{r.entry.status === "REVERSED" ? " ↺" : ""}</td>
                  <td className="text-sm">{r.entry.narration}{r.narration ? <span className="subtle"> · {r.narration}</span> : null}</td>
                  <td className="num">{money(r.debit)}</td><td className="num">{money(r.credit)}</td>
                  <td className="num strong">{formatINR(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {l.rows.length === 0 ? <Empty title="No postings in this period" /> : null}
        </Card>
      )}
    </div>
  );
}

async function Trial({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const to = day(sp.to, new Date());
  const tb = await trialBalance(viewer.tenantId, { to: endOf(to) });
  const ok = tb.debit === tb.credit;
  return (
    <Card tight title={`Trial balance as at ${formatDate(to)}`} description={ok ? "Debits equal credits." : "Debits and credits differ — the ledger is broken."}
      action={<form className="row gap-2"><input type="hidden" name="tab" value="trial" /><input className="input" type="date" name="to" defaultValue={iso(to)} aria-label="As at" /><button className="btn sm">Show</button></form>}>
      {tb.rows.length === 0 ? <Empty title="Nothing posted" /> : (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Code</th><th>Account</th><th>Class</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>{tb.rows.map((r) => (
            <tr key={r.id}>
              <td className="mono text-sm">{r.code}</td>
              <td className="text-sm"><Link href={`/accounting?tab=ledger&account=${r.id}&to=${iso(to)}`}>{r.name}</Link></td>
              <td className="text-xs subtle">{r.accountClass.toLowerCase()}</td>
              <td className="num">{money(r.debit)}</td><td className="num">{money(r.credit)}</td>
            </tr>
          ))}</tbody>
          <tfoot><tr><td colSpan={3} className="strong">Total {ok ? <Badge tone="success">balanced</Badge> : <Badge tone="danger">out by {formatINR(Math.abs(tb.debit - tb.credit))}</Badge>}</td><td className="num strong">{formatINR(tb.debit)}</td><td className="num strong">{formatINR(tb.credit)}</td></tr></tfoot>
        </table></div>
      )}
    </Card>
  );
}

function StatementBlock({ title, rows, total, totalLabel }: { title: string; rows: Array<{ code: string; name: string; amount: number }>; total: number; totalLabel: string }) {
  return (
    <>
      <tr><td colSpan={2} className="strong" style={{ paddingTop: 14 }}>{title}</td></tr>
      {rows.length === 0 ? <tr><td className="text-sm subtle" colSpan={2}>None</td></tr> : rows.map((r) => <tr key={r.code}><td className="text-sm" style={{ paddingLeft: 20 }}>{r.name}</td><td className="num">{formatINR(r.amount)}</td></tr>)}
      <tr><td className="text-sm strong">{totalLabel}</td><td className="num strong" style={{ borderTop: "1px solid var(--border)" }}>{formatINR(total)}</td></tr>
    </>
  );
}

async function Statements({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const from = day(sp.from, fyStart()), to = day(sp.to, new Date());
  const s = await financialStatements(viewer.tenantId, from, endOf(to));
  return (
    <div className="stack gap-4">
      <Card>
        <form className="row gap-2 wrap" style={{ alignItems: "flex-end" }}>
          <input type="hidden" name="tab" value="statements" />
          <div className="field"><label className="label" htmlFor="st-from">Profit and loss from</label><input id="st-from" className="input" type="date" name="from" defaultValue={iso(from)} /></div>
          <div className="field"><label className="label" htmlFor="st-to">to (and balance sheet at)</label><input id="st-to" className="input" type="date" name="to" defaultValue={iso(to)} /></div>
          <button className="btn sm primary">Show</button>
        </form>
      </Card>
      <div className="grid grid-2">
        <Card tight title="Profit and loss" description={`${formatDate(from)} – ${formatDate(to)}`}>
          <table className="data"><tbody>
            <StatementBlock title="Income" rows={s.pl.income} total={s.pl.totals.income} totalLabel="Total income" />
            <StatementBlock title="Expenses" rows={s.pl.expenses} total={s.pl.totals.expenses} totalLabel="Total expenses" />
            <tr><td className="strong" style={{ paddingTop: 14 }}>{s.pl.profit >= 0 ? "Profit" : "Loss"} for the period</td><td className={`num strong ${s.pl.profit >= 0 ? "pos" : "neg"}`} style={{ paddingTop: 14 }}>{formatINR(Math.abs(s.pl.profit))}</td></tr>
          </tbody></table>
        </Card>
        <Card tight title="Balance sheet" description={`As at ${formatDate(to)}`} action={s.bs.balances ? <Badge tone="success">balances</Badge> : <Badge tone="danger">does not balance</Badge>}>
          <table className="data"><tbody>
            <StatementBlock title="Assets" rows={s.bs.assets} total={s.bs.totals.assets} totalLabel="Total assets" />
            <StatementBlock title="Liabilities" rows={s.bs.liabilities} total={s.bs.totals.liabilities} totalLabel="Total liabilities" />
            <StatementBlock title="Equity" rows={[...s.bs.equity, { code: "P&L", name: s.bs.profitToDate >= 0 ? "Profit to date" : "Loss to date", amount: s.bs.profitToDate }]} total={s.bs.totals.equity + s.bs.profitToDate} totalLabel="Total equity" />
            <tr><td className="strong" style={{ paddingTop: 14 }}>Liabilities and equity</td><td className="num strong" style={{ paddingTop: 14 }}>{formatINR(s.bs.totals.liabilities + s.bs.totals.equity + s.bs.profitToDate)}</td></tr>
          </tbody></table>
        </Card>
      </div>
    </div>
  );
}

async function Periods({ viewer }: { viewer: Viewer }) {
  const periods = await prisma.accountingPeriod.findMany({ where: { tenantId: viewer.tenantId } });
  const start = fyStart();
  const now = new Date();
  const months: string[] = [];
  for (let d = new Date(start); d <= now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  const counts = await prisma.ledgerEntry.groupBy({ by: ["entryDate"], where: { tenantId: viewer.tenantId, entryDate: { gte: start } }, _count: true });
  const perMonth = new Map<string, number>();
  for (const c of counts) { const k = iso(c.entryDate).slice(0, 7); perMonth.set(k, (perMonth.get(k) ?? 0) + c._count); }
  return (
    <Card tight title="Accounting periods" description="Closing a month freezes it: no entry dated in it can be posted until it is reopened. Corrections land in the current month.">
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Month</th><th className="num">Entries</th><th>Status</th><th /></tr></thead>
        <tbody>{months.reverse().map((m) => {
          const p = periods.find((x) => x.code === m);
          return (
            <tr key={m}>
              <td className="text-sm strong">{new Date(`${m}-01T00:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}</td>
              <td className="num">{perMonth.get(m) ?? 0}</td>
              <td>{p?.isClosed ? <Badge tone="neutral">closed {p.closedAt ? formatDate(p.closedAt) : ""}</Badge> : <Badge tone="success">open</Badge>}</td>
              <td>{can(viewer, P.PERIOD_CLOSE) ? <PeriodToggle code={m} closed={!!p?.isClosed} /> : null}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </Card>
  );
}
