import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { CHANGE_TARGETS, CORRECTABLE_FIELDS, diffChanges, fieldLabel, checklistProgress, freshness } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { displayChangeValue } from "@/lib/core-hr";
import { PageHead, Card, Badge, Empty, Callout, Progress } from "@/components/ui";
import { SpecForm, SpecDisclosure, ActionButton, type FieldSpec } from "@/components/spec-form";
import { withdrawChangeRequestAction } from "@/app/actions/core-hr-depth";
import { requestProfileChangeAction, requestDataCorrectionAction, requestDocumentAction, withdrawDocumentRequestAction } from "@/app/actions/self-service-depth";
import { toggleChecklistItemAction } from "@/app/actions/hr-ops";

export const metadata = { title: "My requests — BooS-HR" };

const TABS = { profile: "Update my details", requests: "My change requests", documents: "Letters", corrections: "Report a mistake", checklists: "My checklist items" } as const;
type Tab = keyof typeof TABS;
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const RELS = ["SPOUSE", "CHILD", "FATHER", "MOTHER", "SIBLING", "PARTNER", "GUARDIAN", "OTHER"].map((r) => ({ value: r, label: r.charAt(0) + r.slice(1).toLowerCase() }));
const TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "brand"> = { APPLIED: "success", PENDING: "warning", SCHEDULED: "brand", REJECTED: "danger", FAILED: "danger", WITHDRAWN: "neutral", ISSUED: "success" };
const reason: FieldSpec = { name: "reason", label: "Note for the reviewer", wide: true };

/**
 * Me › Requests: ask for a change to my own details (my manager or HR
 * approves it before it is applied), request letters such as a salary
 * certificate, report a mistake on my record, and tick off checklist items
 * that are mine. My data can be downloaded too.
 */
export default async function MyRequestsPage({ searchParams }: { searchParams: Promise<{ tab?: string; edit?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const tab = (sp.tab && sp.tab in TABS ? sp.tab : "profile") as Tab;
  if (!viewer.employee) {
    return <><PageHead title="My requests" /><Card><Empty title="No employee profile">This account is not linked to an employee record.</Empty></Card></>;
  }
  const me = viewer.employee.id;
  const openCount = await prisma.recordChangeRequest.count({ where: { tenantId: viewer.tenantId, employeeId: me, status: { in: ["PENDING", "SCHEDULED"] } } });
  return (
    <>
      <PageHead title="My requests" subtitle="Changes to your details, letters, and corrections"
        actions={<><Link className="btn" href="/me/id-card">My ID card</Link><a className="btn" href="/me/requests/export">Download my data</a></>} />
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((k) => <Link key={k} href={`/me/changes?tab=${k}`} className={`tab${tab === k ? " active" : ""}`}>{TABS[k]}{k === "requests" && openCount ? ` (${openCount})` : ""}</Link>)}
      </div>
      {tab === "profile" ? <Profile tenantId={viewer.tenantId} employeeId={me} edit={sp.edit} /> : null}
      {tab === "requests" ? <Requests tenantId={viewer.tenantId} employeeId={me} userId={viewer.user.id} /> : null}
      {tab === "documents" ? <Documents tenantId={viewer.tenantId} employeeId={me} /> : null}
      {tab === "corrections" ? <Corrections tenantId={viewer.tenantId} employeeId={me} /> : null}
      {tab === "checklists" ? <Checklists tenantId={viewer.tenantId} employeeId={me} /> : null}
    </>
  );
}

async function Profile({ tenantId, employeeId, edit }: { tenantId: string; employeeId: string; edit?: string }) {
  const e = await prisma.employee.findFirstOrThrow({
    where: { id: employeeId, tenantId },
    include: { addresses: true, bankAccounts: { where: { isPrimary: true }, take: 1 }, dependents: true, emergencyContacts: true, educations: true, experiences: true },
  });
  const open = await prisma.recordChangeRequest.findMany({ where: { tenantId, employeeId, status: "PENDING", category: "PROFILE" }, select: { targetType: true, targetId: true } });
  const waiting = (type: string, id?: string | null) => open.some((o) => o.targetType === type && (id === undefined || o.targetId === (id ?? null)));
  const addr = e.addresses.find((a) => a.type === "CURRENT");
  const bank = e.bankAccounts[0];
  const fresh = freshness(e.updatedAt);
  const form = (target: string, fields: FieldSpec[]) => (
    waiting(target) ? <Badge tone="warning">A change is waiting for approval</Badge> : <SpecForm action={requestProfileChangeAction} hidden={{ targetType: target }} fields={[...fields, reason]} submitLabel="Send for approval" />
  );
  const editing = (id: string) => edit === id;
  return (
    <div className="stack gap-4">
      <Callout title="How this works">Changes are sent for approval — personal and bank details to HR, the rest to your manager — and appear on your profile once approved. {fresh.label}{fresh.stale ? "; please check your details are still right." : "."}</Callout>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Personal details" description="Goes to HR.">
          {form("PERSONAL", [
            { name: "firstName", label: "First name", required: true, defaultValue: e.firstName },
            { name: "middleName", label: "Middle name", defaultValue: e.middleName },
            { name: "lastName", label: "Last name", required: true, defaultValue: e.lastName },
            { name: "displayName", label: "Display name", defaultValue: e.displayName },
            { name: "dateOfBirth", label: "Date of birth", kind: "date", defaultValue: iso(e.dateOfBirth) },
            { name: "gender", label: "Gender", kind: "select", defaultValue: e.gender, options: ["MALE", "FEMALE", "OTHER", "UNDISCLOSED"].map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() })) },
            { name: "maritalStatus", label: "Marital status", kind: "select", defaultValue: e.maritalStatus, options: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "UNDISCLOSED"].map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() })) },
            { name: "bloodGroup", label: "Blood group", kind: "select", defaultValue: e.bloodGroup, options: ["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG", "UNKNOWN"].map((v) => ({ value: v, label: v.replace("_POS", "+").replace("_NEG", "−") })) },
            { name: "nationality", label: "Nationality", defaultValue: e.nationality },
          ])}
        </Card>
        <div className="stack gap-4">
          <Card title="Contact details" description="Goes to your manager.">
            {form("CONTACT", [
              { name: "personalEmail", label: "Personal email", kind: "email", defaultValue: e.personalEmail },
              { name: "mobile", label: "Mobile", defaultValue: e.mobile },
              { name: "alternatePhone", label: "Alternate phone", defaultValue: e.alternatePhone },
            ])}
          </Card>
          <Card title="Current address" description="Goes to your manager.">
            {form("ADDRESS", [
              { name: "type", label: "Which address", kind: "select", required: true, defaultValue: "CURRENT", options: [{ value: "CURRENT", label: "Current" }, { value: "PERMANENT", label: "Permanent" }] },
              { name: "line1", label: "Address", required: true, defaultValue: addr?.line1, wide: true },
              { name: "line2", label: "Line 2", defaultValue: addr?.line2, wide: true },
              { name: "city", label: "City", defaultValue: addr?.city },
              { name: "state", label: "State", defaultValue: addr?.state },
              { name: "postalCode", label: "PIN code", defaultValue: addr?.postalCode },
            ])}
          </Card>
        </div>
      </div>
      <Card title="Bank account for salary" description={bank ? `On record: ${bank.bankName} •••• ${bank.accountNumber.slice(-4)} (${bank.ifsc}). Goes to HR.` : "None on record. Goes to HR."}>
        {waiting("BANK") ? <Badge tone="warning">A change is waiting for approval</Badge> : (
          <SpecDisclosure label={bank ? "Change bank account" : "Add bank account"}>
            <SpecForm action={requestProfileChangeAction} hidden={{ targetType: "BANK" }} submitLabel="Send for approval" fields={[
              { name: "bankName", label: "Bank", required: true },
              { name: "ifsc", label: "IFSC", required: true, placeholder: "HDFC0001234" },
              { name: "accountNumber", label: "Account number", required: true },
              { name: "confirmAccountNumber", label: "Account number again", required: true },
              { name: "accountHolder", label: "Account holder name" },
              { name: "branch", label: "Branch" },
              reason,
            ]} />
          </SpecDisclosure>
        )}
      </Card>
      <SubRecords title="Family & dependents" target="DEPENDENT" rows={e.dependents.map((d) => ({ id: d.id, text: `${d.name} — ${d.relationship.toLowerCase()}${d.dateOfBirth ? `, born ${formatDate(d.dateOfBirth)}` : ""}${d.isNominee ? " · nominee" : ""}`, fields: depFields(d) }))}
        newFields={depFields()} edit={edit} waiting={waiting} editing={editing} />
      <SubRecords title="Emergency contacts" target="EMERGENCY_CONTACT" rows={e.emergencyContacts.map((c) => ({ id: c.id, text: `${c.name} — ${c.relationship}, ${c.phone}${c.isPrimary ? " · primary" : ""}`, fields: emFields(c) }))}
        newFields={emFields()} edit={edit} waiting={waiting} editing={editing} />
      <SubRecords title="Education" target="EDUCATION" rows={e.educations.map((x) => ({ id: x.id, text: `${x.degree ?? "Qualification"}${x.specialization ? `, ${x.specialization}` : ""} — ${x.institution}${x.toYear ? ` (${x.toYear})` : ""}`, fields: eduFields(x) }))}
        newFields={eduFields()} edit={edit} waiting={waiting} editing={editing} />
      <SubRecords title="Previous experience" target="EXPERIENCE" rows={e.experiences.map((x) => ({ id: x.id, text: `${x.jobTitle ?? "Role"} at ${x.companyName}${x.fromDate ? `, ${formatDate(x.fromDate)} – ${formatDate(x.toDate)}` : ""}`, fields: expFields(x) }))}
        newFields={expFields()} edit={edit} waiting={waiting} editing={editing} />
    </div>
  );
}

function depFields(d?: { name: string; relationship: string; dateOfBirth: Date | null; isNominee: boolean }): FieldSpec[] {
  return [
    { name: "name", label: "Name", required: true, defaultValue: d?.name },
    { name: "relationship", label: "Relationship", kind: "select", required: true, options: RELS, defaultValue: d?.relationship.toUpperCase() },
    { name: "dateOfBirth", label: "Date of birth", kind: "date", defaultValue: iso(d?.dateOfBirth) },
    { name: "isNominee", label: "Nominee", kind: "checkbox", defaultChecked: d?.isNominee },
  ];
}
function emFields(c?: { name: string; relationship: string; phone: string; email: string | null; isPrimary: boolean }): FieldSpec[] {
  return [
    { name: "name", label: "Name", required: true, defaultValue: c?.name },
    { name: "relationship", label: "Relationship", required: true, defaultValue: c?.relationship },
    { name: "phone", label: "Phone", required: true, defaultValue: c?.phone },
    { name: "email", label: "Email", kind: "email", defaultValue: c?.email },
    { name: "isPrimary", label: "Primary contact", kind: "checkbox", defaultChecked: c?.isPrimary },
  ];
}
function eduFields(x?: { institution: string; degree: string | null; specialization: string | null; fromYear: number | null; toYear: number | null; grade: string | null }): FieldSpec[] {
  return [
    { name: "institution", label: "Institution", required: true, defaultValue: x?.institution },
    { name: "degree", label: "Degree", defaultValue: x?.degree },
    { name: "specialization", label: "Specialisation", defaultValue: x?.specialization },
    { name: "grade", label: "Grade", defaultValue: x?.grade },
    { name: "fromYear", label: "From (year)", kind: "number", step: "1", defaultValue: x?.fromYear },
    { name: "toYear", label: "To (year)", kind: "number", step: "1", defaultValue: x?.toYear },
  ];
}
function expFields(x?: { companyName: string; jobTitle: string | null; fromDate: Date | null; toDate: Date | null; description: string | null }): FieldSpec[] {
  return [
    { name: "companyName", label: "Company", required: true, defaultValue: x?.companyName },
    { name: "jobTitle", label: "Job title", defaultValue: x?.jobTitle },
    { name: "fromDate", label: "From", kind: "date", defaultValue: iso(x?.fromDate) },
    { name: "toDate", label: "To", kind: "date", defaultValue: iso(x?.toDate) },
    { name: "description", label: "What you did", kind: "textarea", defaultValue: x?.description },
  ];
}

function SubRecords({ title, target, rows, newFields, waiting, editing }: {
  title: string; target: string; rows: Array<{ id: string; text: string; fields: FieldSpec[] }>; newFields: FieldSpec[]; edit?: string;
  waiting: (type: string, id?: string | null) => boolean; editing: (id: string) => boolean;
}) {
  return (
    <Card title={title} description="Goes to your manager." tight>
      {rows.length === 0 ? <Empty title="Nothing recorded" /> : (
        <ul className="stack" style={{ padding: 0, margin: 0, listStyle: "none" }}>{rows.map((r) => (
          <li key={r.id} style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
            <div className="row gap-2 wrap" style={{ justifyContent: "space-between" }}>
              <span>{r.text}</span>
              {waiting(target, r.id) ? <Badge tone="warning">Change waiting</Badge> : (
                <div className="row gap-1">
                  <Link className="btn sm" href={`/me/changes?tab=profile&edit=${r.id}`}>Change</Link>
                  <ActionButton action={requestProfileChangeAction} hidden={{ targetType: target, operation: "DELETE", targetId: r.id }} label="Ask to remove" confirm="Ask for this to be removed?" />
                </div>
              )}
            </div>
            {editing(r.id) && !waiting(target, r.id) ? <div style={{ marginTop: 10 }}><SpecForm action={requestProfileChangeAction} hidden={{ targetType: target, operation: "UPDATE", targetId: r.id }} fields={[...r.fields, reason]} submitLabel="Send for approval" /></div> : null}
          </li>
        ))}</ul>
      )}
      <div style={{ padding: 14 }}>
        <SpecDisclosure label="+ Add"><SpecForm action={requestProfileChangeAction} hidden={{ targetType: target, operation: "CREATE" }} fields={[...newFields, reason]} submitLabel="Send for approval" /></SpecDisclosure>
      </div>
    </Card>
  );
}

async function Requests({ tenantId, employeeId, userId }: { tenantId: string; employeeId: string; userId: string }) {
  const rows = await prisma.recordChangeRequest.findMany({ where: { tenantId, OR: [{ employeeId }, { requestedBy: userId }] }, orderBy: { createdAt: "desc" }, take: 100 });
  return (
    <Card title="Changes I asked for" tight>
      {rows.length === 0 ? <Empty title="No requests yet" /> : rows.map((r) => (
        <div key={r.id} style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
          <div className="row gap-2 wrap" style={{ justifyContent: "space-between" }}>
            <div><span className="strong">{r.title}</span> <Badge tone={TONE[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge>
              <div className="text-xs muted">{CHANGE_TARGETS[r.targetType as keyof typeof CHANGE_TARGETS]?.label ?? r.targetType} · asked {formatDate(r.createdAt)} · {r.approverType === "MANAGER" ? "manager" : "HR"} approval{r.decidedAt ? ` · decided ${formatDate(r.decidedAt)}` : ""}{r.decisionNote ? ` — “${r.decisionNote}”` : ""}</div></div>
            {r.requestedBy === userId && (r.status === "PENDING" || r.status === "SCHEDULED") ? <ActionButton action={withdrawChangeRequestAction} hidden={{ id: r.id }} label="Withdraw" /> : null}
          </div>
          {r.operation !== "DELETE" ? (
            <div className="text-sm" style={{ marginTop: 6 }}>{diffChanges(r.previous as Record<string, unknown> | null, r.changes as Record<string, unknown>).map((d) => <div key={d.field}>{fieldLabel(d.field)}: <span className="muted">{displayChangeValue(d.field, d.from)}</span> → <strong>{displayChangeValue(d.field, d.to)}</strong></div>)}</div>
          ) : <div className="text-sm muted">Remove this record</div>}
        </div>
      ))}
    </Card>
  );
}

async function Documents({ tenantId, employeeId }: { tenantId: string; employeeId: string }) {
  const [types, mine] = await Promise.all([
    prisma.documentRequestType.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.selfServiceDocumentRequest.findMany({ where: { tenantId, employeeId }, include: { type: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <Card title="Request a letter">
        {types.length === 0 ? <Empty title="No letters on offer yet">HR has not offered any letters for self-service.</Empty> : (
          <SpecForm action={requestDocumentAction} submitLabel="Request" fields={[
            { name: "typeId", label: "Letter", kind: "select", required: true, options: types.map((x) => ({ value: x.id, label: `${x.name}${x.requiresApproval ? "" : " (instant)"}` })) },
            { name: "purpose", label: "What it is for", required: true, placeholder: "Visa application" },
            { name: "addressedTo", label: "Addressed to", placeholder: "To whomsoever it may concern", wide: true },
          ]} />
        )}
      </Card>
      <Card title="My letter requests" tight>
        {mine.length === 0 ? <Empty title="None yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Letter</th><th>For</th><th>Status</th><th /></tr></thead>
            <tbody>{mine.map((r) => (
              <tr key={r.id}><td>{r.type.name}<div className="text-xs muted">{formatDate(r.createdAt)}</div></td><td className="text-sm">{r.purpose}</td>
                <td><Badge tone={TONE[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge>{r.note ? <div className="text-xs muted">{r.note}</div> : null}</td>
                <td className="right">{r.status === "ISSUED" && r.letterId ? <Link className="btn sm primary" href={`/documents/letters/${r.letterId}`}>Open</Link> : r.status === "PENDING" ? <ActionButton action={withdrawDocumentRequestAction} hidden={{ id: r.id }} label="Withdraw" /> : null}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

async function Corrections({ tenantId, employeeId }: { tenantId: string; employeeId: string }) {
  const mine = await prisma.recordChangeRequest.findMany({ where: { tenantId, employeeId, category: "CORRECTION" }, orderBy: { createdAt: "desc" }, take: 30 });
  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <Card title="Something on my record is wrong" description="HR checks it, corrects it, and the old value is kept in the audit log.">
        <SpecForm action={requestDataCorrectionAction} submitLabel="Report" fields={[
          { name: "field", label: "What is wrong", kind: "select", required: true, options: Object.entries(CORRECTABLE_FIELDS).map(([k, f]) => ({ value: k, label: f.label })) },
          { name: "correctValue", label: "The correct value", required: true, hint: "Dates as 2026-04-01." },
          { name: "reason", label: "How you know (e.g. as on my PAN card)", kind: "textarea", required: true },
        ]} />
      </Card>
      <Card title="My corrections" tight>
        {mine.length === 0 ? <Empty title="None reported" /> : (
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>{mine.map((r) => (
            <li key={r.id} style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>{r.title} <Badge tone={TONE[r.status] ?? "neutral"}>{r.status.toLowerCase()}</Badge><div className="text-xs muted">{formatDate(r.createdAt)}{r.decisionNote ? ` — ${r.decisionNote}` : ""}</div></li>
          ))}</ul>
        )}
      </Card>
    </div>
  );
}

async function Checklists({ tenantId, employeeId }: { tenantId: string; employeeId: string }) {
  const lists = await prisma.hrChecklist.findMany({ where: { tenantId, employeeId }, include: { items: { orderBy: { position: "asc" } } }, orderBy: { createdAt: "desc" } });
  return (
    <Card title="Checklists about me" description="Items marked “employee” are yours to tick off." tight>
      {lists.length === 0 ? <Empty title="No checklists" /> : lists.map((c) => {
        const pr = checklistProgress(c.items);
        return (
          <div key={c.id} style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
            <div className="strong">{c.title} <Badge>{c.status.toLowerCase().replace(/_/g, " ")}</Badge></div>
            <div style={{ maxWidth: 240, margin: "6px 0" }}><Progress value={pr.percent} tone={pr.complete ? "success" : undefined} /></div>
            <ul className="stack gap-1">{c.items.map((it) => (
              <li key={it.id} className="row gap-2" style={{ alignItems: "center" }}>
                {it.owner === "EMPLOYEE" && c.status !== "SIGNED_OFF" ? <ActionButton action={toggleChecklistItemAction} hidden={{ id: it.id }} label={it.done ? "✓" : "○"} /> : <span>{it.done ? "✓" : "○"}</span>}
                <span>{it.title}</span><Badge>{it.owner.toLowerCase()}</Badge>
              </li>
            ))}</ul>
          </div>
        );
      })}
    </Card>
  );
}
