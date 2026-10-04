import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS, employeeScopeFilter } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Person, Stat, Callout, Progress } from "@/components/ui";
import { verifyDocument, acknowledgeOrgDocument } from "@/app/actions/workplace";
import { EMPLOYEE_VISIBLE, LETTER_STATUS_LABEL, LETTER_WORKFLOWS } from "@keka/services";
import { GenerateLetter } from "./letters/forms";
import { LETTER_TONE } from "./letters/tone";
import { UploadDocument } from "./upload";
import { DocumentsTabs } from "./tabs";

const P = PERMISSIONS;

const TABS = ["pending", "expiring", "policies", "letters", "templates", "mine"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  pending: "Pending verification",
  expiring: "Expiring",
  policies: "Company policies",
  letters: "Letters",
  templates: "Letter templates",
  mine: "My documents",
};

const DOC_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  VERIFIED: "success",
  PENDING_VERIFICATION: "info",
  PENDING_ON_EMPLOYEE: "warning",
  REJECTED: "danger",
  EXPIRED: "danger",
  NOT_APPLICABLE: "neutral",
};

export default async function DocumentsPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; q?: string }> }) {
  const viewer = await requireAuth(P.DOCUMENT_VIEW);
  const sp = await searchParams;
  const canVerify = can(viewer, P.DOCUMENT_VERIFY);
  const canManage = can(viewer, P.DOCUMENT_MANAGE);
  const canGenerate = can(viewer, P.LETTER_GENERATE);
  const canTemplates = can(viewer, P.DOCUMENT_TEMPLATE_MANAGE);
  const myId = viewer.employee?.id;
  const defaultTab: Tab = canVerify ? "pending" : "mine";
  const tab = (TABS.includes(sp.tab as Tab) ? sp.tab : defaultTab) as Tab;

  const scopeFilter = employeeScopeFilter(viewer, P.DOCUMENT_VIEW);
  const soon = new Date(Date.now() + 90 * 86400000);

  // List search (?q=) on the letters and templates tabs.
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 100) : "";
  const letterQ = q ? { OR: [{ letterNumber: { contains: q, mode: "insensitive" as const } }, { template: { name: { contains: q, mode: "insensitive" as const } } }, { employee: { displayName: { contains: q, mode: "insensitive" as const } } }, { employee: { employeeNumber: { contains: q, mode: "insensitive" as const } } }] } : {};
  const letterScope = employeeScopeFilter(viewer, P.LETTER_GENERATE);
  const [letters, myLetters] = await Promise.all([
    canGenerate
      ? prisma.generatedDocument.findMany({
          where: { employee: { tenantId: viewer.tenantId, ...(letterScope ? (letterScope as object) : {}) }, ...letterQ },
          orderBy: { issuedOn: "desc" }, take: 200,
          include: { template: { select: { name: true } }, employee: { select: { id: true, displayName: true, employeeNumber: true } } },
        })
      : Promise.resolve([]),
    myId
      ? prisma.generatedDocument.findMany({
          where: { employeeId: myId, status: { in: EMPLOYEE_VISIBLE } },
          orderBy: { issuedOn: "desc" },
          include: { template: { select: { name: true } } },
        })
      : Promise.resolve([]),
  ]);
  const myOpenLetters = myLetters.filter((l) => l.status === "PENDING_SIGNATURE" || l.status === "PENDING_ACKNOWLEDGEMENT");

  const [pending, expiring, policies, templates, myDocs, myPolicyAcks, employees, headcount, statusCounts] =
    await Promise.all([
      canVerify
        ? prisma.employeeDocument.findMany({
            where: {
              tenantId: viewer.tenantId,
              status: { in: ["PENDING_VERIFICATION", "PENDING_ON_EMPLOYEE"] },
              ...(scopeFilter ? { employee: scopeFilter as never } : {}),
            },
            orderBy: [{ status: "asc" }, { uploadedAt: "desc" }],
            take: 150,
            include: {
              employee: {
                select: {
                  id: true, displayName: true, employeeNumber: true,
                  department: { select: { name: true } },
                },
              },
              documentType: { select: { name: true, isMandatory: true } },
              folder: { select: { name: true, isConfidential: true } },
            },
          })
        : Promise.resolve([]),
      canVerify
        ? prisma.employeeDocument.findMany({
            where: {
              tenantId: viewer.tenantId,
              expiresOn: { not: null, lte: soon },
              status: { notIn: ["NOT_APPLICABLE", "REJECTED"] },
              ...(scopeFilter ? { employee: scopeFilter as never } : {}),
            },
            orderBy: { expiresOn: "asc" },
            include: {
              employee: { select: { id: true, displayName: true, employeeNumber: true } },
              documentType: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      prisma.orgDocument.findMany({
        where: { tenantId: viewer.tenantId, isPublished: true },
        orderBy: { effectiveFrom: "desc" },
        include: {
          folder: { select: { name: true } },
          _count: { select: { acknowledgements: true } },
        },
      }),
      canGenerate
        ? prisma.documentTemplate.findMany({
            where: { tenantId: viewer.tenantId, ...(canTemplates ? {} : { isArchived: false }), ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}) },
            orderBy: [{ isArchived: "asc" }, { category: "asc" }],
            include: { _count: { select: { generated: true } } },
          })
        : Promise.resolve([]),
      myId
        ? prisma.employeeDocument.findMany({
            where: { employeeId: myId },
            orderBy: [{ status: "asc" }, { name: "asc" }],
            include: {
              documentType: { select: { name: true, isMandatory: true, trackExpiry: true } },
              folder: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      myId
        ? prisma.orgDocumentAck.findMany({ where: { employeeId: myId }, select: { documentId: true } })
        : Promise.resolve([]),
      canGenerate
        ? prisma.employee.findMany({
            where: { tenantId: viewer.tenantId, ...(letterScope ? (letterScope as object) : {}) },
            select: { id: true, displayName: true, employeeNumber: true },
            orderBy: { firstName: "asc" },
          })
        : Promise.resolve([]),
      prisma.employee.count({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } } }),
      canVerify
        ? prisma.employeeDocument.groupBy({
            by: ["status"],
            where: { tenantId: viewer.tenantId },
            _count: true,
          })
        : Promise.resolve([] as Array<{ status: string; _count: number }>),
    ]);

  const ackedIds = new Set(myPolicyAcks.map((a) => a.documentId));
  const myPendingPolicies = policies.filter((p) => p.requireAck && !ackedIds.has(p.id));
  const sc = (s: string) => statusCounts.find((x) => x.status === s)?._count ?? 0;

  const visibleTabs = TABS.filter((t) => {
    if (t === "mine") return !!myId;
    if (t === "templates" || t === "letters") return canGenerate;
    if (t === "pending" || t === "expiring") return canVerify;
    return true;
  });

  return (
    <>
      <PageHead
        title="Documents"
        subtitle={
          canVerify
            ? `${sc("PENDING_VERIFICATION")} awaiting verification · ${sc("PENDING_ON_EMPLOYEE")} owed by employees · ${expiring.length} expiring within 90 days`
            : "Your documents and the company policies you need to acknowledge"
        }
      />
      <DocumentsTabs />

      {myOpenLetters.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warning" title={`${myOpenLetters.length} letter${myOpenLetters.length === 1 ? "" : "s"} waiting for you`}>
            <div className="row gap-2 wrap" style={{ marginTop: 8 }}>
              {myOpenLetters.map((l) => (
                <Link key={l.id} className="btn primary sm" href={`/documents/letters/${l.id}`}>
                  {l.status === "PENDING_SIGNATURE" ? "Sign" : "Acknowledge"} {l.template.name}
                </Link>
              ))}
            </div>
          </Callout>
        </div>
      ) : null}

      {myPendingPolicies.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warning" title={`${myPendingPolicies.length} policy document(s) need your acknowledgement`}>
            <div className="row gap-2 wrap" style={{ marginTop: 8 }}>
              {myPendingPolicies.map((p) => (
                <form action={acknowledgeOrgDocument} key={p.id}>
                  <input type="hidden" name="documentId" value={p.id} />
                  <button className="btn primary sm" type="submit">
                    Acknowledge {p.title}{p.version ? ` v${p.version}` : ""}
                  </button>
                </form>
              ))}
            </div>
          </Callout>
        </div>
      ) : null}

      {canVerify ? (
        <div className="grid grid-4" style={{ marginBottom: 18 }}>
          <Stat label="Verified" value={sc("VERIFIED")} meta="Approved and on file" />
          <Stat label="Awaiting verification" value={sc("PENDING_VERIFICATION")} meta="Uploaded, needs review" />
          <Stat label="Owed by employees" value={sc("PENDING_ON_EMPLOYEE")} meta="Mandatory, not submitted" />
          <Stat label="Expiring in 90 days" value={expiring.length} meta="Passports, visas, certifications" />
        </div>
      ) : null}

      <div className="tabs">
        {visibleTabs.map((t) => (
          <Link key={t} href={`/documents?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>
            {TAB_LABEL[t]}
            {t === "pending" && pending.length > 0 ? ` (${pending.length})` : ""}
            {t === "expiring" && expiring.length > 0 ? ` (${expiring.length})` : ""}
          </Link>
        ))}
      </div>

      {tab === "pending" && canVerify ? (
        <Card title={`Pending documents (${pending.length})`} tight>
          {pending.length === 0 ? <Empty title="Nothing pending — every document is verified" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Employee</th><th>Document</th><th>Folder</th>
                    <th>Uploaded</th><th>Status</th><th>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link href={`/employees/${d.employee.id}`}>
                          <Person
                            name={d.employee.displayName ?? ""}
                            meta={`${d.employee.employeeNumber} · ${d.employee.department?.name ?? "—"}`}
                          />
                        </Link>
                      </td>
                      <td>
                        <span className="strong">{d.name}</span>
                        {d.documentType?.isMandatory ? <Badge tone="warning">mandatory</Badge> : null}
                        {d.fileUrl?.startsWith("/files/") ? <div><a className="text-xs" href={d.fileUrl}>View file</a></div> : null}
                      </td>
                      <td className="text-sm">
                        {d.folder?.name ?? "—"}
                        {d.folder?.isConfidential ? <Badge tone="danger">confidential</Badge> : null}
                      </td>
                      <td className="text-sm nowrap">
                        {d.uploadedAt ? formatDate(d.uploadedAt) : <span className="subtle">Not uploaded</span>}
                      </td>
                      <td>
                        <Badge tone={DOC_STATUS_TONE[d.status] ?? "neutral"}>
                          {d.status.replace(/_/g, " ").toLowerCase()}
                        </Badge>
                      </td>
                      <td>
                        {d.status === "PENDING_VERIFICATION" ? (
                          <div className="row gap-1">
                            <form action={verifyDocument}>
                              <input type="hidden" name="id" value={d.id} />
                              <input type="hidden" name="decision" value="approve" />
                              <button className="btn primary sm" type="submit">Verify</button>
                            </form>
                            <form action={verifyDocument} className="row gap-1">
                              <input type="hidden" name="id" value={d.id} />
                              <input type="hidden" name="decision" value="reject" />
                              <input className="input" name="reason" placeholder="Reason" required style={{ width: 110, padding: "3px 7px", fontSize: 12 }} />
                              <button className="btn sm" type="submit">Reject</button>
                            </form>
                          </div>
                        ) : (
                          <span className="subtle text-xs">Waiting on the employee</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === "expiring" && canVerify ? (
        <Card
          title={`Expiring within 90 days (${expiring.length})`}
          description="Chase these before they lapse — an expired identity document blocks statutory filing."
          tight
        >
          {expiring.length === 0 ? <Empty title="Nothing expiring soon" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Employee</th><th>Document</th><th>Issued</th><th>Expires</th><th>Days left</th></tr>
                </thead>
                <tbody>
                  {expiring.map((d) => {
                    const days = d.expiresOn
                      ? Math.ceil((d.expiresOn.getTime() - Date.now()) / 86400000)
                      : null;
                    return (
                      <tr key={d.id}>
                        <td>
                          <Link href={`/employees/${d.employee.id}`}>
                            <Person name={d.employee.displayName ?? ""} meta={d.employee.employeeNumber} />
                          </Link>
                        </td>
                        <td className="strong">{d.name}</td>
                        <td className="text-sm nowrap">{formatDate(d.issuedOn)}</td>
                        <td className="text-sm nowrap">{formatDate(d.expiresOn)}</td>
                        <td>
                          {days === null ? <span className="subtle">—</span>
                            : days < 0 ? <Badge tone="danger">expired {Math.abs(days)}d ago</Badge>
                            : days <= 30 ? <Badge tone="danger">{days}d</Badge>
                            : <Badge tone="warning">{days}d</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === "policies" ? (
        <Card title={`Company policies (${policies.length})`} tight>
          {policies.length === 0 ? <Empty title="No policy documents published" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Policy</th><th>Version</th><th>Effective</th>
                    <th>Acknowledgement</th><th>Mine</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <span className="strong">{p.title}</span>
                        {p.description ? <div className="text-xs subtle">{p.description}</div> : null}
                      </td>
                      <td className="mono text-xs">{p.version ?? "—"}</td>
                      <td className="text-sm nowrap">{formatDate(p.effectiveFrom)}</td>
                      <td style={{ minWidth: 170 }}>
                        {p.requireAck ? (
                          <>
                            <div className="row text-xs subtle" style={{ justifyContent: "space-between", marginBottom: 3 }}>
                              <span>Acknowledged</span>
                              <span className="num">{p._count.acknowledgements} of {headcount}</span>
                            </div>
                            <Progress
                              value={p._count.acknowledgements}
                              max={Math.max(1, headcount)}
                              tone={p._count.acknowledgements >= headcount ? "success" : "warning"}
                            />
                          </>
                        ) : <span className="subtle text-xs">Not required</span>}
                      </td>
                      <td>
                        {!p.requireAck ? <span className="subtle">—</span>
                          : ackedIds.has(p.id) ? <Badge tone="success" dot>Done</Badge>
                          : (
                            <form action={acknowledgeOrgDocument}>
                              <input type="hidden" name="documentId" value={p.id} />
                              <button className="btn primary sm" type="submit">Acknowledge</button>
                            </form>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === "templates" && canGenerate ? (
        <div className="stack gap-4">
          <Callout tone="info" title="Rendered output is frozen at generation">
            A generated letter stores its rendered body, so editing a template later never
            rewrites a document that has already been issued. Unresolved placeholders are
            emitted as a visible marker rather than silently left blank.
          </Callout>

          <ListSearch tab="templates" q={q} placeholder="Search templates by name" />
          <Card title={`Letter templates (${templates.length})`} tight action={canTemplates ? <Link className="btn sm primary" href="/documents/templates/new">New template</Link> : null}>
            {templates.length === 0 ? <Empty title="No letter templates yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Template</th><th>Category</th><th>Workflow</th>
                    <th className="num">Issued</th><th>Generate</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.map((t) => (
                    <tr key={t.id}>
                      <td>
                        {canTemplates ? <Link className="strong" href={`/documents/templates/${t.id}`}>{t.name}</Link> : <span className="strong">{t.name}</span>}
                        {t.isArchived ? <> <Badge tone="neutral">archived</Badge></> : null}
                      </td>
                      <td><Badge tone="neutral">{t.category.toLowerCase().replace(/_/g, " ")}</Badge></td>
                      <td className="text-sm">{LETTER_WORKFLOWS[(t.workflow ?? "") as keyof typeof LETTER_WORKFLOWS] ?? t.workflow}</td>
                      <td className="num">{t._count.generated}</td>
                      <td>{t.isArchived ? null : <GenerateLetter templateId={t.id} employees={employees.map((e) => ({ value: e.id, label: `${e.employeeNumber} ${e.displayName}` }))} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </Card>
        </div>
      ) : null}

      {tab === "letters" && canGenerate ? (
        <>
        <ListSearch tab="letters" q={q} placeholder="Search by letter number, template or employee" />
        <Card title={`Letters (${letters.length})`} tight>
          {letters.length === 0 ? <Empty title="No letters generated yet">Generate one from the letter templates tab.</Empty> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Letter</th><th>Employee</th><th>Generated</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {letters.map((l) => (
                    <tr key={l.id}>
                      <td className="strong">{l.template.name}{l.letterNumber ? <div className="text-xs subtle">{l.letterNumber}</div> : null}</td>
                      <td><Link href={`/employees/${l.employee.id}`}>{l.employee.displayName}</Link> <span className="subtle text-xs">{l.employee.employeeNumber}</span></td>
                      <td className="text-sm nowrap">{formatDate(l.issuedOn)}</td>
                      <td>
                        <Badge tone={LETTER_TONE[l.status] ?? "neutral"}>{LETTER_STATUS_LABEL[l.status] ?? l.status.toLowerCase()}</Badge>
                        {l.signedAt ? <div className="text-xs subtle">signed {formatDate(l.signedAt)}</div> : l.acknowledgedAt ? <div className="text-xs subtle">acknowledged {formatDate(l.acknowledgedAt)}</div> : null}
                      </td>
                      <td className="right"><Link className="btn sm ghost" href={`/documents/letters/${l.id}`}>Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        </>
      ) : null}

      {tab === "mine" && myId ? (
        <div className="stack gap-4">
        {myLetters.length > 0 ? (
          <Card title={`My letters (${myLetters.length})`} tight>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Letter</th><th>Issued</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {myLetters.map((l) => (
                    <tr key={l.id}>
                      <td className="strong">{l.template.name}</td>
                      <td className="text-sm nowrap">{formatDate(l.issuedOn)}</td>
                      <td><Badge tone={LETTER_TONE[l.status] ?? "neutral"}>{LETTER_STATUS_LABEL[l.status] ?? l.status.toLowerCase()}</Badge></td>
                      <td className="right"><Link className="btn sm ghost" href={`/documents/letters/${l.id}`}>{l.status === "PENDING_SIGNATURE" ? "Sign" : l.status === "PENDING_ACKNOWLEDGEMENT" ? "Acknowledge" : "View"}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
        <Card title={`My documents (${myDocs.length})`} tight>
          {myDocs.length === 0 ? <Empty title="No documents on your record" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Document</th><th>Folder</th><th>Status</th><th>Expires</th><th>Note</th><th /></tr>
                </thead>
                <tbody>
                  {myDocs.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <span className="strong">{d.name}</span>
                        {d.documentType?.isMandatory ? <Badge tone="warning">mandatory</Badge> : null}
                      </td>
                      <td className="text-sm">{d.folder?.name ?? "—"}</td>
                      <td>
                        <Badge tone={DOC_STATUS_TONE[d.status] ?? "neutral"}>
                          {d.status.replace(/_/g, " ").toLowerCase()}
                        </Badge>
                      </td>
                      <td className="text-sm nowrap">
                        {d.expiresOn ? formatDate(d.expiresOn) : <span className="subtle">—</span>}
                      </td>
                      <td className="text-sm muted">
                        {d.status === "PENDING_ON_EMPLOYEE"
                          ? "Upload this when you can"
                          : d.rejectReason ?? "—"}
                      </td>
                      <td className="right">
                        <span className="row gap-2" style={{ justifyContent: "flex-end" }}>
                          {d.fileUrl?.startsWith("/files/") ? <a className="btn sm ghost" href={d.fileUrl}>View</a> : null}
                          {d.status !== "VERIFIED" && d.status !== "NOT_APPLICABLE"
                            ? <UploadDocument documentId={d.id} trackExpiry={d.documentType?.trackExpiry} label={d.fileUrl ? "Replace" : "Upload"} />
                            : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        </div>
      ) : null}
    </>
  );
}

/** A small GET search form for a list tab. */
function ListSearch({ tab, q, placeholder }: { tab: string; q: string; placeholder: string }) {
  return (
    <form method="get" action="/documents" className="row gap-2" style={{ marginBottom: 12 }}>
      <input type="hidden" name="tab" value={tab} />
      <input className="input" name="q" defaultValue={q} placeholder={placeholder} aria-label={placeholder} style={{ width: 320 }} />
      <button className="btn sm" type="submit">Search</button>
      {q ? <Link className="btn sm ghost" href={`/documents?tab=${tab}`}>Clear</Link> : null}
    </form>
  );
}
