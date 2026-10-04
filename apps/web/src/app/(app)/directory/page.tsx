import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { requireViewer } from "@/lib/context";
import { directoryWhere, DIRECTORY_SELECT, nameOf } from "@/lib/directory";
import { SubTabs } from "@/components/subtabs";
import { Avatar } from "@/components/avatar";
import { EmptyState } from "@/components/keka";
import { IconUsers } from "@/components/icons";
import { DIRECTORY_TABS } from "./tabs";
import { DirectoryFilters, type FilterDef } from "./filters";
import { CardMenu } from "./card-menu";
import s from "./directory.module.css";

export const metadata = { title: "Employee Directory — BooS-HR" };

const PAGE_SIZE = 60;
const MAX_SHOWN = 3000;

/** A card needs every directory field except the free-text "about me". */
const { aboutMe: _about, ...CARD_SELECT } = DIRECTORY_SELECT;

/** URL key → the employee column it filters and the label on the dropdown. */
const FILTERS = [
  { key: "bu", label: "Business Unit", column: "businessUnitId" },
  { key: "dept", label: "Department", column: "departmentId" },
  { key: "loc", label: "Location", column: "locationId" },
  { key: "cc", label: "Cost Center", column: "costCenterId" },
  { key: "le", label: "Legal Entity", column: "legalEntityId" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");

export default async function DirectoryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const viewer = await requireViewer();
  const tenantId = viewer.tenantId;
  const sp = await searchParams;

  const selected = Object.fromEntries(FILTERS.map((f) => [f.key, one(sp[f.key]).slice(0, 64)])) as Record<FilterKey, string>;
  const q = one(sp.q).slice(0, 100);
  const requested = Number.parseInt(one(sp.show), 10);
  const show = Number.isFinite(requested) ? Math.min(MAX_SHOWN, Math.max(PAGE_SIZE, requested)) : PAGE_SIZE;

  // Every word of the search must match one of the card's fields.
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const text = (w: string) => ({ contains: w, mode: "insensitive" as const });
  const where: Prisma.EmployeeWhereInput = {
    ...directoryWhere(tenantId),
    ...Object.fromEntries(FILTERS.filter((f) => selected[f.key]).map((f) => [f.column, selected[f.key]])),
    ...(words.length
      ? {
          AND: words.map((w) => ({
            OR: [
              { firstName: text(w) }, { lastName: text(w) }, { displayName: text(w) },
              { workEmail: text(w) }, { jobTitleName: text(w) }, { employeeNumber: text(w) },
            ],
          })),
        }
      : {}),
  };

  // Dropdown options: only units that have someone in the directory, plus
  // whatever is currently selected so the dropdown can still show it.
  const has = (key: FilterKey) => ({
    tenantId,
    OR: [{ employees: { some: directoryWhere(tenantId) } }, ...(selected[key] ? [{ id: selected[key] }] : [])],
  });
  const opt = { select: { id: true, name: true }, orderBy: { name: "asc" as const } };

  const [people, matched, bus, depts, locs, ccs, les] = await Promise.all([
    prisma.employee.findMany({
      where, select: CARD_SELECT, take: show,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }],
    }),
    prisma.employee.count({ where }),
    prisma.businessUnit.findMany({ where: has("bu"), ...opt }),
    prisma.department.findMany({ where: has("dept"), ...opt }),
    prisma.location.findMany({ where: has("loc"), ...opt }),
    prisma.costCenter.findMany({ where: has("cc"), ...opt }),
    prisma.legalEntity.findMany({ where: has("le"), ...opt }),
  ]);

  const options: Record<FilterKey, Array<{ id: string; name: string }>> = { bu: bus, dept: depts, loc: locs, cc: ccs, le: les };
  const filters: FilterDef[] = FILTERS.map((f) => ({ key: f.key, label: f.label, value: selected[f.key], options: options[f.key] }));
  const filtered = !!q || FILTERS.some((f) => selected[f.key]);

  const moreHref = (() => {
    const p = new URLSearchParams();
    for (const f of FILTERS) if (selected[f.key]) p.set(f.key, selected[f.key]);
    if (q) p.set("q", q);
    p.set("show", String(show + PAGE_SIZE));
    return `/directory?${p}`;
  })();

  return (
    <>
      <SubTabs items={DIRECTORY_TABS} />
      <h1 className={s.title}>Employee Directory</h1>

      <div className={s.filterPanel}>
        <DirectoryFilters filters={filters} q={q} filtered={filtered} />
        <div className={s.showing} aria-live="polite">
          Showing {people.length} of {matched}
        </div>
      </div>

      {people.length === 0 ? (
        <div className={s.emptyWrap}>
          <EmptyState icon={<IconUsers />} title={filtered ? "No one matches these filters" : "No employees yet"}>
            {filtered ? (
              <>Try a different search, or <Link href="/directory">clear the filters</Link>.</>
            ) : (
              "People appear here once they have joined."
            )}
          </EmptyState>
        </div>
      ) : (
        <ul className={s.grid} aria-label="Employees">
          {people.map((e) => {
            const name = nameOf(e);
            return (
              <li key={e.id} className={s.card}>
                <Link href={`/directory/${e.id}`} className={s.avatarLink} tabIndex={-1} aria-hidden="true">
                  <Avatar name={name} photoUrl={e.photoUrl} size={72} />
                </Link>
                <div className={s.cardBody}>
                  <div className={s.nameRow}>
                    <Link href={`/directory/${e.id}`} className={s.name}>{name}</Link>
                    <CardMenu id={e.id} name={name} email={e.workEmail} />
                  </div>
                  <div className={s.jobTitle}>{e.jobTitleName ?? "—"}</div>
                  <dl className={s.facts}>
                    <div className={s.fact}>
                      <dt>Department :</dt>
                      <dd title={e.department?.name}>{e.department?.name ?? "—"}</dd>
                    </div>
                    <div className={s.fact}>
                      <dt>Location :</dt>
                      <dd title={e.location?.name}>{e.location?.name ?? "—"}</dd>
                    </div>
                    <div className={s.fact}>
                      <dt>Email :</dt>
                      <dd title={e.workEmail ?? undefined}>{e.workEmail ?? "—"}</dd>
                    </div>
                  </dl>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {people.length < matched && show < MAX_SHOWN ? (
        <div className={s.more}>
          <Link href={moreHref} className="btn" scroll={false}>
            Load more <span className="subtle">({matched - people.length} more)</span>
          </Link>
        </div>
      ) : null}
    </>
  );
}
