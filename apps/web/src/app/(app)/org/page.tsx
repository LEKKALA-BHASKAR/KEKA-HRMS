import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, KeyValue, Callout, Money } from "@/components/ui";
import {
  Disclosure, LegalEntityForm, DeleteEntityButton, SignatoryForm, DeleteSignatoryButton,
  EntityBankForm, BusinessUnitForm, DeleteBusinessUnitButton, DepartmentForm,
  DeleteDepartmentButton, HeadPicker, LocationForm, DeleteLocationButton,
  CostCentreForm, BandForm, PayGradeForm, WorkerTypeForm, JobTitleForm, DeleteLookupButton,
  NumberSeriesForm, DeleteSeriesButton, type Option,
} from "./forms";

const P = PERMISSIONS;

const TABS = ["entities", "structure", "locations", "grades", "numbering"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  entities: "Legal entities",
  structure: "Business units & departments",
  locations: "Locations",
  grades: "Bands, grades & worker types",
  numbering: "Employee numbering",
};

export default async function OrgPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; edit?: string }> }) {
  const viewer = await requireAuth(P.ORG_VIEW);
  const sp = await searchParams;
  const tab = (TABS.includes(sp.tab as Tab) ? sp.tab : "entities") as Tab;
  const canManage = can(viewer, P.ORG_MANAGE);
  const canManageEntity = can(viewer, P.ORG_ENTITY_MANAGE);
  const canManageSettings = can(viewer, P.ORG_SETTINGS_MANAGE);
  const editId = sp.edit ?? null;

  const [entities, businessUnits, locations, bands, grades, workerTypes, costCentres, series, jobTitles, employeeOpts] =
    await Promise.all([
      prisma.legalEntity.findMany({
        where: { tenantId: viewer.tenantId },
        include: {
          signatories: true, bankAccounts: true,
          _count: { select: { employees: true, businessUnits: true, payGroups: true } },
        },
        orderBy: { name: "asc" },
      }),
      prisma.businessUnit.findMany({
        where: { tenantId: viewer.tenantId },
        include: {
          legalEntity: { select: { name: true } },
          head: { select: { id: true, displayName: true } },
          departments: {
            include: {
              head: { select: { id: true, displayName: true } },
              _count: { select: { employees: true } },
            },
            orderBy: { name: "asc" },
          },
          _count: { select: { employees: true } },
        },
        orderBy: { name: "asc" },
      }),
      prisma.location.findMany({
        where: { tenantId: viewer.tenantId },
        include: {
          _count: { select: { employees: true } },
          ptLinks: { include: { registration: { select: { stateCode: true, frequency: true, establishmentId: true } } } },
          lwfLinks: { include: { registration: { select: { stateCode: true, establishmentId: true } } } },
        },
        orderBy: { name: "asc" },
      }),
      prisma.band.findMany({
        where: { tenantId: viewer.tenantId },
        include: { _count: { select: { employees: true } } },
        orderBy: { rank: "asc" },
      }),
      prisma.payGrade.findMany({
        where: { tenantId: viewer.tenantId },
        include: { _count: { select: { employees: true } } },
        orderBy: { name: "asc" },
      }),
      prisma.workerType.findMany({
        where: { tenantId: viewer.tenantId },
        include: { _count: { select: { employees: true } } },
        orderBy: { name: "asc" },
      }),
      prisma.costCenter.findMany({
        where: { tenantId: viewer.tenantId },
        include: { _count: { select: { employees: true } } },
        orderBy: { name: "asc" },
      }),
      prisma.employeeNumberSeries.findMany({
        where: { tenantId: viewer.tenantId },
        orderBy: { isDefault: "desc" },
      }),
      prisma.jobTitle.findMany({
        where: { tenantId: viewer.tenantId },
        include: { _count: { select: { employeeJobs: true } } },
        orderBy: { name: "asc" },
      }),
      prisma.employee.findMany({
        where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } },
        select: { id: true, displayName: true, employeeNumber: true },
        orderBy: { firstName: "asc" },
      }),
    ]);

  const entityOpts: Option[] = entities.map((e) => ({ value: e.id, label: e.name }));
  const unitOpts: Option[] = businessUnits.map((b) => ({ value: b.id, label: b.name }));
  const bandOpts: Option[] = bands.map((b) => ({ value: b.id, label: b.name }));
  const empOpts: Option[] = employeeOpts.map((e) => ({
    value: e.id, label: `${e.displayName} (${e.employeeNumber})`,
  }));

  const allDepartments = businessUnits.flatMap((b) => b.departments);
  const editEntity = editId ? entities.find((e) => e.id === editId) : undefined;
  const editUnit = editId ? businessUnits.find((b) => b.id === editId) : undefined;
  const editDept = editId ? allDepartments.find((d) => d.id === editId) : undefined;
  const editLocation = editId ? locations.find((l) => l.id === editId) : undefined;
  const editSeries = editId ? series.find((s) => s.id === editId) : undefined;

  const tabHref = (t: Tab) => `/org?tab=${t}`;

  return (
    <>
      <PageHead
        title="Organisation"
        subtitle="Legal entity → business unit → department, with location as a parallel dimension that drives state statutory rules"
      />

      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t} href={tabHref(t)} className={`tab${tab === t ? " active" : ""}`}>
            {TAB_LABEL[t]}
          </Link>
        ))}
      </div>

      {/* ================= LEGAL ENTITIES ================= */}
      {tab === "entities" ? (
        <div className="stack gap-4">
          <Callout tone="info" title="The legal entity carries identity, not statute">
            Statutory registrations — PF, ESI, PT, LWF and income tax — live on the
            <strong> pay group</strong>, not here. Moving an employee between companies is a
            pay-group change, which is what synchronises their legal entity.
          </Callout>

          {canManageEntity ? (
            <Card title={editEntity ? `Edit ${editEntity.name}` : "Add a legal entity"}>
              {editEntity ? (
                <>
                  <LegalEntityForm entity={{
                    id: editEntity.id, name: editEntity.name, legalName: editEntity.legalName,
                    cin: editEntity.cin,
                    dateOfIncorporation: editEntity.dateOfIncorporation?.toISOString() ?? null,
                    businessType: editEntity.businessType, sector: editEntity.sector,
                    natureOfBusiness: editEntity.natureOfBusiness,
                    addressLine1: editEntity.addressLine1, addressLine2: editEntity.addressLine2,
                    city: editEntity.city, state: editEntity.state, postalCode: editEntity.postalCode,
                    countryCode: editEntity.countryCode, currency: editEntity.currency,
                  }} />
                  <div style={{ marginTop: 10 }}>
                    <Link className="btn ghost sm" href="/org?tab=entities">Done editing</Link>
                  </div>
                </>
              ) : (
                <Disclosure label="+ New legal entity">
                  <LegalEntityForm />
                </Disclosure>
              )}
            </Card>
          ) : null}

          {entities.map((e) => (
            <Card
              key={e.id}
              title={e.legalName}
              description={`${e.businessType ?? "—"} · ${e.sector ?? "—"}`}
              action={
                <div className="row gap-2">
                  <Badge tone="brand">{e._count.employees} employees</Badge>
                  {canManageEntity ? (
                    <>
                      <Link className="btn sm" href={`/org?tab=entities&edit=${e.id}`}>Edit</Link>
                      <DeleteEntityButton id={e.id} name={e.legalName} />
                    </>
                  ) : null}
                </div>
              }
              tight
            >
              <div style={{ padding: 18 }}>
                <div className="grid grid-3" style={{ alignItems: "start" }}>
                  <KeyValue items={[
                    ["Internal name", e.name],
                    ["CIN", <span className="mono text-sm" key="c">{e.cin ?? "—"}</span>],
                    ["Incorporated", formatDate(e.dateOfIncorporation)],
                    ["Country / currency", `${e.countryCode} / ${e.currency}`],
                    ["Business units", e._count.businessUnits],
                    ["Pay groups", e._count.payGroups],
                    ["Registered address", [e.addressLine1, e.city, e.state, e.postalCode].filter(Boolean).join(", ") || "—"],
                  ]} />

                  <div>
                    <div className="stat-label" style={{ marginBottom: 8 }}>
                      Authorised signatories ({e.signatories.length})
                    </div>
                    <div className="stack gap-2">
                      {e.signatories.length === 0 ? (
                        <span className="text-sm subtle">None — statutory filings need at least one.</span>
                      ) : e.signatories.map((s) => (
                        <div key={s.id} className="row gap-2" style={{ justifyContent: "space-between" }}>
                          <div>
                            <div className="strong text-sm">{s.name}</div>
                            <div className="text-xs subtle">{s.designation}</div>
                            <div className="mono text-xs subtle">{s.pan ?? "PANNOTAVBL"}</div>
                          </div>
                          {canManageEntity ? <DeleteSignatoryButton id={s.id} name={s.name} /> : null}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="stat-label" style={{ marginBottom: 8 }}>
                      Bank accounts ({e.bankAccounts.length})
                    </div>
                    <div className="stack gap-2">
                      {e.bankAccounts.length === 0 ? (
                        <span className="text-sm subtle">None — payroll disbursal needs one.</span>
                      ) : e.bankAccounts.map((b) => (
                        <div key={b.id}>
                          <div className="row gap-2">
                            <span className="strong text-sm">{b.bankName}</span>
                            {b.isPrimary ? <Badge tone="brand">Primary</Badge> : null}
                          </div>
                          <div className="mono text-xs subtle">
                            ••••{b.accountNumber.slice(-4)} · {b.ifsc} · {b.branch}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {canManageEntity ? (
                <>
                  <SignatoryForm legalEntityId={e.id} />
                  <EntityBankForm legalEntityId={e.id} />
                </>
              ) : null}
            </Card>
          ))}
        </div>
      ) : null}

      {/* ================= STRUCTURE ================= */}
      {tab === "structure" ? (
        <div className="stack gap-4">
          {canManage ? (
            <div className="grid grid-2" style={{ alignItems: "start" }}>
              <Card title={editUnit ? `Edit ${editUnit.name}` : "Add a business unit"}>
                {editUnit ? (
                  <>
                    <BusinessUnitForm entities={entityOpts} employees={empOpts} unit={{
                      id: editUnit.id, name: editUnit.name, code: editUnit.code,
                      description: editUnit.description, legalEntityId: editUnit.legalEntityId,
                      headId: editUnit.headId,
                    }} />
                    <div style={{ marginTop: 10 }}>
                      <Link className="btn ghost sm" href="/org?tab=structure">Done editing</Link>
                    </div>
                  </>
                ) : (
                  <Disclosure label="+ New business unit">
                    <BusinessUnitForm entities={entityOpts} employees={empOpts} />
                  </Disclosure>
                )}
              </Card>

              <Card title={editDept ? `Edit ${editDept.name}` : "Add a department"}>
                {editDept ? (
                  <>
                    <DepartmentForm units={unitOpts} employees={empOpts} dept={{
                      id: editDept.id, name: editDept.name, code: editDept.code,
                      description: editDept.description, businessUnitId: editDept.businessUnitId,
                      headId: editDept.headId,
                    }} />
                    <div style={{ marginTop: 10 }}>
                      <Link className="btn ghost sm" href="/org?tab=structure">Done editing</Link>
                    </div>
                  </>
                ) : (
                  <Disclosure label="+ New department">
                    <DepartmentForm units={unitOpts} employees={empOpts} />
                  </Disclosure>
                )}
              </Card>
            </div>
          ) : null}

          {businessUnits.map((bu) => (
            <Card
              key={bu.id}
              title={bu.name}
              description={`${bu.legalEntity.name}${bu.head ? ` · headed by ${bu.head.displayName}` : " · no business head"}`}
              action={
                <div className="row gap-2">
                  <Badge tone="neutral">{bu._count.employees} employees</Badge>
                  {canManage ? (
                    <>
                      <Link className="btn sm" href={`/org?tab=structure&edit=${bu.id}`}>Edit</Link>
                      <DeleteBusinessUnitButton id={bu.id} name={bu.name} />
                    </>
                  ) : null}
                </div>
              }
              tight
            >
              {bu.departments.length === 0 ? (
                <Empty title="No departments in this business unit" />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Department</th><th>Code</th><th>Department head</th>
                        <th className="num">Employees</th>{canManage ? <th /> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {bu.departments.map((d) => (
                        <tr key={d.id}>
                          <td className="strong">{d.name}</td>
                          <td className="mono text-xs">{d.code ?? "—"}</td>
                          <td>
                            {canManage ? (
                              <HeadPicker kind="department" id={d.id} employees={empOpts} current={d.headId} />
                            ) : d.head ? (
                              <Link href={`/employees/${d.head.id}`}>{d.head.displayName}</Link>
                            ) : <span className="subtle">Unassigned</span>}
                          </td>
                          <td className="num">{d._count.employees}</td>
                          {canManage ? (
                            <td className="right">
                              <div className="row gap-1" style={{ justifyContent: "flex-end" }}>
                                <Link className="btn sm" href={`/org?tab=structure&edit=${d.id}`}>Edit</Link>
                                <DeleteDepartmentButton id={d.id} name={d.name} />
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}

          <Card title={`Cost centres (${costCentres.length})`} tight>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Cost centre</th><th>Code</th><th className="num">Employees</th>{canManage ? <th /> : null}</tr>
                </thead>
                <tbody>
                  {costCentres.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td className="mono text-xs">{c.code ?? "—"}</td>
                      <td className="num">{c._count.employees}</td>
                      {canManage ? (
                        <td className="right"><DeleteLookupButton kind="costCentre" id={c.id} name={c.name} /></td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canManage ? <CostCentreForm /> : null}
          </Card>
        </div>
      ) : null}

      {/* ================= LOCATIONS ================= */}
      {tab === "locations" ? (
        <div className="stack gap-4">
          {canManage ? (
            <Card title={editLocation ? `Edit ${editLocation.name}` : "Add a location"}>
              {editLocation ? (
                <>
                  <LocationForm location={{ ...editLocation, latitude: editLocation.latitude?.toString() ?? null, longitude: editLocation.longitude?.toString() ?? null }} />
                  <div style={{ marginTop: 10 }}>
                    <Link className="btn ghost sm" href="/org?tab=locations">Done editing</Link>
                  </div>
                </>
              ) : (
                <Disclosure label="+ New location">
                  <LocationForm />
                </Disclosure>
              )}
            </Card>
          ) : null}

          <Card
            title={`Locations (${locations.length})`}
            description="An employee's office location is what maps them to a registered state for Professional Tax and Labour Welfare Fund."
            tight
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Location</th><th>Code</th><th>City</th><th>State</th>
                    <th className="num">Employees</th><th>PT registration</th><th>LWF registration</th>
                    {canManage ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {locations.map((l) => (
                    <tr key={l.id}>
                      <td className="strong">{l.name}</td>
                      <td className="mono text-xs">{l.code ?? "—"}</td>
                      <td>{l.city ?? "—"}</td>
                      <td>{l.state} <span className="mono text-xs subtle">{l.stateCode}</span></td>
                      <td className="num">{l._count.employees}</td>
                      <td>
                        {l.ptLinks.length > 0 ? (
                          <span className="text-sm">
                            <Badge tone="success">{l.ptLinks[0].registration.stateCode}</Badge>{" "}
                            <span className="text-xs subtle">
                              {l.ptLinks[0].registration.frequency.toLowerCase().replace("_", "-")}
                            </span>
                          </span>
                        ) : <Badge tone="warning">Not mapped</Badge>}
                      </td>
                      <td>
                        {l.lwfLinks.length > 0
                          ? <Badge tone="success">{l.lwfLinks[0].registration.stateCode}</Badge>
                          : <Badge tone="warning">Not mapped</Badge>}
                      </td>
                      {canManage ? (
                        <td className="right">
                          <div className="row gap-1" style={{ justifyContent: "flex-end" }}>
                            <Link className="btn sm" href={`/org?tab=locations&edit=${l.id}`}>Edit</Link>
                            <DeleteLocationButton id={l.id} name={l.name} />
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {locations.some((l) => l.ptLinks.length === 0 || l.lwfLinks.length === 0) ? (
            <Callout tone="warning" title="Unmapped locations will not deduct PT or LWF">
              A location with no PT or LWF registration produces zero for those heads. Map it
              from <Link href="/payroll/pay-groups">Pay groups</Link> before running payroll for
              anyone based there.
            </Callout>
          ) : null}
        </div>
      ) : null}

      {/* ================= GRADES ================= */}
      {tab === "grades" ? (
        <div className="stack gap-4">
          <div className="grid grid-2" style={{ alignItems: "start" }}>
            <Card title={`Bands (${bands.length})`} tight>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th className="num">Rank</th><th>Band</th><th className="num">People</th>{canManage ? <th /> : null}</tr></thead>
                  <tbody>
                    {bands.map((b) => (
                      <tr key={b.id}>
                        <td className="num">{b.rank}</td>
                        <td>{b.name}</td>
                        <td className="num">{b._count.employees}</td>
                        {canManage ? (
                          <td className="right"><DeleteLookupButton kind="band" id={b.id} name={b.name} /></td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canManage ? <BandForm /> : null}
            </Card>

            <Card title={`Pay grades (${grades.length})`} tight>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Grade</th><th className="num">Min</th><th className="num">Mid</th><th className="num">Max</th><th className="num">People</th>{canManage ? <th /> : null}</tr>
                  </thead>
                  <tbody>
                    {grades.map((g) => (
                      <tr key={g.id}>
                        <td className="strong">{g.name}</td>
                        <td className="num"><Money value={g.minAnnual} compact showZero={false} /></td>
                        <td className="num"><Money value={g.midAnnual} compact showZero={false} /></td>
                        <td className="num"><Money value={g.maxAnnual} compact showZero={false} /></td>
                        <td className="num">{g._count.employees}</td>
                        {canManage ? (
                          <td className="right"><DeleteLookupButton kind="payGrade" id={g.id} name={g.name} /></td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canManage ? <PayGradeForm /> : null}
            </Card>

            <Card title={`Worker types (${workerTypes.length})`} tight>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Type</th><th>Contingent</th><th className="num">People</th>{canManage ? <th /> : null}</tr></thead>
                  <tbody>
                    {workerTypes.map((w) => (
                      <tr key={w.id}>
                        <td>{w.name}</td>
                        <td>{w.isContingent ? <Badge tone="info">26Q TDS</Badge> : <span className="subtle">—</span>}</td>
                        <td className="num">{w._count.employees}</td>
                        {canManage ? (
                          <td className="right"><DeleteLookupButton kind="workerType" id={w.id} name={w.name} /></td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canManage ? <WorkerTypeForm /> : null}
            </Card>

            <Card title={`Job titles (${jobTitles.length})`} tight>
              <div className="table-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
                <table className="data">
                  <thead><tr><th>Title</th><th className="num">Held by</th>{canManage ? <th /> : null}</tr></thead>
                  <tbody>
                    {jobTitles.map((j) => (
                      <tr key={j.id}>
                        <td>{j.name}</td>
                        <td className="num">{j._count.employeeJobs}</td>
                        {canManage ? (
                          <td className="right"><DeleteLookupButton kind="jobTitle" id={j.id} name={j.name} /></td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canManage ? <JobTitleForm bands={bandOpts} /> : null}
            </Card>
          </div>
        </div>
      ) : null}

      {/* ================= NUMBERING ================= */}
      {tab === "numbering" ? (
        <div className="stack gap-4">
          {canManageSettings ? (
            <Card title={editSeries ? `Edit ${editSeries.name}` : "Add a number series"}>
              {editSeries ? (
                <>
                  <NumberSeriesForm series={editSeries} />
                  <div style={{ marginTop: 10 }}>
                    <Link className="btn ghost sm" href="/org?tab=numbering">Done editing</Link>
                  </div>
                </>
              ) : (
                <Disclosure label="+ New series">
                  <NumberSeriesForm />
                </Disclosure>
              )}
            </Card>
          ) : null}

          <Card
            title={`Employee number series (${series.length})`}
            description="Prefix, digit width, suffix and next number. Multiple series can run side by side — one for permanent staff, another for contingent workers."
            tight
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Series</th><th>Pattern</th><th>Next value</th>
                    <th className="num">Next</th><th>Status</th>{canManageSettings ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {series.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <span className="strong">{s.name}</span>
                        {s.isDefault ? <Badge tone="brand">Default</Badge> : null}
                        <div className="text-xs subtle">{s.description}</div>
                      </td>
                      <td className="mono">{s.prefix}{"N".repeat(s.digits)}{s.suffix}</td>
                      <td className="mono">
                        {s.prefix}{String(s.nextNumber).padStart(s.digits, "0")}{s.suffix}
                      </td>
                      <td className="num">{s.nextNumber}</td>
                      <td>{s.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</td>
                      {canManageSettings ? (
                        <td className="right">
                          <div className="row gap-1" style={{ justifyContent: "flex-end" }}>
                            <Link className="btn sm" href={`/org?tab=numbering&edit=${s.id}`}>Edit</Link>
                            {!s.isDefault ? <DeleteSeriesButton id={s.id} name={s.name} /> : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
