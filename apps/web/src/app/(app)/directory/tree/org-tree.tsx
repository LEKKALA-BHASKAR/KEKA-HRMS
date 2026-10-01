"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Avatar } from "@/components/avatar";
import { IconChevronDown } from "@/components/icons";
import s from "./tree.module.css";

export interface TreePerson {
  id: string;
  name: string;
  title: string | null;
  dept: string | null;
  photoUrl: string | null;
  managerId: string | null;
}

const ZOOMS = [0.5, 0.65, 0.8, 1] as const;

/**
 * A top-down org chart built from reporting lines. Only opened levels are
 * rendered, so a tenant of hundreds costs no more than the cards on screen.
 * The viewer's own card is highlighted and the path to it starts open.
 */
export function OrgTree({ people, rootId, viewerId }: { people: TreePerson[]; rootId: string | null; viewerId: string | null }) {
  const { byId, children, roots, teamSize } = useMemo(() => build(people), [people]);
  const top = useMemo(() => (rootId && byId.has(rootId) ? [byId.get(rootId)!] : roots), [rootId, byId, roots]);

  /** Viewer → … → top of the visible tree; empty if the viewer is not in it. */
  const viewerPath = useMemo(() => {
    const path: string[] = [];
    const topIds = new Set(top.map((t) => t.id));
    let cur = viewerId ? byId.get(viewerId) : undefined;
    while (cur && !path.includes(cur.id)) {
      path.push(cur.id);
      if (topIds.has(cur.id)) return path;
      cur = cur.managerId ? byId.get(cur.managerId) : undefined;
    }
    return [];
  }, [viewerId, byId, top]);

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Open the first level when there are only a few tops, and every manager
    // between the top and the viewer.
    const open = new Set<string>(top.length <= 3 ? top.map((t) => t.id) : []);
    viewerPath.slice(1).forEach((id) => open.add(id));
    return open;
  });
  const [zoom, setZoom] = useState<number>(1);
  const [target, setTarget] = useState<string | null>(viewerPath[0] ?? top[0]?.id ?? null);
  const scroller = useRef<HTMLDivElement>(null);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const expandAll = () => setExpanded(new Set([...children.keys()]));
  const collapseAll = () => { setExpanded(new Set()); setTarget(top[0]?.id ?? null); };
  const locateMe = () => {
    setExpanded((prev) => new Set([...prev, ...viewerPath.slice(1)]));
    setTarget(viewerPath[0] ?? null);
  };

  // Bring the target card to the middle of the viewport once it has rendered.
  useEffect(() => {
    if (!target) return;
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(`[data-node="${CSS.escape(target)}"]`);
    if (!box || !el) return;
    const b = box.getBoundingClientRect(), n = el.getBoundingClientRect();
    box.scrollTo({
      left: box.scrollLeft + (n.left + n.width / 2) - (b.left + b.width / 2),
      top: box.scrollTop + (n.top + n.height / 2) - (b.top + b.height / 2),
      behavior: "smooth",
    });
    setTarget(null);
  }, [target, expanded, zoom]);

  // Drag the background to pan, as on any chart. Mouse only; touch scrolls natively.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("a, button")) return;
    const box = scroller.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop };
    box.setPointerCapture(e.pointerId);
    box.dataset.dragging = "true";
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const box = scroller.current!;
    box.scrollLeft = d.left - (e.clientX - d.x);
    box.scrollTop = d.top - (e.clientY - d.y);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    const box = scroller.current!;
    if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId);
    delete box.dataset.dragging;
  };

  const zi = ZOOMS.indexOf(zoom as (typeof ZOOMS)[number]);
  const viewerId0 = viewerPath[0] ?? null;

  const renderNode = (p: TreePerson, above: Set<string>): React.ReactNode => {
    // A reporting cycle in the data must not render forever.
    const kids = (children.get(p.id) ?? []).filter((k) => !above.has(k.id));
    const depth = above.size;
    const open = kids.length > 0 && expanded.has(p.id);
    const total = teamSize.get(p.id) ?? 0;
    const isMe = p.id === viewerId0;
    return (
      <li key={p.id}>
        <div className={`${s.node}${isMe ? ` ${s.me}` : ""}`} data-node={p.id}>
          {isMe ? <span className={s.you}>You</span> : null}
          <Avatar name={p.name} photoUrl={p.photoUrl} size={48} />
          <Link href={`/directory/${p.id}`} className={s.name} title={p.name}>{p.name}</Link>
          <div className={s.role} title={p.title ?? undefined}>{p.title ?? "—"}</div>
          {p.dept ? <div className={s.dept} title={p.dept}>{p.dept}</div> : null}
          {kids.length > 0 && depth > 0 ? (
            <Link href={`/directory/tree?root=${p.id}`} className={s.focus} title={`Start the tree at ${p.name}`} aria-label={`Start the tree at ${p.name}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /><circle cx="12" cy="12" r="2.5" />
              </svg>
            </Link>
          ) : null}
          {kids.length > 0 ? (
            <button
              type="button"
              className={`${s.toggle}${open ? ` ${s.toggleOpen}` : ""}`}
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} ${kids.length} direct report${kids.length === 1 ? "" : "s"} of ${p.name}`}
              title={`${kids.length} direct report${kids.length === 1 ? "" : "s"}${total > kids.length ? `, ${total} in the whole team` : ""}`}
              onClick={() => toggle(p.id)}
            >
              {kids.length}
              <IconChevronDown aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {open ? <ul>{kids.map((k) => renderNode(k, new Set(above).add(p.id)))}</ul> : null}
      </li>
    );
  };

  return (
    <div className={s.frame}>
      <div className={s.toolbar} role="toolbar" aria-label="Organization tree controls">
        <div className={s.toolGroup}>
          <button type="button" className="btn sm" onClick={expandAll}>Expand all</button>
          <button type="button" className="btn sm" onClick={collapseAll}>Collapse all</button>
          {viewerPath.length ? <button type="button" className="btn sm" onClick={locateMe}>Find me</button> : null}
        </div>
        <div className={s.toolGroup}>
          <span className={s.hint}>Drag to pan</span>
          <button type="button" className="btn sm" onClick={() => setZoom(ZOOMS[Math.max(0, zi - 1)])} disabled={zi <= 0} aria-label="Zoom out">−</button>
          <span className={s.zoomValue} aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn sm" onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zi + 1)])} disabled={zi >= ZOOMS.length - 1} aria-label="Zoom in">+</button>
        </div>
      </div>
      <div
        ref={scroller}
        className={s.scroller}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className={s.canvas} style={{ zoom }}>
          <ul className={s.tree} aria-label="Organization tree">
            {top.map((p) => renderNode(p, new Set()))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Index the reporting lines once: children per manager, the tops, and team sizes. */
function build(people: TreePerson[]) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const children = new Map<string, TreePerson[]>();
  const isTop = (p: TreePerson) => !p.managerId || p.managerId === p.id || !byId.has(p.managerId);
  for (const p of people) {
    if (isTop(p)) continue;
    const list = children.get(p.managerId!) ?? [];
    list.push(p);
    children.set(p.managerId!, list);
  }

  const roots = people.filter(isTop);
  // Anyone not reachable from a top sits in a reporting cycle: show them as a top.
  const seen = new Set<string>();
  const walk = (start: TreePerson) => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      for (const k of children.get(cur.id) ?? []) stack.push(k);
    }
  };
  roots.forEach(walk);
  for (const p of people) {
    if (!seen.has(p.id)) {
      roots.push(p);
      walk(p);
    }
  }

  // Whole-team sizes, bottom-up, guarded against cycles.
  const teamSize = new Map<string, number>();
  const sizeOf = (id: string, path: Set<string>): number => {
    const known = teamSize.get(id);
    if (known !== undefined) return known;
    if (path.has(id)) return 0;
    path.add(id);
    let n = 0;
    for (const k of children.get(id) ?? []) n += 1 + sizeOf(k.id, path);
    path.delete(id);
    teamSize.set(id, n);
    return n;
  };
  people.forEach((p) => sizeOf(p.id, new Set()));

  return { byId, children, roots, teamSize };
}
