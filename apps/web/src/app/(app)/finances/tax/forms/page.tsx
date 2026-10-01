import Link from "next/link";
import { prisma } from "@keka/db";
import { fyStartYear } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { EmptyState } from "@/components/keka";
import { IconFile } from "@/components/icons";
import { GhostFigure, IconDown, IconExternal } from "../../_components/icons";
import { NavSelect } from "../../_components/nav-select";
import { fySpan } from "../../_lib/rules";
import s from "../../finances.module.css";

export const metadata = { title: "Forms" };

/**
 * Forms: Form 16, as released by the payroll team for a financial year, and
 * Form 12BB, generated on demand from the employee's own declaration.
 */
export default async function TaxFormsPage({ searchParams }: { searchParams: Promise<{ f16?: string; bb?: string }> }) {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconFile />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const sp = await searchParams;
  const employeeId = viewer.employee.id;
  const fyStartMonth = viewer.tenant.fyStartMonth;
  const currentFy = fyStartYear(new Date(), fyStartMonth);
  const [emp, files, decls] = await Promise.all([
    prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { dateOfJoining: true } }),
    prisma.storedFile.findMany({
      where: { tenantId: viewer.tenantId, employeeId, relatedType: "Form16" },
      orderBy: { createdAt: "desc" }, select: { id: true, relatedId: true, createdAt: true },
    }),
    prisma.investmentDeclaration.findMany({ where: { employeeId }, select: { fyStartYear: true, _count: { select: { items: true } }, hraDetail: { select: { id: true } } }, orderBy: { fyStartYear: "desc" } }),
  ]);
  const joinedFy = fyStartYear(emp?.dateOfJoining ?? new Date(), fyStartMonth);

  // Form 16: completed years since joining, plus any year with a (provisional) file.
  const fileByFy = new Map<number, (typeof files)[number]>();
  for (const f of files) { const y = Number(f.relatedId); if (Number.isFinite(y) && !fileByFy.has(y)) fileByFy.set(y, f); }
  const f16Years = [...new Set([
    ...Array.from({ length: Math.max(0, currentFy - Math.max(joinedFy, currentFy - 5)) }, (_, i) => currentFy - 1 - i),
    ...fileByFy.keys(),
  ])].sort((a, b) => b - a);
  if (f16Years.length === 0) f16Years.push(currentFy);
  const f16 = f16Years.includes(Number(sp.f16)) ? Number(sp.f16) : f16Years[0];
  const f16File = fileByFy.get(f16) ?? null;

  // Form 12BB: years with a declaration, always including the current one.
  const bbYears = [...new Set([currentFy, ...decls.map((d) => d.fyStartYear)])].filter((y) => y <= currentFy).sort((a, b) => b - a);
  const bb = bbYears.includes(Number(sp.bb)) ? Number(sp.bb) : bbYears[0];
  const decl = decls.find((d) => d.fyStartYear === bb);
  const hasDecl = !!decl && (decl._count.items > 0 || !!decl.hraDetail);
  const q = (k: "f16" | "bb", v: number) => `/finances/tax/forms?${new URLSearchParams({ f16: String(k === "f16" ? v : f16), bb: String(k === "bb" ? v : bb) })}`;

  return (
    <div className={s.formsGrid}>
      <section className={`${s.boxed} ${s.formPanel}`} aria-label="Form 16">
        <h2 className={s.formPanelTitle}>Form 16</h2>
        <p className={s.formPanelSub}>Form 16 summarizes your salary, deductions and tax paid and is needed for filing tax returns.</p>
        <div className={s.formPanelRow}>
          <NavSelect label="Form 16 financial year" className={s.fySelectWide} value={String(f16)}
            options={f16Years.map((y) => ({ value: String(y), label: fySpan(y, fyStartMonth), href: q("f16", y) }))} />
          {f16File ? (
            <a className={`btn ${s.outlineBtn}`} href={`/files/${f16File.id}`} download>Download Form 16 <IconDown width={17} height={17} /></a>
          ) : (
            <button type="button" className={`btn ${s.outlineBtn}`} disabled>Download Form 16 <IconDown width={17} height={17} /></button>
          )}
        </div>
        {f16File ? (
          <p className={s.muted} style={{ marginTop: 18, fontSize: 14 }}>
            {f16 >= currentFy ? "Provisional: the year is not over yet. " : ""}The file opens with your PAN in capitals.
          </p>
        ) : (
          <div className={s.ghostInline}>
            <GhostFigure size={52} />
            <span>Form 16 has not been released by the admin for the selected financial year.</span>
          </div>
        )}
        <div className={s.outsideBox}>
          Received Form 16 Outside? <Link className={s.link} href="/finances/tax/tax-filing">File your ITR <IconExternal width={14} height={14} /></Link>
        </div>
      </section>

      <section className={`${s.boxed} ${s.formPanel}`} aria-label="Form 12 BB">
        <h2 className={s.formPanelTitle}>Form 12 BB</h2>
        <p className={s.formPanelSub}>Form 12BB has details about your proposed investments &amp; expenses that are tax deductible.</p>
        <div className={s.formPanelRow}>
          <NavSelect label="Form 12BB financial year" className={s.fySelectWide} value={String(bb)}
            options={bbYears.map((y) => ({ value: String(y), label: fySpan(y, fyStartMonth), href: q("bb", y) }))} />
          {hasDecl ? (
            <a className={`btn ${s.outlinePrimary}`} href={`/finances/tax/forms/12bb?fy=${bb}`} download>Download Form 12BB <IconDown width={17} height={17} /></a>
          ) : (
            <button type="button" className={`btn ${s.outlineBtn}`} disabled>Download Form 12BB <IconDown width={17} height={17} /></button>
          )}
        </div>
        {!hasDecl ? (
          <p className={s.muted} style={{ marginTop: 18, fontSize: 14 }}>
            You have not declared any investments for this year. <Link className={s.link} href={`/finances/tax?fy=${bb}`}>Declare now</Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}
