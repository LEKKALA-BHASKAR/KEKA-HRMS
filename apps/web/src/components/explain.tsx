import type { Explanation } from "@keka/services";
import { formatINR } from "@keka/shared";
import { Card, Empty } from "./ui";

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A waterfall from one month's figure to the next. Every bar is a cause;
 * the bars add up to the change exactly, so there is no "other" to wonder
 * about unless the numbers genuinely contain one.
 */
export function ExplainCard({ title, explanation, measure }: { title: string; explanation: Explanation | null; measure: string }) {
  if (!explanation) return null;
  const e = explanation;
  if (!e.from) {
    return <Card title={title}><Empty title="Nothing to compare yet">{e.context[0]}</Empty></Card>;
  }
  const max = Math.max(1, ...e.causes.map((c) => Math.abs(c.amount)));
  const label = (y: number, m: number) => `${MONTHS[m]} ${y}`;
  return (
    <Card title={title}
      description={`${measure} ${e.change === 0 ? "did not change" : e.change > 0 ? `rose ${formatINR(e.change)}` : `fell ${formatINR(-e.change)}`} from ${label(e.from.year, e.from.month)} to ${label(e.to.year, e.to.month)}`}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <span className="text-sm muted">{label(e.from.year, e.from.month)}</span>
        <span className="num strong">{formatINR(e.from.value)}</span>
      </div>
      {e.causes.length === 0 ? <div className="text-sm subtle" style={{ marginBottom: 10 }}>No changes.</div> : (
        <div className="stack gap-2" style={{ marginBottom: 10 }}>
          {e.causes.map((c, i) => (
            <div key={i}>
              <div className="row gap-2" style={{ justifyContent: "space-between" }}>
                <span className="text-sm">{c.label}</span>
                <span className={`num text-sm strong ${c.amount >= 0 ? "pos" : "neg"}`}>{c.amount >= 0 ? "+" : "−"}{formatINR(Math.abs(c.amount))}</span>
              </div>
              <div style={{ height: 6, background: "var(--surface-2)", borderRadius: 4, marginTop: 3, position: "relative" }}>
                <div style={{
                  position: "absolute", top: 0, bottom: 0, borderRadius: 4,
                  background: c.amount >= 0 ? "var(--success)" : "var(--danger)",
                  width: `${(Math.abs(c.amount) / max) * 50}%`,
                  left: c.amount >= 0 ? "50%" : `${50 - (Math.abs(c.amount) / max) * 50}%`,
                }} />
              </div>
              {c.detail ? <div className="text-xs subtle" style={{ marginTop: 2 }}>{c.detail}</div> : null}
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
        <span className="text-sm muted">{label(e.to.year, e.to.month)}</span>
        <span className="num strong">{formatINR(e.to.value)}</span>
      </div>
      {e.context.length ? <div className="text-xs subtle" style={{ marginTop: 8 }}>{e.context.join(" ")}</div> : null}
    </Card>
  );
}
