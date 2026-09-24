import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { formatDate, formatPeriod, fyStartYear, fyLabel } from "@keka/shared";
import { resolveStructure } from "@keka/payroll";
import { requireViewer, can } from "@/lib/context";
import {
  PageHead, Card, Avatar, StatusBadge, Money, KeyValue, Badge, Empty, Progress, Callout,
  AccessDenied,
} from "@/components/ui";

const P = PERMISSIONS;

const TABS = [
  "about", "profile", "job", "time", "documents",
  "assets", "finances", "expenses", "performance",
] as const;
type Tab = (typeof TABS)[number];

export default async function EmployeePage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const viewer = await requireViewer();
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const tab = (TABS.includes(rawTab as Tab) ? rawTab : "about") as Tab;

  const employee = await prisma.employee.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      user: { select: { email: true, lastLoginAt: true, loginDisabled: true, twoFactor: true } },
      department: true, businessUnit: true, location: true, legalEntity: true,
      costCenter: true, band: true, payGrade: true, workerType: true,
      payGroup: { include: { filingDetail: true } },
      reportingManager: { select: { id: true, displayName: true, jobTitleName: true } },
      directReports: {
        select: { id: true, displayName: true, jobTitleName: true, employeeNumber: true, status: true },
        orderBy: { firstName: "asc" },
      },
      addresses: true, experiences: true, educations: true,
      identityDocs: true, emergencyContacts: true, dependents: true,
      bankAccounts: true,
      statutoryProfile: true,
      jobHistory: { orderBy: { effectiveFrom: "desc" }, include: { jobTitle: true } },
      salaryRevisions: {
        orderBy: { effectiveFrom: "desc" },
        include: {
          structure: { include: { components: { include: { component: true } } } },
        },
      },
      payslips: { orderBy: [{ year: "desc" }, { month: "desc" }], take: 12 },
      loans: { include: { category: true }, orderBy: { requestedAt: "desc" } },
      exitRecord: true,
    },
  });

  if (!employee) notFound();

  // Authorisation on the specific record, not just the permission in general.
  const target = {
    id: employee.id,
    departmentId: employee.departmentId,
    locationId: employee.locationId,
    legalEntityId: employee.legalEntityId,
    businessUnitId: employee.businessUnitId,
    reportingManagerId: employee.reportingManagerId,
  };
  if (!canAccessEmployee(viewer, target, P.EMPLOYEE_VIEW)) {
    return <AccessDenied permission={P.EMPLOYEE_VIEW} what="this employee record" />;
  }

  const isSelf = viewer.employee?.id === employee.id;
  const showFinancials = isSelf || canAccessEmployee(viewer, target, P.EMPLOYEE_VIEW_FINANCIALS);

  const name = employee.displayName ?? `${employee.firstName} ${employee.lastName}`;
  const currentSalary = employee.salaryRevisions[0] ?? null;
  const pan = employee.identityDocs.find((d) => d.type === "PAN")?.number ?? null;

  const resolved = showFinancials && currentSalary?.structure
    ? resolveStructure({
        annualCtc: Number(currentSalary.annualCtc),
        components: currentSalary.structure.components.map((sc) => ({
          code: sc.component.code,
          name: sc.component.name,
          type: sc.component.type,
          calculationType: sc.calculationType,
          formula: sc.formula,
          fixedAmount: sc.fixedAmount ? Number(sc.fixedAmount) : null,
          percentage: sc.percentage ? Number(sc.percentage) : null,
          percentageOf: sc.percentageOf,
          sequence: sc.sequence,
          isOutsideCtc: sc.component.isOutsideCtc,
          isLopApplicable: sc.component.isLopApplicable,
          affectsPfWage: sc.component.affectsPfWage,
          affectsEsiGross: sc.component.affectsEsiGross,
          showOnPayslip: sc.component.showOnPayslip,
          isPartOfFbp: sc.component.isPartOfFbp,
        })),
        roundComponents: currentSalary.structure.roundComponents,
      })
    : null;

  const tabHref = (t: Tab) => `/employees/${employee.id}?tab=${t}`;

  return (
    <>
      <PageHead
        title={
          <span className="row gap-3">
            <Avatar name={name} size="lg" />
            <span>
              {name}
              <span style={{ display: "block", fontSize: 13.5, fontWeight: 400, color: "var(--text-muted)", marginTop: 2 }}>
                {employee.jobTitleName ?? "—"} · {employee.department?.name ?? "—"}
              </span>
            </span>
          </span>
        }
        actions={
          <>
            <StatusBadge status={employee.status} />
            {can(viewer, P.EMPLOYEE_UPDATE) ? <button className="btn">Edit</button> : null}
          </>
        }
      />

      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t} href={tabHref(t)} className={`tab${tab === t ? " active" : ""}`}>
            {t[0].toUpperCase() + t.slice(1)}
          </Link>
        ))}
      </div>

      {/* ---------------------------------------------------------------- */}
      {tab === "about" ? (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <Card title="Primary details">
            <KeyValue items={[
              ["Employee number", <span className="mono" key="n">{employee.employeeNumber}</span>],
              ["Work email", employee.workEmail],
              ["Mobile", employee.mobile],
              ["Date of birth", formatDate(employee.dateOfBirth)],
              ["Gender", employee.gender?.toLowerCase()],
              ["Marital status", employee.maritalStatus?.toLowerCase()],
              ["Nationality", employee.nationality],
              ["Blood group", employee.bloodGroup?.replace("_", " ")],
            ]} />
          </Card>

          <Card title="Employment">
            <KeyValue items={[
              ["Date of joining", formatDate(employee.dateOfJoining)],
              ["Confirmation", formatDate(employee.confirmationDate)],
              ["Legal entity", employee.legalEntity?.legalName],
              ["Business unit", employee.businessUnit?.name],
              ["Department", employee.department?.name],
              ["Location", employee.location ? `${employee.location.name} (${employee.location.stateCode})` : null],
              ["Worker type", employee.workerType?.name],
              ["Reports to", employee.reportingManager
                ? <Link key="m" href={`/employees/${employee.reportingManager.id}`}>{employee.reportingManager.displayName}</Link>
                : null],
            ]} />
          </Card>

          <Card title="Profile completion">
            <div className="stack gap-2">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="text-sm muted">Completeness</span>
                <span className="strong num">{employee.profileCompletion}%</span>
              </div>
              <Progress
                value={employee.profileCompletion}
                tone={employee.profileCompletion >= 90 ? "success" : "warning"}
              />
              <div className="text-sm muted">
                {employee.profileCompletion >= 90
                  ? "All mandatory fields are filled."
                  : "Some mandatory fields are still missing."}
              </div>
            </div>
          </Card>

          {employee.directReports.length > 0 ? (
            <Card title={`Direct reports (${employee.directReports.length})`}>
              <div className="stack gap-2">
                {employee.directReports.map((r) => (
                  <Link key={r.id} href={`/employees/${r.id}`} className="row gap-2" style={{ justifyContent: "space-between" }}>
                    <span>
                      <span className="strong text-sm">{r.displayName}</span>
                      <span className="text-xs subtle"> · {r.jobTitleName}</span>
                    </span>
                    <StatusBadge status={r.status} />
                  </Link>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {tab === "profile" ? (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <Card title="Addresses">
            {employee.addresses.length === 0 ? <Empty title="No addresses on record" /> : (
              <div className="stack gap-3">
                {employee.addresses.map((a) => (
                  <div key={a.id}>
                    <Badge tone="neutral">{a.type.toLowerCase()}</Badge>
                    <div className="text-sm" style={{ marginTop: 5 }}>
                      {a.line1}{a.line2 ? `, ${a.line2}` : ""}<br />
                      {[a.city, a.state, a.postalCode].filter(Boolean).join(", ")}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Identity information">
            {employee.identityDocs.length === 0 ? <Empty title="No identity documents" /> : (
              <div className="stack gap-2">
                {employee.identityDocs.map((d) => (
                  <div key={d.id} className="row" style={{ justifyContent: "space-between" }}>
                    <span className="text-sm">{d.type.replace(/_/g, " ")}</span>
                    <span className="row gap-2">
                      <span className="mono text-sm">
                        {isSelf || showFinancials ? d.number : `••••${d.number.slice(-4)}`}
                      </span>
                      {d.isVerified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Pending</Badge>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Experience">
            {employee.experiences.length === 0 ? <Empty title="No prior experience recorded" /> : (
              <div className="stack gap-3">
                {employee.experiences.map((x) => (
                  <div key={x.id}>
                    <div className="strong text-sm">{x.jobTitle ?? "—"}</div>
                    <div className="text-sm muted">{x.companyName}</div>
                    <div className="text-xs subtle">{formatDate(x.fromDate)} – {formatDate(x.toDate)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Education">
            {employee.educations.length === 0 ? <Empty title="No education recorded" /> : (
              <div className="stack gap-3">
                {employee.educations.map((x) => (
                  <div key={x.id}>
                    <div className="strong text-sm">{x.degree ?? "—"}{x.specialization ? `, ${x.specialization}` : ""}</div>
                    <div className="text-sm muted">{x.institution}</div>
                    <div className="text-xs subtle">{x.fromYear} – {x.toYear}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {tab === "job" ? (
        <Card
          title="Job history"
          description="Effective-dated. There is no separate transfer or promotion module — position changes are made here with an effective date and the full history is retained."
          tight
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Effective from</th><th>Reason</th><th>Job title</th>
                  <th>Department</th><th>Band</th><th>Note</th>
                </tr>
              </thead>
              <tbody>
                {employee.jobHistory.map((h) => (
                  <tr key={h.id}>
                    <td className="nowrap">{formatDate(h.effectiveFrom)}</td>
                    <td><Badge tone="neutral">{h.reason.replace(/_/g, " ").toLowerCase()}</Badge></td>
                    <td>{h.jobTitle?.name ?? "—"}</td>
                    <td>{employee.department?.name ?? "—"}</td>
                    <td>{employee.band?.name ?? "—"}</td>
                    <td className="text-sm muted">{h.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {tab === "finances" ? (
        !showFinancials ? (
          <Callout tone="warning" title="Financial details are restricted">
            Viewing salary, bank and tax details needs the
            <span className="mono"> employee.financials.view </span>
            permission. Your roles do not grant it for this employee.
          </Callout>
        ) : (
          <div className="stack gap-4">
            <div className="grid grid-3">
              <Card title="Current compensation">
                <div className="stat-value sm">
                  <Money value={currentSalary?.annualCtc ?? 0} />
                </div>
                <div className="text-sm muted" style={{ marginTop: 4 }}>
                  Annual CTC · effective {formatDate(currentSalary?.effectiveFrom)}
                </div>
              </Card>
              <Card title="Monthly gross">
                <div className="stat-value sm">
                  <Money value={resolved?.monthlyGross.toNumber() ?? 0} />
                </div>
                <div className="text-sm muted" style={{ marginTop: 4 }}>
                  Before statutory deductions
                </div>
              </Card>
              <Card title="Tax regime">
                <div className="stat-value sm">
                  {employee.statutoryProfile?.taxRegime === "OLD" ? "Old regime" : "New regime"}
                </div>
                <div className="text-sm muted" style={{ marginTop: 4 }}>
                  {fyLabel(fyStartYear(new Date(), viewer.tenant.fyStartMonth))}
                </div>
              </Card>
            </div>

            {resolved ? (
              <Card
                title="Salary structure"
                description={`${currentSalary?.structure?.name ?? "—"} · every formula produces a monthly amount`}
                tight
              >
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Component</th><th>Type</th><th>Formula</th>
                        <th className="num">Monthly</th><th className="num">Annual</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resolved.components.map((c) => {
                        const line = currentSalary?.structure?.components.find(
                          (sc) => sc.component.code === c.code,
                        );
                        return (
                          <tr key={c.code}>
                            <td>
                              <span className="strong">{c.name}</span>
                              <span className="mono text-xs subtle"> {c.code}</span>
                              {c.isPartOfFbp ? <Badge tone="info">FBP</Badge> : null}
                            </td>
                            <td className="text-sm muted">{c.type.replace(/_/g, " ").toLowerCase()}</td>
                            <td className="mono text-xs subtle">
                              {line?.calculationType === "BALANCE"
                                ? "balance of CTC"
                                : line?.formula ?? (line?.fixedAmount ? `fixed ${line.fixedAmount}` : "—")}
                            </td>
                            <td className="num"><Money value={c.monthly.toNumber()} /></td>
                            <td className="num"><Money value={c.annual.toNumber()} /></td>
                          </tr>
                        );
                      })}
                      <tr className="total-row">
                        <td colSpan={3}>Cost to company</td>
                        <td className="num"><Money value={resolved.monthlyCtcValue.toNumber()} /></td>
                        <td className="num"><Money value={resolved.annualCtc.toNumber()} /></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {resolved.warnings.length > 0 ? (
                  <div style={{ padding: 14 }}>
                    <Callout tone="warning" title="Structure warnings">
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {resolved.warnings.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    </Callout>
                  </div>
                ) : null}
              </Card>
            ) : null}

            <div className="grid grid-2" style={{ alignItems: "start" }}>
              <Card title="Statutory profile">
                <KeyValue items={[
                  ["PAN", pan ? <span className="mono" key="p">{pan}</span> : null],
                  ["UAN", employee.statutoryProfile?.uan],
                  ["PF account", employee.statutoryProfile?.pfAccountNumber],
                  ["PF enabled", employee.statutoryProfile?.pfEnabled ? "Yes" : "No"],
                  ["VPF", employee.statutoryProfile?.vpfAmount
                    ? <Money key="v" value={employee.statutoryProfile.vpfAmount} /> : "None"],
                  ["ESIC number", employee.statutoryProfile?.esicNumber ?? "Not covered"],
                  ["Professional tax", employee.statutoryProfile?.ptEnabled
                    ? `Yes · ${employee.location?.stateCode ?? "—"}` : "No"],
                  ["LWF", employee.statutoryProfile?.lwfEnabled ? "Yes" : "No"],
                ]} />
              </Card>

              <Card title="Bank accounts">
                {employee.bankAccounts.length === 0 ? <Empty title="No bank account on file" /> : (
                  <div className="stack gap-3">
                    {employee.bankAccounts.map((b) => (
                      <div key={b.id}>
                        <div className="row gap-2">
                          <span className="strong text-sm">{b.bankName}</span>
                          {b.isPrimary ? <Badge tone="brand">Primary</Badge> : null}
                          {b.isVerified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Unverified</Badge>}
                        </div>
                        <div className="mono text-sm muted" style={{ marginTop: 3 }}>
                          ••••{b.accountNumber.slice(-4)} · {b.ifsc}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <Card title="Salary revision history" tight>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Effective from</th><th className="num">Annual CTC</th>
                      <th className="num">Change</th><th>Structure</th><th>Reason</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employee.salaryRevisions.map((r, i) => {
                      const prev = employee.salaryRevisions[i + 1];
                      const delta = prev
                        ? ((Number(r.annualCtc) - Number(prev.annualCtc)) / Number(prev.annualCtc)) * 100
                        : null;
                      return (
                        <tr key={r.id}>
                          <td className="nowrap">{formatDate(r.effectiveFrom)}</td>
                          <td className="num"><Money value={r.annualCtc} /></td>
                          <td className={`num ${delta && delta > 0 ? "pos" : ""}`}>
                            {delta === null ? <span className="subtle">—</span> : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`}
                          </td>
                          <td className="text-sm">{r.structure?.name ?? "—"}</td>
                          <td className="text-sm muted">{r.reason ?? "—"}</td>
                          <td><Badge tone={r.status === "APPLIED" ? "success" : "warning"}>{r.status.toLowerCase()}</Badge></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            {employee.loans.length > 0 ? (
              <Card title="Loans" tight>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Category</th><th className="num">Principal</th><th className="num">EMI</th>
                        <th className="num">Outstanding</th><th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {employee.loans.map((l) => (
                        <tr key={l.id}>
                          <td>{l.category.name}</td>
                          <td className="num"><Money value={l.principal} /></td>
                          <td className="num"><Money value={l.emiAmount} /></td>
                          <td className="num"><Money value={l.outstanding} /></td>
                          <td><Badge tone={l.status === "ACTIVE" ? "info" : "neutral"}>{l.status.toLowerCase()}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ) : null}

            <Card title="Payslips" tight>
              {employee.payslips.length === 0 ? (
                <Empty title="No payslips yet">Payslips appear once a payroll run is finalised and released.</Empty>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Period</th><th className="num">Net pay</th><th>Status</th><th /></tr>
                    </thead>
                    <tbody>
                      {employee.payslips.map((p) => (
                        <tr key={p.id}>
                          <td>{formatPeriod(p.year, p.month)}</td>
                          <td className="num"><Money value={p.netPay} /></td>
                          <td>
                            <Badge tone={p.status === "RELEASED" ? "success" : p.status === "HELD" ? "warning" : "neutral"}>
                              {p.status.replace(/_/g, " ").toLowerCase()}
                            </Badge>
                          </td>
                          <td className="right">
                            <Link className="btn sm" href={`/payroll/payslips/${p.id}`}>View</Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {(["time", "documents", "assets", "expenses", "performance"] as Tab[]).includes(tab) ? (
        <Card>
          <Empty title={`${tab[0].toUpperCase() + tab.slice(1)} — not in this milestone`}>
            This tab is part of the module roadmap. The schema is in place; the screens
            are scheduled after the payroll spine.
          </Empty>
        </Card>
      ) : null}
    </>
  );
}
