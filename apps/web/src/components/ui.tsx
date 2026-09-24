import type { ReactNode } from "react";
import { formatINR, formatINRCompact } from "@keka/shared";

/** Shared presentational primitives. Server components — no client JS. */

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return <div className={`avatar${size === "lg" ? " lg" : size === "sm" ? " sm" : ""}`}>{initials}</div>;
}

export function Person({
  name, meta, size = "md",
}: { name: string; meta?: string | null; size?: "sm" | "md" | "lg" }) {
  return (
    <div className="person">
      <Avatar name={name} size={size} />
      <div style={{ minWidth: 0 }}>
        <div className="person-name">{name}</div>
        {meta ? <div className="person-meta">{meta}</div> : null}
      </div>
    </div>
  );
}

type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

export function Badge({ children, tone = "neutral", dot }: { children: ReactNode; tone?: BadgeTone; dot?: boolean }) {
  return (
    <span className={`badge ${tone}`}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

const EMPLOYEE_STATUS_TONE: Record<string, BadgeTone> = {
  CONFIRMED: "success",
  PROBATION: "warning",
  NOTICE_PERIOD: "danger",
  ONBOARDING: "info",
  PREBOARDING: "info",
  EXITED: "neutral",
  INACTIVE: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  const label = status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return <Badge tone={EMPLOYEE_STATUS_TONE[status] ?? "neutral"} dot>{label}</Badge>;
}

const RUN_STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: "neutral",
  IN_PROGRESS: "info",
  PENDING_APPROVAL: "warning",
  LOCKED: "brand",
  FINALIZED: "success",
  ROLLED_BACK: "danger",
};

export function RunStatusBadge({ status }: { status: string }) {
  const label = status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return <Badge tone={RUN_STATUS_TONE[status] ?? "neutral"} dot>{label}</Badge>;
}

export function Money({
  value, compact, className, showZero = true,
}: { value: unknown; compact?: boolean; className?: string; showZero?: boolean }) {
  const n = value === null || value === undefined ? 0 : Number(value);
  if (!showZero && n === 0) return <span className="subtle">—</span>;
  return (
    <span className={`num ${className ?? ""}`}>
      {compact ? formatINRCompact(n) : formatINR(n)}
    </span>
  );
}

export function Stat({
  label, value, meta, tone,
}: { label: string; value: ReactNode; meta?: ReactNode; tone?: "pos" | "neg" }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ""}`}>{value}</div>
      {meta ? <div className="stat-meta">{meta}</div> : null}
    </div>
  );
}

export function Card({
  title, description, action, children, footer, tight,
}: {
  title?: ReactNode; description?: ReactNode; action?: ReactNode;
  children: ReactNode; footer?: ReactNode; tight?: boolean;
}) {
  return (
    <div className="card">
      {title || action ? (
        <div className="card-head">
          <div>
            {title ? <div className="card-title">{title}</div> : null}
            {description ? <div className="card-desc">{description}</div> : null}
          </div>
          {action}
        </div>
      ) : null}
      <div className={`card-body${tight ? " tight" : ""}`}>{children}</div>
      {footer ? <div className="card-foot">{footer}</div> : null}
    </div>
  );
}

export function PageHead({
  title, subtitle, actions,
}: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-title-group">
        <h1>{title}</h1>
        {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div className="row gap-2 wrap no-print">{actions}</div> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div className="text-sm">{children}</div> : null}
    </div>
  );
}

export function Callout({
  tone = "info", title, children,
}: { tone?: "info" | "warning" | "danger" | "success"; title?: ReactNode; children: ReactNode }) {
  return (
    <div className={`callout ${tone}`}>
      <div>
        {title ? <div className="callout-title">{title}</div> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function KeyValue({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v ?? <span className="subtle">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Progress({ value, max = 100, tone }: { value: number; max?: number; tone?: "success" | "warning" }) {
  const pct = max === 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="progress">
      <div className={`progress-bar ${tone ?? ""}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Denied access is an expected outcome, not an exception. Pages that check a
 * specific record render this instead of throwing, so the viewer gets a clear
 * page rather than an error boundary.
 */
export function AccessDenied({
  permission, what,
}: { permission: string; what?: string }) {
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <div className="card-body">
        <h2 style={{ marginBottom: 6 }}>You do not have access{what ? ` to ${what}` : ""}</h2>
        <p className="muted text-sm" style={{ marginBottom: 14 }}>
          This needs the <span className="mono">{permission}</span> permission, and none of
          your roles grant it here. Role scopes narrow access by department and location,
          so a colleague with the same role may still be able to see this.
        </p>
        <a className="btn" href="/employees">Back to employees</a>
      </div>
    </div>
  );
}
