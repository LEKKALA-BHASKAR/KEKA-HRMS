"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useForm, FormBanner } from "@/components/form";
import { applyLoanAction } from "@/app/actions/loans";
import { previewLoanAction, type LoanPreview } from "@/app/actions/finances";
import { DialogButton } from "./dialog";
import { IconDoc } from "./icons";
import { inr0, monthShort } from "./fmt";
import s from "../finances.module.css";

interface Month { year: number; month: number }
const mk = (m: Month) => `${m.year}-${String(m.month).padStart(2, "0")}`;

/** Apply New Loan: the drawer with live total repayment and EMI. */
export function ApplyLoanButton({ categories, months }: { categories: Array<{ id: string; label: string }>; months: Month[] }) {
  return (
    <DialogButton label="Apply New Loan" title="Apply New Loan" openParam="apply" className={`btn primary ${s.applyBtn}`}>
      {(close) => <ApplyLoanForm categories={categories} months={months} onDone={close} />}
    </DialogButton>
  );
}

function ApplyLoanForm({ categories, months, onDone }: { categories: Array<{ id: string; label: string }>; months: Month[]; onDone: () => void }) {
  const [state, action, pending] = useForm(applyLoanAction);
  const [form, setForm] = useState({ categoryId: "", amount: "", expectedMonth: "", startMonth: "", installments: "", purpose: "" });
  const [preview, setPreview] = useState<LoanPreview | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [, startTransition] = useTransition();
  const seq = useRef(0);

  useEffect(() => {
    if (!form.categoryId) { setPreview(null); return; }
    const id = ++seq.current;
    const t = setTimeout(() => {
      startTransition(async () => {
        const p = await previewLoanAction({ categoryId: form.categoryId, amount: Number(form.amount), installments: Number(form.installments), start: form.startMonth || null });
        if (id === seq.current) setPreview(p);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [form.categoryId, form.amount, form.installments, form.startMonth]);
  useEffect(() => { if (state.ok) { const t = setTimeout(onDone, 900); return () => clearTimeout(t); } }, [state, onDone]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    const v = e.target.value;
    setForm((f) => {
      const next = { ...f, [k]: v };
      // EMIs start no earlier than the money is paid out.
      if (k === "expectedMonth" && v && (!f.startMonth || f.startMonth < v)) next.startMonth = v;
      return next;
    });
  };
  const startOptions = months.filter((m) => !form.expectedMonth || mk(m) >= form.expectedMonth);
  const err = state.errors ?? {};

  return (
    <form action={action} className={s.dlgForm}>
      <input type="hidden" name="intent" value="apply" />
      <FormBanner state={state} />
      <div className={s.fld}>
        <label className="label" htmlFor="loan-cat">Loan Category</label>
        <select id="loan-cat" name="categoryId" className={`select ${s.halfInput}`} value={form.categoryId} onChange={set("categoryId")} required>
          <option value="">Select Category</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {err.categoryId ? <div className={s.fldErr}>{err.categoryId}</div> : null}
      </div>
      <div className={s.formCols}>
        <div className={s.fld}>
          <label className="label" htmlFor="loan-amount">Loan Amount</label>
          <div className={s.prefixInput}>
            <span>INR</span>
            <input id="loan-amount" name="amount" type="number" className="input num" min={1000} step="1" placeholder="Loan Amount" value={form.amount} onChange={set("amount")} required />
          </div>
          {err.amount ? <div className={s.fldErr}>{err.amount}</div> : preview?.maxAmount ? <div className="hint">Up to {inr0(preview.maxAmount)}</div> : null}
        </div>
        <div className={s.fld}>
          <label className="label" htmlFor="loan-expected">Expected Month (Payroll Month)</label>
          <select id="loan-expected" name="expectedMonth" className="select" value={form.expectedMonth} onChange={set("expectedMonth")} required>
            <option value="" />
            {months.map((m) => <option key={mk(m)} value={mk(m)}>{monthShort(m.year, m.month)}</option>)}
          </select>
          {err.expectedMonth ? <div className={s.fldErr}>{err.expectedMonth}</div> : null}
        </div>
        <div className={s.fld}>
          <label className="label" htmlFor="loan-start">EMI Starts From (Payroll Month)</label>
          <select id="loan-start" name="startMonth" className="select" value={form.startMonth} onChange={set("startMonth")} required>
            <option value="" />
            {startOptions.map((m) => <option key={mk(m)} value={mk(m)}>{monthShort(m.year, m.month)}</option>)}
          </select>
          {err.startMonth ? <div className={s.fldErr}>{err.startMonth}</div> : null}
        </div>
        <div className={s.fld}>
          <label className="label" htmlFor="loan-term">Repayment Term (Months)</label>
          <input id="loan-term" name="installments" type="number" className="input num" min={1} max={preview?.maxInstallments || 120} step="1" placeholder="Provide repayment count" value={form.installments} onChange={set("installments")} required />
          {err.installments ? <div className={s.fldErr}>{err.installments}</div> : preview?.maxInstallments ? <div className="hint">At most {preview.maxInstallments} months · {preview.interestNote}</div> : null}
        </div>
      </div>
      <div className={s.fld}>
        <label className="label" htmlFor="loan-note">Note</label>
        <input id="loan-note" name="purpose" className="input" maxLength={500} placeholder="Provide the note for applying loan" value={form.purpose} onChange={set("purpose")} />
      </div>
      <div className={s.fld}>
        <label className="label" htmlFor="loan-doc">Supporting document</label>
        <input id="loan-doc" name="document" type="file" accept="application/pdf,image/png,image/jpeg" className="text-xs" />
        <div className="hint">Required for some loan types (quotation, medical estimate).</div>
      </div>

      <div className={s.loanTiles}>
        <div className={s.loanTile}><div className={s.loanTileLabel}>Total Repayment Amount</div><div className={s.loanTileValue}>{inr0(preview?.total ?? 0)}</div></div>
        <div className={s.loanTile}><div className={s.loanTileLabel}>EMI</div><div className={s.loanTileValue}>{inr0(preview?.emi ?? 0)}</div></div>
      </div>
      {preview && preview.schedule.length ? (
        <button type="button" className={s.linkBtn} onClick={() => setShowSchedule((v) => !v)} aria-expanded={showSchedule}>{showSchedule ? "Hide details" : "View details"}</button>
      ) : null}
      {showSchedule && preview?.schedule.length ? (
        <div className={s.tableWrap} style={{ marginTop: 10 }}>
          <table className={`${s.table} ${s.compact}`}>
            <thead><tr><th scope="col">#</th><th scope="col">Month</th><th scope="col" className={s.right}>Principal</th><th scope="col" className={s.right}>Interest</th><th scope="col" className={s.right}>EMI</th><th scope="col" className={s.right}>Balance</th></tr></thead>
            <tbody>
              {preview.schedule.map((r) => (
                <tr key={r.sequence}>
                  <td>{r.sequence}</td><td>{monthShort(r.year, r.month)}</td>
                  <td className={`${s.right} ${s.num}`}>{inr0(r.principal)}</td><td className={`${s.right} ${s.num}`}>{inr0(r.interest)}</td>
                  <td className={`${s.right} ${s.num}`}>{inr0(r.total)}</td><td className={`${s.right} ${s.num}`}>{inr0(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {preview && preview.reasons.length ? <div className={s.reasonNote} role="alert">{preview.reasons.join(" ")}</div> : null}
      <div className={s.approverNote}>Final loan approval decision, including loan amount and tenure, will be taken by the approver.</div>

      <div className={s.dlgFormFoot}>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? "Applying…" : "Apply"}</button>
      </div>
    </form>
  );
}

export interface PolicyView {
  name: string;
  description: string | null;
  eligibility: string[];
  categories: Array<{ id: string; name: string; code: string | null; description: string | null; limit: string | null; limitNote: string | null; interest: { rate: string; kind: string }; maxInstallments: number }>;
}

/** The 📄 beside "Loan Summary": Loan Policy Explanation, full screen. */
export function LoanPolicyButton({ policy }: { policy: PolicyView | null }) {
  const [tab, setTab] = useState<"details" | "categories">("details");
  return (
    <DialogButton label={<IconDoc width={22} height={22} />} title="Loan Policy Explanation" size="full" className={s.iconLink} ariaLabel="View Loan Policy" tooltip="View Loan Policy">
      {() => (
        <div>
          <div className={s.dlgTabs} role="tablist">
            {(["details", "categories"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={`${s.dlgTab}${tab === t ? ` ${s.dlgTabActive}` : ""}`} onClick={() => setTab(t)}>
                {t === "details" ? "Policy Details" : "Loan Categories"}
              </button>
            ))}
          </div>
          {!policy ? <p className={s.muted} style={{ padding: "24px 0" }}>No loan policy has been set up yet.</p> : tab === "details" ? (
            <div className={s.policyBody}>
              <h3 className={s.policyHeading}>Policy Details</h3>
              <div className="k-field"><div className="k-field-label">Policy Name</div><div className="k-field-value">{policy.name}</div></div>
              {policy.description ? <p className={s.muted} style={{ marginTop: 8 }}>{policy.description}</p> : null}
              <h3 className={s.policyHeading} style={{ marginTop: 28 }}>Loan Eligibility</h3>
              <ul className={s.policyList}>{policy.eligibility.map((l) => <li key={l}>{l}</li>)}</ul>
            </div>
          ) : (
            <div className={s.policyBody}>
              <h3 className={s.policyHeading}>Loan Categories</h3>
              <div className={s.boxed}>
                <div className={s.tableScroll}>
                  <table className={`${s.table} ${s.flatTable}`}>
                    <thead><tr><th scope="col">Loan Category</th><th scope="col">Loan Limit</th><th scope="col">Default Rate of Interest</th><th scope="col">Maximum Installments</th></tr></thead>
                    <tbody>
                      {policy.categories.map((c) => (
                        <tr key={c.id}>
                          <td><div className={s.catCell}><span className={s.catIcon} aria-hidden="true">{c.name.slice(0, 1)}</span><div>{c.name}{c.code ? ` | ${c.code}` : ""}{c.description ? <div className={s.muted} style={{ fontSize: 13 }}>{c.description}</div> : null}</div></div></td>
                          <td>{c.limit ?? (c.limitNote ? "" : "No Limit")}{c.limitNote ? <div className={c.limit ? s.muted : undefined} style={c.limit ? { fontSize: 13 } : undefined}>{c.limitNote}</div> : null}</td>
                          <td>{c.interest.rate}<div className={s.muted} style={{ fontSize: 13 }}>{c.interest.kind}</div></td>
                          <td>{c.maxInstallments} Months</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className={s.pager}><span>{policy.categories.length ? `1 to ${policy.categories.length} of ${policy.categories.length}` : "0 to 0 of 0"}</span><span className={s.pagerArrows} aria-hidden="true">|‹ ‹</span><span>Page 1 of 1</span><span className={s.pagerArrows} aria-hidden="true">› ›|</span></div>
              </div>
            </div>
          )}
        </div>
      )}
    </DialogButton>
  );
}
