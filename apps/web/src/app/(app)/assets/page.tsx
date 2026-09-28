import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS, employeeScopeFilter, hasUnscopedPermission } from "@keka/rbac";
import { formatDate, formatINRCompact } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import {
  PageHead, Card, Badge, Empty, Money, Person, Stat, Callout, Progress,
} from "@/components/ui";
import {
  assignAsset, returnAsset, acknowledgeAsset, recoverAssetDamage,
  decideAssetRequest, requestAsset,
} from "@/app/actions/workplace";

const P = PERMISSIONS;
const n = (v: unknown) => Number(v ?? 0);

const TABS = ["inventory", "assigned", "requests", "recovery", "mine"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  inventory: "Inventory",
  assigned: "Assignments",
  requests: "Requests",
  recovery: "Damage recovery",
  mine: "My assets",
};

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral" | "brand"> = {
  AVAILABLE: "success", ASSIGNED: "brand", IN_REPAIR: "warning",
  RETIRED: "neutral", LOST: "danger", UNAVAILABLE: "neutral",
};
const CONDITION_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  NEW: "success", GOOD: "success", FAIR: "warning", DAMAGED: "danger", UNUSABLE: "danger",
};

export default async function AssetsPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; status?: string }> }) {
  const viewer = await requireAuth(P.ASSET_VIEW);
  const sp = await searchParams;
  const canManage = can(viewer, P.ASSET_MANAGE);
  const canAssign = can(viewer, P.ASSET_ASSIGN);
  const canRecover = can(viewer, P.PAYROLL_RUN);
  // Someone with self-access only lands on their own assets.
  const defaultTab: Tab = canManage || canAssign ? "inventory" : "mine";
  const tab = (TABS.includes(sp.tab as Tab) ? sp.tab : defaultTab) as Tab;
  const myId = viewer.employee?.id;

  // Assignment visibility follows the same scoping as the employee list.
  const scopeFilter = employeeScopeFilter(viewer, P.ASSET_VIEW);
  const isUnscoped = hasUnscopedPermission(viewer, P.ASSET_VIEW);

  const [assets, byStatus, assignments, requests, damaged, assetTypes, employees, openRun, myAssignments] =
    await Promise.all([
      canManage || canAssign
        ? prisma.asset.findMany({
            where: {
              tenantId: viewer.tenantId,
              ...(sp.status ? { status: sp.status as never } : {}),
            },
            orderBy: { assetTag: "asc" },
            take: 200,
            include: {
              assetType: { include: { category: true } },
              assignments: {
                where: { returnedOn: null },
                include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } },
                take: 1,
              },
            },
          })
        : Promise.resolve([]),
      canManage || canAssign
        ? prisma.asset.groupBy({
            by: ["status"],
            where: { tenantId: viewer.tenantId },
            _count: true,
            _sum: { currentValue: true },
          })
        : Promise.resolve([] as Array<{ status: string; _count: number; _sum: { currentValue: unknown } }>),
      canManage || canAssign
        ? prisma.assetAssignment.findMany({
            where: {
              returnedOn: null,
              asset: { tenantId: viewer.tenantId },
              ...(scopeFilter ? { employee: scopeFilter as never } : {}),
            },
            orderBy: { assignedOn: "desc" },
            take: 200,
            include: {
              asset: { include: { assetType: { select: { name: true } } } },
              employee: {
                select: {
                  id: true, displayName: true, employeeNumber: true, status: true,
                  department: { select: { name: true } },
                },
              },
            },
          })
        : Promise.resolve([]),
      canManage
        ? prisma.assetRequest.findMany({
            where: { tenantId: viewer.tenantId },
            orderBy: [{ status: "asc" }, { createdAt: "desc" }],
            include: {
              employee: { select: { id: true, displayName: true, employeeNumber: true } },
            },
          })
        : Promise.resolve([]),
      canManage || canAssign
        ? prisma.assetAssignment.findMany({
            where: {
              asset: { tenantId: viewer.tenantId },
              damageCharge: { not: null },
            },
            orderBy: { returnedOn: "desc" },
            include: {
              asset: { include: { assetType: { select: { name: true } } } },
              employee: {
                select: { id: true, displayName: true, employeeNumber: true, status: true },
              },
            },
          })
        : Promise.resolve([]),
      prisma.assetType.findMany({
        where: { category: { tenantId: viewer.tenantId } },
        include: { category: { select: { name: true } } },
        orderBy: { name: "asc" },
      }),
      canAssign
        ? prisma.employee.findMany({
            where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } },
            select: { id: true, displayName: true, employeeNumber: true },
            orderBy: { firstName: "asc" },
          })
        : Promise.resolve([]),
      canRecover
        ? prisma.payrollRun.findFirst({
            where: { tenantId: viewer.tenantId, status: { in: ["DRAFT", "IN_PROGRESS"] } },
            orderBy: [{ year: "desc" }, { month: "desc" }],
            select: { id: true },
          })
        : Promise.resolve(null),
      myId
        ? prisma.assetAssignment.findMany({
            where: { employeeId: myId },
            orderBy: [{ returnedOn: "asc" }, { assignedOn: "desc" }],
            include: { asset: { include: { assetType: { include: { category: true } } } } },
          })
        : Promise.resolve([]),
    ]);

  const count = (s: string) => byStatus.find((b) => b.status === s)?._count ?? 0;
  const bookValue = byStatus.reduce((sum, b) => sum + n(b._sum.currentValue), 0);
  const pendingAck = assignments.filter((a) => !a.acknowledgedAt);
  const pendingRecovery = damaged.filter((d) => !d.chargeRecovered);
  const myPendingAck = myAssignments.filter((a) => !a.returnedOn && !a.acknowledgedAt);
  const available = assets.filter((a) => a.status === "AVAILABLE");

  const visibleTabs = TABS.filter((t) => {
    if (t === "mine") return !!myId;
    if (t === "requests") return canManage;
    if (t === "recovery") return canManage || canAssign;
    return canManage || canAssign;
  });

  return (
    <>
      <PageHead
        title="Assets"
        subtitle={
          canManage || canAssign
            ? `${byStatus.reduce((s, b) => s + b._count, 0)} items · ${formatINRCompact(bookValue)} book value after depreciation`
            : "Equipment issued to you"
        }
      />

      {myPendingAck.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warning" title={`${myPendingAck.length} asset(s) awaiting your acknowledgement`}>
            Confirm you have received these. Acknowledgement is the record that the item was
            handed over, and it matters if a damage charge is ever raised.
            <div className="row gap-2 wrap" style={{ marginTop: 10 }}>
              {myPendingAck.map((a) => (
                <form action={acknowledgeAsset} key={a.id}>
                  <input type="hidden" name="assignmentId" value={a.id} />
                  <button className="btn primary sm" type="submit">
                    Acknowledge {a.asset.assetType.name} ({a.asset.assetTag})
                  </button>
                </form>
              ))}
            </div>
          </Callout>
        </div>
      ) : null}

      {canManage || canAssign ? (
        <div className="grid grid-4" style={{ marginBottom: 18 }}>
          <Stat label="Available" value={count("AVAILABLE")} meta="Ready to assign" />
          <Stat label="Assigned" value={count("ASSIGNED")} meta={`${pendingAck.length} unacknowledged`} />
          <Stat label="In repair" value={count("IN_REPAIR")} meta={`${count("LOST")} lost, ${count("RETIRED")} retired`} />
          <Stat
            label="Damage recovery"
            value={<Money value={pendingRecovery.reduce((s, d) => s + n(d.damageCharge), 0)} compact />}
            meta={`${pendingRecovery.length} pending`}
          />
        </div>
      ) : null}

      {!isUnscoped && (canManage || canAssign) ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="info" title="Assignments are scoped to you">
            You see assignments for the employees your roles reach. Inventory is not scoped,
            because an asset is not an employee record.
          </Callout>
        </div>
      ) : null}

      <div className="tabs">
        {visibleTabs.map((t) => (
          <Link key={t} href={`/assets?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>
            {TAB_LABEL[t]}
            {t === "requests" && requests.filter((r) => r.status === "PENDING").length > 0
              ? ` (${requests.filter((r) => r.status === "PENDING").length})`
              : ""}
            {t === "recovery" && pendingRecovery.length > 0 ? ` (${pendingRecovery.length})` : ""}
          </Link>
        ))}
      </div>

      {/* ---------------- Inventory ---------------- */}
      {tab === "inventory" && (canManage || canAssign) ? (
        <div className="stack gap-4">
          {canAssign && available.length > 0 ? (
            <Card title="Assign an asset" description="Only available items can be assigned.">
              <form action={assignAsset} className="row gap-2 wrap">
                <select className="select" name="assetId" required style={{ maxWidth: 300 }}>
                  <option value="">Select an available asset…</option>
                  {available.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.assetTag} — {a.assetType.name}
                      {a.serialNumber ? ` (${a.serialNumber})` : ""}
                    </option>
                  ))}
                </select>
                <select className="select" name="employeeId" required style={{ maxWidth: 230 }}>
                  <option value="">Assign to…</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.displayName} ({e.employeeNumber})</option>
                  ))}
                </select>
                <select className="select" name="conditionOut" style={{ maxWidth: 130 }}>
                  <option value="NEW">New</option>
                  <option value="GOOD" selected>Good</option>
                  <option value="FAIR">Fair</option>
                </select>
                <input className="input" name="notes" placeholder="Notes" style={{ maxWidth: 180 }} />
                <button className="btn primary" type="submit">Assign</button>
              </form>
            </Card>
          ) : null}

          <Card
            title={`Inventory (${assets.length})`}
            action={
              <form className="row gap-2">
                <input type="hidden" name="tab" value="inventory" />
                <select className="select" name="status" defaultValue={sp.status ?? ""} style={{ maxWidth: 160 }}>
                  <option value="">All statuses</option>
                  {["AVAILABLE", "ASSIGNED", "IN_REPAIR", "RETIRED", "LOST", "UNAVAILABLE"].map((s) => (
                    <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>
                  ))}
                </select>
                <button className="btn sm" type="submit">Filter</button>
              </form>
            }
            tight
          >
            {assets.length === 0 ? <Empty title="No assets match" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Tag</th><th>Item</th><th>Category</th><th>Serial</th>
                      <th className="num">Purchase cost</th><th className="num">Book value</th>
                      <th>Condition</th><th>Status</th><th>Held by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((a) => {
                      const holder = a.assignments[0];
                      const depreciated = n(a.purchaseCost) > 0
                        ? (1 - n(a.currentValue) / n(a.purchaseCost)) * 100
                        : 0;
                      return (
                        <tr key={a.id}>
                          <td className="mono text-xs">{a.assetTag}</td>
                          <td>
                            <span className="strong">{a.assetType.name}</span>
                            <div className="text-xs subtle">
                              {a.assetType.make} {a.assetType.model}
                            </div>
                          </td>
                          <td className="text-sm">{a.assetType.category.name}</td>
                          <td className="mono text-xs subtle">{a.serialNumber ?? "—"}</td>
                          <td className="num"><Money value={a.purchaseCost} showZero={false} /></td>
                          <td className="num">
                            <Money value={a.currentValue} showZero={false} />
                            {depreciated > 0 ? (
                              <div style={{ marginTop: 3 }}>
                                <Progress value={100 - depreciated} max={100} tone={depreciated > 80 ? "warning" : undefined} />
                              </div>
                            ) : null}
                          </td>
                          <td><Badge tone={CONDITION_TONE[a.condition] ?? "neutral"}>{a.condition.toLowerCase()}</Badge></td>
                          <td><Badge tone={STATUS_TONE[a.status] ?? "neutral"} dot>{a.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                          <td>
                            {holder ? (
                              <Link href={`/employees/${holder.employee.id}`} className="text-sm">
                                {holder.employee.displayName}
                                {!holder.acknowledgedAt ? <Badge tone="warning">unack</Badge> : null}
                              </Link>
                            ) : <span className="subtle">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {/* ---------------- Assignments ---------------- */}
      {tab === "assigned" && (canManage || canAssign) ? (
        <Card title={`Open assignments (${assignments.length})`} tight>
          {assignments.length === 0 ? <Empty title="Nothing is currently assigned" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Employee</th><th>Asset</th><th>Assigned</th>
                    <th>Condition out</th><th>Acknowledged</th>
                    {canAssign ? <th>Record return</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link href={`/employees/${a.employee.id}`}>
                          <Person
                            name={a.employee.displayName ?? ""}
                            meta={`${a.employee.employeeNumber} · ${a.employee.department?.name ?? "—"}`}
                          />
                        </Link>
                        {a.employee.status === "NOTICE_PERIOD" ? (
                          <Badge tone="danger">on notice — recover before exit</Badge>
                        ) : null}
                      </td>
                      <td>
                        <span className="strong text-sm">{a.asset.assetType.name}</span>
                        <div className="mono text-xs subtle">{a.asset.assetTag}</div>
                      </td>
                      <td className="text-sm nowrap">{formatDate(a.assignedOn)}</td>
                      <td><Badge tone={CONDITION_TONE[a.conditionOut] ?? "neutral"}>{a.conditionOut.toLowerCase()}</Badge></td>
                      <td>
                        {a.acknowledgedAt
                          ? <Badge tone="success" dot>{formatDate(a.acknowledgedAt)}</Badge>
                          : <Badge tone="warning">Pending</Badge>}
                      </td>
                      {canAssign ? (
                        <td>
                          <form action={returnAsset} className="row gap-1">
                            <input type="hidden" name="assignmentId" value={a.id} />
                            <select className="select" name="conditionIn" style={{ width: 106, padding: "3px 6px", fontSize: 12 }}>
                              <option value="GOOD">Good</option>
                              <option value="FAIR">Fair</option>
                              <option value="DAMAGED">Damaged</option>
                              <option value="UNUSABLE">Unusable</option>
                            </select>
                            <input
                              className="input num" name="damageCharge" type="number" step="0.01" min="0"
                              placeholder="Charge"
                              style={{ width: 84, padding: "3px 7px", fontSize: 12 }}
                            />
                            <button className="btn sm" type="submit">Return</button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {/* ---------------- Requests ---------------- */}
      {tab === "requests" && canManage ? (
        <Card title={`Asset requests (${requests.length})`} tight>
          {requests.length === 0 ? <Empty title="No requests raised" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Employee</th><th>Reason</th><th>Needed by</th><th>Status</th><th>Decision</th></tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/employees/${r.employee.id}`}>
                          <Person name={r.employee.displayName ?? ""} meta={r.employee.employeeNumber} />
                        </Link>
                      </td>
                      <td className="text-sm" style={{ maxWidth: 340 }}>{r.reason}</td>
                      <td className="text-sm nowrap">{formatDate(r.neededBy)}</td>
                      <td>
                        <Badge tone={
                          r.status === "APPROVED" ? "success"
                          : r.status === "REJECTED" ? "danger"
                          : r.status === "FULFILLED" ? "brand" : "warning"
                        }>
                          {r.status.toLowerCase()}
                        </Badge>
                        {r.rejectReason ? <div className="text-xs subtle">{r.rejectReason}</div> : null}
                      </td>
                      <td>
                        {r.status === "PENDING" ? (
                          <div className="row gap-1">
                            <form action={decideAssetRequest}>
                              <input type="hidden" name="id" value={r.id} />
                              <input type="hidden" name="decision" value="approve" />
                              <button className="btn primary sm" type="submit">Approve</button>
                            </form>
                            <form action={decideAssetRequest} className="row gap-1">
                              <input type="hidden" name="id" value={r.id} />
                              <input type="hidden" name="decision" value="reject" />
                              <input className="input" name="reason" placeholder="Reason" style={{ width: 110, padding: "3px 7px", fontSize: 12 }} />
                              <button className="btn sm" type="submit">Reject</button>
                            </form>
                          </div>
                        ) : <span className="subtle">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {/* ---------------- Damage recovery ---------------- */}
      {tab === "recovery" && (canManage || canAssign) ? (
        <div className="stack gap-4">
          <Callout tone="info" title="Where a damage charge ends up">
            For a serving employee the charge is pushed into the open payroll run as an
            ad-hoc deduction. For a leaver it belongs in the full-and-final settlement, which
            reads the charge straight off the assignment — so do not push it to payroll too,
            or it will be recovered twice.
          </Callout>

          <Card title={`Damage charges (${damaged.length})`} tight>
            {damaged.length === 0 ? <Empty title="No damage charges recorded" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Employee</th><th>Asset</th><th>Returned</th>
                      <th>Condition in</th><th className="num">Charge</th><th>Note</th><th>Recovery</th>
                    </tr>
                  </thead>
                  <tbody>
                    {damaged.map((d) => {
                      const isLeaver = d.employee.status === "EXITED" || d.employee.status === "NOTICE_PERIOD";
                      return (
                        <tr key={d.id}>
                          <td>
                            <Link href={`/employees/${d.employee.id}`}>
                              <Person name={d.employee.displayName ?? ""} meta={d.employee.employeeNumber} />
                            </Link>
                          </td>
                          <td>
                            <span className="text-sm">{d.asset.assetType.name}</span>
                            <div className="mono text-xs subtle">{d.asset.assetTag}</div>
                          </td>
                          <td className="text-sm nowrap">{formatDate(d.returnedOn)}</td>
                          <td><Badge tone={CONDITION_TONE[d.conditionIn ?? "GOOD"] ?? "neutral"}>{(d.conditionIn ?? "").toLowerCase()}</Badge></td>
                          <td className="num strong"><Money value={d.damageCharge} /></td>
                          <td className="text-sm muted" style={{ maxWidth: 260 }}>{d.damageNote ?? "—"}</td>
                          <td>
                            {d.chargeRecovered ? (
                              <Badge tone="success">Recovered</Badge>
                            ) : isLeaver ? (
                              <Badge tone="info">Via final settlement</Badge>
                            ) : canRecover && openRun ? (
                              <form action={recoverAssetDamage}>
                                <input type="hidden" name="assignmentId" value={d.id} />
                                <button className="btn sm" type="submit">Deduct in payroll</button>
                              </form>
                            ) : (
                              <Badge tone="warning">Pending</Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {/* ---------------- My assets ---------------- */}
      {tab === "mine" && myId ? (
        <div className="stack gap-4">
          <Card title={`Assets issued to me (${myAssignments.filter((a) => !a.returnedOn).length} open)`} tight>
            {myAssignments.length === 0 ? (
              <Empty title="Nothing issued to you yet" />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Asset</th><th>Category</th><th>Assigned</th><th>Returned</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {myAssignments.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <span className="strong">{a.asset.assetType.name}</span>
                          <div className="mono text-xs subtle">
                            {a.asset.assetTag}
                            {a.asset.serialNumber ? ` · ${a.asset.serialNumber}` : ""}
                          </div>
                        </td>
                        <td className="text-sm">{a.asset.assetType.category.name}</td>
                        <td className="text-sm nowrap">{formatDate(a.assignedOn)}</td>
                        <td className="text-sm nowrap">
                          {a.returnedOn ? formatDate(a.returnedOn) : <span className="subtle">In use</span>}
                        </td>
                        <td>
                          {a.returnedOn ? (
                            <Badge tone="neutral">Returned</Badge>
                          ) : a.acknowledgedAt ? (
                            <Badge tone="success" dot>Acknowledged</Badge>
                          ) : (
                            <form action={acknowledgeAsset}>
                              <input type="hidden" name="assignmentId" value={a.id} />
                              <button className="btn primary sm" type="submit">Acknowledge receipt</button>
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

          <Card title="Request an asset">
            <form action={requestAsset} className="row gap-2 wrap">
              <select className="select" name="assetTypeId" style={{ maxWidth: 260 }}>
                <option value="">Any suitable item</option>
                {assetTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.category.name} — {t.name}</option>
                ))}
              </select>
              <input className="input" name="reason" placeholder="Why do you need it?" required style={{ maxWidth: 300 }} />
              <input className="input" name="neededBy" type="date" style={{ maxWidth: 160 }} />
              <button className="btn primary" type="submit">Raise request</button>
            </form>
          </Card>
        </div>
      ) : null}
    </>
  );
}
