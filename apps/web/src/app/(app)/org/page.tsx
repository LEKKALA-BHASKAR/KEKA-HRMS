import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, KeyValue, Callout, Money } from "@/components/ui";

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
}: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireAuth(P.ORG_VIEW);
  const sp = await searchParams;
  const tab = (TABS.includes(sp.tab as Tab) ? sp.tab : "entities") as Tab;

  const [entities, businessUnits, locations, bands, grades, workerTypes, costCenters, series] =
    await Promise.all([
      prisma.legalEntity.findMany({
        where: { tenantId: viewer.tenantId },
        include: {
          signatories: true,
          bankAccounts: true,
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
    ]);

  return (
    <>
      <PageHead
        title="Organisation"
        subtitle="Legal entity → business unit → department, with location as a parallel dimension that drives state statutory rules"
      />

      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t} href={`/org?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>
            {TAB_LABEL[t]}
          </Link>
        ))}
      </div>

      {tab === "entities" ? (
        <div className="stack gap-4">
          <Callout tone="info" title="The legal entity carries identity, not statute">
            Statutory registrations — PF, ESI, PT, LWF and income tax — live on the
            <strong> pay group</strong>, not here. Moving an employee between companies is a
            pay-group change, which is what synchronises their legal entity.
          </Callout>

          {entities.map((e) => (
            <Card
              key={e.id}
              title={e.legalName}
              description={`${e.businessType ?? "—"} · ${e.sector ?? "—"}`}
              action={<Badge tone="brand">{e._count.employees} employees</Badge>}
            >
              <div className="grid grid-3" style={{ alignItems: "start" }}>
                <KeyValue items={[
                  ["Internal name", e.name],
                  ["CIN", <span className="mono text-sm" key="c">{e.cin ?? "—"}</span>],
                  ["Incorporated", formatDate(e.dateOfIncorporation)],
                  ["Country", e.countryCode],
                  ["Currency", e.currency],
                  ["Business units", e._count.businessUnits],
                  ["Pay groups", e._count.payGroups],
                  ["Registered address", [e.addressLine1, e.city, e.state, e.postalCode].filter(Boolean).join(", ")],
                ]} />

                <div>
                  <div className="stat-label" style={{ marginBottom: 8 }}>Authorised signatories</div>
                  <div className="stack gap-2">
                    {e.signatories.map((s) => (
                      <div key={s.id}>
                        <div className="strong text-sm">{s.name}</div>
                        <div className="text-xs subtle">{s.designation}</div>
                        <div className="mono text-xs subtle">{s.pan ?? "PANNOTAVBL"}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="stat-label" style={{ marginBottom: 8 }}>Bank accounts</div>
                  <div className="stack gap-2">
                    {e.bankAccounts.map((b) => (
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
            </Card>
          ))}
        </div>
      ) : null}

      {tab === "structure" ? (
        <div className="stack gap-4">
          {businessUnits.map((bu) => (
            <Card
              key={bu.id}
              title={bu.name}
              description={`${bu.legalEntity.name}${bu.head ? ` · headed by ${bu.head.displayName}` : ""}`}
              action={<Badge tone="neutral">{bu._count.employees} employees</Badge>}
              tight
            >
              {bu.departments.length === 0 ? (
                <Empty title="No departments in this business unit" />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Department</th><th>Code</th><th>Department head</th><th className="num">Employees</th></tr>
                    </thead>
                    <tbody>
                      {bu.departments.map((d) => (
                        <tr key={d.id}>
                          <td className="strong">{d.name}</td>
                          <td className="mono text-xs">{d.code ?? "—"}</td>
                          <td>
                            {d.head ? (
                              <Link href={`/employees/${d.head.id}`}>{d.head.displayName}</Link>
                            ) : <span className="subtle">Unassigned — no implicit Department Head</span>}
                          </td>
                          <td className="num">{d._count.employees}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}

          <Card title="Cost centres" tight>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Cost centre</th><th>Code</th><th className="num">Employees</th></tr></thead>
                <tbody>
                  {costCenters.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td className="mono text-xs">{c.code ?? "—"}</td>
                      <td className="num">{c._count.employees}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "locations" ? (
        <Card
          title="Locations"
          description="An employee's office location is what maps them to a registered state for Professional Tax and Labour Welfare Fund."
          tight
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Location</th><th>Code</th><th>City</th><th>State</th>
                  <th className="num">Employees</th><th>PT registration</th><th>LWF registration</th>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {tab === "grades" ? (
        <div className="grid grid-3" style={{ alignItems: "start" }}>
          <Card title="Bands" tight>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th className="num">Rank</th><th>Band</th><th className="num">People</th></tr></thead>
                <tbody>
                  {bands.map((b) => (
                    <tr key={b.id}>
                      <td className="num">{b.rank}</td>
                      <td>{b.name}</td>
                      <td className="num">{b._count.employees}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Pay grades" tight>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Grade</th><th className="num">Min</th><th className="num">Mid</th><th className="num">Max</th><th className="num">People</th></tr></thead>
                <tbody>
                  {grades.map((g) => (
                    <tr key={g.id}>
                      <td className="strong">{g.name}</td>
                      <td className="num"><Money value={g.minAnnual} compact /></td>
                      <td className="num"><Money value={g.midAnnual} compact /></td>
                      <td className="num"><Money value={g.maxAnnual} compact /></td>
                      <td className="num">{g._count.employees}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Worker types" tight>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Type</th><th>Contingent</th><th className="num">People</th></tr></thead>
                <tbody>
                  {workerTypes.map((w) => (
                    <tr key={w.id}>
                      <td>{w.name}</td>
                      <td>{w.isContingent ? <Badge tone="info">26Q TDS</Badge> : <span className="subtle">—</span>}</td>
                      <td className="num">{w._count.employees}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "numbering" ? (
        <Card
          title="Employee number series"
          description="Prefix, digit width, suffix and next number. Multiple series can run side by side — one for permanent staff, another for contingent workers."
          tight
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Series</th><th>Pattern</th><th>Prefix</th><th className="num">Digits</th><th>Suffix</th><th className="num">Next</th><th>Status</th></tr>
              </thead>
              <tbody>
                {series.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="strong">{s.name}</span>
                      {s.isDefault ? <Badge tone="brand">Default</Badge> : null}
                      <div className="text-xs subtle">{s.description}</div>
                    </td>
                    <td className="mono">
                      {s.prefix}{"0".repeat(s.digits - 1)}{"N"}{s.suffix}
                    </td>
                    <td className="mono">{s.prefix || "—"}</td>
                    <td className="num">{s.digits}</td>
                    <td className="mono">{s.suffix || "—"}</td>
                    <td className="num">{s.nextNumber}</td>
                    <td>{s.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
