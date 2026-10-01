import type { ReactNode } from "react";

/**
 * Keka-style building blocks shared by the employee screens. Pure markup and
 * SVG — usable from server components, no client JavaScript.
 */

/** A boxed panel with a heading, as on every Keka screen. */
export function Panel({ title, subtitle, action, children, pad = true, className }: {
  title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; pad?: boolean; className?: string;
}) {
  return (
    <section className={`k-panel${className ? ` ${className}` : ""}`}>
      {title || action ? (
        <div className="k-panel-head">
          <div style={{ minWidth: 0 }}>
            {title ? <h3 className="k-panel-title">{title}</h3> : null}
            {subtitle ? <div className="k-panel-sub">{subtitle}</div> : null}
          </div>
          {action}
        </div>
      ) : null}
      <div className={pad ? "k-panel-body" : undefined}>{children}</div>
    </section>
  );
}

/** A section heading outside a panel ("Logs & Requests", "Leave Balances"). */
export function SectionTitle({ children, action, sub }: { children: ReactNode; action?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="k-section-title">
      <div>
        <h2>{children}</h2>
        {sub ? <div className="k-panel-sub">{sub}</div> : null}
      </div>
      {action}
    </div>
  );
}

/** A label over a value, the way Keka lays out details ("BANK NAME / State Bank of India"). */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="k-field">
      <div className="k-field-label">{label}</div>
      <div className="k-field-value">{children ?? <span className="subtle">—</span>}</div>
    </div>
  );
}

/**
 * A ring for one balance: how much of a whole is left. `value` of `max`
 * fills the ring; the centre shows the label.
 */
export function Ring({ value, max, size = 140, stroke = 16, colour = "var(--brand-500)", track = "var(--surface-sunken)", children }: {
  value: number; max: number; size?: number; stroke?: number; colour?: string; track?: string; children?: ReactNode;
}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : value > 0 ? 1 : 0;
  return (
    <div className="k-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={colour} strokeWidth={stroke} strokeLinecap="butt"
          strokeDasharray={`${frac * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      {children ? <div className="k-ring-label">{children}</div> : null}
    </div>
  );
}

/** A donut of several parts, each in its own colour. */
export function Donut({ parts, size = 120, stroke = 18, children }: {
  parts: Array<{ value: number; colour: string; label: string }>; size?: number; stroke?: number; children?: ReactNode;
}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const total = parts.reduce((s, p) => s + p.value, 0);
  let offset = 0;
  return (
    <div className="k-ring" style={{ width: size, height: size }} role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-sunken)" strokeWidth={stroke} />
        {total > 0 ? parts.filter((p) => p.value > 0).map((p) => {
          const len = (p.value / total) * c;
          const el = <circle key={p.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.colour} strokeWidth={stroke}
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
          offset += len;
          return el;
        }) : null}
      </svg>
      {children ? <div className="k-ring-label">{children}</div> : null}
    </div>
  );
}

/** Vertical bars with a label under each — weekly patterns, monthly stats. */
export function Bars({ data, height = 70, colour = "var(--brand-400, #608cfa)", rotateLabels }: {
  data: Array<{ label: string; value: number; title?: string }>; height?: number; colour?: string; rotateLabels?: boolean;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="k-bars">
      <div className="k-bars-plot" style={{ height }}>
        {data.map((d) => (
          <div key={d.label} className="k-bar-col" title={d.title ?? `${d.label}: ${d.value}`}>
            <div className="k-bar" style={{ height: `${(d.value / max) * 100}%`, background: colour, minHeight: d.value > 0 ? 3 : 1, opacity: d.value > 0 ? 1 : 0.35 }} />
          </div>
        ))}
      </div>
      <div className={`k-bars-labels${rotateLabels ? " rotate" : ""}`}>
        {data.map((d) => <span key={d.label}>{d.label}</span>)}
      </div>
    </div>
  );
}

const CHIP: Record<string, string> = {
  in: "#8bc34a", out: "#ef6f6f", "not-in-yet": "#4fc3d9", leave: "#9b7ede", "on-duty": "#f5b83d", wfh: "#4fc3d9",
  verified: "#5cb85c", current: "#36b8c9", closed: "#ef5350", open: "#5cb85c", woff: "#c9b48a", hldy: "#8bc34a",
  cleared: "#8faa2e", withdrawn: "#9aa3b2", pending: "#f5b83d", "not-in-use": "#ef5350",
};

/** The small uppercase chips: IN, OUT, NOT IN YET, VERIFIED, CURRENT, W-OFF… */
export function Chip({ kind, children }: { kind: keyof typeof CHIP | string; children: ReactNode }) {
  return <span className="k-chip" style={{ background: CHIP[kind] ?? "var(--text-subtle)" }}>{children}</span>;
}

/** An empty state with a line illustration. */
export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="k-empty">
      {icon ? <div className="k-empty-icon">{icon}</div> : null}
      <div className="k-empty-title">{title}</div>
      {children ? <div className="k-empty-text">{children}</div> : null}
    </div>
  );
}

/** The outlined information strip ("Your income and tax liability is being computed as per…"). */
export function InfoBanner({ tone = "info", children }: { tone?: "info" | "warning"; children: ReactNode }) {
  return <div className={`k-banner ${tone}`}><span aria-hidden="true">ⓘ</span><div>{children}</div></div>;
}

/** A thin outlined notice inside a panel ("No saved expenses to show."). */
export function Notice({ children }: { children: ReactNode }) {
  return <div className="k-notice">{children}</div>;
}
