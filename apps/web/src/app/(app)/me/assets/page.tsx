import Link from "next/link";
import { prisma } from "@keka/db";
import { getAssetSettings, ASSET_REQUEST_STATUS_LABEL, ASSET_REQUEST_TYPE_LABEL, assetWarrantyStatus } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { aiEnabled } from "@/lib/ai";
import { acknowledgeAssetAction, cancelAssetRequestAction } from "@/app/actions/assets";
import { ActButton, Kebab, UrlSheet, type MenuItem } from "../../assets/_ui";
import { AssetIcon, AckText, Segments, PageHead, EmptyList, Yellow, condLabel, fmt } from "../../assets/_parts";
import { RequestDrawer } from "../../assets/_drawers";
import { RequestAssetForm } from "./request-form";
import s from "../../assets/assets.module.css";

/**
 * Me › Apps › Assets: what the organisation has handed me — acknowledge each
 * one on receipt, ask for a replacement or to return it — what I have handed
 * back, and my asset requests with where each one stands.
 *
 *   ?view=requests      my requests
 *   ?request=1          raise a request (&rtype=REPLACEMENT|RETURN&held=<asset>)
 *   ?req=<id>           one request, with its activity
 */

type SP = Record<string, string | undefined>;

export default async function MyAssetsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <><PageHead title="My assets" /><Yellow>This login is not linked to an employee record, so no assets can be assigned to it.</Yellow></>;
  }
  const me = viewer.employee.id;
  const tenantId = viewer.tenantId;
  const showRequests = sp.view === "requests";
  const base = showRequests ? "/me/assets?view=requests" : "/me/assets";
  const join = base.includes("?") ? "&" : "?";

  const [settings, current, past, requests] = await Promise.all([
    getAssetSettings(tenantId),
    prisma.assetAssignment.findMany({
      where: { employeeId: me, returnedOn: null, asset: { tenantId } }, orderBy: { assignedOn: "desc" },
      include: { asset: { include: { assetType: { include: { category: true } } } } },
    }),
    prisma.assetAssignment.findMany({
      where: { employeeId: me, returnedOn: { not: null }, asset: { tenantId } }, orderBy: { returnedOn: "desc" }, take: 50,
      include: { asset: { include: { assetType: true } } },
    }),
    prisma.assetRequest.findMany({
      where: { tenantId, employeeId: me }, orderBy: { createdAt: "desc" }, take: 100,
      include: { category: { select: { name: true } }, assetType: { select: { name: true } } },
    }),
  ]);
  const pendingAck = current.filter((a) => a.ackStatus === "PENDING").length;
  const openRequests = requests.filter((r) => r.status === "PENDING" || r.status === "APPROVED");
  const openAbout = new Set(openRequests.map((r) => r.heldAssetId).filter(Boolean));
  const now = new Date();
  const canRequest = settings.allowEmployeeRequests;

  return (
    <>
      <PageHead title="My assets" sub="Assets the organisation has given you, and your requests for more."
        right={canRequest ? <Link className="btn primary" href={`${base}${join}request=1`} scroll={false}>Request Asset</Link> : null} />
      <Segments items={[
        { label: `Assigned to me (${current.length})`, href: "/me/assets", on: !showRequests },
        { label: `My requests${openRequests.length ? ` (${openRequests.length} open)` : ""}`, href: "/me/assets?view=requests", on: showRequests },
        { label: "Bookings, repairs & loss", href: "/me/assets/bookings", on: false },
      ]} />

      {!showRequests ? (
        <>
          {pendingAck ? <div style={{ marginBottom: 18 }}><Yellow>Please acknowledge {pendingAck === 1 ? "the asset" : `the ${pendingAck} assets`} below to confirm you have received {pendingAck === 1 ? "it" : "them"}.</Yellow></div> : null}
          {current.length === 0 ? (
            <div className={s.panel}><EmptyList title="No assets assigned to you">{canRequest ? "Need a laptop, a monitor or anything else? Use Request Asset." : "Assets the organisation gives you will be listed here."}</EmptyList></div>
          ) : (
            <div className={s.myCards}>
              {current.map((a) => {
                const name = a.asset.name ?? a.asset.assetType.name;
                const w = assetWarrantyStatus(a.asset.warrantyExpiry, now, 30);
                const menu: MenuItem[] = canRequest && !openAbout.has(a.assetId) ? [
                  { kind: "link", label: "Request a replacement", icon: "recover", href: `/me/assets?request=1&rtype=REPLACEMENT&held=${a.assetId}` },
                  { kind: "link", label: "Request to return it", icon: "cancel", href: `/me/assets?request=1&rtype=RETURN&held=${a.assetId}` },
                ] : [];
                return (
                  <article key={a.id} className={s.myCard} aria-label={`${name} ${a.asset.assetTag}`}>
                    <div className={s.myCardTop}>
                      <span className={s.myIcon}><AssetIcon icon={a.asset.assetType.icon} size={24} /></span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="strong">{name}</div>
                        <div className="text-sm muted">{a.asset.assetTag} · {a.asset.assetType.category.name} › {a.asset.assetType.name}</div>
                      </div>
                      {menu.length ? <Kebab horizontal items={menu} label={`Requests about ${a.asset.assetTag}`} /> : null}
                    </div>
                    <dl className={s.kvGrid}>
                      <div><dt>Assigned on</dt><dd>{fmt(a.assignedOn)}</dd></div>
                      <div><dt>Condition at handover</dt><dd>{condLabel(a.conditionOut)}</dd></div>
                      <div><dt>Serial number</dt><dd>{a.asset.serialNumber ?? "—"}</dd></div>
                      <div><dt>Warranty</dt><dd>{a.asset.warrantyExpiry ? `${fmt(a.asset.warrantyExpiry)}${w === "EXPIRED" ? " · expired" : ""}` : "—"}</dd></div>
                      {a.notes ? <div style={{ gridColumn: "1 / -1" }}><dt>Notes</dt><dd>{a.notes}</dd></div> : null}
                    </dl>
                    <div className="row gap-2" style={{ alignItems: "center", justifyContent: "space-between", marginTop: "auto" }}>
                      <span><AckText status={a.ackStatus} />{a.acknowledgedAt ? <span className="text-xs muted"> · {fmt(a.acknowledgedAt)}</span> : null}</span>
                      {a.ackStatus === "PENDING" ? <ActButton action={acknowledgeAssetAction} hidden={{ assignmentId: a.id }} className="btn primary sm">Acknowledge</ActButton> : null}
                    </div>
                    {openAbout.has(a.assetId) ? <span className="text-xs muted">A request about this asset is open — <Link className={s.link} href="/me/assets?view=requests">see it</Link>.</span> : null}
                  </article>
                );
              })}
            </div>
          )}

          {past.length ? (
            <section className={`${s.tableCard} ${s.alone}`} style={{ marginTop: 22 }} aria-labelledby="past-h">
              <div className={s.toolbar} style={{ justifyContent: "space-between" }}>
                <h2 id="past-h" className={s.formSection} style={{ margin: 0 }}>Assets you have returned</h2>
                <span className={s.total}>Total: {past.length}</span>
              </div>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th>Asset</th><th>Assigned On</th><th>Returned On</th><th>Condition In</th><th>Damage Charge</th></tr></thead>
                  <tbody>
                    {past.map((a) => (
                      <tr key={a.id}>
                        <td>{a.asset.name ?? a.asset.assetType.name}<span className={s.sub}>{a.asset.assetTag}</span></td>
                        <td className="nowrap">{fmt(a.assignedOn)}</td>
                        <td className="nowrap">{fmt(a.returnedOn)}</td>
                        <td>{condLabel(a.conditionIn)}</td>
                        <td>{a.damageCharge && Number(a.damageCharge) > 0 ? <>₹{Number(a.damageCharge).toLocaleString("en-IN")}<span className={s.sub}>{a.chargeRecovered ? "Recovered" : "To be recovered"}{a.damageNote ? ` · ${a.damageNote}` : ""}</span></> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <div className={`${s.tableCard} ${s.alone}`}>
          {requests.length === 0 ? (
            <EmptyList title="No asset requests">{canRequest ? <>Use <Link className={s.link} href="/me/assets?view=requests&request=1">Request Asset</Link> to ask for one.</> : "Asset requests are switched off for your organisation."}</EmptyList>
          ) : (
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr><th>Asset</th><th>Request Type</th><th>Category &amp; Type</th><th>Raised On</th><th>Needed By</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td>{r.title ?? r.reason}</td>
                      <td>{ASSET_REQUEST_TYPE_LABEL[r.requestType]}</td>
                      <td>{[r.category?.name, r.assetType?.name].filter(Boolean).join(" › ") || "NA"}</td>
                      <td className="nowrap">{fmt(r.createdAt)}</td>
                      <td className="nowrap">{r.neededBy ? fmt(r.neededBy) : "—"}</td>
                      <td>{ASSET_REQUEST_STATUS_LABEL[r.status]}{r.status === "REJECTED" && r.rejectReason ? <span className={s.sub}>{r.rejectReason}</span> : null}</td>
                      <td>
                        <span className={s.decide}>
                          <Link className={s.link} href={`/me/assets?view=requests&req=${r.id}`} scroll={false}>View</Link>
                          {r.status === "PENDING" || r.status === "APPROVED" ? <ActButton action={cancelAssetRequestAction} hidden={{ requestId: r.id }} className={s.linkish} confirm="Cancel this request?">Cancel</ActButton> : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {sp.request && canRequest ? (
        <RequestSheet tenantId={tenantId} held={current.map((a) => ({ id: a.assetId, label: `${a.asset.name ?? a.asset.assetType.name} (${a.asset.assetTag})` }))} rtype={sp.rtype} heldId={sp.held} closeHref={base} />
      ) : null}
      {sp.req ? <RequestDrawer viewer={viewer} requestId={sp.req} closeHref="/me/assets?view=requests" own /> : null}
    </>
  );
}

async function RequestSheet({ tenantId, held, rtype, heldId, closeHref }: { tenantId: string; held: Array<{ id: string; label: string }>; rtype?: string; heldId?: string; closeHref: string }) {
  const categories = await prisma.assetCategory.findMany({
    where: { tenantId, isActive: true }, orderBy: { name: "asc" },
    select: { id: true, name: true, types: { where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } } },
  });
  return (
    <UrlSheet title="Request an asset" subtitle="It is approved before an asset is assigned to you." closeHref={closeHref}>
      <RequestAssetForm categories={categories} held={held} initialType={rtype} initialHeld={heldId} aiEnabled={aiEnabled()} closeHref={closeHref} />
    </UrlSheet>
  );
}
