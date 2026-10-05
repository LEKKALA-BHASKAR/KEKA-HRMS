import Link from "next/link";
import { prisma } from "@keka/db";
import { NOMINEE_BENEFITS } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Empty, Callout } from "@/components/ui";
import { GridForm } from "@/components/grid-form";
import { saveNomineeSharesAction } from "@/app/actions/core2-people";

export const metadata = { title: "My nominees — BooS-HR" };

/**
 * Who receives each benefit if something happens to me, and in what share:
 * provident fund, pension, gratuity and group insurance, each adding up to
 * 100%.
 */
export default async function NomineesPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) return <><PageHead title="My nominees" /><Card><Empty title="No employee profile" /></Card></>;
  const me = viewer.employee.id;
  const [deps, shares] = await Promise.all([
    prisma.dependent.findMany({ where: { employeeId: me }, select: { id: true, name: true, relationship: true }, orderBy: { name: "asc" } }),
    prisma.nomineeAllocation.findMany({ where: { tenantId: viewer.tenantId, employeeId: me } }),
  ]);
  return (
    <>
      <PageHead title="My nominees" subtitle="Share of each benefit by dependent" actions={<Link className="btn" href="/me/changes">My dependents</Link>} />
      {!deps.length ? <Callout tone="info">Add your dependents under My details first; nominees are chosen from them.</Callout> : null}
      {deps.length ? (Object.entries(NOMINEE_BENEFITS) as Array<[string, string]>).map(([benefit, label]) => {
        const total = shares.filter((s) => s.benefit === benefit).reduce((t, s) => t + s.sharePct, 0);
        return (
          <Card key={benefit} title={label} description={total ? `${total}% allocated` : "No nominees yet"}>
            <GridForm action={saveNomineeSharesAction} hidden={{ benefit }} submitLabel={`Save ${label.toLowerCase()} nominees`}>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Dependent</th><th>Relationship</th><th>Share (%)</th></tr></thead>
                <tbody>{deps.map((d) => (
                  <tr key={d.id}><td>{d.name}</td><td className="text-sm">{d.relationship}</td>
                    <td><input className="input" type="number" min={0} max={100} step={1} name={`share:${d.id}`} defaultValue={shares.find((s) => s.benefit === benefit && s.dependentId === d.id)?.sharePct ?? ""} style={{ width: 100 }} aria-label={`${d.name}'s share of ${label}`} /></td></tr>
                ))}</tbody>
              </table></div>
            </GridForm>
          </Card>
        );
      }) : null}
    </>
  );
}
