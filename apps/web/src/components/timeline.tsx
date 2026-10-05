import type { TimelineEvent } from "@keka/services";

/** A dated list of events, newest first. Server component. */
export function Timeline({ events, empty = "Nothing yet." }: { events: TimelineEvent[]; empty?: string }) {
  if (!events.length) return <div className="muted text-sm">{empty}</div>;
  return (
    <ol className="stack gap-2" style={{ listStyle: "none", padding: 0, margin: 0, borderLeft: "2px solid var(--border)" }}>
      {events.map((e, i) => (
        <li key={i} style={{ paddingLeft: 12 }}>
          <div className="text-xs muted">{e.at.toISOString().slice(0, 10)} · {e.kind}</div>
          <div className="text-sm"><strong>{e.title}</strong></div>
          {e.detail ? <div className="text-xs muted">{e.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}
