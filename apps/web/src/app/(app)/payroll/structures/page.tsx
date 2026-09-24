import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { resolveStructure, validateFormula } from "@keka/payroll";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Money, Empty, Callout } from "@/components/ui";

const P = PERMISSIONS;

/** Sample CTCs used to show what each structure actually pays out. */
const PREVIEW_CTCS = [300000, 800000, 1500000, 3000000];

export default async function StructuresPage() {
  const viewer = await requireAuth(P.SALARY_STRUCTURE_MANAGE);

  const [structures, components] = await Promise.all([
    prisma.salaryStructure.findMany({
      where: { payGroup: { tenantId: viewer.tenantId } },
      include: {
        payGroup: { select: { name: true } },
        components: {
          include: { component: true },
          orderBy: { sequence: "asc" },
        },
        _count: { select: { revisions: true } },
      },
      orderBy: [{ minAnnualCtc: "asc" }],
    }),
    prisma.salaryComponent.findMany({
      where: { tenantId: viewer.tenantId },
      orderBy: { displayOrder: "asc" },
    }),
  ]);

  return (
    <>
      <PageHead
        title="Salary structures"
        subtitle="How a CTC breaks down into components. Every formula produces a monthly amount."
      />

      <Callout tone="info" title="Formula syntax">
        Component codes go in square brackets, arithmetic follows BODMAS, and nested{" "}
        <span className="mono">IF</span> is supported. The context exposes{" "}
        <span className="mono">[CTC_ANNUAL]</span>, <span className="mono">[CTC_MONTHLY]</span>,{" "}
        every resolved component as <span className="mono">[CODE]</span> (monthly) and{" "}
        <span className="mono">[CODE_ANNUAL]</span>, plus a running{" "}
        <span className="mono">[GROSS]</span>. One component per structure may be set to{" "}
        <strong>BALANCE</strong> — it absorbs whatever is left of the CTC.
      </Callout>

      <div style={{ height: 16 }} />

      <div className="stack gap-4">
        {structures.map((s) => {
          const specs = s.components.map((sc) => ({
            code: sc.component.code,
            name: sc.component.name,
            type: sc.component.type,
            calculationType: sc.calculationType,
            formula: sc.formula,
            fixedAmount: sc.fixedAmount === null ? null : Number(sc.fixedAmount),
            percentage: sc.percentage === null ? null : Number(sc.percentage),
            percentageOf: sc.percentageOf,
            sequence: sc.sequence,
            isOutsideCtc: sc.component.isOutsideCtc,
            isLopApplicable: sc.component.isLopApplicable,
            affectsPfWage: sc.component.affectsPfWage,
            affectsEsiGross: sc.component.affectsEsiGross,
            showOnPayslip: sc.component.showOnPayslip,
            isPartOfFbp: sc.component.isPartOfFbp,
          }));

          // Preview at a CTC inside this structure's own range.
          const previewCtc = PREVIEW_CTCS.find(
            (c) => (!s.minAnnualCtc || c >= Number(s.minAnnualCtc)) &&
                   (!s.maxAnnualCtc || c <= Number(s.maxAnnualCtc)),
          ) ?? Number(s.minAnnualCtc ?? 1200000);

          const resolved = resolveStructure({
            annualCtc: previewCtc,
            components: specs,
            roundComponents: s.roundComponents,
          });

          return (
            <Card
              key={s.id}
              title={s.name}
              description={
                `${s.payGroup.name} · ${s.type.replace(/_/g, " ").toLowerCase()}` +
                (s.minAnnualCtc || s.maxAnnualCtc
                  ? ` · ₹${Number(s.minAnnualCtc ?? 0).toLocaleString("en-IN")} to ${s.maxAnnualCtc ? "₹" + Number(s.maxAnnualCtc).toLocaleString("en-IN") : "no upper limit"}`
                  : "") +
                ` · ${s._count.revisions} employee(s) on it`
              }
              action={
                <div className="row gap-2">
                  {s.isDefault ? <Badge tone="brand">Default</Badge> : null}
                  {s.isPartOfFbp ? <Badge tone="info">FBP</Badge> : null}
                  <Badge tone="neutral">TDS {s.tdsMethod.toLowerCase()}</Badge>
                </div>
              }
              tight
            >
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th className="num">Seq</th>
                      <th>Component</th>
                      <th>Type</th>
                      <th>Calculation</th>
                      <th>Flags</th>
                      <th className="num">Preview at ₹{(previewCtc / 100000).toFixed(1)}L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.components.map((sc) => {
                      const r = resolved.byCode.get(sc.component.code.toUpperCase());
                      const check = sc.formula ? validateFormula(sc.formula) : null;
                      return (
                        <tr key={sc.id}>
                          <td className="num subtle">{sc.sequence}</td>
                          <td>
                            <span className="strong">{sc.component.name}</span>
                            <span className="mono text-xs subtle"> {sc.component.code}</span>
                          </td>
                          <td className="text-sm muted">
                            {sc.component.type.replace(/_/g, " ").toLowerCase()}
                          </td>
                          <td>
                            {sc.calculationType === "BALANCE" ? (
                              <Badge tone="brand">balance of CTC</Badge>
                            ) : sc.calculationType === "FIXED" ? (
                              <span className="text-sm">fixed ₹{Number(sc.fixedAmount ?? 0).toLocaleString("en-IN")}</span>
                            ) : (
                              <span className="mono text-xs">{sc.formula ?? "—"}</span>
                            )}
                            {check && !check.valid ? (
                              <Badge tone="danger">invalid formula</Badge>
                            ) : null}
                          </td>
                          <td>
                            <span className="row gap-1 wrap">
                              {sc.component.affectsPfWage ? <Badge tone="info">PF wage</Badge> : null}
                              {sc.component.affectsEsiGross ? <Badge tone="neutral">ESI</Badge> : null}
                              {sc.component.isPartOfFbp ? <Badge tone="info">FBP</Badge> : null}
                              {sc.component.isOutsideCtc ? <Badge tone="warning">outside CTC</Badge> : null}
                              {!sc.component.isLopApplicable ? <Badge tone="neutral">no LOP</Badge> : null}
                            </span>
                          </td>
                          <td className="num strong">
                            <Money value={r?.monthly.toNumber() ?? 0} />
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="total-row">
                      <td colSpan={5}>
                        Monthly cost to company at ₹{(previewCtc / 100000).toFixed(1)}L
                      </td>
                      <td className="num">
                        <Money value={resolved.monthlyCtcValue.toNumber()} />
                      </td>
                    </tr>
                    <tr className="subtotal">
                      <td colSpan={5}>Of which gross earnings (what reaches the payslip)</td>
                      <td className="num"><Money value={resolved.monthlyGross.toNumber()} /></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {resolved.warnings.length > 0 ? (
                <div style={{ padding: 14 }}>
                  <Callout tone="warning" title="Preview warnings">
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {resolved.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </Callout>
                </div>
              ) : null}
            </Card>
          );
        })}

        <Card
          title={`Component repository (${components.length})`}
          description="Components are set up once globally, then assigned to a pay group, then included in a structure."
          tight
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Code</th><th>Name</th><th>Type</th><th>Tax treatment</th>
                  <th>Recurring</th><th>Section</th><th className="num">Annual exempt limit</th>
                </tr>
              </thead>
              <tbody>
                {components.map((c) => (
                  <tr key={c.id}>
                    <td className="mono text-xs">{c.code}</td>
                    <td>
                      <span className="strong">{c.name}</span>
                      {c.isSystem ? <Badge tone="neutral">system</Badge> : null}
                    </td>
                    <td className="text-sm muted">{c.type.replace(/_/g, " ").toLowerCase()}</td>
                    <td>
                      <Badge tone={
                        c.taxTreatment === "FULLY_EXEMPT" ? "success"
                        : c.taxTreatment === "PARTIALLY_EXEMPT" ? "info" : "warning"
                      }>
                        {c.taxTreatment.replace(/_/g, " ").toLowerCase()}
                      </Badge>
                    </td>
                    <td className="text-sm">{c.isRecurring ? "Every cycle" : "Ad-hoc"}</td>
                    <td className="mono text-xs">{c.taxSection ?? "—"}</td>
                    <td className="num">
                      {c.annualExemptLimit
                        ? <Money value={c.annualExemptLimit} />
                        : <span className="subtle">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
