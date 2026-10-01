import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  decisionBlocker, resolveRequisitionApprover, backfillReasonLabel, currencyLabel, jobTypeLabel, employmentTypeLabel,
} from "@keka/services";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { aiEnabled, AI_UNAVAILABLE } from "@/lib/ai";
import { UrlModal } from "@/components/url-modal";
import {
  requisitionRows, readFilters, requisitionOptions, approverActor, visibleRequisitions, userNames, kDate, kDateTime, salaryRange,
  PAGE_SIZE, type View, type ReqRow,
} from "../_lib/data";
import { FilterBar } from "../_parts/filter-bar";
import { PendingTable } from "../_parts/pending-table";
import { RowMenu } from "../_parts/row-menu";
import { RequisitionForm, type ReqValues } from "../_parts/requisition-form";
import { DecideButtons } from "../_parts/decide";
import { FlashToast } from "../_parts/toast";
import { Markdown } from "../_parts/markdown";
import s from "../hire.module.css";

const P = PERMISSIONS;
type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) ?? "";

const FLASH = {
  saved: "Requisition request saved successfully", updated: "Requisition updated successfully",
  approved: "Requisition approved successfully", rejected: "Requisition rejected",
};

export const metadata = { title: "Requisitions · Hire" };

/**
 * Org › Hiring › All Requisitions / Pending Approvals / Archived (R02–R10,
 * C02, C14). Create, View and Edit open as full-screen modals carried in
 * the URL, so a link from a notification lands on the right one.
 */
export default async function RequisitionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.REQUISITION_VIEW, P.REQUISITION_MANAGE, P.REQUISITION_APPROVE])) forbidden();
  const sp = await searchParams;
  const view: View = one(sp, "view") === "pending" ? "pending" : one(sp, "view") === "archived" ? "archived" : "all";
  const f = readFilters(sp);
  const [{ rows, total, pendingCount }, depts, locs] = await Promise.all([
    requisitionRows(viewer, view, f),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  // Links keep the view and filters; modals add one parameter on top.
  const keep = new URLSearchParams();
  for (const k of ["view", "department", "location", "status", "priority", "q", "page"]) if (one(sp, k)) keep.set(k, one(sp, k));
  const base = `/hiring/requisitions${keep.toString() ? `?${keep}` : ""}`;
  const withParam = (extra: string) => `${base}${base.includes("?") ? "&" : "?"}${extra}`;
  const tabHref = (v: View) => (v === "all" ? "/hiring/requisitions" : `/hiring/requisitions?view=${v}`);
  const exportQs = new URLSearchParams(keep); exportQs.delete("page");
  const exportHref = `/hiring/requisitions/export${exportQs.toString() ? `?${exportQs}` : ""}`;
  const viewHref = Object.fromEntries(rows.map((r) => [r.id, withParam(`req=${r.id}`)]));

  const reqId = one(sp, "req");
  const modal = can(viewer, P.REQUISITION_MANAGE) && one(sp, "new") === "1"
    ? await CreateModal({ viewer, closeHref: base })
    : reqId ? await ViewOrEditModal({ viewer, id: reqId, edit: one(sp, "edit") === "1", closeHref: base, editHref: withParam(`req=${reqId}&edit=1`), viewHref: withParam(`req=${reqId}`) }) : null;

  const statusOptions = [
    { value: "pending", label: "Pending" }, { value: "approved", label: "Approved" }, { value: "progress", label: "Hiring in Progress" },
    { value: "rejected", label: "Rejected" }, { value: "fulfilled", label: "Fulfilled" },
  ];
  const selects = [
    { name: "department", label: "Department", options: depts.map((d) => ({ value: d.id, label: d.name })) },
    { name: "location", label: "Location", options: locs.map((l) => ({ value: l.id, label: l.name })) },
    ...(view === "all" ? [{ name: "status", label: "Status", options: statusOptions }] : []),
    { name: "priority", label: "Priority", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
  ];
  const hasFilters = !!(f.department || f.location || f.status || f.priority || f.q);

  return (
    <>
      <nav className={s.segTabs} aria-label="Requisitions">
        <Link href={tabHref("all")} className={`${s.segTab}${view === "all" ? ` ${s.active}` : ""}`} aria-current={view === "all" ? "page" : undefined}>All Requisitions</Link>
        <Link href={tabHref("pending")} className={`${s.segTab}${view === "pending" ? ` ${s.active}` : ""}`} aria-current={view === "pending" ? "page" : undefined}>
          Pending Approvals{pendingCount ? <span className={s.segCount}>{pendingCount}</span> : null}
        </Link>
        <Link href={tabHref("archived")} className={`${s.segTab}${view === "archived" ? ` ${s.active}` : ""}`} aria-current={view === "archived" ? "page" : undefined}>Archived</Link>
      </nav>

      <div className={s.head}>
        <div>
          <h1 className={s.h1}>{view === "pending" ? "Pending Requisition" : view === "archived" ? "Archived Requisitions" : "All Requisitions"}</h1>
          {view === "pending" ? <p className={s.sub}>Below are the job requisitions waiting for an approval.</p> : null}
          {view === "archived" ? <p className={s.sub}>Requisitions taken out of play. Unarchive one to work on it again.</p> : null}
        </div>
        <div className={s.headActions}>
          {canAny(viewer, [P.JOB_MANAGE, P.CANDIDATE_MANAGE]) ? (
            <Link href="/hiring/jobs" className={s.outlineBtn}>Jobs &amp; Candidates
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </Link>
          ) : null}
          {can(viewer, P.REQUISITION_MANAGE) ? <Link href={withParam("new=1")} className={s.primaryBtn} scroll={false}>Create New Requisition</Link> : null}
        </div>
      </div>

      {total === 0 && !hasFilters && view === "all" ? (
        <div className={s.cardAlone}><div className={s.empty}>No requisitions made yet</div></div>
      ) : (
        <>
          <FilterBar selects={selects} />
          {view === "pending" ? (
            <PendingTable rows={rows} total={total} exportHref={exportHref} viewHref={viewHref} />
          ) : (
            <div className={s.card}>
              <div className={s.toolbar}>
                <span />
                <div className={s.toolbarRight}>
                  <span>Total: {total}</span>
                  <a className={s.iconLink} href={exportHref} title="Download" aria-label="Download as CSV">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </a>
                </div>
              </div>
              {rows.length === 0 ? <div className={s.empty}>{view === "archived" ? "No archived requisitions." : "No requisitions match these filters."}</div> : (
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead>
                      <tr><th>Requisition For</th><th>Department</th><th>Requested By</th><th>Location</th><th>Priority</th><th>Positions</th><th>Salary Range</th><th>Status</th><th>Actions</th></tr>
                    </thead>
                    <tbody>{rows.map((r) => <Row key={r.id} r={r} viewHref={viewHref[r.id]} editHref={withParam(`req=${r.id}&edit=1`)} />)}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          <Pager total={total} page={f.page} href={(p) => { const q = new URLSearchParams(keep); if (p > 1) q.set("page", String(p)); else q.delete("page"); return `/hiring/requisitions${q.toString() ? `?${q}` : ""}`; }} />
        </>
      )}
      {modal}
      <FlashToast messages={FLASH} />
    </>
  );
}

function Row({ r, viewHref, editHref }: { r: ReqRow; viewHref: string; editHref: string }) {
  return (
    <tr>
      <td><Link className={s.reqLink} href={viewHref} scroll={false}>{r.title}</Link><div className={s.code}>{r.code}</div></td>
      <td>{r.department}</td>
      <td>{r.requestedBy}<div className={s.metaLine}>on {r.requestedOn}</div></td>
      <td>{r.location}</td>
      <td className={r.priority ? s.priorityYes : undefined}>{r.priority ? "Yes" : "No"}</td>
      <td>{r.positions}</td>
      <td className="nowrap">{r.salary}</td>
      <td>
        {r.status}
        {r.tone === "progress" && r.jobId ? <div><Link className={s.statusLink} href={`/hiring/jobs/${r.jobId}`}>View Job</Link></div> : null}
        {r.statusSub ? <div className={s.statusSub}>{r.statusSub}</div> : null}
      </td>
      <td><RowMenu id={r.id} viewHref={viewHref} editHref={editHref} canEdit={r.canEdit} canArchive={r.canArchive} archived={r.archived} canOpenJob={r.canOpenJob} /></td>
    </tr>
  );
}

function Pager({ total, page, href }: { total: number; page: number; href: (p: number) => string }) {
  if (total === 0) return null;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = (page - 1) * PAGE_SIZE + 1, to = Math.min(total, page * PAGE_SIZE);
  const btn = (p: number, label: string, aria: string) => (p >= 1 && p <= pages && p !== page
    ? <Link href={href(p)} aria-label={aria}>{label}</Link>
    : <span className={s.off} aria-hidden="true">{label}</span>);
  return (
    <div className={s.pager} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderTop: 0, borderRadius: "0 0 4px 4px" }}>
      <span>{from} to {to} of {total}</span>
      <span className={s.pagerBtns}>
        {btn(1, "«", "First page")}{btn(page - 1, "‹", "Previous page")}
        <span style={{ padding: "0 8px", color: "var(--text)" }}>Page {page} of {pages}</span>
        {btn(page + 1, "›", "Next page")}{btn(pages, "»", "Last page")}
      </span>
    </div>
  );
}

// --- Modals ---------------------------------------------------------------------------

const blank: ReqValues = {
  title: "", isPriority: false, departmentId: "", minExperienceYears: "", newHire: true, newPositions: "1", backfill: false, backfills: [],
  locationId: "", targetStartDate: "", currency: "INR", salaryMin: "", salaryMax: "", salaryFrequency: "", jobType: "FULL_TIME", employmentType: "",
  description: "", justification: "", hiringManagerId: "", recruiterId: "",
};

async function CreateModal({ viewer, closeHref }: { viewer: Viewer; closeHref: string }) {
  const [options, approver] = await Promise.all([
    requisitionOptions(viewer),
    resolveRequisitionApprover(viewer.tenantId, { raisedBy: viewer.user.id, departmentId: null }),
  ]);
  const names = await userNames(viewer.tenantId, [approver]);
  return (
    <UrlModal title="Create Requisition" closeHref={closeHref} full>
      <RequisitionForm mode="create" initial={{ ...blank, departmentId: viewer.employee ? (await prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { departmentId: true } }))?.departmentId ?? "" : "" }}
        options={options} approverName={approver ? names.get(approver) ?? null : null} aiOn={aiEnabled()} aiUnavailable={AI_UNAVAILABLE} closeHref={closeHref} />
    </UrlModal>
  );
}

async function ViewOrEditModal({ viewer, id, edit, closeHref, editHref, viewHref }: { viewer: Viewer; id: string; edit: boolean; closeHref: string; editHref: string; viewHref: string }) {
  const scope = await visibleRequisitions(viewer);
  const r = await prisma.requisition.findFirst({
    where: { AND: [scope, { id }] },
    include: { backfills: { include: { employee: { select: { id: true, displayName: true } } } }, jobs: { select: { id: true, openings: true, status: true } } },
  });
  if (!r) {
    return <UrlModal title="View Requisition" closeHref={closeHref}><p>This requisition does not exist or is not visible to you.</p></UrlModal>;
  }
  const manage = can(viewer, P.REQUISITION_MANAGE), approve = can(viewer, P.REQUISITION_APPROVE);
  const canEdit = !r.archivedAt && !["FULFILLED", "CANCELLED"].includes(r.status) && (r.status === "APPROVED" ? approve : manage || r.raisedBy === viewer.user.id);

  if (edit && canEdit) {
    const options = await requisitionOptions(viewer);
    const names = await userNames(viewer.tenantId, [r.approverUserId]);
    const initial: ReqValues = {
      title: r.title, isPriority: r.isPriority, departmentId: r.departmentId ?? "", minExperienceYears: r.minExperienceYears === null ? "" : String(Number(r.minExperienceYears)),
      newHire: r.newPositions > 0 || r.backfills.length === 0, newPositions: String(r.newPositions || (r.backfills.length ? 1 : r.positions)),
      backfill: r.backfills.length > 0, backfills: r.backfills.map((b) => ({ employeeId: b.employeeId, reason: b.reason })),
      locationId: r.locationId ?? "", targetStartDate: r.targetStartDate ? r.targetStartDate.toISOString().slice(0, 10) : "",
      currency: r.currency, salaryMin: r.salaryMin === null ? "" : String(Number(r.salaryMin)), salaryMax: r.salaryMax === null ? "" : String(Number(r.salaryMax)),
      salaryFrequency: r.salaryFrequency ?? "", jobType: r.jobType, employmentType: r.employmentType ?? "",
      description: r.description ?? "", justification: r.justification ?? "", hiringManagerId: r.hiringManagerId ?? "", recruiterId: r.recruiterId ?? "",
    };
    // Backfilled people who have since left still show on the requisition.
    for (const b of r.backfills) if (!options.employees.some((e) => e.id === b.employeeId)) options.employees.push({ id: b.employeeId, name: b.employee.displayName, number: "", title: null });
    return (
      <UrlModal title="Edit Requisition" closeHref={viewHref} full>
        <RequisitionForm mode="edit" id={r.id} initial={initial} options={options} approverName={r.approverUserId ? names.get(r.approverUserId) ?? null : null}
          aiOn={aiEnabled()} aiUnavailable={AI_UNAVAILABLE} closeHref={viewHref} />
      </UrlModal>
    );
  }

  const [setting, dept, loc, hm, audits, actor] = await Promise.all([
    prisma.hiringSetting.findUnique({ where: { tenantId: viewer.tenantId }, select: { requisitionInstructions: true } }),
    r.departmentId ? prisma.department.findFirst({ where: { tenantId: viewer.tenantId, id: r.departmentId }, select: { name: true } }) : null,
    r.locationId ? prisma.location.findFirst({ where: { tenantId: viewer.tenantId, id: r.locationId }, select: { name: true } }) : null,
    r.hiringManagerId ? prisma.employee.findFirst({ where: { tenantId: viewer.tenantId, id: r.hiringManagerId }, select: { displayName: true } }) : null,
    prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, entityType: "Requisition", entityId: r.id }, orderBy: { createdAt: "asc" }, select: { actorId: true, summary: true, createdAt: true } }),
    approverActor(viewer),
  ]);
  const names = await userNames(viewer.tenantId, [r.raisedBy, r.approverUserId, r.recruiterId, ...audits.map((a) => a.actorId)]);
  const activities = audits.length ? audits : [{ actorId: r.raisedBy, summary: "Created Requisition", createdAt: r.createdAt }];
  const decidable = decisionBlocker(r, actor) === null;
  const reqType = r.backfills.length && r.newPositions ? "New Hiring + Backfill" : r.backfills.length ? "Backfill" : "New Hiring";
  const kv: Array<[string, string]> = [
    ["Job Title", r.title], ["Experience", r.minExperienceYears === null ? "Not available" : `${Number(r.minExperienceYears)} years`],
    ["Number of Positions", String(r.positions)], ["Priority", r.isPriority ? "Yes" : "No"],
    ["Currency", currencyLabel(r.currency)], ["Salary Range", salaryRange(r).replace("Not Available", "Not available")],
    ["Location", loc?.name ?? "Not available"], ["Department", dept?.name ?? "Not available"],
    ["Target Hiring Date", r.targetStartDate ? kDate(r.targetStartDate) : "Not available"], ["Job Type", jobTypeLabel(r.jobType)],
    ["Requisition Type", reqType], ["Employment Type", r.employmentType ? employmentTypeLabel(r.employmentType) : "Not available"],
    ["Hiring Manager", hm?.displayName ?? "Not available"], ["Recruiter", r.recruiterId ? names.get(r.recruiterId) ?? "—" : "Not available"],
    ["Status", r.archivedAt ? "Archived" : r.status === "PENDING_APPROVAL" ? `Pending on ${r.approverUserId ? names.get(r.approverUserId) ?? "an approver" : "any approver"}` : r.status.charAt(0) + r.status.slice(1).toLowerCase().replace(/_/g, " ")],
    ["Code", r.code ?? "—"],
  ];
  return (
    <UrlModal title="View Requisition" closeHref={closeHref} full>
      <div className={s.viewGrid}>
        <div className={s.viewMain}>
          <div className={s.instructions}>
            <div className={s.instructionsBox}>
              <div className={s.instructionsTitle}>Instructions</div>
              <div className={s.instructionsText}>{setting?.requisitionInstructions ?? "Please raise a relevant requisition."}</div>
            </div>
            {canEdit ? (
              <Link href={editHref} className={s.pencil} aria-label="Edit requisition" title="Edit" scroll={false}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" strokeLinejoin="round" /></svg>
              </Link>
            ) : null}
          </div>
          <div className={s.kv}>
            {kv.map(([k, v]) => <div key={k}><div className={s.kvLabel}>{k}</div><div className={s.kvValue}>{v}</div></div>)}
          </div>
          {r.rejectReason && r.status === "REJECTED" ? <div className="callout danger" style={{ marginTop: 24 }}><div><strong>Rejected:</strong> {r.rejectReason}</div></div> : null}
          {r.backfills.length ? (
            <>
              <div className={s.blockLabel}>Backfill for</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.8 }}>
                {r.backfills.map((b) => <li key={b.id}>{b.employee.displayName} — {backfillReasonLabel(b.reason)}</li>)}
              </ul>
            </>
          ) : null}
          <div className={s.blockLabel}>Job Description</div>
          <Markdown text={r.description ?? r.justification} className={s.markdown} />
          {r.justification && r.description ? (
            <>
              <div className={s.blockLabel}>Additional Comments</div>
              <p style={{ fontSize: 14 }}>{r.justification}</p>
            </>
          ) : null}
        </div>
        <aside className={s.viewSide}>
          <h3 className={s.activitiesTitle}>Activities</h3>
          {activities.map((a, i) => (
            <div key={i} className={s.activity}>
              <span className={s.activityDot} />
              <div>
                <div><span className={s.activityWho}>{a.actorId ? names.get(a.actorId) ?? "Administrator" : "System"}</span><span className={s.activityWhen}>on {kDateTime(a.createdAt)}</span></div>
                <div className={s.activityText}>{a.summary}</div>
              </div>
            </div>
          ))}
        </aside>
      </div>
      {decidable ? <div className={s.decisionBar}><DecideButtons id={r.id} closeHref={closeHref} /></div> : null}
    </UrlModal>
  );
}
