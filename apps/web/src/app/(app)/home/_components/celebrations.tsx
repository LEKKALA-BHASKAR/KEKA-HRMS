"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import type { Celebrant, CelebrationGroup } from "../_lib/data";
import { IconCake, IconParty, IconJoinees, IconChevronUp } from "./icons";
import s from "../home.module.css";

type Key = CelebrationGroup["key"];

const META: Record<Key, {
  icon: typeof IconCake; one: string; many: string;
  todayTitle: string | null; upcomingTitle: string; emptyToday: string; emptyUpcoming: string;
}> = {
  birthdays: {
    icon: IconCake, one: "Birthday", many: "Birthdays",
    todayTitle: "Birthdays today", upcomingTitle: "Upcoming Birthdays",
    emptyToday: "No birthdays today.", emptyUpcoming: "No birthdays in the next 30 days.",
  },
  anniversaries: {
    icon: IconParty, one: "Work Anniversary", many: "Work Anniversaries",
    todayTitle: "Work Anniversaries today", upcomingTitle: "Upcoming Work Anniversaries",
    emptyToday: "No Work Anniversaries today.", emptyUpcoming: "No work anniversaries in the next 30 days.",
  },
  joinees: {
    icon: IconJoinees, one: "New joinee", many: "New joinees",
    todayTitle: "New joinees today", upcomingTitle: "Recent joinees",
    emptyToday: "No new joinees today.", emptyUpcoming: "No one has joined in the last 90 days.",
  },
};

/** Birthdays, work anniversaries and new joinees, one tab each. */
export function Celebrations({ groups, wished, selfId, canWish }: { groups: CelebrationGroup[]; wished?: string[]; selfId?: string | null; canWish?: boolean }) {
  const [active, setActive] = useState<Key>(groups[0]?.key ?? "birthdays");
  // Keka folds the card away when there is nothing to celebrate today.
  const [open, setOpen] = useState(() => groups.some((g) => g.count > 0));
  const id = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const group = groups.find((g) => g.key === active) ?? groups[0];
  if (!group) return null;
  const meta = META[group.key];

  const move = (delta: number) => {
    const idx = groups.findIndex((g) => g.key === active);
    const next = (idx + delta + groups.length) % groups.length;
    setActive(groups[next].key);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className={`${s.card} ${s.flush}`} aria-label="Celebrations">
      <div className={s.tabs}>
        <div role="tablist" aria-label="Celebrations" className={s.tabList}>
          {groups.map((g, k) => {
            const m = META[g.key];
            const Icon = m.icon;
            const selected = g.key === active;
            return (
              <button
                key={g.key}
                ref={(el) => { tabRefs.current[k] = el; }}
                type="button"
                role="tab"
                id={`${id}-tab-${g.key}`}
                aria-selected={selected}
                aria-controls={`${id}-panel`}
                tabIndex={selected ? 0 : -1}
                className={s.tab}
                onClick={() => { setActive(g.key); setOpen(true); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
                  if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
                }}
              >
                <Icon />
                <span>{g.count} {g.count === 1 ? m.one : m.many}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={s.iconBtn}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          aria-label={open ? "Collapse celebrations" : "Expand celebrations"}
          onClick={() => setOpen((o) => !o)}
        >
          <IconChevronUp />
        </button>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${group.key}`} hidden={!open} className={s.cardBody}>
        {meta.todayTitle ? (
          <div className={s.section}>
            <h4 className={s.sectionTitle}>{meta.todayTitle}</h4>
            {group.today.length > 0
              ? <People list={group.today} wish={canWish ? { occasion: OCCASION[group.key], done: new Set(wished ?? []), selfId: selfId ?? null } : undefined} />
              : <EmptyArt kind={group.key} text={meta.emptyToday} />}
          </div>
        ) : null}
        <div className={s.section}>
          <h4 className={s.sectionTitle}>{meta.upcomingTitle}</h4>
          {group.upcoming.length > 0 ? <People list={group.upcoming} /> : <p className={s.muted} style={{ margin: 0 }}>{meta.emptyUpcoming}</p>}
        </div>
      </div>
    </section>
  );
}

const OCCASION: Record<Key, "BIRTHDAY" | "WORK_ANNIVERSARY" | "NEW_JOINEE"> = { birthdays: "BIRTHDAY", anniversaries: "WORK_ANNIVERSARY", joinees: "NEW_JOINEE" };
const SHOWN = 11;

function People({ list, wish }: { list: Celebrant[]; wish?: { occasion: "BIRTHDAY" | "WORK_ANNIVERSARY" | "NEW_JOINEE"; done: Set<string>; selfId: string | null } }) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <ul className={s.avatarGrid} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {shown.map((p) => (
        <li key={p.id} className={s.celebrant}>
          <Link href={`/directory/${p.id}`} className={s.celebrant} style={{ gap: 6 }}>
            <Avatar name={p.name} photoUrl={p.photoUrl} size={52} />
            <span className={s.celebrantName}>{p.name}</span>
          </Link>
          {wish && p.id !== wish.selfId ? (
            wish.done.has(`${wish.occasion}:${p.id}`)
              ? <span className={s.celebrantWhen}>Wished</span>
              : <Link href={`/?wish=${p.id}&for=${wish.occasion}`} scroll={false} className={s.wishLink} title={`Wish ${p.name}`}>Wish</Link>
          ) : (
            <span className={s.celebrantWhen}>{p.when}{p.note ? <><br />{p.note}</> : null}</span>
          )}
        </li>
      ))}
      {!all && list.length > SHOWN ? (
        <li className={s.celebrant}>
          <button type="button" className={s.moreBubble} onClick={() => setAll(true)} aria-label={`Show ${list.length - SHOWN} more`}>+{list.length - SHOWN}</button>
        </li>
      ) : null}
    </ul>
  );
}

/** A small line drawing for an empty "today": bunting over a cake, or confetti. */
function EmptyArt({ kind, text }: { kind: Key; text: string }) {
  return (
    <div className={s.emptyArt}>
      <svg viewBox="0 0 132 92" fill="none" aria-hidden="true">
        <path d="M14 10 Q66 30 118 10" style={{ stroke: "var(--border-strong)" }} strokeWidth="1.5" />
        {[22, 36, 50, 64, 78, 92, 106].map((x, i) => {
          const y = 10 + Math.sin((x - 14) / 104 * Math.PI) * 14;
          return <path key={x} d={`M${x - 5} ${y} L${x} ${y + 9} L${x + 5} ${y}`} style={{ fill: i % 2 ? "var(--brand-200)" : "var(--brand-100)", stroke: "var(--brand-300)" }} strokeWidth="1" />;
        })}
        {kind === "birthdays" ? (
          <g>
            <rect x="40" y="58" width="52" height="22" rx="3" style={{ fill: "var(--brand-50)", stroke: "var(--brand-400)" }} strokeWidth="1.5" />
            <rect x="48" y="44" width="36" height="14" rx="3" style={{ fill: "var(--surface)", stroke: "var(--brand-400)" }} strokeWidth="1.5" />
            <path d="M40 66 q6.5 5 13 0 t13 0 t13 0 t13 0" style={{ stroke: "var(--brand-300)" }} strokeWidth="1.5" />
            <path d="M66 44 v-8" style={{ stroke: "var(--brand-500)" }} strokeWidth="2" strokeLinecap="round" />
            <path d="M66 28 c2 2.5 2 4.5 0 5.5 c-2 -1 -2 -3 0 -5.5z" style={{ fill: "#f5b83d" }} />
            <path d="M30 82 h72" style={{ stroke: "var(--border-strong)" }} strokeWidth="1.5" strokeLinecap="round" />
          </g>
        ) : (
          <g strokeLinecap="round" strokeWidth="2">
            <path d="M48 80 60 44 84 68z" style={{ fill: "var(--brand-50)", stroke: "var(--brand-400)" }} strokeLinejoin="round" />
            <path d="M70 40 q4 -8 12 -6 M88 50 q8 -2 10 6 M80 30 l2 -6 M98 42 l6 -2" style={{ stroke: "var(--brand-300)" }} />
            <circle cx="96" cy="30" r="2" style={{ fill: "#f5b83d" }} />
            <circle cx="104" cy="58" r="2" style={{ fill: "var(--brand-400)" }} />
            <circle cx="72" cy="26" r="1.6" style={{ fill: "var(--brand-500)" }} />
          </g>
        )}
      </svg>
      <span>{text}</span>
    </div>
  );
}
