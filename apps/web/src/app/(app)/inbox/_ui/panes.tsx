import Link from "next/link";
import Form from "next/form";
import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { IconChevronDown, IconSearch, IconInbox } from "@/components/icons";
import { EmptyState } from "@/components/keka";
import { formatDateTime, relativeTime } from "./format";
import type { PersonRef } from "./people";
import { SelectAll, RowCheck } from "./bulk";
import s from "../inbox.module.css";

/**
 * The inbox's three panes — categories, a list, a detail — as server
 * components. All state lives in the URL (`?cat=&id=&q=&sort=`), so every
 * pane is server-rendered and every view is a link someone can share.
 */

export type Sort = "newest" | "oldest";

export interface InboxNav {
  /** The tab's path: /inbox, /inbox/notifications, /inbox/archive. */
  base: string;
  cat: string;
  q: string;
  sort: Sort;
  /** Further params a tab keeps across links (e.g. unread=1). */
  extra?: Record<string, string>;
}

export function readNav(base: string, sp: Record<string, string | string[] | undefined>, extraKeys: string[] = []): InboxNav & { id: string } {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.slice(0, 200) ?? "";
  };
  const extra: Record<string, string> = {};
  for (const k of extraKeys) if (one(k)) extra[k] = one(k);
  return { base, cat: one("cat"), id: one("id"), q: one("q").trim(), sort: one("sort") === "oldest" ? "oldest" : "newest", extra };
}

/** A link within the tab, keeping the other URL state unless overridden. */
export function hrefFor(nav: InboxNav, over: { cat?: string; id?: string | null; q?: string; sort?: Sort; extra?: Record<string, string | null> } = {}): string {
  const p = new URLSearchParams();
  const cat = over.cat ?? nav.cat;
  if (cat) p.set("cat", cat);
  const id = over.id === undefined ? null : over.id;
  if (id) p.set("id", id);
  const q = over.q ?? nav.q;
  if (q) p.set("q", q);
  const sort = over.sort ?? nav.sort;
  if (sort !== "newest") p.set("sort", sort);
  const extra = { ...(nav.extra ?? {}), ...(over.extra ?? {}) };
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const qs = p.toString();
  return qs ? `${nav.base}?${qs}` : nav.base;
}

export function sortByDate<T extends { at: Date }>(items: T[], sort: Sort): T[] {
  return [...items].sort((a, b) => (sort === "oldest" ? a.at.getTime() - b.at.getTime() : b.at.getTime() - a.at.getTime()));
}

// ---------------------------------------------------------------------------
//  Frame
// ---------------------------------------------------------------------------

export function InboxFrame({ categories, children }: { categories: ReactNode; children: ReactNode }) {
  return (
    <div className={s.frame}>
      {categories}
      <div className={s.work}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Left pane — categories
// ---------------------------------------------------------------------------

export interface Category {
  key: string;
  label: string;
  icon: ReactNode;
  count?: number;
  /** Counts that need attention render in the alert colour. */
  hot?: boolean;
}

export function CategoryPane({ heading, categories, nav, action }: {
  heading: string; categories: Category[]; nav: InboxNav; action?: ReactNode;
}) {
  return (
    <nav className={s.cats} aria-label={heading}>
      <div className={s.paneHead}>
        <span>{heading}</span>
        {action}
      </div>
      <ul className={s.catList}>
        {categories.map((c) => {
          const active = c.key === nav.cat;
          return (
            <li key={c.key}>
              <Link
                href={hrefFor(nav, { cat: c.key, id: null, q: "" })}
                className={`${s.cat}${active ? ` ${s.catActive}` : ""}`}
                aria-current={active ? "page" : undefined}
                scroll={false}
              >
                <span className={s.catIcon} aria-hidden="true">{c.icon}</span>
                <span className={s.catLabel}>{c.label}</span>
                {c.count ? (
                  <span className={`${s.catCount}${c.hot ? ` ${s.catCountHot}` : ""}`} aria-label={`${c.count} items`}>{c.count}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
//  Middle pane — sort, search and the list
// ---------------------------------------------------------------------------

export interface ListItem {
  id: string;
  person: PersonRef | null;
  /** Shown in place of a person's avatar (e.g. a notification's kind). */
  icon?: ReactNode;
  /** The bold first line; the person's name when there is one. */
  heading?: string;
  title: string;
  at: Date;
  unread?: boolean;
  /** A short tag under the title ("Leave", "Approved"). */
  tag?: string;
  tagTone?: "danger" | "success";
}

export function ListPane({ label, nav, items, activeId, empty, hidden, toolbar, selectable }: {
  label: string; nav: InboxNav; items: ListItem[]; activeId?: string; empty: string;
  /** Hidden inputs to carry with a search (beyond cat and sort). */
  hidden?: Record<string, string>;
  /** Filters shown under the search box. */
  toolbar?: ReactNode;
  /** Checkboxes for bulk decisions; needs a BulkScope around the panes. */
  selectable?: boolean;
}) {
  return (
    <section className={s.list} aria-label={label}>
      <div className={s.listHead}>
        <span className={s.listHeadMain}>
          {selectable ? <SelectAll label={label} /> : null}
          <span className={s.listTitle}>{label}</span>
        </span>
        <details className={s.sort} key={nav.sort}>
          <summary aria-label={`Sort: ${nav.sort}`}>{nav.sort} <IconChevronDown width={14} height={14} /></summary>
          <div className={s.sortMenu}>
            {(["newest", "oldest"] as const).map((o) => (
              <Link key={o} href={hrefFor(nav, { sort: o, id: null })} scroll={false}
                className={o === nav.sort ? s.sortActive : undefined} aria-current={o === nav.sort ? "true" : undefined}>
                {o === "newest" ? "Newest first" : "Oldest first"}
              </Link>
            ))}
          </div>
        </details>
      </div>
      <Form action={nav.base} className={s.search} role="search" scroll={false}>
        <input type="hidden" name="cat" value={nav.cat} />
        {nav.sort !== "newest" ? <input type="hidden" name="sort" value={nav.sort} /> : null}
        {Object.entries({ ...(nav.extra ?? {}), ...(hidden ?? {}) }).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <IconSearch width={16} height={16} aria-hidden="true" />
        <input name="q" defaultValue={nav.q} placeholder="Search by employee name, task name" aria-label="Search by employee name, task name" />
      </Form>
      {toolbar ? <div className={s.toolbar}>{toolbar}</div> : null}
      {items.length === 0 ? (
        <div className={s.listEmpty}>{nav.q ? `Nothing matches “${nav.q}”.` : empty}</div>
      ) : (
        <ul className={s.items}>
          {items.map((it) => {
            const active = it.id === activeId;
            const name = it.heading ?? it.person?.name ?? "";
            return (
              <li key={it.id} className={selectable ? s.itemWrap : undefined}>
                {selectable ? <RowCheck id={it.id} label={`${name}: ${it.title}`} /> : null}
                <Link href={hrefFor(nav, { id: it.id })} scroll={false}
                  className={`${s.item}${active ? ` ${s.itemActive}` : ""}${it.unread ? ` ${s.itemUnread}` : ""}`}
                  aria-current={active ? "true" : undefined}>
                  <span className={s.itemAvatar}>
                    {it.person ? <Avatar name={it.person.name} photoUrl={it.person.photoUrl} size={36} /> : it.icon}
                  </span>
                  <span className={s.itemName}>
                    {it.unread ? <span className={s.unreadDot} aria-label="Unread" /> : null}
                    {name}
                  </span>
                  <time className={s.itemWhen} dateTime={it.at.toISOString()} title={formatDateTime(it.at)}>{relativeTime(it.at)}</time>
                  <span className={s.itemTitle}>{it.title}</span>
                  {it.tag ? <span className={`${s.itemTag}${it.tagTone ? ` ${s[`tag_${it.tagTone}`]}` : ""}`}>{it.tag}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
//  Right pane — the detail
// ---------------------------------------------------------------------------

export type Tone = "pending" | "success" | "danger" | "neutral" | "info";

export function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={`${s.pill} ${s[`tone_${tone}`]}`}>{label}</span>;
}

export interface ActivityEntry {
  who: PersonRef | null;
  text: string;
  at: Date | null;
  note?: string | null;
}

export function DetailPane({ title, sub, status, children, actions, activity, avatar, footer }: {
  title: string; sub?: ReactNode; status?: { label: string; tone: Tone };
  children?: ReactNode; actions?: ReactNode; activity: ActivityEntry[];
  /** A person beside the title, as Keka heads a request with who raised it. */
  avatar?: PersonRef;
  /** A bar pinned to the foot of the pane (comment, approve, reject). */
  footer?: ReactNode;
}) {
  const timeline = activity.filter((a) => a.at).sort((a, b) => a.at!.getTime() - b.at!.getTime());
  const pane = (
    <article className={s.detail} aria-label={title}>
      <header className={s.dHead}>
        <div style={{ minWidth: 0, display: "flex", gap: 14, alignItems: "center" }}>
          {avatar ? <Avatar name={avatar.name} photoUrl={avatar.photoUrl} size={46} /> : null}
          <div style={{ minWidth: 0 }}>
            <h2 className={s.dTitle}>{title}</h2>
            {sub ? <div className={s.dSub}>{sub}</div> : null}
          </div>
        </div>
        {status ? (
          <div className={s.dStatus}>
            <span>Status</span>
            <StatusPill {...status} />
          </div>
        ) : null}
      </header>
      {children || actions ? (
        <div className={s.dBody}>
          {children}
          {actions ? <div className={s.dActions}>{actions}</div> : null}
        </div>
      ) : null}
      <section className={s.activity} aria-label="Activity">
        <h3 className={s.actTitle}>Activity</h3>
        {timeline.length === 0 ? <p className="muted text-sm">No activity recorded yet.</p> : (
          <ol className={s.actList}>
            {timeline.map((a, i) => (
              <li key={i} className={s.act}>
                <span className={s.actAvatar}>
                  <Avatar name={a.who?.name ?? "System"} photoUrl={a.who?.photoUrl} size={34} />
                </span>
                <span className={s.actWho}>
                  {a.who?.id ? <Link href={`/directory/${a.who.id}`}>{a.who.name}</Link> : a.who?.name ?? "System"}
                </span>
                <time className={s.actWhen} dateTime={a.at!.toISOString()}>{formatDateTime(a.at!)}</time>
                <span className={s.actText}>
                  {a.text}
                  {a.note ? <q className={s.actNote}>{a.note}</q> : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
  return footer ? <div className={s.detailCol}>{pane}{footer}</div> : pane;
}

/** The right pane when nothing is selected, or the selection has moved on. */
export function DetailEmpty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={s.detailEmpty}>
      <EmptyState icon={icon ?? <IconInbox />} title={title}>{children}</EmptyState>
    </div>
  );
}

/** Who a request is from, at the top of a detail body. */
export function PersonStrip({ person, meta }: { person: PersonRef; meta?: ReactNode }) {
  return (
    <div className={s.personStrip}>
      <Avatar name={person.name} photoUrl={person.photoUrl} size={40} />
      <div style={{ minWidth: 0 }}>
        <div className={s.personName}>
          {person.id ? <Link href={`/directory/${person.id}`}>{person.name}</Link> : person.name}
        </div>
        {meta ? <div className={s.personMeta}>{meta}</div> : null}
      </div>
    </div>
  );
}

/** A grid of label/value facts. */
export function Facts({ items }: { items: Array<[string, ReactNode] | null | false> }) {
  const rows = items.filter((x): x is [string, ReactNode] => !!x);
  return (
    <dl className={s.facts}>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? <span className="subtle">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A quoted message or reason. */
export function Message({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className={s.message}>
      {label ? <div className={s.messageLabel}>{label}</div> : null}
      <div>{children}</div>
    </div>
  );
}
