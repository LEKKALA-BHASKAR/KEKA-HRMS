import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, employeeScopeFilter } from "@keka/rbac";
import { documentVersions, completenessByEmployee, expiryStage, folderGrants } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { userOptions, userNames, fmtDate } from "@/lib/governance";
import { PageHead, Card, Callout, Progress } from "@/components/ui";
import { Pill, Tabs, SearchBar, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import {
  requestRenewalAction, requestFolderAccessAction, revokeFolderAccessAction, shareDocumentAction, revokeShareAction, bulkUploadAction, newPolicyVersionAction,
} from "@/app/actions/doc-ops";
import { DocumentsTabs } from "../tabs";

export const metadata = { title: "Document library" };
const TABS = { versions: "Versions", expiry: "Expiry & renewal", folders: "Folder access", shared: "Shared", bulk: "Bulk upload", completeness: "Completeness" };
type Tab = keyof typeof TABS;
const STAGE = ["—", "Within 30 days", "Within 7 days", "Expired"];

/**
 * Documents › Library: version history (employee documents and policies),
 * expiry and renewal, confidential folder access by approval, time-limited
 * shares, bulk upload by employee number and completeness of mandatory
 * documents. Employee data is limited to the viewer's document scope.
 */
export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireAuth(PERMISSIONS.DOCUMENT_VIEW);
  const sp = await searchParams;
  const manage = can(viewer, PERMISSIONS.DOCUMENT_MANAGE);
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : manage ? "versions" : "folders";
  const scope = employeeScopeFilter(viewer, PERMISSIONS.DOCUMENT_VIEW) as Prisma.EmployeeWhereInput | null;
  const t = viewer.tenantId;
  const docWhere: Prisma.EmployeeDocumentWhereInput = { tenantId: t, ...(manage ? (scope ? { employee: scope } : {}) : { employeeId: viewer.employee?.id ?? "__none__" }) };
  return (
    <>
      <PageHead title="Document library" subtitle="Versions, expiry, confidential folders, sharing and bulk upload"
        actions={manage ? <Link className="btn" href="/documents/library/export">Completeness CSV</Link> : null} />
      <DocumentsTabs />
      <Tabs base="/documents/library" tabs={TABS} active={tab} />
      {tab === "versions" ? <Versions tenantId={t} where={docWhere} q={sp.q} doc={sp.doc} manage={manage} /> : null}
      {tab === "expiry" ? <Expiry where={docWhere} manage={manage} /> : null}
      {tab === "folders" ? <Folders tenantId={t} userId={viewer.user.id} manage={manage} /> : null}
      {tab === "shared" ? <Shared tenantId={t} userId={viewer.user.id} where={docWhere} manage={manage} /> : null}
      {tab === "bulk" ? (manage ? <Bulk tenantId={t} /> : <Callout>Bulk upload needs document management rights.</Callout>) : null}
      {tab === "completeness" ? (manage ? <Completeness tenantId={t} scope={scope} /> : <Callout>Completeness reports need document management rights.</Callout>) : null}
    </>
  );
}

async function Versions({ tenantId, where, q, doc, manage }: { tenantId: string; where: Prisma.EmployeeDocumentWhereInput; q?: string; doc?: string; manage: boolean }) {
  const filter: Prisma.EmployeeDocumentWhereInput = { ...where, fileUrl: { not: null }, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { employee: { displayName: { contains: q, mode: "insensitive" } } }, { employee: { employeeNumber: { contains: q, mode: "insensitive" } } }] } : {}) };
  const docs = await prisma.employeeDocument.findMany({ where: filter, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { updatedAt: "desc" }, take: 100 });
  const counts = new Map((await prisma.documentVersion.groupBy({ by: ["documentId"], where: { tenantId, documentKind: "EMPLOYEE", documentId: { in: docs.map((d) => d.id) } }, _count: { _all: true } })).map((c) => [c.documentId, c._count._all]));
  const selected = doc ? docs.find((d) => d.id === doc) ?? (await prisma.employeeDocument.findFirst({ where: { ...where, id: doc }, include: { employee: { select: { displayName: true, employeeNumber: true } } } })) : null;
  const history = selected ? await documentVersions(tenantId, "EMPLOYEE", selected.id) : [];
  const policies = manage ? await prisma.orgDocument.findMany({ where: { tenantId }, orderBy: { title: "asc" }, take: 100 }) : [];
  const policyVersions = new Map((await prisma.documentVersion.groupBy({ by: ["documentId"], where: { tenantId, documentKind: "ORG" }, _count: { _all: true } })).map((c) => [c.documentId, c._count._all]));
  return (
    <div className="stack gap-4">
      <Card title="Employee documents" description="Every replaced file is kept: re-uploads, renewals and bulk uploads add a version.">
        <SearchBar action="/documents/library" tab="versions" q={q} />
        <Table head={["Document", "Employee", "Current upload", "Earlier versions", ""]} empty={!docs.length}>
          {docs.map((d) => <tr key={d.id}><td>{d.name}</td><td>{d.employee.displayName} ({d.employee.employeeNumber})</td><td>{fmtDate(d.uploadedAt)} {d.fileUrl ? <a href={d.fileUrl}>Download</a> : null}</td><td className="num">{counts.get(d.id) ?? 0}</td><td><Link href={`/documents/library?tab=versions&doc=${d.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>History</Link></td></tr>)}
        </Table>
      </Card>
      {selected ? (
        <Card title={`History: ${selected.name} — ${selected.employee.displayName}`}>
          <Table head={["Version", "Uploaded", "Status then", "Expired on", "Note", "File"]} empty={!history.length}>
            {history.map((h) => <tr key={h.id}><td className="num">v{h.version}</td><td>{fmtDate(h.uploadedAt)}</td><td>{h.status ? <Pill s={h.status} /> : "—"}</td><td>{fmtDate(h.expiresOn)}</td><td className="text-sm">{h.note ?? ""}</td><td>{h.fileUrl ? <a href={h.fileUrl}>Download</a> : "—"}</td></tr>)}
          </Table>
        </Card>
      ) : null}
      {manage ? (
        <Card title="Company policies" description="Publish a new version; the previous file and its acknowledgement count are kept.">
          <Table head={["Policy", "Current version", "Effective", "Earlier versions"]} empty={!policies.length}>
            {policies.map((p) => <tr key={p.id}><td>{p.title}</td><td>{p.version ?? "—"}</td><td>{fmtDate(p.effectiveFrom)}</td><td className="num">{policyVersions.get(p.id) ?? 0}</td></tr>)}
          </Table>
          <div style={{ marginTop: 12 }}>
            <SpecForm action={newPolicyVersionAction} submitLabel="Publish version" fields={[
              { name: "documentId", label: "Policy", type: "select", options: policies.map((p) => ({ value: p.id, label: p.title })), required: true },
              { name: "versionLabel", label: "New version label", required: true, placeholder: "2.0" },
              { name: "file", label: "File (PDF)", type: "file", required: true },
              { name: "effectiveFrom", label: "Effective from", type: "date" },
              { name: "resetAcks", label: "Acknowledgements", type: "checkbox", placeholder: "Ask everyone to acknowledge again" },
              { name: "note", label: "What changed" },
            ]} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

async function Expiry({ where, manage }: { where: Prisma.EmployeeDocumentWhereInput; manage: boolean }) {
  const now = new Date();
  const docs = await prisma.employeeDocument.findMany({ where: { ...where, expiresOn: { not: null, lte: new Date(now.getTime() + 60 * 86_400_000) }, status: { notIn: ["NOT_APPLICABLE", "REJECTED"] } }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { expiresOn: "asc" }, take: 300 });
  return (
    <Card title={`Expiring within 60 days or expired (${docs.length})`} description="Reminders go to the employee and verifiers at 30 days, 7 days and on expiry (nightly job). Requesting a renewal keeps the current file as a version and asks the employee for a new one.">
      <Table head={["Document", "Employee", "Expires", "Stage", "Status", ""]} empty={!docs.length}>
        {docs.map((d) => <tr key={d.id}><td>{d.name}</td><td>{d.employee.displayName} ({d.employee.employeeNumber})</td><td>{fmtDate(d.expiresOn)}</td><td>{STAGE[expiryStage(d.expiresOn, now)]}</td><td><Pill s={d.status} />{d.renewalRequestedAt ? <div className="muted text-xs">renewal asked {fmtDate(d.renewalRequestedAt)}</div> : null}</td><td>{manage && d.status !== "PENDING_ON_EMPLOYEE" ? <ActButton action={requestRenewalAction} hidden={{ documentId: d.id }} label="Request renewal" input={{ name: "note", placeholder: "Note to the employee" }} /> : null}</td></tr>)}
      </Table>
    </Card>
  );
}

async function Folders({ tenantId, userId, manage }: { tenantId: string; userId: string; manage: boolean }) {
  const [folders, grants, mine] = await Promise.all([
    prisma.documentFolder.findMany({ where: { tenantId, isConfidential: true }, orderBy: { name: "asc" }, include: { _count: { select: { documents: true } } } }),
    manage ? prisma.documentFolderAccess.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 200 }) : Promise.resolve([]),
    folderGrants(tenantId, userId),
  ]);
  const myRequests = await prisma.documentFolderAccess.findMany({ where: { tenantId, userId }, orderBy: { createdAt: "desc" } });
  const names = await userNames(tenantId, grants.map((g) => g.userId));
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  return (
    <div className="stack gap-4">
      <Card title="Confidential folders" description="Files in these folders open only for the roles listed on the folder, or with an approved, time-limited access grant.">
        <Table head={["Folder", "Documents", "Roles that may view", "Your access"]} empty={!folders.length}>
          {folders.map((f) => <tr key={f.id}><td>{f.name}</td><td className="num">{f._count.documents}</td><td className="text-sm">{Array.isArray(f.viewRoles) && f.viewRoles.length ? (f.viewRoles as unknown[]).map(String).join(", ") : "Document managers"}</td><td>{mine.has(f.id) ? <Pill s="GRANTED" /> : "—"}</td></tr>)}
        </Table>
        {folders.length ? (
          <div style={{ marginTop: 12 }}>
            <SpecForm action={requestFolderAccessAction} submitLabel="Request access" fields={[
              { name: "folderId", label: "Folder", type: "select", options: folders.map((f) => ({ value: f.id, label: f.name })), required: true },
              { name: "days", label: "For how many days", type: "number", defaultValue: 30 },
              { name: "canEdit", label: "Edit", type: "checkbox", placeholder: "I also need to upload or replace files" },
              { name: "reason", label: "Why you need it", type: "textarea", required: true, wide: true },
            ]} />
          </div>
        ) : null}
      </Card>
      <Card title="Your requests">
        <Table head={["Folder", "Requested", "Until", "Status"]} empty={!myRequests.length}>
          {myRequests.map((r) => <tr key={r.id}><td>{folderName.get(r.folderId) ?? "—"}</td><td>{fmtDate(r.createdAt)}</td><td>{fmtDate(r.expiresAt)}</td><td><Pill s={r.status} /></td></tr>)}
        </Table>
      </Card>
      {manage ? (
        <Card title="All grants" description="Approvals run through Inbox › Approvals (built-in approver: document managers).">
          <Table head={["Person", "Folder", "Edit", "Until", "Reason", "Status", ""]} empty={!grants.length}>
            {grants.map((g) => <tr key={g.id}><td>{names.get(g.userId)}</td><td>{folderName.get(g.folderId) ?? "—"}</td><td>{g.canEdit ? "Yes" : "No"}</td><td>{fmtDate(g.expiresAt)}</td><td className="text-sm">{g.reason}</td><td><Pill s={g.status} /></td><td>{g.status === "ACTIVE" ? <ActButton action={revokeFolderAccessAction} hidden={{ accessId: g.id }} label="Revoke" variant="danger" /> : null}</td></tr>)}
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

async function Shared({ tenantId, userId, where, manage }: { tenantId: string; userId: string; where: Prisma.EmployeeDocumentWhereInput; manage: boolean }) {
  const now = new Date();
  const [withMe, byMe, users, docs] = await Promise.all([
    prisma.documentShare.findMany({ where: { tenantId, sharedWithUserId: userId, revokedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } }),
    prisma.documentShare.findMany({ where: { tenantId, ...(manage ? {} : { sharedByUserId: userId }) }, orderBy: { createdAt: "desc" }, take: 200 }),
    manage ? userOptions(tenantId) : Promise.resolve([]),
    manage ? prisma.employeeDocument.findMany({ where: { ...where, fileUrl: { not: null } }, select: { id: true, name: true, employee: { select: { displayName: true } } }, orderBy: { updatedAt: "desc" }, take: 300 }) : Promise.resolve([]),
  ]);
  const all = await prisma.employeeDocument.findMany({ where: { tenantId, id: { in: [...withMe, ...byMe].map((s) => s.documentId) } }, select: { id: true, name: true, fileUrl: true, employee: { select: { displayName: true } } } });
  const doc = new Map(all.map((d) => [d.id, d]));
  const names = await userNames(tenantId, byMe.map((s) => s.sharedWithUserId));
  return (
    <div className="stack gap-4">
      <Card title="Shared with you">
        <Table head={["Document", "Employee", "Until", ""]} empty={!withMe.length}>
          {withMe.map((s) => <tr key={s.id}><td>{doc.get(s.documentId)?.name}</td><td>{doc.get(s.documentId)?.employee.displayName}</td><td>{fmtDate(s.expiresAt)}</td><td>{s.allowDownload && doc.get(s.documentId)?.fileUrl ? <a href={doc.get(s.documentId)!.fileUrl!}>Download</a> : "View only"}</td></tr>)}
        </Table>
      </Card>
      {manage ? (
        <Card title="Shares" description="A share lets one named person open one document until it expires; revoke it any time.">
          <Table head={["Document", "With", "Until", "Status", ""]} empty={!byMe.length}>
            {byMe.map((s) => { const live = !s.revokedAt && s.expiresAt > now; return <tr key={s.id}><td>{doc.get(s.documentId)?.name} — {doc.get(s.documentId)?.employee.displayName}</td><td>{names.get(s.sharedWithUserId)}</td><td>{fmtDate(s.expiresAt)}</td><td><Pill s={s.revokedAt ? "REVOKED" : live ? "ACTIVE" : "EXPIRED"} /></td><td>{live ? <ActButton action={revokeShareAction} hidden={{ shareId: s.id }} label="Revoke" variant="danger" /> : null}</td></tr>; })}
          </Table>
          <div style={{ marginTop: 12 }}>
            <SpecForm action={shareDocumentAction} submitLabel="Share" fields={[
              { name: "documentId", label: "Document", type: "select", options: docs.map((d) => ({ value: d.id, label: `${d.name} — ${d.employee.displayName}` })), required: true },
              { name: "userId", label: "With", type: "select", options: users, required: true },
              { name: "days", label: "Days", type: "number", defaultValue: 7 },
              { name: "allowDownload", label: "Download", type: "checkbox", defaultValue: true, placeholder: "Allow download" },
              { name: "note", label: "Note", wide: true },
            ]} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

async function Bulk({ tenantId }: { tenantId: string }) {
  const [types, logs] = await Promise.all([
    prisma.documentType.findMany({ where: { folder: { tenantId } }, include: { folder: { select: { name: true } } }, orderBy: { name: "asc" } }),
    prisma.documentBulkUpload.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  return (
    <div className="stack gap-4">
      <Card title="Bulk upload" description="Name each file starting with the employee number (ACM0009_passport.pdf). Up to 50 files of 10 MB each; PDF, PNG or JPEG.">
        <SpecForm action={bulkUploadAction} submitLabel="Upload" fields={[
          { name: "documentTypeId", label: "Document type", type: "select", options: types.map((t) => ({ value: t.id, label: `${t.name} (${t.folder.name})` })), required: true },
          { name: "expiresOn", label: "Expires on (optional)", type: "date" },
          { name: "files", label: "Files", type: "file", multiple: true, required: true, wide: true },
        ]} />
      </Card>
      <Card title="Upload log">
        <Table head={["When", "Type", "Filed", "Failed", "Details"]} empty={!logs.length}>
          {logs.map((l) => <tr key={l.id}><td>{fmtDate(l.createdAt)}</td><td>{typeName.get(l.documentTypeId)}</td><td className="num">{l.matched}</td><td className="num">{l.failed}</td><td className="text-xs">{(Array.isArray(l.results) ? (l.results as Array<{ file: string; ok: boolean; message: string }>) : []).filter((r) => !r.ok).map((r) => `${r.file}: ${r.message}`).join("; ")}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Completeness({ tenantId, scope }: { tenantId: string; scope: Prisma.EmployeeWhereInput | null }) {
  const rows = await completenessByEmployee(tenantId, scope ?? {});
  const incomplete = rows.filter((r) => r.percent < 100);
  return (
    <Card title={`Mandatory documents: ${rows.length - incomplete.length} of ${rows.length} employees complete`}>
      <Table head={["Employee", "Department", "Done", "Complete"]} empty={!rows.length}>
        {incomplete.concat(rows.filter((r) => r.percent === 100)).slice(0, 300).map((r) => <tr key={r.id}><td><Link href={`/employees/${r.id}`}>{r.name}</Link> <span className="muted text-xs">{r.number}</span></td><td>{r.department ?? "—"}</td><td className="num">{r.done}/{r.required}</td><td style={{ width: 160 }}><Progress value={r.percent} tone={r.percent === 100 ? "success" : "warning"} /></td></tr>)}
      </Table>
    </Card>
  );
}
