import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate, fyLabel, fyStartYear } from "@keka/shared";
import { previousIncomeApplies } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { EmptyState, InfoBanner } from "@/components/keka";
import { IconBriefcase } from "@/components/icons";
import { IconHistory } from "../../_components/icons";
import { PreviousIncomeForm } from "../../_components/tax-forms";
import { loadTaxPicture } from "../../_lib/data";
import { inr } from "../../_lib/rules";
import s from "../../finances.module.css";

export const metadata = { title: "Previous Income" };

/**
 * Previous Employment Details. They matter only in the financial year an
 * employee joins: the income and TDS from the employer before this one feed
 * this year's tax. Anyone who joined before the year began sees that nothing
 * is needed, as Keka shows it.
 */
export default async function PreviousIncomePage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconBriefcase />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const fyStartMonth = viewer.tenant.fyStartMonth;
  const fy = fyStartYear(new Date(), fyStartMonth);
  const [p, emp] = await Promise.all([
    loadTaxPicture(viewer, fy),
    prisma.employee.findFirst({ where: { id: viewer.employee.id, tenantId: viewer.tenantId }, select: { dateOfJoining: true, statutoryProfile: { select: { id: true } } } }),
  ]);
  const applies = !!emp && previousIncomeApplies(emp.dateOfJoining, fy, fyStartMonth);
  const prof = p.profile;
  const open = p.windows.declaration.open;
  const values = {
    previousEmployerIncome: prof?.previousEmployerIncome ?? null,
    previousEmployerTds: prof?.previousEmployerTds ?? null,
    previousEmployerPf: prof?.previousEmployerPf ?? null,
    previousEmployerPt: prof?.previousEmployerPt ?? null,
  };
  const any = Object.values(values).some((v) => v !== null && v > 0);
  const history = emp?.statutoryProfile
    ? await prisma.auditLog.findMany({
        where: { tenantId: viewer.tenantId, entityType: "EmployeeStatutoryProfile", entityId: emp.statutoryProfile.id, summary: { contains: "previous-employer" } },
        orderBy: { createdAt: "desc" }, take: 20, select: { id: true, summary: true, createdAt: true, actorId: true, actorLabel: true },
      })
    : [];

  return (
    <>
      <div className={s.titleRow}>
        <div className={s.titleLeft}>
          <h1 className={s.bigTitle}>Previous Employment Details</h1>
          <details className={s.history}>
            <summary aria-label="Previous employment history" title="History"><IconHistory width={22} height={22} /></summary>
            <div className={s.historyPanel} role="region" aria-label="Previous employment history">
              {history.length === 0 ? <div className={s.historyItem}><span className={s.muted}>No changes recorded yet.</span></div> : history.map((h) => (
                <div key={h.id} className={s.historyItem}>
                  <div>{h.summary}</div>
                  <div className={s.muted} style={{ fontSize: 12 }}>{formatDate(h.createdAt)} · {h.actorId === viewer.user.id ? "You" : h.actorLabel ?? "Payroll team"}</div>
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
      <p className={s.pageSub}>Previous Employment details are necessary for income tax computation when the employee switches the organization in the middle of the FY.</p>

      <section className={`${s.boxed} ${s.pad} ${s.mt}`} aria-label="Previous employment">
        {!applies ? (
          <div className={s.successNote}>Previous Employment Details are not required for this financial year, as you joined before it began.</div>
        ) : (
          <>
            <InfoBanner>{open ? `You joined during ${fyLabel(fy)}, so declare what your previous employer paid you this year and the tax they deducted. ${p.windows.declaration.note}` : p.windows.declaration.note}</InfoBanner>
            <div className={s.mt}>
              {open ? <PreviousIncomeForm defaults={values} /> : (
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead><tr><th scope="col">Previous employment — {fyLabel(fy)}</th><th scope="col" className={s.right}>Amount</th></tr></thead>
                    <tbody>
                      <tr><td>Income after exemptions</td><td className={`${s.right} ${s.num}`}>{inr(values.previousEmployerIncome)}</td></tr>
                      <tr><td>Income tax deducted (TDS)</td><td className={`${s.right} ${s.num}`}>{inr(values.previousEmployerTds)}</td></tr>
                      <tr><td>Provident Fund</td><td className={`${s.right} ${s.num}`}>{inr(values.previousEmployerPf)}</td></tr>
                      <tr><td>Professional tax</td><td className={`${s.right} ${s.num}`}>{inr(values.previousEmployerPt)}</td></tr>
                    </tbody>
                  </table>
                  {!any ? <div className={s.pad}><span className={s.muted}>No previous employment has been declared for this year.</span></div> : null}
                </div>
              )}
            </div>
            {any && p.result ? (
              <p className={s.capHint} style={{ fontSize: 14 }}>
                With this income your projected tax for the year is {inr(p.totalTax)}, of which {inr(p.taxPaid)} is already paid.{" "}
                <Link className={s.link} href="/finances/pay/tax">See the computation</Link>
              </p>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
