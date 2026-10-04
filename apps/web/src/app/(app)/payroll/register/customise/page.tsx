import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { REGISTER_COLUMNS, registerLayout } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Empty, Callout } from "@/components/ui";
import { DepthForm } from "../../_forms/depth";
import { saveRegisterLayoutAction } from "@/app/actions/payroll-depth";

const P = PERMISSIONS;

/**
 * Customise pay register: tick the columns to show and number their order.
 * Employee number, name and payable days always lead; the earnings and
 * deductions components can be moved but not removed.
 */
export default async function CustomiseRegisterPage({ searchParams }: { searchParams: Promise<{ payGroup?: string }> }) {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const sp = await searchParams;
  const groups = await prisma.payGroup.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true, payRegisterConfig: true }, orderBy: { name: "asc" } });
  const group = groups.find((g) => g.id === sp.payGroup) ?? groups[0];
  if (!group) return <Card><Empty title="No pay groups yet" /></Card>;
  const layout = registerLayout(group.payRegisterConfig?.columns);
  const ordered = [...layout.map((k) => REGISTER_COLUMNS.find((c) => c.key === k)!).filter(Boolean), ...REGISTER_COLUMNS.filter((c) => !layout.includes(c.key))];
  const fixed = new Set(["earnings", "deductions"]);

  return (
    <>
      <PageHead title="Customise pay register" subtitle={`${group.name} — choose and order the register's columns`}
        actions={<Link className="btn" href="/payroll/register">Back to register</Link>} />
      {groups.length > 1 ? (
        <div className="row gap-2 wrap" style={{ marginBottom: 12 }}>
          {groups.map((g) => <Link key={g.id} className={`btn sm${g.id === group.id ? " primary" : ""}`} href={`/payroll/register/customise?payGroup=${g.id}`}>{g.name}</Link>)}
        </div>
      ) : null}
      <Callout tone="warning" title="Applies to every month">
        The layout belongs to the pay group, so it changes how every past and future month's register and CSV look. Employee number, name, month and
        payable days always come first; the salary components (earnings, deductions) cannot be removed, only moved.
      </Callout>
      <div style={{ height: 14 }} />
      <Card title="Columns" description="Tick a column to show it; the numbers set the order (lowest first)." tight>
        <div style={{ padding: 16 }}>
          <DepthForm action={saveRegisterLayoutAction} submitLabel="Save layout" hidden={{ payGroupId: group.id }}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Show</th><th>Column</th><th>Group</th><th className="num">Order</th></tr></thead>
                <tbody>
                  {ordered.map((c) => {
                    const on = layout.includes(c.key);
                    return (
                      <tr key={c.key}>
                        <td>
                          {fixed.has(c.key)
                            ? <><input type="checkbox" checked readOnly disabled aria-label={c.label} /><input type="hidden" name="col" value={c.key} /></>
                            : <input type="checkbox" name="col" value={c.key} defaultChecked={on} aria-label={c.label} />}
                        </td>
                        <td>{c.label}</td>
                        <td className="text-xs subtle">{c.group}</td>
                        <td className="num"><input className="input num" name={`pos_${c.key}`} type="number" min={1} max={99} defaultValue={on ? layout.indexOf(c.key) + 1 : 50 + REGISTER_COLUMNS.indexOf(c)} style={{ width: 70, padding: "4px 8px" }} aria-label={`Order of ${c.label}`} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <label className="checkbox-row" style={{ marginTop: 10 }}>
              <input type="checkbox" name="showOutsideCtc" defaultChecked={group.payRegisterConfig?.showOutsideCtc ?? false} />
              <span className="text-sm">Show components paid outside CTC</span>
            </label>
          </DepthForm>
        </div>
      </Card>
    </>
  );
}
