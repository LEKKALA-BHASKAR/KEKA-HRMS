import { formatINR } from "@keka/shared";
import { Badge, Empty } from "@/components/ui";
import { GrowthForm, ActButton, Reveal, type Opt } from "@/components/growth-forms";
import { updateCompItemAction, compItemOpAction } from "@/app/actions/compensation";

export interface WorksheetItem {
  id: string; employeeId: string; currentCtc: unknown; rating: unknown; eligible: boolean; ineligibleReason: string | null;
  meritPct: unknown; promotionPct: unknown; marketPct: unknown; prorationFactor: unknown; totalPct: unknown; newCtc: unknown;
  compaBefore: unknown; compaAfter: unknown; newPayGradeId: string | null; note: string | null; exceptionStatus: string; status: string;
  employee: { displayName: string | null; employeeNumber: string };
}

const EXC: Record<string, "success" | "warning" | "danger" | "neutral"> = { NONE: "neutral", PENDING: "warning", APPROVED: "success", REJECTED: "danger" };
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * The increase worksheet: one line per employee with rating, current pay,
 * merit / promotion / market increases, compa-ratio before and after, and
 * the edit, exception and skip controls the viewer is allowed.
 */
export function CompWorksheet({ items, editable, admin, grades, sessions, breaches, viewerEmployeeId }: {
  items: WorksheetItem[]; editable: boolean; admin: boolean; grades: Opt[]; sessions: Opt[];
  breaches: Map<string, string[]>; viewerEmployeeId: string | null;
}) {
  if (items.length === 0) return <Empty title="No one on this worksheet yet" />;
  return (
    <div className="table-wrap"><table className="data">
      <thead><tr><th>Employee</th><th className="num">Rating</th><th className="num">Current CTC</th><th className="num">Merit</th><th className="num">Promo</th><th className="num">Market</th><th className="num">Total</th><th className="num">New CTC</th><th className="num">Compa</th><th>Status</th><th /></tr></thead>
      <tbody>{items.map((i) => {
        const b = breaches.get(i.id) ?? [];
        const own = i.employeeId === viewerEmployeeId;
        const open = editable && i.eligible && i.status === "DRAFT" && !own;
        return (
          <tr key={i.id} style={i.status === "SKIPPED" || !i.eligible ? { opacity: 0.6 } : undefined}>
            <td><div className="text-sm strong">{i.employee.displayName}</div><div className="text-xs subtle">{i.employee.employeeNumber}{n(i.prorationFactor)! < 1 ? ` · prorated ${Math.round(n(i.prorationFactor)! * 100)}%` : ""}</div>{!i.eligible ? <div className="text-xs neg">{i.ineligibleReason}</div> : null}{i.note ? <div className="text-xs subtle">{i.note}</div> : null}</td>
            <td className="num">{n(i.rating) ?? "—"}</td>
            <td className="num">{formatINR(Number(i.currentCtc))}</td>
            <td className="num">{n(i.meritPct)}%</td>
            <td className="num">{n(i.promotionPct)}%</td>
            <td className="num">{n(i.marketPct)}%</td>
            <td className="num strong">{n(i.totalPct)}%</td>
            <td className="num">{formatINR(Number(i.newCtc))}</td>
            <td className="num text-xs">{n(i.compaBefore)?.toFixed(2) ?? "—"} → {n(i.compaAfter)?.toFixed(2) ?? "—"}</td>
            <td>
              <Badge tone={i.status === "APPLIED" ? "success" : i.status === "SKIPPED" ? "neutral" : "info"}>{i.status.toLowerCase()}</Badge>
              {i.exceptionStatus !== "NONE" ? <div><Badge tone={EXC[i.exceptionStatus] ?? "neutral"}>exception {i.exceptionStatus.toLowerCase()}</Badge></div> : null}
              {b.length && i.exceptionStatus !== "APPROVED" ? <div className="text-xs neg">{b.join(" ")}</div> : null}
            </td>
            <td>
              {open ? (
                <Reveal label="Edit">
                  <GrowthForm action={updateCompItemAction} hidden={{ itemId: i.id }} cols={1} compact submitLabel="Save" fields={[
                    { name: "meritPct", label: "Merit %", type: "number", required: true, defaultValue: n(i.meritPct) },
                    { name: "promotionPct", label: "Promotion %", type: "number", defaultValue: n(i.promotionPct) },
                    { name: "newPayGradeId", label: "New grade (promotion)", type: "select", options: grades, defaultValue: i.newPayGradeId },
                    { name: "marketPct", label: "Market adjustment %", type: "number", defaultValue: n(i.marketPct) },
                    ...(admin && sessions.length ? [{ name: "sessionId", label: "Calibration session", type: "select" as const, options: sessions }] : []),
                    { name: "note", label: "Note / justification", defaultValue: i.note },
                  ]} />
                </Reveal>
              ) : null}
              {open && b.length && !["PENDING", "APPROVED"].includes(i.exceptionStatus) ? <ActButton action={compItemOpAction} hidden={{ itemId: i.id, op: "exception" }} label="Request exception" input={{ name: "reason", placeholder: "Business reason", required: true }} /> : null}
              {editable && admin && i.status !== "APPLIED" ? <ActButton action={compItemOpAction} hidden={{ itemId: i.id, op: i.status === "SKIPPED" ? "unskip" : "skip" }} label={i.status === "SKIPPED" ? "Include" : "Leave out"} variant="ghost" /> : null}
            </td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}
