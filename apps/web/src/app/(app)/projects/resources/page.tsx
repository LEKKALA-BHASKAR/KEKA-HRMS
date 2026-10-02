import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { plannerResources, planWeeks, weeklyLoad, loadTone, costLabel } from "@keka/services/src/psa";
import { requireViewer, canAny, can } from "@/lib/context";
import { forbidden } from "next/navigation";
import { PageHead, Card, Empty, Badge } from "@/components/ui";
import { ResourceTabs, iso } from "./nav";
import { AllocateForm, AllocationOps } from "./forms";

const TONE = { free: "var(--surface-sunken)", part: "#cfe3f7", full: "#9fd3a5", over: "#f4b4a8" } as const;

/** Projects › Resources: who is on what, week by week, and who is free. */
export default async function ResourcePlanner({ searchParams }: { searchParams: Promise<{ q?: string; from?: string; weeks?: string; bench?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.RESOURCE_VIEW, P.RESOURCE_MANAGE])) forbidden();
  const manage = can(viewer, P.RESOURCE_MANAGE);
  const sp = await searchParams;
  const n = [4, 8, 12].includes(Number(sp.weeks)) ? Number(sp.weeks) : 8;
  const start = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? new Date(`${sp.from}T00:00:00Z`) : new Date();
  const weeks = planWeeks(start, n);
  const to = new Date(weeks.at(-1)!.getTime() + 6 * 86_400_000);
  const people = (await plannerResources(viewer.tenantId, weeks[0]!, to, sp.q?.trim() || undefined)).map((p) => ({ ...p, load: weeklyLoad(p.allocations, weeks, p.capacity) }));
  const bench = sp.bench === "1";
  const shown = bench ? people.filter((p) => p.load.some((l) => l.hard < 100)) : people;
  const [projects, roles] = manage ? await Promise.all([
    prisma.project.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.billingRole.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { name: true }, orderBy: { name: "asc" } }),
  ]) : [[], []];
  const qs = (patch: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: sp.q, from: iso(weeks[0]!), weeks: n, bench: bench ? 1 : undefined, ...patch })) if (v !== undefined && v !== "") u.set(k, String(v));
    return u.toString();
  };
  const shift = (w: number) => iso(new Date(weeks[0]!.getTime() + w * 7 * 86_400_000));
  const fullyFree = people.filter((p) => p.load.every((l) => l.hard === 0)).length;
  const over = people.filter((p) => p.load.some((l) => l.hard + l.soft > 100)).length;

  return (
    <>
      <PageHead title="Resource planner" subtitle={`${iso(weeks[0]!)} to ${iso(to)} · ${people.length} people · ${fullyFree} with nothing planned · ${over} overbooked counting soft plans`}
        actions={<Link className="btn" href="/projects?tab=projects">Projects</Link>} />
      <ResourceTabs viewer={viewer} active="/projects/resources" />
      <div className="stack gap-3">
        {manage ? (
          <Card title="Allocate" description={roles.length ? "Hard allocations cannot take anyone past 100% on any day; soft ones are pencil marks and may overlap." : undefined}>
            {roles.length ? <AllocateForm projects={projects.map((p) => ({ value: p.id, label: p.name }))} people={people.map((p) => ({ value: p.id, label: `${p.name} (${p.number})` }))} roles={roles.map((r) => r.name)} />
              : <Empty title="Add billing roles first"><Link href="/projects/resources/settings">Roles & cost</Link></Empty>}
          </Card>
        ) : null}
        <Card tight title="Weekly load" description="Peak share of each working week on hard allocations; a + shows soft plans on top."
          action={
            <form className="row gap-2">
              <input className="input" name="q" defaultValue={sp.q} placeholder="Name, number or title" style={{ padding: "4px 6px", fontSize: 13, width: 180 }} aria-label="Search" />
              <input type="hidden" name="from" value={iso(weeks[0]!)} />
              <select className="select" name="weeks" defaultValue={String(n)} style={{ padding: "4px 6px", fontSize: 13 }} aria-label="Weeks">{[4, 8, 12].map((w) => <option key={w} value={w}>{w} weeks</option>)}</select>
              <label className="row gap-1 text-sm"><input type="checkbox" name="bench" value="1" defaultChecked={bench} /> Bench only</label>
              <button className="btn sm">Apply</button>
              <Link className="btn sm" href={`/projects/resources?${qs({ from: shift(-n) })}`}>‹</Link>
              <Link className="btn sm" href={`/projects/resources?${qs({ from: shift(n) })}`}>›</Link>
            </form>
          }>
          {shown.length === 0 ? <Empty title="Nobody matches" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Person</th>{weeks.map((w) => <th key={w.getTime()} className="num" style={{ minWidth: 58 }}>{iso(w).slice(5)}</th>)}<th>Allocations</th></tr></thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id}>
                      <td style={{ minWidth: 190 }}>
                        <Link href={`/employees/${p.id}`} className="strong">{p.name}</Link>
                        <div className="text-xs subtle">{p.number}{p.title ? ` · ${p.title}` : ""}{costLabel(p.profile) ? ` · ${costLabel(p.profile)}` : ""}</div>
                      </td>
                      {p.load.map((l, i) => (
                        <td key={i} className="num" style={{ background: TONE[loadTone(l.hard)], fontWeight: l.hard > 100 ? 700 : undefined }} title={`Hard ${l.hard}%${l.soft ? `, soft ${l.soft}%` : ""}`}>
                          {l.hard ? `${l.hard}%` : <span className="subtle">0</span>}{l.soft ? <span className="text-xs" style={{ color: "var(--text-muted)" }}> +{l.soft}</span> : null}
                        </td>
                      ))}
                      <td style={{ minWidth: 260 }}>
                        <div className="stack gap-1">
                          {p.allocations.map((a) => (
                            <div key={a.id} className="row gap-2 text-sm wrap">
                              <Link href={`/projects/${a.projectId}`}>{a.projectName}</Link>
                              <span className="subtle">{a.allocationPercent}% · {iso(a.startDate)}{a.endDate ? ` to ${iso(a.endDate)}` : " onwards"}</span>
                              {a.kind === "SOFT" ? <Badge tone="warning">Soft</Badge> : null}
                              {manage ? <AllocationOps id={a.id} soft={a.kind === "SOFT"} /> : null}
                            </div>
                          ))}
                          {p.allocations.length === 0 ? <span className="subtle text-sm">On the bench</span> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
