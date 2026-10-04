import Link from "next/link";
import { requireViewer } from "@/lib/context";
import { nameOf } from "@/lib/directory";
import { loadDirectory } from "@/lib/directory-search";
import { SubTabs } from "@/components/subtabs";
import { Avatar } from "@/components/avatar";
import { EmptyState } from "@/components/keka";
import { IconUsers } from "@/components/icons";
import { SpecForm, ActionButton } from "@/components/spec-form";
import { saveDirectorySearchAction, deleteDirectorySearchAction, clearDirectoryHistoryAction } from "@/app/actions/hr-ops";
import { DIRECTORY_TABS } from "./tabs";
import { DirectoryFilters } from "./filters";
import { CardMenu } from "./card-menu";
import s from "./directory.module.css";

export const metadata = { title: "Employee Directory — BooS-HR" };

const PAGE_SIZE = 60;
const MAX_SHOWN = 3000;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");

/**
 * The employee directory: search by name, title, email, number or skill;
 * filter by unit, manager (dotted line included), employment type, tenure,
 * skill, team, division or today's shift; save searches; export what you
 * see. The company's visibility settings decide who appears.
 */
export default async function DirectoryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const requested = Number.parseInt(one(sp.show), 10);
  const show = Number.isFinite(requested) ? Math.min(MAX_SHOWN, Math.max(PAGE_SIZE, requested)) : PAGE_SIZE;
  const d = await loadDirectory(viewer, sp, { show, log: show === PAGE_SIZE });
  const { people, matched, filters, filtered, query } = d;
  const q = d.params.q;
  const moreHref = `/directory?${query ? `${query}&` : ""}show=${show + PAGE_SIZE}`;

  return (
    <>
      <SubTabs items={DIRECTORY_TABS} />
      <h1 className={s.title}>Employee Directory</h1>

      <div className={s.filterPanel}>
        <DirectoryFilters filters={filters} q={q} filtered={filtered} />
        <div className={s.showing} aria-live="polite">
          Showing {people.length} of {matched} · <a href={`/exports/core-hr/directory${query ? `?${query}` : ""}`}>Export CSV</a>
        </div>
      </div>

      <div className="row gap-2 wrap" style={{ margin: "10px 0", alignItems: "center" }}>
        {d.saved.length ? <span className="text-xs muted">Saved:</span> : null}
        {d.saved.map((x) => (
          <span key={x.id} className="row gap-1" style={{ alignItems: "center" }}>
            <Link className="btn sm" href={`/directory?${x.query}`}>{x.name}</Link>
            <ActionButton action={deleteDirectorySearchAction} hidden={{ id: x.id }} label="×" />
          </span>
        ))}
        {d.recent.length ? <span className="text-xs muted" style={{ marginLeft: 8 }}>Recent:</span> : null}
        {d.recent.map((r) => <Link key={r.id} className="btn ghost sm" href={`/directory?${r.query}`}>{decodeURIComponent(r.query.replace(/\+/g, " ")).slice(0, 40)}</Link>)}
        {d.recent.length ? <ActionButton action={clearDirectoryHistoryAction} hidden={{}} label="Clear history" /> : null}
        {filtered ? (
          <div style={{ marginLeft: "auto" }}>
            <SpecForm compact action={saveDirectorySearchAction} hidden={{ query }} submitLabel="Save this search" fields={[{ name: "name", label: "Name", required: true, placeholder: "e.g. Bengaluru engineers" }]} />
          </div>
        ) : null}
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
