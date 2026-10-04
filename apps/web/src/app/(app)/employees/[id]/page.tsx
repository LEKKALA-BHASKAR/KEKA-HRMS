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

import {
  EditToggle, PersonalForm, JobChangeForm, SalaryRevisionForm, StatutoryForm,
  AddressForm, IdentityForm, BankForm, EducationForm, ExperienceForm,
  DependentForm, EmergencyForm, RemoveSubRecord, AccessControls,
} from "./forms";
import { CustomFieldsForm } from "./custom-fields";
import { NoticePolicyPicker } from "./notice";
import { TimeTab, DocumentsTab, AssetsTab, ExpensesTab, PerformanceTab } from "./tabs";
import { HrRecordsTab } from "./hr-records";
import { isManagerOf } from "@/lib/core-hr";
import { displayCustomValue, type CustomFieldKind } from "@keka/services";

const P = PERMISSIONS;

const TABS = [
  "about", "profile", "job", "time", "documents",
  "assets", "finances", "expenses", "performance", "hr",
] as const;
const TAB_LABEL: Partial<Record<(typeof TABS)[number], string>> = { hr: "Notes & records" };
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
      user: { select: { email: true, lastLoginAt: true, loginDisabled: true, isDeactivated: true, twoFactor: true } },
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
  const currentSalary = employee.salaryRevisions.find((r) => r.status === "APPLIED") ?? null;
  const pan = employee.identityDocs.find((d) => d.type === "PAN")?.number ?? null;

  const canEdit = canAccessEmployee(viewer, target, P.EMPLOYEE_UPDATE);
  const canEditFinancials = canAccessEmployee(viewer, target, P.EMPLOYEE_MANAGE_FINANCIALS);
  const canRevise = can(viewer, P.SALARY_REVISE) && showFinancials;
  const canManageAccess = can(viewer, P.EMPLOYEE_DISABLE_LOGIN) || can(viewer, P.EMPLOYEE_INVITE);

  // Module tabs open only for viewers who may see that module for this person.
  const reach = (permission: (typeof P)[keyof typeof P]) => canAccessEmployee(viewer, target, permission);
  const seeAttendance = reach(P.ATTENDANCE_VIEW);
  const seeLeave = reach(P.LEAVE_VIEW);
  const moduleAccess: Partial<Record<Tab, { ok: boolean; permission: string }>> = {
    time: { ok: seeAttendance || seeLeave, permission: P.ATTENDANCE_VIEW },
    documents: { ok: reach(P.DOCUMENT_VIEW), permission: P.DOCUMENT_VIEW },
    assets: { ok: reach(P.ASSET_VIEW), permission: P.ASSET_VIEW },
    expenses: { ok: reach(P.EXPENSE_VIEW), permission: P.EXPENSE_VIEW },
    performance: { ok: reach(P.PERFORMANCE_VIEW), permission: P.PERFORMANCE_VIEW },
    // Internal notes, secondary managers, ID card and change history: HR and the person's managers.
    hr: { ok: !isSelf && (canEdit || await isManagerOf(viewer, employee.id)), permission: P.EMPLOYEE_UPDATE },
  };
  const visibleTabs = TABS.filter((t) => moduleAccess[t]?.ok ?? true);
  const refused = moduleAccess[tab] && !moduleAccess[tab]!.ok ? moduleAccess[tab]! : null;

  // Custom fields the organisation added under Settings; inactive ones stay hidden but keep their values.
  const customDefs = tab === "profile"
    ? await prisma.customFieldDefinition.findMany({
        where: { tenantId: viewer.tenantId, entity: "EMPLOYEE", isActive: true },
        orderBy: [{ displayOrder: "asc" }, { label: "asc" }],
        include: { values: { where: { ownerId: employee.id } } },
      })
    : [];
  const customFields = customDefs.map((d) => ({
    id: d.id, label: d.label, section: d.section ?? "Additional details", type: d.type,
    options: (d.options as string[] | null) ?? [], isMandatory: d.isMandatory, value: d.values[0]?.value ?? null,
  }));
  const customSections = [...new Set(customFields.map((f) => f.section))];

  // Job changes asked for but not yet in the history: waiting on approval or on their date.
  const openChanges = tab === "job"
    ? await prisma.jobChange.findMany({ where: { employeeId: employee.id, tenantId: viewer.tenantId, status: { in: ["PENDING_APPROVAL", "SCHEDULED"] } }, orderBy: { effectiveFrom: "asc" } })
    : [];
  const noticePolicies = tab === "job"
    ? await prisma.noticePeriodPolicy.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] })
    : [];
  const noticeOwn = noticePolicies.find((p) => p.id === employee.noticePeriodPolicyId) ?? null;
  // The same fallback noticeDaysFor uses: the default, else the oldest active policy.
  const noticeDefault = noticePolicies.find((p) => p.isDefault) ?? [...noticePolicies].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0] ?? null;
  const noticeLabel = (p: { name: string; resignationDays: number; probationDays: number }) => `${p.name}: ${p.resignationDays} days, ${p.probationDays} in probation`;

  // Option lists for the edit forms. Only loaded when an edit form will render.
  const needsJobOptions = canEdit && tab === "job";
  const needsStructures = canRevise && tab === "finances";
  const [jobTitlesO, departmentsO, unitsO, locationsO, bandsO, gradesO, workerTypesO, managersO, structuresO] =
    await Promise.all([
      needsJobOptions ? prisma.jobTitle.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
      needsJobOptions ? prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
      needsJobOptions ? prisma.businessUnit.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
      needsJobOptions ? prisma.location.findMany({ where: { tenantId: viewer.tenantId, stateCode: { not: null } }, select: { id: true, name: true, stateCode: true }, orderBy: { name: "asc" } }) : [],
      needsJobOptions ? prisma.band.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { rank: "asc" } }) : [],
      needsJobOptions ? prisma.payGrade.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
      needsJobOptions ? prisma.workerType.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
      needsJobOptions ? prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] }, id: { not: employee.id } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" } }) : [],
      needsStructures && employee.payGroupId ? prisma.salaryStructure.findMany({ where: { payGroupId: employee.payGroupId, isActive: true }, select: { id: true, name: true }, orderBy: { minAnnualCtc: "asc" } }) : [],
    ]);
  const opt = (rows: Array<{ id: string; name: string }>) => rows.map((r) => ({ value: r.id, label: r.name }));

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
            {canEdit && tab !== "about" ? (
              <Link className="btn" href={`/employees/${employee.id}?tab=about`}>Edit details</Link>
            ) : null}
          </>
        }
      />

      <div className="tabs">
        {visibleTabs.map((t) => (
          <Link key={t} href={tabHref(t)} className={`tab${tab === t ? " active" : ""}`}>
            {TAB_LABEL[t] ?? t[0].toUpperCase() + t.slice(1)}
          </Link>
        ))}
      </div>

      {/* ---------------------------------------------------------------- */}
      {tab === "about" ? (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          {canEdit ? (
            <div style={{ gridColumn: "1 / -1" }}>
              <Card title="Edit personal details">
                <EditToggle label="Edit personal details">
                  <PersonalForm employee={{
                    id: employee.id, firstName: employee.firstName, middleName: employee.middleName,
                    lastName: employee.lastName, displayName: employee.displayName,
                    workEmail: employee.workEmail, personalEmail: employee.personalEmail,
                    mobile: employee.mobile, alternatePhone: employee.alternatePhone,
                    dateOfBirth: employee.dateOfBirth?.toISOString() ?? null,
                    gender: employee.gender, maritalStatus: employee.maritalStatus,
                    bloodGroup: employee.bloodGroup, nationality: employee.nationality,
                  }} />
                </EditToggle>
              </Card>
            </div>
          ) : null}

          {canManageAccess ? (
            <Card title="Portal access" description={employee.user
              ? `${employee.user.email}${employee.user.lastLoginAt ? ` · last signed in ${formatDate(employee.user.lastLoginAt)}` : " · never signed in"}`
              : "No login"}>
              <AccessControls
                employeeId={employee.id}
                hasLogin={!!employee.user}
                loginDisabled={employee.user?.loginDisabled ?? false}
                isDeactivated={employee.user?.isDeactivated ?? false}
                email={employee.workEmail}
              />
            </Card>
          ) : null}

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
            {canEdit ? <AddressForm employeeId={employee.id} /> : null}
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
            {canEdit ? <IdentityForm employeeId={employee.id} /> : null}
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
            {canEdit ? <ExperienceForm employeeId={employee.id} /> : null}
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
            {canEdit ? <EducationForm employeeId={employee.id} /> : null}
          </Card>
        </div>
      ) : null}

      {tab === "profile" ? (
        <div className="grid grid-2" style={{ alignItems: "start", marginTop: 16 }}>
          <Card title={`Dependents (${employee.dependents.length})`}>
            {employee.dependents.length === 0 ? <Empty title="No dependents recorded" /> : (
              <div className="stack gap-2">
                {employee.dependents.map((d) => (
                  <div key={d.id} className="row" style={{ justifyContent: "space-between" }}>
                    <span className="text-sm">
                      <span className="strong">{d.name}</span>
                      <span className="subtle"> · {d.relationship}</span>
                      {d.isNominee ? <Badge tone="brand">nominee</Badge> : null}
                    </span>
                    {canEdit ? <RemoveSubRecord kind="dependent" id={d.id} employeeId={employee.id} /> : null}
                  </div>
                ))}
              </div>
            )}
            {canEdit ? <DependentForm employeeId={employee.id} /> : null}
          </Card>

          <Card title={`Emergency contacts (${employee.emergencyContacts.length})`}>
            {employee.emergencyContacts.length === 0 ? <Empty title="No emergency contact on file" /> : (
              <div className="stack gap-2">
                {employee.emergencyContacts.map((c) => (
                  <div key={c.id} className="row" style={{ justifyContent: "space-between" }}>
                    <span className="text-sm">
                      <span className="strong">{c.name}</span>
                      <span className="subtle"> · {c.relationship} · {c.phone}</span>
                      {c.isPrimary ? <Badge tone="brand">primary</Badge> : null}
                    </span>
                    {canEdit ? <RemoveSubRecord kind="emergency" id={c.id} employeeId={employee.id} /> : null}
                  </div>
                ))}
              </div>
            )}
            {canEdit ? <EmergencyForm employeeId={employee.id} /> : null}
          </Card>
        </div>
      ) : null}

      {tab === "profile" && customFields.length ? (
        <div style={{ marginTop: 16 }}>
          <Card title="Additional details" description={customSections.length > 1 ? customSections.join(" · ") : undefined}>
            <div className="stack gap-4">
              {customSections.map((section) => (
                <div key={section}>
                  {customSections.length > 1 ? <div className="text-xs strong subtle" style={{ marginBottom: 6 }}>{section.toUpperCase()}</div> : null}
                  <KeyValue items={customFields.filter((f) => f.section === section).map((f) => [
                    <>{f.label}{f.isMandatory && !f.value ? <Badge tone="warning">missing</Badge> : null}</>,
                    f.value ? displayCustomValue(f.type as CustomFieldKind, f.value) : <span className="subtle">—</span>,
                  ])} />
                </div>
              ))}
              {canEdit ? (
                <EditToggle label="Edit details">
                  <CustomFieldsForm employeeId={employee.id} fields={customFields} />
                </EditToggle>
              ) : null}
            </div>
          </Card>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {tab === "job" ? (
        <div className="stack gap-4">
        {canEdit ? (
          <Card title="Record a job change" description="Promotion, transfer, manager change or confirmation — effective-dated.">
            <EditToggle label="+ Record a change">
              <JobChangeForm
                employeeId={employee.id}
                jobTitles={opt(jobTitlesO)}
                departments={opt(departmentsO)}
                businessUnits={opt(unitsO)}
                locations={locationsO.map((l) => ({ value: l.id, label: `${l.name} (${l.stateCode})` }))}
                bands={opt(bandsO)}
                grades={opt(gradesO)}
                workerTypes={opt(workerTypesO)}
                managers={managersO.map((m) => ({ value: m.id, label: `${m.displayName} (${m.employeeNumber})` }))}
              />
            </EditToggle>
          </Card>
        ) : null}
        {openChanges.length ? (
          <Card tight title={`Upcoming job changes (${openChanges.length})`} description="Recorded but not yet in the job history: waiting for approval, or approved and waiting for the effective date.">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Effective from</th><th>Reason</th><th>Status</th><th>Source</th><th>Note</th></tr></thead>
                <tbody>
                  {openChanges.map((c) => (
                    <tr key={c.id}>
                      <td className="nowrap">{formatDate(c.effectiveFrom)}</td>
                      <td><Badge tone="neutral">{c.reason.replace(/_/g, " ").toLowerCase()}</Badge></td>
                      <td><Badge tone={c.status === "SCHEDULED" ? "info" : "warning"}>{c.status === "SCHEDULED" ? "scheduled" : "awaiting approval"}</Badge></td>
                      <td className="text-sm muted">{c.source === "IMPORT" ? "Bulk import" : "Profile"}</td>
                      <td className="text-sm muted">{c.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
        <Card title="Notice period" description="What this person must serve on resignation. Used when an exit is raised.">
          {canEdit && noticePolicies.length ? (
            <NoticePolicyPicker employeeId={employee.id} current={noticeOwn?.id ?? null} defaultName={noticeDefault ? noticeLabel(noticeDefault) : "none set"}
              options={noticePolicies.map((p) => ({ value: p.id, label: noticeLabel(p) }))} />
          ) : (
            <div className="text-sm">{noticeOwn ? noticeLabel(noticeOwn) : noticeDefault ? `Organisation default — ${noticeLabel(noticeDefault)}` : "No notice policy set up: 60 days on resignation."}</div>
          )}
        </Card>
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
        </div>
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

            {canRevise ? (
              <Card title="Revise salary">
                {employee.payGroupId ? (
                  <EditToggle label="+ New salary revision">
                    <SalaryRevisionForm
                      employeeId={employee.id}
                      structures={opt(structuresO)}
                      currentCtc={currentSalary ? Number(currentSalary.annualCtc) : null}
                    />
                  </EditToggle>
                ) : (
                  <p className="text-sm muted">Assign a pay group first — it carries the statutory configuration a salary needs.</p>
                )}
              </Card>
            ) : null}

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
                {canEditFinancials ? (
              <div style={{ marginTop: 14 }}>
                <EditToggle label="Edit statutory profile">
                  <StatutoryForm employeeId={employee.id} profile={employee.statutoryProfile ? {
                    pfEnabled: employee.statutoryProfile.pfEnabled,
                    uan: employee.statutoryProfile.uan,
                    pfAccountNumber: employee.statutoryProfile.pfAccountNumber,
                    vpfAmount: employee.statutoryProfile.vpfAmount ? Number(employee.statutoryProfile.vpfAmount) : null,
                    vpfPercent: employee.statutoryProfile.vpfPercent ? Number(employee.statutoryProfile.vpfPercent) : null,
                    epsApplicable: employee.statutoryProfile.epsApplicable,
                    esiEnabled: employee.statutoryProfile.esiEnabled,
                    esicNumber: employee.statutoryProfile.esicNumber,
                    ptEnabled: employee.statutoryProfile.ptEnabled,
                    lwfEnabled: employee.statutoryProfile.lwfEnabled,
                    taxRegime: employee.statutoryProfile.taxRegime,
                    flatTdsAmount: employee.statutoryProfile.flatTdsAmount ? Number(employee.statutoryProfile.flatTdsAmount) : null,
                    tdsDisabled: employee.statutoryProfile.tdsDisabled,
                    previousEmployerIncome: employee.statutoryProfile.previousEmployerIncome ? Number(employee.statutoryProfile.previousEmployerIncome) : null,
                    previousEmployerTds: employee.statutoryProfile.previousEmployerTds ? Number(employee.statutoryProfile.previousEmployerTds) : null,
                  } : null} />
                </EditToggle>
              </div>
            ) : null}
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
                {canEditFinancials ? <BankForm employeeId={employee.id} /> : null}
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
                      const prevCtc = r.previousCtc ? Number(r.previousCtc) : Number(employee.salaryRevisions.slice(i + 1).find((p) => p.status === "APPLIED")?.annualCtc ?? 0);
                      const delta = prevCtc ? ((Number(r.annualCtc) - prevCtc) / prevCtc) * 100 : null;
                      return (
                        <tr key={r.id}>
                          <td className="nowrap">{formatDate(r.effectiveFrom)}</td>
                          <td className="num"><Money value={r.annualCtc} /></td>
                          <td className={`num ${delta && delta > 0 ? "pos" : ""}`}>
                            {delta === null ? <span className="subtle">—</span> : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`}
                          </td>
                          <td className="text-sm">{r.structure?.name ?? "—"}</td>
                          <td className="text-sm muted">{r.reason ?? "—"}</td>
                          <td>
                            {r.status === "PENDING_APPROVAL"
                              ? <Link href="/payroll/approvals"><Badge tone="warning">awaiting approval</Badge></Link>
                              : <Badge tone={r.status === "APPLIED" ? "success" : r.status === "REJECTED" ? "danger" : "warning"}>{r.status.toLowerCase().replace(/_/g, " ")}</Badge>}
                          </td>
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
      {refused ? <AccessDenied permission={refused.permission} what={`${name}'s ${tab}`} /> : null}
      {tab === "time" && !refused ? (
        <TimeTab tenantId={viewer.tenantId} employeeId={employee.id} attendance={seeAttendance} leave={seeLeave} isSelf={isSelf} />
      ) : null}
      {tab === "documents" && !refused ? (
        <DocumentsTab tenantId={viewer.tenantId} employeeId={employee.id} isSelf={isSelf}
          seeConfidential={reach(P.DOCUMENT_MANAGE)} seeAllLetters={can(viewer, P.LETTER_GENERATE) && reach(P.LETTER_GENERATE)} />
      ) : null}
      {tab === "assets" && !refused ? (
        <AssetsTab tenantId={viewer.tenantId} employeeId={employee.id} isSelf={isSelf} seeValue={reach(P.ASSET_MANAGE)} />
      ) : null}
      {tab === "expenses" && !refused ? (
        <ExpensesTab tenantId={viewer.tenantId} employeeId={employee.id} isSelf={isSelf} />
      ) : null}
      {tab === "hr" && !refused ? (
        <HrRecordsTab viewer={viewer} employeeId={employee.id} isHr={canEdit} />
      ) : null}
      {tab === "performance" && !refused ? (
        <PerformanceTab tenantId={viewer.tenantId} employeeId={employee.id} isSelf={isSelf} seeOneOnOnes={isSelf || viewer.allReportIds.has(employee.id)} />
      ) : null}
    </>
  );
}
