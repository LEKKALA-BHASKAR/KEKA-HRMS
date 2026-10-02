import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { formatINR } from "@keka/shared";
import { ASSET_CONDITION_LABEL, assetWarrantyStatus, type AssetConditionKey } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { recoverAssetAction, markAssetAvailableAction } from "@/app/actions/assets";
import { Kebab, ModalButton, ActButton } from "../_ui";
import { AssetIcon, AckText, StatusText, Timeline, condLabel, fmt, type TimelineEntry } from "../_parts";
import { assetMenu, assetPerms, RecoverFields } from "../_menu";
import { AuditDrawer, AssignOverlay } from "../_drawers";
import { AssetFormOverlay } from "../_overlays";
import s from "../assets.module.css";

/**
 * One asset: what it is, where it is and who has it, its purchase and
 * warranty, every assignment it has been through and its recent activity,
 * with the same actions as its ⋮ menu. ?edit=1 opens the edit form.
 */

type SP = Record<string, string | undefined>;
const money = (v: unknown) => (v === null || v === undefined ? "—" : formatINR(Number(v)).replace(/\.00$/, ""));

export default async function AssetDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const viewer = await requireViewer();
  const perms = assetPerms(viewer);
  const asset = await prisma.asset.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      assetType: { include: { category: true } }, location: true,
      assignments: { orderBy: { assignedOn: "desc" }, include: { employee: { select: { id: true, displayName: true, employeeNumber: true, jobTitleName: true } }, request: { select: { id: true, title: true } } } },
      events: { orderBy: { createdAt: "desc" }, take: 8 },
    },
  });
  if (!asset) notFound();
  const here = `/assets/${asset.id}`;
  const [docs, people] = await Promise.all([
    prisma.storedFile.findMany({ where: { tenantId: viewer.tenantId, relatedType: "Asset", relatedId: asset.id }, select: { id: true, filename: true, createdAt: true }, orderBy: { createdAt: "desc" } }),
    prisma.employee.findMany({
      where: { tenantId: viewer.tenantId, id: { in: asset.assignments.flatMap((a) => [a.assignedBy, a.returnedBy]).filter((x): x is string => !!x) } },
      select: { id: true, displayName: true },
    }),
  ]);
  const who = new Map(people.map((p) => [p.id, p.displayName ?? "—"]));
  const open = asset.assignments.find((a) => !a.returnedOn);
  const name = asset.name ?? asset.assetType.name;
  const warranty = assetWarrantyStatus(asset.warrantyExpiry, new Date(), 30);
  const activity: TimelineEntry[] = asset.events.map((e) => ({
    text: `${e.kind.charAt(0)}${e.kind.slice(1).toLowerCase().replace(/_/g, " ")}${e.actorLabel ? ` by ${e.actorLabel}` : ""}`,
    at: e.createdAt, note: e.note, tone: e.kind === "ACK_REMINDED" ? "grey" : "ok",
  }));

  const kv = (label: string, value: ReactNode) => <div><dt>{label}</dt><dd>{value ?? "—"}</dd></div>;

  return (
    <>
      <div className="text-sm" style={{ marginBottom: 12 }}>
        <Link className={s.link} href={`/assets/list?type=${asset.assetTypeId}`}>← {asset.assetType.category.name} › {asset.assetType.name}</Link>
      </div>
      <div className={s.detailHead}>
        <div className={s.detailHeadTop}>
          <div className="row gap-3" style={{ alignItems: "center" }}>
            <span className={s.myIcon}><AssetIcon icon={asset.assetType.icon} size={26} /></span>
            <div>
              <h1 className={s.detailTitle}>{name}</h1>
              <p className={s.detailSub}>{asset.assetTag} · {asset.assetType.category.name} › {asset.assetType.name}{asset.serialNumber ? ` · S/N ${asset.serialNumber}` : ""}</p>
            </div>
          </div>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            <StatusText status={asset.status} />
            <Kebab horizontal items={assetMenu({ asset, assignmentId: open?.id, perms, here })} label={`Actions for ${asset.assetTag}`} />
          </div>
        </div>
        {perms.assign || perms.manage ? (
          <div className={s.actionsRow} style={{ borderTop: "1px solid var(--border)", borderBottom: 0 }}>
            {perms.assign && asset.status === "AVAILABLE" ? <Link className="btn primary" href={`${here}?assign=asset:${asset.id}`} scroll={false}>Assign Asset</Link> : null}
            {perms.assign && open ? (
              <ModalButton label="Recover Asset" className="btn primary" title="Recover asset" action={recoverAssetAction} hidden={{ assignmentId: open.id }} submitLabel="Recover">
                <p className="text-sm muted">From {open.employee.displayName}, assigned on {fmt(open.assignedOn)}.</p>
                <RecoverFields condition={asset.condition} />
              </ModalButton>
            ) : null}
            {perms.assign && ["IN_REPAIR", "LOST", "UNAVAILABLE"].includes(asset.status) ? <ActButton action={markAssetAvailableAction} hidden={{ assetId: asset.id }} className="btn">Mark as available</ActButton> : null}
            {perms.manage ? <Link className={s.btnOutline} href={`${here}?edit=1`} scroll={false}>Edit asset details</Link> : null}
            <Link className={s.btnOutline} href={`${here}?audit=${asset.id}`} scroll={false}>View Audit History</Link>
          </div>
        ) : null}
      </div>

      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 360px", alignItems: "start", gap: 22 }}>
        <div className="stack gap-4" style={{ minWidth: 0 }}>
          <section className={s.panel} style={{ padding: 18 }} aria-labelledby="details-h">
            <h2 id="details-h" className={s.formSection}>Asset details</h2>
            <dl className={s.kvGrid} style={{ fontSize: 14 }}>
              {kv("Asset ID", asset.assetTag)}
              {kv("Asset name", name)}
              {kv("Category", asset.assetType.category.name)}
              {kv("Asset type", asset.assetType.name)}
              {kv("Location", asset.location?.name)}
              {kv("Condition", ASSET_CONDITION_LABEL[asset.condition as AssetConditionKey])}
              {kv("Status", <StatusText status={asset.status} />)}
              {asset.unavailableReason && !["AVAILABLE", "ASSIGNED"].includes(asset.status) ? kv("Reason", asset.unavailableReason) : null}
              {kv("Serial number", asset.serialNumber)}
              {kv("Make & model", [asset.assetType.make, asset.assetType.model].filter(Boolean).join(" ") || null)}
              {asset.description ? <div style={{ gridColumn: "1 / -1" }}><dt>Description</dt><dd style={{ whiteSpace: "pre-wrap" }}>{asset.description}</dd></div> : null}
            </dl>
          </section>

          <section className={s.panel} style={{ padding: 18 }} aria-labelledby="purchase-h">
            <h2 id="purchase-h" className={s.formSection}>Purchase and warranty</h2>
            <dl className={s.kvGrid} style={{ fontSize: 14 }}>
              {kv("Purchased on", asset.purchaseDate ? fmt(asset.purchaseDate) : null)}
              {kv("Purchase cost", money(asset.purchaseCost))}
              {kv("Book value", <>{money(asset.currentValue)}{asset.assetType.category.usefulLifeMonths ? <span className="text-xs muted"> · over {asset.assetType.category.usefulLifeMonths} months</span> : null}</>)}
              {kv("Vendor", asset.vendor)}
              {kv("Invoice number", asset.invoiceNumber)}
              {kv("Warranty expires on", asset.warrantyExpiry ? <>{fmt(asset.warrantyExpiry)}{warranty === "EXPIRED" ? <span style={{ color: "var(--danger)" }}> · Expired</span> : warranty === "EXPIRING" ? <span style={{ color: "#c26a00" }}> · Expiring soon</span> : null}</> : null)}
            </dl>
          </section>

          <section className={`${s.tableCard} ${s.alone}`} aria-labelledby="history-h">
            <div className={s.toolbar} style={{ justifyContent: "space-between" }}>
              <h2 id="history-h" className={s.formSection} style={{ margin: 0 }}>Assignment history</h2>
              <span className={s.total}>Total: {asset.assignments.length}</span>
            </div>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr><th>Employee</th><th>Assigned On</th><th>Assigned By</th><th>Condition Out</th><th>Acknowledgement</th><th>Returned On</th><th>Condition In</th><th>Damage Charge</th></tr></thead>
                <tbody>
                  {asset.assignments.length === 0 ? <tr><td colSpan={8} className="muted" style={{ textAlign: "center", padding: 26 }}>Never assigned.</td></tr> : asset.assignments.map((a) => (
                    <tr key={a.id}>
                      <td><Link className={s.link} href={`/employees/${a.employee.id}?tab=assets`}>{a.employee.displayName}</Link><span className={s.sub}>{a.employee.employeeNumber}{a.request ? " · against a request" : ""}</span></td>
                      <td className="nowrap">{fmt(a.assignedOn)}</td>
                      <td>{a.assignedBy ? who.get(a.assignedBy) ?? "—" : "—"}</td>
                      <td>{condLabel(a.conditionOut)}</td>
                      <td><AckText status={a.ackStatus} />{a.acknowledgedAt ? <span className={s.sub}>{fmt(a.acknowledgedAt)}</span> : null}</td>
                      <td className="nowrap">{a.returnedOn ? fmt(a.returnedOn) : <span className="badge brand">In use</span>}</td>
                      <td>{a.conditionIn ? condLabel(a.conditionIn) : "—"}</td>
                      <td className="nowrap">{a.damageCharge && Number(a.damageCharge) > 0 ? <>{money(a.damageCharge)}<span className={s.sub}>{a.chargeRecovered ? "Recovered" : <Link className={s.link} href="/assets/recovery">Pending recovery</Link>}</span></> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="stack gap-4">
          <section className={s.panel} style={{ padding: 18 }} aria-labelledby="holder-h">
            <h2 id="holder-h" className={s.formSection}>Currently with</h2>
            {open ? (
              <div className="stack gap-2 text-sm">
                <div><Link className={s.link} href={`/employees/${open.employee.id}?tab=assets`}>{open.employee.displayName}</Link> <span className="muted">· {open.employee.jobTitleName ?? open.employee.employeeNumber}</span></div>
                <div className="muted">Since {fmt(open.assignedOn)} · handed over {condLabel(open.conditionOut).toLowerCase()}</div>
                <div><AckText status={open.ackStatus} /></div>
                {open.notes ? <div className="muted">{open.notes}</div> : null}
              </div>
            ) : <p className="text-sm muted">Not assigned to anyone.</p>}
          </section>

          <section className={s.panel} style={{ padding: 18 }} aria-labelledby="docs-h">
            <h2 id="docs-h" className={s.formSection}>Image and documents</h2>
            {asset.imageFileId ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/files/${asset.imageFileId}`} alt={name} style={{ width: "100%", borderRadius: 4, marginBottom: 12, background: "var(--surface-sunken)" }} />
            ) : null}
            {docs.filter((d) => d.id !== asset.imageFileId).length === 0 && !asset.imageFileId ? <p className="text-sm muted">Nothing attached.{perms.manage ? " Attach files from Edit asset details." : ""}</p> : (
              <ul className="stack gap-2 text-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {docs.filter((d) => d.id !== asset.imageFileId).map((d) => <li key={d.id}><a className={s.link} href={`/files/${d.id}`}>{d.filename}</a> <span className="muted">· {fmt(d.createdAt)}</span></li>)}
              </ul>
            )}
          </section>

          <section className={s.panel} style={{ padding: 18 }} aria-labelledby="activity-h">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 id="activity-h" className={s.formSection}>Recent activity</h2>
              <Link className={s.link} href={`${here}?audit=${asset.id}`} scroll={false}>Full history</Link>
            </div>
            <Timeline entries={activity} />
          </section>
        </div>
      </div>

      {sp.edit && perms.manage ? <AssetFormOverlay viewer={viewer} assetId={asset.id} closeHref={here} /> : null}
      {sp.audit ? <AuditDrawer viewer={viewer} assetId={sp.audit} closeHref={here} /> : null}
      {sp.assign ? <AssignOverlay viewer={viewer} spec={sp.assign} sp={sp} base={here} closeHref={here} /> : null}
    </>
  );
}
