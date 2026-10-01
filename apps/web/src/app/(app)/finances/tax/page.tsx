import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate, formatINR, fyLabel, MONTH_SHORT } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { Chip, EmptyState, Notice } from "@/components/keka";
import { IconReceipt } from "@/components/icons";
import { IconHistory } from "../_components/icons";
import { NavSelect } from "../_components/nav-select";
import { RegimeBanner } from "../_components/regime-banner";
import { TaxFigures } from "../_components/tax-figures";
import { AddDeclarationForm, ProofUploadForm, RemoveDeclarationButton, RentForm } from "../_components/tax-forms";
import { financialYears, loadTaxPicture, pickFy, type TaxPicture } from "../_lib/data";
import {
  DECL_TABS, SECTION_BY_KEY, fySpan, inr, roomLeft, sectionAllowed, sectionName, LANDLORD_PAN_THRESHOLD, type DeclTab, type TabKey,
} from "../_lib/rules";
import s from "../finances.module.css";

export const metadata = { title: "Declaration" };

const n = (v: unknown) => Number(v ?? 0);
const PROOF_LABEL: Record<string, string> = { NOT_SUBMITTED: "Not submitted", SUBMITTED: "Under review", APPROVED: "Accepted", REJECTED: "Rejected" };
const TAB_INTRO: Record<Exclude<TabKey, "summary">, string> = {
  "80c": "Investments and payments under sections 80C, 80CCC and 80CCD(1), which together are capped at INR 1,50,000 a year.",
  other: "Other Chapter VI-A deductions: NPS, health insurance, education-loan interest, donations and more.",
  allowances: "Exemptions on allowances you receive. Declare the rent you pay to claim the House Rent Allowance exemption.",
  house: "Interest on a home loan. For a self-occupied home the set-off is capped at INR 2,00,000 a year.",
  income: "Income you earn outside this job, and tax already deducted on it, so the tax on your salary accounts for it.",
};

type Item = NonNullable<TaxPicture["declaration"]>["items"][number];

function tabStats(tab: DeclTab, items: Item[], p: TaxPicture) {
  if (tab.key === "allowances") {
    const rent = n(p.declaration?.hraDetail?.annualRent);
    return { count: rent > 0 ? 1 : 0, declared: rent, proofs: 0, rejected: 0, accepted: 0 };
  }
  const rows = items.filter((i) => tab.sections.includes(i.section));
  const reviewed = rows.filter((i) => i.proofStatus === "APPROVED" || i.proofStatus === "REJECTED");
  return {
    count: rows.length,
    declared: rows.reduce((a, i) => a + n(i.declaredAmount), 0),
    proofs: rows.filter((i) => i.proofStatus !== "NOT_SUBMITTED").length,
    rejected: reviewed.reduce((a, i) => a + Math.max(0, n(i.declaredAmount) - n(i.approvedAmount)), 0),
    accepted: reviewed.reduce((a, i) => a + n(i.approvedAmount), 0),
  };
}

export default async function DeclarationPage({ searchParams }: { searchParams: Promise<{ fy?: string; tab?: string }> }) {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconReceipt />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const sp = await searchParams;
  const years = await financialYears(viewer);
  const fy = pickFy(sp.fy, years);
  const p = await loadTaxPicture(viewer, fy);
  const tab: TabKey = DECL_TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "summary";
  const items = p.declaration?.items ?? [];
  const fyStartMonth = viewer.tenant.fyStartMonth;
  const fyQ = fy === p.currentFy ? "" : `fy=${fy}&`;
  const tabHref = (k: TabKey) => (k === "summary" ? `/finances/tax${fyQ ? `?${fyQ.slice(0, -1)}` : ""}` : `/finances/tax?${fyQ}tab=${k}`);

  const history = p.declaration
    ? await prisma.auditLog.findMany({
        where: { tenantId: viewer.tenantId, entityType: "InvestmentDeclaration", entityId: p.declaration.id },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, summary: true, createdAt: true, actorId: true, actorLabel: true },
      })
    : [];

  const win = p.windows;
  const statusChip = (open: boolean) => (
    <span className={s.status}>
      <span className={s.statusDot} style={{ background: open ? "#5cb85c" : "#ef5350" }} aria-hidden="true" />
      <Chip kind={open ? "open" : "closed"}>{open ? "Open" : "Closed"}</Chip>
    </span>
  );

  return (
    <>
      <div className={s.titleRow}>
        <div className={s.titleLeft}>
          <h1 className={s.bigTitle}>Declaration</h1>
          <details className={s.history}>
            <summary aria-label="Declaration history" title="Declaration history"><IconHistory width={22} height={22} /></summary>
            <div className={s.historyPanel} role="region" aria-label="Declaration history">
              {history.length === 0 ? <div className={s.historyItem}><span className={s.muted}>No changes recorded for {fyLabel(fy)} yet.</span></div> : history.map((h) => (
                <div key={h.id} className={s.historyItem}>
                  <div>{h.summary}</div>
                  <div className={s.muted} style={{ fontSize: 12 }}>
                    {formatDate(h.createdAt)} · {h.actorId === viewer.user.id ? "You" : h.actorLabel ?? "Payroll team"}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
        <NavSelect label="Financial year" className={s.fySelect} value={String(fy)}
          options={years.map((y) => ({ value: String(y), label: fySpan(y, fyStartMonth), href: `/finances/tax?fy=${y}` }))} />
      </div>

      <div className={s.mt}><RegimeBanner regime={p.regime} canSwitch={p.regimeSwitch.allowed} fy={fy} /></div>

      <div className={s.windows}>
        <section className={`${s.boxed} ${s.windowCard}`} aria-label="Investment declaration window">
          <div className={s.windowHead}><h2 className={s.windowTitle}>Investment Declaration</h2>{statusChip(win.declaration.open)}</div>
          {win.declaration.open && win.declaration.rows?.length ? (
            <div className={s.windowRows}>
              {win.declaration.rows.map(([k, v]) => <div key={k} className={s.windowMeta}><span className={s.muted}>{k}</span><span>{v}</span></div>)}
            </div>
          ) : <p className={s.windowNote}>{win.declaration.note}</p>}
        </section>
        <section className={`${s.boxed} ${s.windowCard}`} aria-label="Proof submission window">
          <div className={s.windowHead}><h2 className={s.windowTitle}>Proof Submission</h2>{statusChip(win.proof.open)}</div>
          {win.proof.open && win.proof.till ? (
            <div className={s.windowMeta}><span className={s.muted}>Current Window</span><span>Till {formatDate(win.proof.till)}</span></div>
          ) : <p className={s.windowNote}>{win.proof.note}</p>}
        </section>
      </div>

      {p.result ? <TaxFigures p={p} computationHref={`/finances/pay/tax?fy=${fy}`} /> : (
        <div className={s.mt}>
          <Notice>{!p.payGroup ? "You are not in a pay group yet, so no tax is being computed." : p.missingTables ? `Income-tax slabs for ${fyLabel(fy)} have not been set up yet.` : "Income tax is not deducted through payroll for your pay group."}</Notice>
        </div>
      )}

      <nav className={s.innerTabs} aria-label="Declaration sections">
        {[{ key: "summary" as TabKey, label: "My Declarations" }, ...DECL_TABS].map((t) => (
          <Link key={t.key} href={tabHref(t.key)} scroll={false}
            className={`${s.innerTab}${tab === t.key ? ` ${s.innerTabActive}` : ""}`} aria-current={tab === t.key ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "summary" ? <Summary p={p} items={items} tabHref={tabHref} /> : (
        <SectionTab tab={DECL_TABS.find((t) => t.key === tab)!} p={p} items={items} />
      )}
    </>
  );
}

function Summary({ p, items, tabHref }: { p: TaxPicture; items: Item[]; tabHref: (k: TabKey) => string }) {
  return (
    <>
      <div className={s.sectionHead}>
        <h2>My Declarations</h2>
        <p>Below are the declarations done by you under various sections.</p>
      </div>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Declarations</th><th scope="col">Number of Declarations</th><th scope="col">Amount Declared</th>
              <th scope="col">Proof Submitted</th><th scope="col">Amount Rejected</th><th scope="col">Amount Accepted</th>
            </tr>
          </thead>
          <tbody>
            {DECL_TABS.map((t) => {
              const st = tabStats(t, items, p);
              return (
                <tr key={t.key}>
                  <td><Link className={s.link} href={tabHref(t.key)} style={{ fontWeight: 400 }}>{t.rowLabel}</Link></td>
                  <td>{st.count}</td>
                  <td className={s.num}>{inr(st.declared)}</td>
                  <td>{st.proofs}</td>
                  <td className={s.num}>{inr(st.rejected)}</td>
                  <td className={s.num}>{inr(st.accepted)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={s.sectionHead} style={{ marginTop: 40 }}>
        <h2>Monthly Tax Deduction Details</h2>
        <p>Below deductions are based on your declared amount. Tax amount may change based on the amount approved.</p>
      </div>
      <div className={s.boxed}>
        <div className={s.taxTotals}>
          <div className="k-field"><div className="k-field-label">Total Tax Payable</div><div className="k-field-value">{inr(p.totalTax)}</div></div>
          <div className="k-field"><div className="k-field-label">Tax Paid Till Now</div><div className="k-field-value">{inr(p.taxPaid)}</div></div>
          <div className="k-field"><div className="k-field-label">Remaining Tax Amount</div><div className="k-field-value">{inr(p.remaining)}</div></div>
        </div>
        <div style={{ overflowX: "auto", borderTop: "1px solid var(--border)" }}>
          <table className={`${s.table} ${s.monthTable}`}>
            <thead>
              <tr>
                <th scope="col">Month</th>
                {p.previousTds > 0 ? (
                  <th scope="col"><span className={s.monthCell}><span>Previous<br />employer</span><span className={`${s.dot} ${s.dotPrevious}`} aria-hidden="true" /></span></th>
                ) : null}
                {p.months.map((m) => (
                  <th scope="col" key={`${m.year}-${m.month}`}>
                    <span className={s.monthCell}>
                      <span>{MONTH_SHORT[m.month - 1].toUpperCase()}<br />{m.year}</span>
                      {m.kind === "projected" ? <span className={`${s.dot} ${s.dotProjected}`} title="Projected" aria-label="projected" /> : null}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" style={{ textTransform: "none", letterSpacing: 0, fontSize: 14.5, fontWeight: 400, color: "var(--text)" }}>Monthly Total Tax</th>
                {p.previousTds > 0 ? <td className={s.num}>{inr(p.previousTds)}</td> : null}
                {p.months.map((m) => (
                  <td key={`${m.year}-${m.month}`} className={s.num}>{m.kind === "none" ? <span className={s.muted}>—</span> : inr(m.tds)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <div className={s.legend}>
          <span><span className={`${s.dot} ${s.dotPrevious}`} aria-hidden="true" />Tax Deduction from previous employer</span>
          <span><span className={`${s.dot} ${s.dotProjected}`} aria-hidden="true" />Tax deduction from projected salary</span>
          <span className={s.muted}>Months without a mark were deducted from processed salary.</span>
        </div>
      </div>
    </>
  );
}

function SectionTab({ tab, p, items }: { tab: DeclTab; p: TaxPicture; items: Item[] }) {
  const declOpen = p.windows.declaration.open;
  const proofOpen = p.windows.proof.open;
  const rows = items.filter((i) => tab.sections.includes(i.section));
  const allowed = tab.sections.filter((x) => sectionAllowed(x, p.regime));
  const existing = items.map((i) => ({ section: i.section, declaredAmount: n(i.declaredAmount) }));
  const newRegimeBlocked = p.regime === "NEW" && (tab.key === "allowances" ? true : allowed.length === 0);

  return (
    <>
      <div className={s.sectionHead}>
        <h2>{tab.label}</h2>
        <p>{TAB_INTRO[tab.key as Exclude<TabKey, "summary">]}</p>
      </div>

      {newRegimeBlocked ? (
        <div style={{ marginBottom: 18 }}>
          <Notice>These are not available under the New Tax Regime, so they do not reduce your tax. Switch to the Old Tax Regime from Income Tax to claim them.</Notice>
        </div>
      ) : p.regime === "NEW" && allowed.length < tab.sections.length ? (
        <div style={{ marginBottom: 18 }}>
          <Notice>Under the New Tax Regime only {allowed.map(sectionName).join(", ")} can be declared here.</Notice>
        </div>
      ) : null}

      {tab.key === "allowances" ? <Allowances p={p} declOpen={declOpen && !newRegimeBlocked} /> : (
        <>
          {rows.length === 0 ? (
            <div className={s.boxed}>
              <EmptyState title={`No ${tab.rowLabel.toLowerCase()} declared`}>
                {declOpen && !newRegimeBlocked ? "Add a declaration below." : "Nothing was declared under these sections for this year."}
              </EmptyState>
            </div>
          ) : (
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th scope="col">Section</th><th scope="col">Declaration</th><th scope="col" className={s.right}>Amount Declared</th>
                    <th scope="col">Proof</th><th scope="col" className={s.right}>Amount Accepted</th>
                    {declOpen ? <th scope="col"><span className="sr-only">Actions</span></th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => {
                    const label = `${sectionName(i.section)} — ${i.category}`;
                    const reviewed = i.proofStatus === "APPROVED" || i.proofStatus === "REJECTED";
                    return (
                      <tr key={i.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{sectionName(i.section)}</td>
                        <td>
                          {i.category}
                          <div className={s.muted} style={{ fontSize: 12.5 }}>{i.description ?? SECTION_BY_KEY.get(i.section)?.label}</div>
                        </td>
                        <td className={`${s.right} ${s.num}`}>{formatINR(n(i.declaredAmount), false)}</td>
                        <td>
                          <div className={s.proofCell}>
                            <span className={s[`status_${i.proofStatus}`]}>{PROOF_LABEL[i.proofStatus] ?? i.proofStatus}</span>
                            {i.proofFileUrl?.startsWith("/files/") ? <a className={s.link} href={i.proofFileUrl}>View proof</a> : null}
                          </div>
                          {i.proofRemark ? <div className={s.muted} style={{ fontSize: 12.5 }}>{i.proofRemark}</div> : null}
                          {proofOpen && i.proofStatus !== "APPROVED" ? (
                            <div style={{ marginTop: 6 }}><ProofUploadForm itemId={i.id} label={label} replace={i.proofStatus !== "NOT_SUBMITTED"} /></div>
                          ) : null}
                        </td>
                        <td className={`${s.right} ${s.num}`}>{reviewed ? formatINR(n(i.approvedAmount), false) : <span className={s.muted}>—</span>}</td>
                        {declOpen ? (
                          <td className={s.right}>{i.proofStatus !== "APPROVED" ? <RemoveDeclarationButton itemId={i.id} label={label} /> : null}</td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {declOpen && allowed.length > 0 ? (() => {
            const open = allowed
              .map((x) => ({ x, room: roomLeft(x, existing, p.age) }))
              .filter((o) => o.room === null || o.room > 0);
            return open.length === 0 ? (
              <div className={s.mt}><Notice>You have declared the full amount allowed under {allowed.map(sectionName).join(", ")} for this year.</Notice></div>
            ) : (
              <AddDeclarationForm
                sections={open.map((o) => ({ value: o.x, name: sectionName(o.x), label: SECTION_BY_KEY.get(o.x)!.label, room: o.room === null ? "no limit" : `${inr(o.room)} left` }))}
                hint={tab.key === "income" ? "Income from other sources adds to your taxable income; TDS/TCS already deducted on it counts towards tax already paid." : undefined}
              />
            );
          })() : null}
        </>
      )}
    </>
  );
}

function Allowances({ p, declOpen }: { p: TaxPicture; declOpen: boolean }) {
  const h = p.declaration?.hraDetail ?? null;
  const rent = h ? (h.annualRent !== null ? n(h.annualRent) : Object.values((h.monthlyRent ?? {}) as Record<string, unknown>).reduce<number>((a, v) => a + n(v), 0)) : 0;
  return (
    <>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr><th scope="col">Allowance</th><th scope="col" className={s.right}>Rent Declared</th><th scope="col">Landlord</th><th scope="col" className={s.right}>Exemption (projected)</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>House Rent Allowance — s.10(13A){h?.isMetro ? <span className={s.muted}> · metro</span> : null}</td>
              <td className={`${s.right} ${s.num}`}>{rent > 0 ? formatINR(rent, false) : <span className={s.muted}>—</span>}</td>
              <td>{h?.landlordName ?? <span className={s.muted}>—</span>}{h?.landlordPan ? <div className={s.muted} style={{ fontSize: 12.5 }}>PAN on record</div> : null}</td>
              <td className={`${s.right} ${s.num}`}>{p.regime === "OLD" ? formatINR(p.hraExemption, false) : <span className={s.muted}>Not available</span>}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {declOpen ? (
        <div className={s.mt}>
          <RentForm defaults={{
            annualRent: rent || null, isMetro: h?.isMetro ?? false, landlordName: h?.landlordName ?? null,
            landlordPan: h?.landlordPan ?? null, rentAddress: h?.rentAddress ?? null,
          }} />
          <div className={s.capHint}>The exemption is the least of the HRA you receive, rent paid less 10% of basic, and 50% (metro) or 40% of basic. Landlord PAN is required above {inr(LANDLORD_PAN_THRESHOLD)} a year.</div>
        </div>
      ) : null}
    </>
  );
}
