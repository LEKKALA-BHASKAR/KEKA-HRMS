import { prisma } from "@keka/db";
import { getErSettings, anonymousCaseView, appealOpen, erRef, ER_CATEGORIES, ER_SEVERITIES, ER_STATUSES, ER_ACTION_TYPES, ER_OUTCOMES } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { employeeOptions, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Callout, KeyValue } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { SpecForm } from "@/components/gov-forms";
import { raiseErCaseAction, anonymousInfoAction, respondToActionAction, acknowledgeActionAction, fileAppealAction } from "@/app/actions/relations";
import { MeCasesTabs } from "./tabs";

export const metadata = { title: "My cases" };
const opts = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({ value, label }));

/**
 * Me › Cases: raise a grievance or complaint (by name or anonymously),
 * follow an anonymous report with its tracking code, follow cases you raised,
 * and respond to, acknowledge or appeal an action taken against you.
 */
export default async function MyCasesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const t = viewer.tenantId, me = viewer.employee?.id ?? "__none__";
  const [settings, emps, raised, actions, toSign, policies] = await Promise.all([
    getErSettings(t), employeeOptions(t),
    prisma.erCase.findMany({ where: { tenantId: t, reporterEmployeeId: me }, include: { notes: { where: { kind: "REPORTER" }, orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "desc" } }),
    prisma.erAction.findMany({ where: { tenantId: t, employeeId: me, status: { in: ["ISSUED", "REVOKED"] } }, include: { appeals: true }, orderBy: { issuedAt: "desc" } }),
    prisma.signatureRecipient.count({ where: { tenantId: t, userId: viewer.user.id, status: "PENDING" } }),
    prisma.orgDocument.findMany({ where: { tenantId: t, isPublished: true }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: 100 }),
  ]);
  const anon = sp.code ? await anonymousCaseView(t, sp.code) : null;
  const now = new Date();
  return (
    <>
      <PageHead title="Cases" subtitle="Raise a grievance or complaint, and respond to anything raised with you. Everything here is confidential." />
      <MeCasesTabs toSign={toSign} />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="stack gap-4">
          <Card title="Raise a grievance or complaint" description="HR's employee relations team will review it. Retaliation against anyone who raises a concern in good faith is not allowed.">
            <SpecForm action={raiseErCaseAction} submitLabel="Submit" fields={[
              { name: "kind", label: "This is a", type: "select", options: [{ value: "GRIEVANCE", label: "Grievance (about how I am treated)" }, { value: "COMPLAINT", label: "Complaint (about someone's conduct)" }], required: true },
              { name: "category", label: "Category", type: "select", options: opts(ER_CATEGORIES), required: true },
              { name: "title", label: "Short title", required: true, wide: true },
              { name: "description", label: "What happened", type: "textarea", required: true, wide: true, hint: "Dates, places and people involved help the review." },
              { name: "subjectEmployeeId", label: "About (optional)", type: "select", options: emps.filter((e) => e.value !== me) },
              { name: "severity", label: "How serious", type: "select", options: opts(ER_SEVERITIES), defaultValue: "MEDIUM" },
              { name: "incidentDate", label: "When", type: "date" },
              { name: "incidentLocation", label: "Where" },
              { name: "policyDocumentId", label: "Under policy", type: "select", options: policies.map((p) => ({ value: p.id, label: p.title })) },
              ...(settings.allowAnonymous ? [{ name: "anonymous", label: "Anonymous", type: "checkbox" as const, placeholder: "Do not record my name — I will get a tracking code to follow up" }] : []),
            ]} />
          </Card>

          <Card title="Follow an anonymous report" description="Enter the 12-character tracking code you were given.">
            <form method="get" className="row gap-2"><input className="input" name="code" defaultValue={sp.code ?? ""} placeholder="e.g. 3FA9C01B22DE" style={{ width: 220 }} /><button className="btn sm" type="submit">Look up</button></form>
            {sp.code && !anon ? <div style={{ marginTop: 8 }}><Callout tone="warning">No report matches that code.</Callout></div> : null}
            {anon ? (
              <div className="stack gap-2" style={{ marginTop: 12 }}>
                <KeyValue items={[["Report", `${erRef(anon.number)} · ${anon.title}`], ["Status", ER_STATUSES[anon.status as keyof typeof ER_STATUSES] ?? anon.status], ["Outcome", anon.outcome ? ER_OUTCOMES[anon.outcome as keyof typeof ER_OUTCOMES] : null], ["Raised", fmtDate(anon.createdAt)]]} />
                {anon.notes.map((n, i) => <div key={i} className="text-sm" style={{ borderLeft: "3px solid var(--border)", paddingLeft: 8 }}><div className="muted text-xs">{fmtWhen(n.at)} · {n.by}</div>{n.body}</div>)}
                {anon.status !== "CLOSED" ? <SpecForm action={anonymousInfoAction} hidden={{ code: sp.code! }} submitLabel="Add information" columns={1} fields={[{ name: "body", label: "More information", type: "textarea", required: true }]} /> : null}
              </div>
            ) : null}
          </Card>

          <Card title="Cases you raised">
            <Table head={["Case", "Status", "Updates from HR"]} empty={!raised.length}>
              {raised.map((c) => <tr key={c.id}><td><strong>{erRef(c.number)}</strong> {c.title}<div className="muted text-xs">{fmtDate(c.createdAt)}</div></td><td><Pill s={c.status} />{c.outcome ? <div className="text-xs">{ER_OUTCOMES[c.outcome as keyof typeof ER_OUTCOMES]}</div> : null}</td><td className="text-sm">{c.notes.length ? c.notes.map((n) => <div key={n.id}>{fmtDate(n.createdAt)}: {n.body}</div>) : <span className="muted">None yet</span>}</td></tr>)}
            </Table>
          </Card>
        </div>

        <Card title="Actions issued to you" description="You can respond in writing, acknowledge receipt, and appeal within the appeal window.">
          {!actions.length ? <div className="muted text-sm">Nothing here.</div> : null}
          <div className="stack gap-4">
            {actions.map((a) => {
              const appealable = appealOpen(a, settings.appealWindowDays, now) && !a.appeals.some((x) => x.status === "FILED" || x.status === "UNDER_REVIEW");
              return (
                <div key={a.id} className="card" style={{ padding: 12 }}>
                  <div className="row gap-2" style={{ justifyContent: "space-between" }}><strong>{ER_ACTION_TYPES[a.actionType as keyof typeof ER_ACTION_TYPES]}</strong><Pill s={a.status} /></div>
                  <p className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{a.summary}</p>
                  <KeyValue items={[
                    ["Issued", fmtDate(a.issuedAt)], ["Effective", fmtDate(a.effectiveOn)], ["Valid until", a.expiresOn ? fmtDate(a.expiresOn) : null],
                    ["Suspension", a.suspensionFrom ? `${fmtDate(a.suspensionFrom)} – ${fmtDate(a.suspensionTo)} (${a.suspensionPaid ? "paid" : "unpaid"})` : null],
                    ["Respond by", a.responseDueOn ? fmtDate(a.responseDueOn) : null], ["Letter", a.letterId ? <a key="l" href={`/documents/letters/${a.letterId}`}>Open the notice</a> : null],
                    ["Appeals", a.appeals.length ? a.appeals.map((x) => `${fmtDate(x.filedAt)}: ${x.status.toLowerCase()}${x.decision ? ` — ${x.decision}` : ""}`).join("; ") : null],
                  ]} />
                  {a.status === "ISSUED" ? (
                    <div className="stack gap-2" style={{ marginTop: 8 }}>
                      {!a.acknowledgedAt ? <SpecForm action={acknowledgeActionAction} hidden={{ actionId: a.id }} submitLabel="Acknowledge receipt" columns={1} fields={[]} /> : <div className="text-xs muted">Acknowledged {fmtDate(a.acknowledgedAt)}</div>}
                      {!a.respondedAt ? <SpecForm action={respondToActionAction} hidden={{ actionId: a.id }} submitLabel="Send response" columns={1} fields={[{ name: "response", label: a.actionType === "SHOW_CAUSE" ? "Your explanation" : "Your response", type: "textarea", required: true }]} /> : <div className="text-sm"><strong>Your response:</strong> {a.employeeResponse}</div>}
                      {appealable ? <SpecForm action={fileAppealAction} hidden={{ actionId: a.id }} submitLabel="File appeal" columns={1} fields={[{ name: "grounds", label: `Appeal (within ${settings.appealWindowDays} days of issue)`, type: "textarea", required: true }]} /> : null}
                    </div>
                  ) : <div className="text-xs muted">Revoked {fmtDate(a.revokedAt)}{a.revokeReason ? `: ${a.revokeReason}` : ""}</div>}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </>
  );
}
