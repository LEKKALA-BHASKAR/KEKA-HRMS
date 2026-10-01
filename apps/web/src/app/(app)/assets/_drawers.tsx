import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  ASSET_CONDITION_LABEL, ASSET_STATUS_LABEL, ASSET_REQUEST_TYPE_LABEL, ASSET_REQUEST_STATUS_LABEL, currentAssetLevel, canActOnAssetLevel,
  type AssetConditionKey, type AssetStatusKey, type AssetLevelState,
} from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { Avatar } from "@/components/avatar";
import { assignAssetAction, decideAssetRequestAction, cancelAssetRequestAction } from "@/app/actions/assets";
import { UrlSheet, FullScreen, FilterForm, ActButton, Kebab, ModalButton } from "./_ui";
import { AssetIcon, Timeline, FSelect, FSearch, Yellow, dateTime, fmt, qs, AckText, type TimelineEntry } from "./_parts";
import { assetMenu, ConditionSelect, type AssetPerms } from "./_menu";
import { AssignForm } from "./_assign-form";
import s from "./assets.module.css";

/**
 * Drawers and overlays opened by a query parameter, so they survive a
 * refresh and can be linked to: ?audit=<asset>, ?view=<request>,
 * ?assign=request:<id> | asset:<id> | new, and ?emp=<employee> for the
 * "+N Assets" list.
 */

const P = PERMISSIONS;

async function names(tenantId: string, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const [emps, users] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId, id: { in: list } }, select: { id: true, displayName: true } }),
    prisma.user.findMany({ where: { tenantId, id: { in: list } }, select: { id: true, email: true, employee: { select: { displayName: true } } } }),
  ]);
  const m = new Map<string, string>();
  for (const e of emps) m.set(e.id, e.displayName ?? "—");
  for (const u of users) m.set(u.id, u.employee?.displayName ?? u.email);
  return m;
}

const cond = (v: unknown) => (typeof v === "string" ? ASSET_CONDITION_LABEL[v as AssetConditionKey] ?? v : null);

// ---------------------------------------------------------------------------
//  View Audit History
// ---------------------------------------------------------------------------

export async function AuditDrawer({ viewer, assetId, closeHref }: { viewer: Viewer; assetId: string; closeHref: string }) {
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, tenantId: viewer.tenantId },
    include: { assetType: { include: { category: true } }, events: { orderBy: { createdAt: "desc" }, take: 100 } },
  });
  if (!asset) return null;
  const who = await names(viewer.tenantId, asset.events.map((e) => e.employeeId));
  const entries: TimelineEntry[] = asset.events.map((e) => {
    const to = (e.toValue ?? {}) as Record<string, unknown>, from = (e.fromValue ?? {}) as Record<string, unknown>;
    const by = e.actorLabel ? ` by ${e.actorLabel}` : "";
    const emp = e.employeeId ? who.get(e.employeeId) ?? "an employee" : "";
    switch (e.kind) {
      case "CREATED": return { text: `Added to the inventory${by}`, at: e.createdAt };
      case "IMPORTED": return { text: `Imported${by}`, at: e.createdAt, note: e.note };
      case "UPDATED": return { text: `Details edited${by}`, at: e.createdAt, note: Object.keys(to).length ? `Changed: ${Object.keys(to).join(", ")}` : e.note };
      case "ASSIGNED": return { text: `Assigned to ${emp}${by}`, at: e.createdAt, note: e.note };
      case "ACKNOWLEDGED": return { text: `Acknowledged by ${emp}`, at: e.createdAt };
      case "ACK_REMINDED": return { text: `Acknowledgement reminder sent to ${emp}${by}`, at: e.createdAt, tone: "grey" };
      case "RETURNED": return { text: `Recovered from ${emp}${cond(to.condition) ? ` (${cond(to.condition)})` : ""}${by}`, at: e.createdAt, note: e.note };
      case "CONDITION_CHANGED": return { text: `Condition changed from ${cond(from.condition)} to ${cond(to.condition)}${by}`, at: e.createdAt, note: e.note };
      case "STATUS_CHANGED": return { text: `Status changed to ${ASSET_STATUS_LABEL[to.status as AssetStatusKey] ?? String(to.status)}${by}`, at: e.createdAt, note: e.note, tone: to.status === "AVAILABLE" ? "ok" : "grey" };
      case "REQUEST_FULFILLED": return { text: `Assigned against ${emp}'s request`, at: e.createdAt, note: e.note };
      default: return { text: e.kind, at: e.createdAt };
    }
  });
  return (
    <UrlSheet title="Audit history" subtitle={`${asset.name ?? asset.assetType.name} · ${asset.assetTag}`} closeHref={closeHref}>
      <div className={s.drawerPerson}>
        <div className={s.who}>
          <span className={s.myIcon}><AssetIcon icon={asset.assetType.icon} /></span>
          <div>
            <div className="strong">{asset.name ?? asset.assetType.name}</div>
            <div className="text-sm muted">{asset.assetType.category.name} › {asset.assetType.name}</div>
          </div>
        </div>
        <Link href={`/assets/${asset.id}`} className="btn sm">Open asset</Link>
      </div>
      <div className={s.drawerSection}>
        <h4>Activity</h4>
        <Timeline entries={entries} />
      </div>
    </UrlSheet>
  );
}

// ---------------------------------------------------------------------------
//  View Request
// ---------------------------------------------------------------------------

export async function requestActivity(tenantId: string, r: {
  createdAt: Date; status: string; closedAt: Date | null; closedBy: string | null; employeeId: string; rejectReason: string | null;
  approvals: Array<{ level: number; approverKind: string; approverId: string | null; status: string; actedById: string | null; actedAt: Date | null; note: string | null }>;
  assignment: { assignedOn: Date; assignedBy: string | null; asset: { assetTag: string; name: string | null } } | null;
}): Promise<TimelineEntry[]> {
  const who = await names(tenantId, [...r.approvals.flatMap((a) => [a.actedById, a.approverId]), r.closedBy, r.assignment?.assignedBy, r.employeeId]);
  const out: TimelineEntry[] = [];
  if (r.assignment) out.push({ text: `${who.get(r.assignment.assignedBy ?? "") ?? "Asset manager"} assigned asset`, at: r.assignment.assignedOn, note: `${r.assignment.asset.name ?? ""} ${r.assignment.asset.assetTag}`.trim() });
  if (r.status === "CANCELLED" && r.closedAt) out.push({ text: `Cancelled by ${who.get(r.closedBy ?? "") ?? "—"}`, at: r.closedAt, tone: "grey" });
  for (const a of [...r.approvals].sort((x, y) => y.level - x.level)) {
    if (a.status === "APPROVED" && a.actedAt) out.push({ text: `Approved by ${who.get(a.actedById ?? "") ?? "—"}`, at: a.actedAt, note: a.note });
    else if (a.status === "SKIPPED" && a.actedAt) out.push({ text: "Skipped due to already approved", at: a.actedAt });
    else if (a.status === "REJECTED" && a.actedAt) out.push({ text: `Rejected by ${who.get(a.actedById ?? "") ?? "—"}`, at: a.actedAt, tone: "red", note: a.note });
  }
  out.sort((a, b) => b.at.getTime() - a.at.getTime());
  const cur = r.status === "PENDING" ? currentAssetLevel(r.approvals as AssetLevelState[]) : null;
  if (cur) out.unshift({ text: `Waiting on ${cur.approverId ? who.get(cur.approverId) ?? "the approver" : "an asset manager"}`, at: new Date(), tone: "grey" });
  out.push({ text: `${who.get(r.employeeId) ?? "Employee"} raised the request`, at: r.createdAt, tone: "grey" });
  return out;
}

export async function RequestDrawer({ viewer, requestId, closeHref, own }: { viewer: Viewer; requestId: string; closeHref: string; own?: boolean }) {
  const r = await prisma.assetRequest.findFirst({
    where: {
      id: requestId, tenantId: viewer.tenantId,
      ...(own ? { employeeId: viewer.employee?.id ?? "__none__" } : { employee: scopedEmployeeWhere(viewer, P.ASSET_VIEW) }),
    },
    include: {
      employee: { select: { id: true, displayName: true, photoUrl: true, jobTitleName: true } },
      category: true, assetType: true, approvals: true,
      assignment: { include: { asset: { select: { assetTag: true, name: true } } } },
    },
  });
  if (!r) return null;
  const held = r.heldAssetId ? await prisma.asset.findFirst({ where: { id: r.heldAssetId, tenantId: viewer.tenantId }, select: { assetTag: true, name: true } }) : null;
  const activity = await requestActivity(viewer.tenantId, r);
  const cur = r.status === "PENDING" ? currentAssetLevel(r.approvals as AssetLevelState[]) : null;
  const canDecide = !own && !!cur && viewer.employee?.id !== r.employeeId && canActOnAssetLevel(cur, { employeeId: viewer.employee?.id ?? null, canManage: can(viewer, P.ASSET_MANAGE) });
  const canAssign = !own && r.status === "APPROVED" && r.requestType !== "RETURN" && can(viewer, P.ASSET_ASSIGN);
  const canCancel = (r.status === "PENDING" || r.status === "APPROVED") && (own || can(viewer, P.ASSET_MANAGE));
  const name = r.employee.displayName ?? "—";
  return (
    <UrlSheet title={ASSET_REQUEST_TYPE_LABEL[r.requestType]} closeHref={closeHref}>
      <div className={s.drawerPerson}>
        <div className={s.who}>
          <Avatar name={name} photoUrl={r.employee.photoUrl} size={44} />
          <div>
            <div>{name}</div>
            <div className="text-sm muted">Raised on {dateTime(r.createdAt)}</div>
          </div>
        </div>
        <span className="badge neutral">{ASSET_REQUEST_STATUS_LABEL[r.status]}</span>
      </div>
      <div className={s.drawerSection}><h4>Asset requested for</h4><div>{r.title ?? "—"}</div></div>
      <div className={s.drawerSection}><h4>Reason for request</h4><div style={{ whiteSpace: "pre-wrap" }}>{r.reason}</div></div>
      <div className={s.drawerSection}>
        <div className={s.kvGrid} style={{ fontSize: 14 }}>
          <div><dt>Asset category &amp; type</dt><dd>{[r.category?.name, r.assetType?.name].filter(Boolean).join(" › ") || "NA"}</dd></div>
          <div><dt>Needed by</dt><dd>{r.neededBy ? fmt(r.neededBy) : "—"}</dd></div>
          {held ? <div><dt>{r.requestType === "RETURN" ? "Asset to return" : "Asset to replace"}</dt><dd>{held.name} · {held.assetTag}</dd></div> : null}
          {r.rejectReason ? <div><dt>Reason for rejecting</dt><dd>{r.rejectReason}</dd></div> : null}
        </div>
      </div>
      <div className={s.drawerSection}>
        <h4>Activity</h4>
        <Timeline entries={activity} />
      </div>
      {canDecide || canAssign || canCancel ? (
        <div className={s.drawerSection} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {canDecide ? <ActButton action={decideAssetRequestAction} hidden={{ requestId: r.id, decision: "approve" }} className="btn primary">Approve</ActButton> : null}
          {canDecide ? (
            <ModalButton label="Reject" className="btn" title="Reject request" action={decideAssetRequestAction} hidden={{ requestId: r.id, decision: "reject" }} submitLabel="Reject" danger>
              <div className="field"><label className="label" htmlFor="rej-note">Reason for rejecting</label><textarea id="rej-note" name="note" className="textarea" rows={3} required /></div>
            </ModalButton>
          ) : null}
          {canAssign ? <Link className="btn primary" href={`/assets/requests?assign=request:${r.id}`}>Assign asset</Link> : null}
          {canCancel ? <ActButton action={cancelAssetRequestAction} hidden={{ requestId: r.id }} className="btn" confirm="Cancel this request?">Cancel request</ActButton> : null}
        </div>
      ) : null}
    </UrlSheet>
  );
}

// ---------------------------------------------------------------------------
//  Assign Asset
// ---------------------------------------------------------------------------

export async function AssignOverlay({ viewer, spec, sp, base, closeHref }: {
  viewer: Viewer; spec: string; sp: Record<string, string | undefined>; base: string; closeHref: string;
}) {
  if (!can(viewer, P.ASSET_ASSIGN)) return null;
  const [kind, id] = spec.split(":");

  // One known asset: pick the employee.
  if (kind === "asset") {
    const asset = await prisma.asset.findFirst({ where: { id, tenantId: viewer.tenantId, status: "AVAILABLE" }, include: { assetType: true } });
    if (!asset) return null;
    const emps = await prisma.employee.findMany({
      where: { ...scopedEmployeeWhere(viewer, P.ASSET_ASSIGN), status: { notIn: ["EXITED"] } },
      select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" },
    });
    return (
      <UrlSheet title="Assign asset" subtitle={`${asset.name ?? asset.assetType.name} · ${asset.assetTag}`} closeHref={closeHref} side={false}>
        <AssignToEmployee assetId={asset.id} condition={asset.condition} emps={emps} closeHref={closeHref} />
      </UrlSheet>
    );
  }

  const request = kind === "request"
    ? await prisma.assetRequest.findFirst({ where: { id, tenantId: viewer.tenantId, status: "APPROVED" }, include: { employee: { select: { id: true, displayName: true } } } })
    : null;
  if (kind === "request" && !request) return null;

  const [cats, locs, emps] = await Promise.all([
    prisma.assetCategory.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, include: { types: { where: { isActive: true }, orderBy: { name: "asc" } } }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    request ? Promise.resolve([]) : prisma.employee.findMany({
      where: { ...scopedEmployeeWhere(viewer, P.ASSET_ASSIGN), status: { notIn: ["EXITED"] } },
      select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" },
    }),
  ]);
  const cat = sp.cat ?? request?.categoryId ?? undefined;
  const type = sp.type ?? request?.assetTypeId ?? undefined;
  const catRow = cats.find((c) => c.id === cat);
  const typeOk = !!catRow?.types.some((t) => t.id === type);
  const employeeId = request?.employeeId ?? (emps.some((e) => e.id === sp.emp) ? sp.emp : undefined);
  const rows = catRow && typeOk ? await prisma.asset.findMany({
    where: {
      tenantId: viewer.tenantId, status: "AVAILABLE", assetTypeId: type,
      ...(sp.loc ? { locationId: sp.loc } : {}),
      ...(sp.aq ? { OR: [{ name: { contains: sp.aq, mode: "insensitive" } }, { assetTag: { contains: sp.aq, mode: "insensitive" } }, { serialNumber: { contains: sp.aq, mode: "insensitive" } }] } : {}),
    },
    include: { assetType: { include: { category: true } }, location: true }, orderBy: { assetTag: "asc" }, take: 100,
  }) : [];
  const keep = { assign: spec, ...(employeeId && !request ? { emp: employeeId } : {}) };
  return (
    <FullScreen title="Assign Asset" closeHref={closeHref}
      center={request ? <span className="text-sm muted">For {request.employee.displayName} · {request.title}</span> : null}>
      <FilterForm action={base}>
        {Object.entries(keep).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        {!request ? <FSelect name="emp" label="Employee" value={employeeId} options={emps.map((e) => ({ value: e.id, label: `${e.displayName} (${e.employeeNumber})` }))} /> : null}
        <FSelect name="cat" label="Asset Category" value={cat} options={cats.map((c) => ({ value: c.id, label: c.name }))} />
        <FSelect name="type" label="Asset Type" value={typeOk ? type : undefined} options={(catRow?.types ?? []).map((t) => ({ value: t.id, label: t.name }))} />
        <FSelect name="loc" label="Location" value={sp.loc} options={locs.map((l) => ({ value: l.id, label: l.name }))} />
        <SearchCell value={sp.aq} clearHref={`${base}${qs(keep)}`} />
      </FilterForm>
      <div style={{ marginTop: 22 }}>
        {!catRow || !typeOk ? (
          <div style={{ maxWidth: 780 }}><Yellow>Select Asset Category and Asset Type to view the available assets</Yellow></div>
        ) : !employeeId ? (
          <div style={{ maxWidth: 780 }}><Yellow>Select the employee to assign the asset to.</Yellow></div>
        ) : rows.length === 0 ? (
          <div style={{ maxWidth: 780 }}><Yellow>No {catRow.types.find((t) => t.id === type)?.name} is available right now. Add one from the Asset List.</Yellow></div>
        ) : (
          <div className={`${s.tableCard} ${s.alone}`}>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr><th>Asset Name</th><th>Asset ID</th><th>Asset Category</th><th>Asset Type</th><th>Location</th><th>Asset Condition</th><th>Actions</th></tr></thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td>{a.name ?? a.assetType.name}</td><td>{a.assetTag}</td><td>{a.assetType.category.name}</td><td>{a.assetType.name}</td>
                      <td>{a.location?.name ?? "—"}</td><td>{ASSET_CONDITION_LABEL[a.condition as AssetConditionKey]}</td>
                      <td>
                        <ActButton action={assignAssetAction} hidden={{ assetId: a.id, employeeId: employeeId!, ...(request ? { requestId: request.id } : {}) }} className={s.linkish} next={closeHref}>
                          Assign Asset
                        </ActButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={s.pager}><span>1 to {rows.length} of {rows.length}</span><span>Page 1 of 1</span></div>
          </div>
        )}
      </div>
    </FullScreen>
  );
}

function SearchCell({ value, clearHref }: { value?: string; clearHref: string }) {
  // The overlay's search is "aq" so it never collides with the page's own "q".
  return (
    <div className={s.fsearch}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input type="search" name="aq" defaultValue={value ?? ""} placeholder="Search" aria-label="Search assets" />
      <Link href={clearHref} className={s.fclear} aria-label="Clear filters" title="Clear filters" scroll={false}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 4h15l-6 7v6l-3 2v-8z" /><circle cx="18" cy="17" r="3.5" /><path d="m16.6 15.6 2.8 2.8M19.4 15.6l-2.8 2.8" /></svg>
      </Link>
    </div>
  );
}

function AssignToEmployee({ assetId, condition, emps, closeHref }: { assetId: string; condition: string; emps: Array<{ id: string; displayName: string | null; employeeNumber: string }>; closeHref: string }) {
  return (
    <AssignForm assetId={assetId} closeHref={closeHref}>
      <div className="field">
        <label className="label" htmlFor="as-emp">Employee</label>
        <select id="as-emp" name="employeeId" className="select" required defaultValue="">
          <option value="" disabled>Select an employee…</option>
          {emps.map((e) => <option key={e.id} value={e.id}>{e.displayName} ({e.employeeNumber})</option>)}
        </select>
      </div>
      <ConditionSelect name="conditionOut" defaultValue={condition} label="Condition at handover" />
      <div className="field">
        <label className="label" htmlFor="as-notes">Notes</label>
        <input id="as-notes" name="notes" className="input" placeholder="Optional — e.g. charger and sleeve included" />
      </div>
    </AssignForm>
  );
}


// ---------------------------------------------------------------------------
//  "+N Assets": everything one employee holds
// ---------------------------------------------------------------------------

export async function EmployeeAssetsDrawer({ viewer, employeeId, closeHref, perms, here }: { viewer: Viewer; employeeId: string; closeHref: string; perms: AssetPerms; here: string }) {
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, ...scopedEmployeeWhere(viewer, P.ASSET_VIEW) },
    select: { id: true, displayName: true, photoUrl: true, assetAssignments: { where: { returnedOn: null }, include: { asset: { include: { assetType: true } } }, orderBy: { assignedOn: "desc" } } },
  });
  if (!emp) return null;
  const name = emp.displayName ?? "—";
  return (
    <UrlSheet title="Assigned Assets" closeHref={closeHref}>
      <div className={s.drawerPerson}>
        <div className={s.who}><Avatar name={name} photoUrl={emp.photoUrl} size={36} /><span>{name}</span></div>
        <span className="text-sm muted">Total Assets: {emp.assetAssignments.length}</span>
      </div>
      <div className={`${s.tableCard} ${s.alone}`}>
        <table className={s.table}>
          <thead><tr><th>Asset ID</th><th>Asset Name</th><th>Acknowledgement Status</th><th>Actions</th></tr></thead>
          <tbody>
            {emp.assetAssignments.map((a) => (
              <tr key={a.id}>
                <td>{a.asset.assetTag}</td>
                <td><span className="row gap-2" style={{ alignItems: "center" }}><span className={s.cardIcon}><AssetIcon icon={a.asset.assetType.icon} size={20} /></span>{a.asset.name ?? a.asset.assetType.name}</span></td>
                <td><AckText status={a.ackStatus} /></td>
                <td><Kebab horizontal items={assetMenu({ asset: a.asset, assignmentId: a.id, perms, here })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </UrlSheet>
  );
}
