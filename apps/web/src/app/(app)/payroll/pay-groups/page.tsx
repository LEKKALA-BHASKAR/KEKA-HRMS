import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, KeyValue, Callout, Empty } from "@/components/ui";

const P = PERMISSIONS;
const pc = (v: unknown) => `${Number(v ?? 0)}%`;

export default async function PayGroupsPage() {
  const viewer = await requireAuth(P.PAYGROUP_MANAGE);

  const payGroups = await prisma.payGroup.findMany({
    where: { tenantId: viewer.tenantId },
    include: {
      legalEntity: { select: { legalName: true } },
      filingDetail: true,
      payslipSetting: true,
      approvalRules: true,
      ptRegistrations: { include: { linkedLocations: { include: { location: { select: { name: true } } } } } },
      lwfRegistrations: { include: { linkedLocations: { include: { location: { select: { name: true } } } } } },
      _count: { select: { employees: true, salaryStructures: true, componentLinks: true } },
    },
    orderBy: { name: "asc" },
  });

  return (
    <>
      <PageHead
        title="Pay groups"
        subtitle="The pay group is the real segmentation unit — it carries the pay schedule, every statutory registration, and the salary structures"
      />

      <Callout tone="info" title="Why the pay group matters more than the legal entity">
        Statutory registrations (PF, ESI, state-wise PT and LWF) and income-tax filing
        details all attach here. To move an employee to another company you create a pay
        group associated with that entity and reassign them, which synchronises their
        legal entity automatically.
      </Callout>

      <div style={{ height: 16 }} />

      <div className="stack gap-4">
        {payGroups.map((g) => (
          <Card
            key={g.id}
            title={g.name}
            description={`${g.legalEntity.legalName} · ${g._count.employees} employees · ${g._count.salaryStructures} structures · ${g._count.componentLinks} components`}
            action={
              <div className="row gap-2">
                {g.pfEnabled ? <Badge tone="success">PF</Badge> : <Badge tone="neutral">PF off</Badge>}
                {g.esiEnabled ? <Badge tone="success">ESI</Badge> : <Badge tone="neutral">ESI off</Badge>}
                {g.ptEnabled ? <Badge tone="success">PT</Badge> : <Badge tone="neutral">PT off</Badge>}
                {g.lwfEnabled ? <Badge tone="success">LWF</Badge> : <Badge tone="neutral">LWF off</Badge>}
                {g.tdsEnabled ? <Badge tone="success">TDS</Badge> : <Badge tone="neutral">TDS off</Badge>}
              </div>
            }
          >
            <div className="grid grid-2" style={{ alignItems: "start" }}>
              <div>
                <div className="stat-label" style={{ marginBottom: 8 }}>Pay schedule</div>
                <KeyValue items={[
                  ["Frequency", g.frequency.toLowerCase()],
                  ["Period", `day ${g.payPeriodStartDay} to ${g.payPeriodEndDay === 0 ? "last day of month" : `day ${g.payPeriodEndDay}`}`],
                  ["Attendance cut-off", g.attendanceCutoffDay
                    ? `day ${g.attendanceCutoffDay} — LOP after this rolls to next month`
                    : "same as period end"],
                  ["Pay day", `day ${g.payDay}`],
                  ["Maker-checker", g.approvalWorkflowEnabled
                    ? `on · ${g.approvalRules.length} rule(s)`
                    : "off"],
                ]} />

                <div className="divider" />

                <div className="stat-label" style={{ marginBottom: 8 }}>Declaration &amp; proof timelines</div>
                <KeyValue items={[
                  ["Monthly window", `day ${g.declarationOpenDay} to ${g.declarationCloseDay}`],
                  ["FY cut-off", formatDate(g.declarationFyCutoff)],
                  ["New joiner window", `${g.newJoinerWindowDays} days from joining`],
                  ["Proof due", formatDate(g.proofSubmissionDue)],
                  ["Proof mandatory", g.proofMandatory ? "Yes" : "No"],
                  ["Late declarations", g.allowLateDeclaration ? "Allowed" : "Blocked after cut-off"],
                  ["Regime choice", g.allowRegimeChoice
                    ? `Employees may switch until ${formatDate(g.regimeChangeCutoff)}`
                    : "Locked by admin"],
                ]} />
              </div>

              <div>
                <div className="stat-label" style={{ marginBottom: 8 }}>Income tax filing</div>
                <KeyValue items={[
                  ["PAN", <span className="mono" key="a">{g.filingDetail?.pan ?? "—"}</span>],
                  ["TAN", <span className="mono" key="b">{g.filingDetail?.tan ?? "—"}</span>],
                  ["TAN circle", g.filingDetail?.tanCircle],
                  ["CIT (TDS)", g.filingDetail?.citTds],
                  ["Form 16 signatory", g.filingDetail?.form16SignatoryName
                    ? `${g.filingDetail.form16SignatoryName}, ${g.filingDetail.form16SignatoryDesignation}`
                    : null],
                ]} />

                <div className="divider" />

                <div className="stat-label" style={{ marginBottom: 8 }}>Provident Fund</div>
                <KeyValue items={[
                  ["Registration", <span className="mono text-sm" key="r">{g.filingDetail?.pfRegistrationNumber ?? "—"}</span>],
                  ["Wage ceiling", g.filingDetail ? `₹${Number(g.filingDetail.pfWageCeiling).toLocaleString("en-IN")}` : null],
                  ["Restrict to ceiling", g.filingDetail?.pfCapAtCeiling ? "Yes" : "No — PF on actual basic"],
                  ["Employee / employer", g.filingDetail ? `${pc(g.filingDetail.pfEmployeeRate)} / ${pc(g.filingDetail.pfEmployerRate)}` : null],
                  ["EPS", g.filingDetail ? `${pc(g.filingDetail.epsRate)} of PF wage, capped at ₹${Number(g.filingDetail.epsWageCeiling).toLocaleString("en-IN")}` : null],
                  ["EDLI + admin", g.filingDetail ? `${pc(g.filingDetail.edliRate)} + ${pc(g.filingDetail.pfAdminRate)}` : null],
                ]} />

                <div className="divider" />

                <div className="stat-label" style={{ marginBottom: 8 }}>ESI</div>
                <KeyValue items={[
                  ["Registration", <span className="mono text-sm" key="e">{g.filingDetail?.esiRegistrationNumber ?? "—"}</span>],
                  ["Wage limit", g.filingDetail ? `₹${Number(g.filingDetail.esiWageLimit).toLocaleString("en-IN")} monthly gross` : null],
                  ["Employee / employer", g.filingDetail ? `${pc(g.filingDetail.esiEmployeeRate)} / ${pc(g.filingDetail.esiEmployerRate)}` : null],
                  ["Employer share", g.filingDetail?.esiEmployerInsideCtc
                    ? "Inside CTC — deducted from annual salary"
                    : "Over and above annual salary"],
                  ["Arrears in wage base", g.filingDetail?.esiIncludeArrears ? "Included" : "Excluded"],
                ]} />
              </div>
            </div>

            <div className="divider" />

            <div className="grid grid-2" style={{ alignItems: "start" }}>
              <div>
                <div className="stat-label" style={{ marginBottom: 8 }}>
                  Professional Tax registrations ({g.ptRegistrations.length})
                </div>
                {g.ptRegistrations.length === 0 ? <Empty title="None registered" /> : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr><th>State</th><th>Establishment</th><th>Frequency</th><th>Linked locations</th></tr>
                      </thead>
                      <tbody>
                        {g.ptRegistrations.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <span className="strong">{r.stateName}</span>
                              {r.localBodyType ? <Badge tone="info">{r.localBodyType.toLowerCase()}</Badge> : null}
                            </td>
                            <td className="mono text-xs">{r.establishmentId}</td>
                            <td className="text-sm">{r.frequency.toLowerCase().replace("_", "-")}</td>
                            <td className="text-sm">
                              {r.linkedLocations.map((l) => l.location.name).join(", ") || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div>
                <div className="stat-label" style={{ marginBottom: 8 }}>
                  Labour Welfare Fund registrations ({g.lwfRegistrations.length})
                </div>
                {g.lwfRegistrations.length === 0 ? <Empty title="None registered" /> : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr><th>State</th><th>Establishment</th><th>Employer share</th><th>Linked locations</th></tr>
                      </thead>
                      <tbody>
                        {g.lwfRegistrations.map((r) => (
                          <tr key={r.id}>
                            <td className="strong">{r.stateName}</td>
                            <td className="mono text-xs">{r.establishmentId}</td>
                            <td className="text-sm">{r.employerInsideCtc ? "Inside CTC" : "Above CTC"}</td>
                            <td className="text-sm">
                              {r.linkedLocations.map((l) => l.location.name).join(", ") || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {g.approvalRules.length > 0 ? (
              <>
                <div className="divider" />
                <div className="stat-label" style={{ marginBottom: 8 }}>Approval workflow</div>
                <div className="stack gap-2">
                  {g.approvalRules.map((r) => (
                    <div key={r.id} className="row gap-2">
                      <Badge tone="brand">{r.action.replace(/_/g, " ").toLowerCase()}</Badge>
                      <span className="text-sm">{r.name}</span>
                      <span className="text-xs subtle">
                        {(r.approverRoleIds as string[]).length} level(s) — only explicit user roles appear in chains
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </Card>
        ))}
      </div>
    </>
  );
}
