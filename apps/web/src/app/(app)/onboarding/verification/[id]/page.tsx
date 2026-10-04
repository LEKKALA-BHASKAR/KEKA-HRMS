import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  BGV_CHECK_FIELDS, BGV_REASON_CODES, BGV_PRIORITIES, BGV_SEVERITIES, BGV_ITEM_OPEN, bgvSlaState, bgvConsentState, bgvRollup,
} from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, KeyValue, Empty } from "@/components/ui";
import { Table, Pill } from "@/components/gov-ui";
import { SpecForm, ActButton, type FieldSpec } from "@/components/gov-forms";
import { fmtDay, fmtTime, pretty, opts } from "@/lib/engage-depth";
import {
  updateBgvItemAction, recheckBgvItemAction, uploadBgvEvidenceAction, proposeBgvResultAction, amendBgvResultAction, bgvCaseOpAction,
} from "@/app/actions/join-bgv";

const P = PERMISSIONS;

/** One verification case: each check with its own data and status, the result and its approval, evidence, and the full audit trail. */
export default async function VerificationCasePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const { id } = await params;
  const c = await prisma.bgvCheck.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { items: { orderBy: { createdAt: "asc" } }, employee: { select: { id: true, displayName: true, employeeNumber: true, dateOfJoining: true, status: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } },
  });
  if (!c?.employee || !canAccessEmployee(viewer, c.employee, P.BGV_MANAGE)) notFound();
  const [events, users, vendor] = await Promise.all([
    prisma.bgvCaseEvent.findMany({ where: { tenantId: viewer.tenantId, bgvCheckId: c.id }, orderBy: { createdAt: "desc" } }),
    prisma.user.findMany({ where: { tenantId: viewer.tenantId, isDeactivated: false, loginDisabled: false }, select: { id: true, email: true }, orderBy: { email: "asc" } }),
    c.vendorId ? prisma.bgvVendor.findFirst({ where: { id: c.vendorId, tenantId: viewer.tenantId } }) : null,
  ]);
  const email = new Map(users.map((u) => [u.id, u.email]));
  const now = new Date();
  const open = ["INITIATED", "IN_PROGRESS"].includes(c.status);
  const current = c.items.filter((i) => !c.items.some((n) => n.recheckOfId === i.id));
  const evidence = events.filter((e) => e.kind === "EVIDENCE");
  const reasonOpts = Object.entries(BGV_REASON_CODES).map(([k, v]) => ({ value: k, label: `${v.label} (${v.severity.toLowerCase()})` }));
  return (
    <>
      <PageHead title={`Verification: ${c.employee.displayName}`} subtitle={`${c.employee.employeeNumber} · opened ${fmtDay(c.initiatedAt)}${c.vendor ? ` · ${c.vendor}` : ""}`}
        actions={<Link className="btn" href="/onboarding/verification">Back to queue</Link>} />
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }}>
        <div className="stack gap-4">
          {current.length === 0 ? <Card><Empty title="This case has no per-check records">It was opened before checks were tracked one by one.</Empty></Card> : null}
          {c.items.map((i) => {
            const superseded = c.items.some((n) => n.recheckOfId === i.id);
            const details = (i.details ?? {}) as Record<string, string>;
            const fields: FieldSpec[] = [
              { name: "status", label: "Status", type: "select", options: opts(["PENDING", "IN_PROGRESS", "VERIFIED", "DISCREPANCY", "FAILED", "UNABLE_TO_VERIFY", "WAIVED"]), defaultValue: i.status === "PENDING_REVIEW" ? i.proposedStatus : i.status },
              ...(vendor?.stages.length ? [{ name: "vendorStage", label: "Vendor stage", type: "select" as const, options: vendor.stages.map((s) => ({ value: s, label: s })), defaultValue: i.vendorStage }] : [{ name: "vendorStage", label: "Stage", defaultValue: i.vendorStage }]),
              { name: "reasonCode", label: "Reason code", type: "select", options: reasonOpts, placeholder: "None", defaultValue: i.reasonCode, hint: "Required for an adverse outcome" },
              { name: "severity", label: "Severity", type: "select", options: opts(BGV_SEVERITIES), placeholder: "From the reason code", defaultValue: i.severity },
              ...(BGV_CHECK_FIELDS[i.checkType] ?? []).map((fl) => ({ name: `d_${fl.key}`, label: fl.label, defaultValue: details[fl.key] ?? null })),
              { name: "findings", label: "Findings", type: "textarea", defaultValue: i.findings, wide: true },
            ];
            return (
              <Card key={i.id} title={`${pretty(i.checkType)} check${i.recheckOfId ? " (recheck)" : ""}`} description={`SLA ${pretty(bgvSlaState(i.slaDueAt, i.completedAt, now))} · due ${fmtDay(i.slaDueAt)}${i.cost !== null ? ` · ₹${Number(i.cost)}` : ""}${superseded ? " · superseded by a recheck" : ""}`}
                action={<Pill s={i.status} />}>
                {i.reasonCode ? <div className="text-sm"><Badge tone={i.severity === "CRITICAL" ? "danger" : "warning"}>{pretty(i.severity ?? "")}</Badge> {BGV_REASON_CODES[i.reasonCode]?.label}</div> : null}
                {i.status === "PENDING_REVIEW" ? <div className="text-sm warn">Proposed {pretty(i.proposedStatus ?? "")} — waiting for a verification reviewer in the inbox.</div> : null}
                {open && !superseded && i.status !== "PENDING_REVIEW" && BGV_ITEM_OPEN.includes(i.status) ? <SpecForm action={updateBgvItemAction} hidden={{ id: i.id }} submitLabel="Save check" fields={fields} /> : null}
                {!superseded && !BGV_ITEM_OPEN.includes(i.status) ? (
                  <div className="stack gap-2" style={{ marginTop: 8 }}>
                    <KeyValue items={Object.entries(details).map(([k, v]) => [(BGV_CHECK_FIELDS[i.checkType] ?? []).find((x) => x.key === k)?.label ?? k, v])} />
                    {i.findings ? <div className="text-sm muted">{i.findings}</div> : null}
                    <ActButton action={recheckBgvItemAction} hidden={{ id: i.id }} label="Run again" input={{ name: "reason", placeholder: "Why recheck", required: true }} />
                  </div>
                ) : null}
              </Card>
            );
          })}
          <Card tight title="Audit trail">
            <Table head={["When", "Event", "Detail", "By"]} empty={!events.length}>
              {events.map((e) => <tr key={e.id}><td className="text-xs nowrap">{fmtTime(e.createdAt)}</td><td><Badge>{pretty(e.kind)}</Badge></td><td className="text-sm">{(e.note ?? "").replace(/\s*\[file:[^\]]+\]/, "")}</td><td className="text-xs">{e.actorUserId ? email.get(e.actorUserId) : "system"}</td></tr>)}
            </Table>
          </Card>
        </div>
        <div className="stack gap-4">
          <Card title="Case">
            <KeyValue items={[
              ["Status", <Pill key="s" s={c.status} />],
              ["Proposed result", c.proposedStatus ? pretty(c.proposedStatus) : "—"],
              ["From the checks", current.length ? pretty(bgvRollup(current)) : "—"],
              ["Priority", pretty(c.priority)],
              ["SLA", `${pretty(bgvSlaState(c.slaDueAt, c.completedAt, now))} (${fmtDay(c.slaDueAt)})`],
              ["Consent", `${pretty(bgvConsentState(c, now))}${c.consentExpiresAt ? ` until ${fmtDay(c.consentExpiresAt)}` : ""}`],
              ["Assignee", c.assigneeUserId ? email.get(c.assigneeUserId) ?? "—" : "—"],
              ["Escalation", c.escalationLevel ? `level ${c.escalationLevel}` : "none"],
              ["Cost", `₹${c.items.reduce((s, i) => s + Number(i.cost ?? 0), 0)}`],
            ]} />
            {c.findings ? <div className="text-sm muted" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{c.findings}</div> : null}
          </Card>
          {open && !c.proposedStatus ? (
            <Card title="Close the case" description="The result takes effect once a verification approver signs off.">
              <SpecForm action={proposeBgvResultAction} hidden={{ id: c.id }} columns={1} submitLabel="Send for approval" fields={[
                { name: "status", label: "Result", type: "select", options: opts(["CLEAR", "DISCREPANCY", "FAILED"]), placeholder: "From the checks" },
                { name: "findings", label: "Summary", type: "textarea" },
              ]} />
            </Card>
          ) : null}
          {["CLEAR", "DISCREPANCY", "FAILED"].includes(c.status) && !c.proposedStatus ? (
            <Card title="Amend the result">
              <SpecForm action={amendBgvResultAction} hidden={{ id: c.id }} columns={1} submitLabel="Propose amendment" fields={[
                { name: "status", label: "Amended result", type: "select", required: true, options: opts(["CLEAR", "DISCREPANCY", "FAILED"]) },
                { name: "reason", label: "Reason", type: "textarea", required: true },
              ]} />
            </Card>
          ) : null}
          <Card title="Manage">
            <div className="stack gap-2">
              <SpecForm action={bgvCaseOpAction} hidden={{ id: c.id, op: "reassign" }} columns={1} submitLabel="Reassign" fields={[{ name: "assigneeUserId", label: "Assign to", type: "select", required: true, options: users.map((u) => ({ value: u.id, label: u.email })), defaultValue: c.assigneeUserId }]} />
              <SpecForm action={bgvCaseOpAction} hidden={{ id: c.id, op: "priority" }} columns={1} submitLabel="Set priority" fields={[{ name: "priority", label: "Priority", type: "select", required: true, options: opts(BGV_PRIORITIES), defaultValue: c.priority }]} />
              <ActButton action={bgvCaseOpAction} hidden={{ id: c.id, op: "escalate" }} label="Escalate" input={{ name: "reason", placeholder: "Reason" }} />
              {open ? <ActButton action={bgvCaseOpAction} hidden={{ id: c.id, op: "consent" }} label="Ask for consent again" /> : null}
              {open ? <ActButton action={bgvCaseOpAction} hidden={{ id: c.id, op: "cancel" }} label="Cancel case" variant="danger" confirmText="Cancel this verification case?" /> : null}
            </div>
          </Card>
          <Card title="Evidence">
            <div className="stack gap-1">
              {evidence.map((e) => { const m = /\[file:([^\]]+)\]/.exec(e.note ?? ""); return <div key={e.id} className="text-sm">{m ? <a href={`/files/${m[1]}`}>{(e.note ?? "").replace(/\s*\[file:[^\]]+\]/, "")}</a> : e.note} <span className="text-xs subtle">{fmtDay(e.createdAt)}</span></div>; })}
              {c.reportUrl && !evidence.length ? <a className="text-sm" href={c.reportUrl}>Report</a> : null}
            </div>
            <div style={{ marginTop: 8 }}>
              <SpecForm action={uploadBgvEvidenceAction} hidden={{ caseId: c.id }} columns={1} submitLabel="Upload" fields={[
                { name: "file", label: "File", type: "file", required: true },
                { name: "label", label: "Label" },
                { name: "itemId", label: "For check", type: "select", options: current.map((i) => ({ value: i.id, label: pretty(i.checkType) })), placeholder: "Whole case" },
              ]} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
