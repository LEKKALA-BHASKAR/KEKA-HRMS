/**
 * Org › Assets and Me › Assets, page by page and end to end: who may open
 * what (employees are sent to /me/assets, managers-only tabs stay closed to
 * assigners, downloads refuse employees), every page and drawer renders, and
 * one asset goes through its whole life — category and type, added from an
 * ID series, assigned, acknowledged by the employee, recovered damaged, its
 * charge recorded — plus a request, a bulk import, a scheduled report and the
 * CSV downloads.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { unlink } from "node:fs/promises";
import path from "node:path";
import Module from "node:module";
import type { ReactElement, ReactNode } from "react";

// The runtime stubs CSS modules with a proxy whose every key is truthy, so an
// `import s from "x.module.css"` default import comes out undefined. Serve a
// proxy that also answers `default` (and is not mistaken for an ES module).
{
  const internal = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = internal._load;
  const classes: Record<string, unknown> = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? undefined : k === "default" ? classes : typeof k === "string" ? k : undefined) });
  internal._load = function cssModules(this: unknown, request: string, parent: unknown, isMain: boolean) {
    return request.endsWith(".module.css") ? classes : prev.call(this, request, parent, isMain);
  };
}

const prisma = new PrismaClient();
type SP = Record<string, string>;
type Page = (props: { searchParams: Promise<SP>; params?: Promise<Record<string, string>> }) => Promise<unknown>;

function outcome(err: unknown): string {
  const e = err as { digest?: string; message?: string };
  const d = `${e.digest ?? ""} ${e.message ?? ""}`;
  const r = /NEXT_REDIRECT;[a-z]+;([^;]+);/.exec(d);
  if (r) return `redirect:${r[1]}`;
  if (/HTTP_ERROR_FALLBACK;404/.test(d)) return "404";
  if (/HTTP_ERROR_FALLBACK;403/.test(d)) return "403";
  throw err;
}

async function main() {
  const React = await import("react");
  // tsx compiles JSX in classic mode; pages expect React in scope.
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const noop = () => {};
  const router = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop, hmrRefresh: noop };

  /** Await every async server component in the tree, so the static renderer sees plain elements. */
  async function resolve(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) return Promise.all(node.map(resolve));
    if (!React.isValidElement(node)) return node;
    const el = node as ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
      return resolve(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    }
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el.props ?? {})) if (k !== "children") props[k] = React.isValidElement(v) || Array.isArray(v) ? await resolve(v) : v;
    const children = el.props?.children;
    // Children go back as arguments, as JSX passes them, so static siblings need no keys.
    return Array.isArray(children) ? React.cloneElement(el, props, ...((await resolve(children)) as ReactNode[])) : React.cloneElement(el, props, (await resolve(children)) as ReactNode);
  }
  async function html(tree: unknown, pathname = "/assets"): Promise<string> {
    const resolved = (await resolve(tree)) as ReactNode;
    return renderToStaticMarkup(
      React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(PathnameContext.Provider, { value: pathname }, resolved)),
    );
  }
  /** Render a page; returns its HTML, or "redirect:<to>" / "404" / "403". */
  async function render(page: Page, sp: SP = {}, params?: Record<string, string>, pathname?: string): Promise<string> {
    try {
      return await html(await page({ searchParams: Promise.resolve(sp), ...(params ? { params: Promise.resolve(params) } : {}) }), pathname);
    } catch (err) { return outcome(err); }
  }
  const ok = (h: string) => !/^(redirect:|404$|403$)/.test(h);

  const A = await import("../apps/web/src/app/actions/assets");
  const pages = {
    summary: (await import("../apps/web/src/app/(app)/assets/page")).default as Page,
    assigned: (await import("../apps/web/src/app/(app)/assets/assigned/page")).default as Page,
    requests: (await import("../apps/web/src/app/(app)/assets/requests/page")).default as Page,
    acks: (await import("../apps/web/src/app/(app)/assets/acknowledgements/page")).default as Page,
    list: (await import("../apps/web/src/app/(app)/assets/list/page")).default as Page,
    detail: (await import("../apps/web/src/app/(app)/assets/[id]/page")).default as Page,
    categories: (await import("../apps/web/src/app/(app)/assets/categories/page")).default as Page,
    reports: (await import("../apps/web/src/app/(app)/assets/reports/page")).default as Page,
    settings: (await import("../apps/web/src/app/(app)/assets/settings/page")).default as unknown as Page,
    recovery: (await import("../apps/web/src/app/(app)/assets/recovery/page")).default as Page,
    importStart: (await import("../apps/web/src/app/(app)/assets/import/page")).default as Page,
    importStep: (await import("../apps/web/src/app/(app)/assets/import/[id]/page")).default as Page,
    mine: (await import("../apps/web/src/app/(app)/me/assets/page")).default as Page,
  };
  const Layout = (await import("../apps/web/src/app/(app)/assets/layout")).default;
  const { GET: exportGet } = await import("../apps/web/src/app/(app)/assets/export/route");
  const { GET: fileGet } = await import("../apps/web/src/app/files/[id]/route");
  const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
  const { ASSET_REPORTS } = await import("../apps/web/src/app/(app)/assets/_reports");
  const download = async (q: string) => {
    const res = await exportGet(new NextRequest(`http://acme.localhost/assets/export?${q}`));
    return { status: res.status, text: res.status === 200 ? await res.text() : "" };
  };
  const layout = async (pathname = "/assets") => {
    try { return await html(await Layout({ children: React.createElement("main", null, "page-body") }), pathname); } catch (err) { return outcome(err); }
  };

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const tenantId = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { email }, include: { employee: true } });
  const [admin, hr, meera] = await Promise.all([user("vikram.menon@acme.test"), user("priya.sharma@acme.test"), user("meera.krishnan@acme.test")]);
  const started = new Date();
  const stamp = String(Date.now()).slice(-6);
  const made = { categories: [] as string[], series: [] as string[], assets: [] as string[], requests: [] as string[], schedules: [] as string[], imports: [] as string[] };
  const settingsBefore = await prisma.assetSettings.findUnique({ where: { tenantId } });

  console.log("\nAsset pages\n" + "=".repeat(72));
  try {
    // -------------------------------------------------------------------------
    section("Access");
    await signInAs(meera.email);
    check("An employee opening Org › Assets is sent to /me/assets", (await layout()) === "redirect:/me/assets");
    check("…and so is a deep link to the asset list", (await layout("/assets/list")) === "redirect:/me/assets");
    check("An employee cannot download asset lists", (await download("view=list")).status === 403);
    check("An employee cannot add an asset", (await A.saveAssetAction({}, fd({ name: "x" }))).ok === false);
    check("An employee's own page renders", ok(await render(pages.mine, {}, undefined, "/me/assets")));

    await signInAs(hr.email);
    const hrLayout = await layout();
    check("An assigner sees the asset tabs without the managers-only ones", ok(hrLayout) && hrLayout.includes("Asset List") && hrLayout.includes("Damage Recovery") && !hrLayout.includes("Settings") && !hrLayout.includes("Reports"));
    for (const k of ["categories", "reports", "settings"] as const) check(`An assigner opening ${k} is sent back to the summary`, (await render(pages[k])) === "redirect:/assets");
    check("An assigner cannot download a report", (await download(`report=${ASSET_REPORTS[0].key}`)).status === 403);
    check("An assigner can open the asset list", ok(await render(pages.list)));

    await signInAs(admin.email);
    const adminLayout = await layout();
    check("A manager sees all nine tabs", ["Summary", "Assigned Assets", "Asset Requests", "Asset Acknowledgement", "Asset List", "Asset Categories &amp; Asset Types", "Reports", "Settings", "Damage Recovery"].every((t) => adminLayout.includes(t)));
    const hrefs = [...adminLayout.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    check("Every tab links to a page that exists", hrefs.length === 9 && hrefs.every((h) => ["/assets", "/assets/assigned", "/assets/requests", "/assets/acknowledgements", "/assets/list", "/assets/categories", "/assets/reports", "/assets/settings", "/assets/recovery"].includes(h)), hrefs.join(" "));

    // -------------------------------------------------------------------------
    section("Every page renders for a manager");
    const seeded = await prisma.asset.findFirstOrThrow({ where: { tenantId, status: "ASSIGNED" }, include: { assignments: { where: { returnedOn: null } } } });
    const renders: Array<[string, Page, SP, Record<string, string>?]> = [
      ["summary", pages.summary, {}], ["summary drill-down", pages.summary, { list: "assigned" }],
      ["assigned", pages.assigned, {}], ["assigned + audit drawer", pages.assigned, { audit: seeded.id }],
      ["requests", pages.requests, {}], ["closed requests", pages.requests, { tab: "closed" }],
      ["acknowledgements", pages.acks, {}], ["completed acknowledgements", pages.acks, { tab: "completed" }],
      ["asset list", pages.list, {}], ["asset list filtered", pages.list, { status: "ASSIGNED", q: seeded.assetTag }],
      ["asset list + add form", pages.list, { new: "1" }], ["asset list + bulk add", pages.list, { import: "ADD" }], ["asset list + bulk update", pages.list, { import: "UPDATE" }],
      ["asset list + assign overlay", pages.list, { assign: "new" }],
      ["asset detail", pages.detail, {}, { id: seeded.id }], ["asset detail + edit", pages.detail, { edit: "1" }, { id: seeded.id }], ["asset detail + audit", pages.detail, { audit: seeded.id }, { id: seeded.id }],
      ["categories", pages.categories, {}], ["settings", pages.settings, {}],
      ["damage recovery", pages.recovery, {}], ["recovered charges", pages.recovery, { tab: "recovered" }],
      ...ASSET_REPORTS.map((r) => [`report: ${r.title}`, pages.reports, { report: r.key }] as [string, Page, SP]),
    ];
    for (const [label, page, sp, params] of renders) {
      const h = await render(page, sp, params, "/assets");
      check(`${label} renders`, ok(h) && h.length > 200, ok(h) ? "" : h);
    }
    const listHtml = await render(pages.list, { q: seeded.assetTag });
    check("The list finds an asset by its ID and links to its detail page", listHtml.includes(`/assets/${seeded.id}`));
    check("An unknown asset is a 404", (await render(pages.detail, {}, { id: "nope" })) === "404");
    check("/assets/import without an upload goes to Bulk Add", (await render(pages.importStart, { mode: "UPDATE" })) === "redirect:/assets/list?import=UPDATE");
    check("Old ?tab=mine links land on /me/assets", (await render(pages.summary, { tab: "mine" })) === "redirect:/me/assets");

    // -------------------------------------------------------------------------
    section("Categories, types, ID series and settings");
    const cat = await A.saveAssetCategoryAction({}, fd({ name: `Smoke Gear ${stamp}`, usefulLifeMonths: "36" }));
    if (cat.values?.id) made.categories.push(cat.values.id);
    check("A category is added", cat.ok === true && !!cat.values?.id, cat.message);
    check("A duplicate category name is refused", (await A.saveAssetCategoryAction({}, fd({ name: `smoke gear ${stamp}` }))).ok === false);
    const type = await A.saveAssetTypeAction({}, fd({ categoryId: cat.values!.id, name: "Smoke Laptop", icon: "laptop", requireAck: true }));
    check("A type that needs acknowledgement is added", type.ok === true, type.message);
    const typeId = type.values!.id;
    const ser = await A.saveAssetIdSeriesAction({}, fd({ name: `Smoke ${stamp}`, prefix: `SMK${stamp}-`, digits: "3", nextNumber: "7" }));
    const series = await prisma.assetIdSeries.findFirst({ where: { tenantId, name: `Smoke ${stamp}` } });
    if (series) made.series.push(series.id);
    check("An ID series is added", ser.ok === true && !!series, ser.message);
    const catHtml = await render(pages.categories, { cat: cat.values!.id });
    check("The categories page shows the new type", catHtml.includes("Smoke Laptop") && catHtml.includes(`Smoke Gear ${stamp}`));
    check("The settings page lists the series with its next ID", (await render(pages.settings)).includes(`SMK${stamp}-007`));
    const s0 = await A.saveAssetSettingsAction({}, fd({ level1: "REPORTING_MANAGER", level2: "ASSET_MANAGER", skipDuplicateApprover: true, allowEmployeeRequests: true, ackReminderDays: "3", warrantyAlertDays: "45" }));
    check("Settings save", s0.ok === true && (await prisma.assetSettings.findUnique({ where: { tenantId } }))?.warrantyAlertDays === 45, s0.message);
    check("A bad reminder interval is refused", (await A.saveAssetSettingsAction({}, fd({ ackReminderDays: "90", warrantyAlertDays: "30" }))).ok === false);

    // -------------------------------------------------------------------------
    section("Add → assign → acknowledge → recover");
    const loc = await prisma.location.findFirstOrThrow({ where: { tenantId, isActive: true } });
    const add = await A.saveAssetAction({}, fd({ assetTypeId: typeId, seriesId: series!.id, name: "Smoke MacBook", locationId: loc.id, condition: "NEW", purchaseCost: "120000", purchaseDate: "2026-01-15", warrantyExpiry: "2029-01-14", serialNumber: `SN-${stamp}` }));
    const asset = add.values?.id ? await prisma.asset.findUnique({ where: { id: add.values.id } }) : null;
    if (asset) made.assets.push(asset.id);
    check("An asset is added from the series", add.ok === true && asset?.assetTag === `SMK${stamp}-007` && asset.status === "AVAILABLE", add.message);
    check("…with a book value from the category's useful life", !!asset?.currentValue && Number(asset.currentValue) < 120000);
    const manual = await A.saveAssetAction({}, fd({ assetTypeId: typeId, seriesId: "MANUAL", assetTag: asset!.assetTag, name: "Dup", locationId: loc.id, condition: "GOOD" }));
    check("A hand-typed ID already in use is refused", manual.ok === false && !!manual.errors?.assetTag, manual.message);
    const held = await A.saveAssetAction({}, fd({ assetTypeId: typeId, seriesId: "MANUAL", assetTag: `SMK${stamp}-X`, name: "Smoke spare", locationId: loc.id, condition: "GOOD", status: "IN_REPAIR" }));
    check("A not-available asset needs a reason", held.ok === false && !!held.errors?.unavailableReason, held.message);
    const edit = await A.saveAssetAction({}, fd({ id: asset!.id, assetTypeId: typeId, assetTag: asset!.assetTag, name: "Smoke MacBook Pro", locationId: loc.id, condition: "NEW", purchaseCost: "120000", purchaseDate: "2026-01-15", warrantyExpiry: "2029-01-14", serialNumber: `SN-${stamp}` }));
    check("Its details can be edited", edit.ok === true && (await prisma.asset.findUnique({ where: { id: asset!.id } }))?.name === "Smoke MacBook Pro", edit.message);
    const withDoc = fd({ id: asset!.id, assetTypeId: typeId, assetTag: asset!.assetTag, name: "Smoke MacBook Pro", locationId: loc.id, condition: "NEW", purchaseCost: "120000", purchaseDate: "2026-01-15", warrantyExpiry: "2029-01-14", serialNumber: `SN-${stamp}` });
    withDoc.append("documents", new File([PDF], "invoice.pdf", { type: "application/pdf" }));
    const docSaved = await A.saveAssetAction({}, withDoc);
    const doc = await prisma.storedFile.findFirst({ where: { tenantId, relatedType: "Asset", relatedId: asset!.id } });
    check("A document can be attached", docSaved.ok === true && !!doc, docSaved.message);
    const getFile = async () => (await fileGet(new NextRequest(`http://acme.localhost/files/${doc!.id}`), { params: Promise.resolve({ id: doc!.id }) })).status;
    check("The detail page links the document", (await render(pages.detail, {}, { id: asset!.id })).includes(`/files/${doc!.id}`));
    check("An asset manager can open it", (await getFile()) === 200);
    await signInAs(hr.email);
    check("So can an assigner", (await getFile()) === 200);
    await signInAs(meera.email);
    check("An employee cannot", (await getFile()) === 404);
    await signInAs(admin.email);
    const typeList = await render(pages.list, { type: typeId });
    check("The type's list shows it", typeList.includes(asset!.assetTag) && typeList.includes("Smoke MacBook Pro"));

    const assign = await A.assignAssetAction({}, fd({ assetId: asset!.id, employeeId: meera.employee!.id, conditionOut: "NEW", notes: "Charger included" }));
    const asg = await prisma.assetAssignment.findFirst({ where: { assetId: asset!.id, returnedOn: null } });
    check("It is assigned to an employee, waiting on her acknowledgement", assign.ok === true && asg?.employeeId === meera.employee!.id && asg.ackStatus === "PENDING", assign.message);
    check("Assigning it again is refused", (await A.assignAssetAction({}, fd({ assetId: asset!.id, employeeId: admin.employee!.id }))).ok === false);
    const detail = await render(pages.detail, {}, { id: asset!.id });
    check("The detail page shows the holder and the assignment history", detail.includes(meera.employee!.displayName ?? "") && detail.includes("Assignment history") && detail.includes("Charger included"));
    check("The acknowledgements tab lists it as pending", (await render(pages.acks, { q: asset!.assetTag })).includes(asset!.assetTag));
    const remind = await A.remindAcknowledgementAction({}, fd({ ids: asg!.id }));
    check("A reminder can be sent", remind.ok === true, remind.message);

    await signInAs(meera.email);
    let mine = await render(pages.mine, {}, undefined, "/me/assets");
    check("The employee sees the asset with an Acknowledge button", mine.includes(asset!.assetTag) && mine.includes("Acknowledge"));
    const ack = await A.acknowledgeAssetAction({}, fd({ assignmentId: asg!.id }));
    check("She acknowledges it", ack.ok === true && (await prisma.assetAssignment.findUnique({ where: { id: asg!.id } }))?.ackStatus === "ACKNOWLEDGED", ack.message);
    check("Acknowledging twice is refused", (await A.acknowledgeAssetAction({}, fd({ assignmentId: asg!.id }))).ok === false);
    mine = await render(pages.mine, {}, undefined, "/me/assets");
    check("…and her page shows it acknowledged", mine.includes("Acknowledged"));
    check("The request form opens, offering a replacement of what she holds", (await render(pages.mine, { request: "1", rtype: "REPLACEMENT", held: asset!.id }, undefined, "/me/assets")).includes("Asset to replace"));
    const req = await A.requestAssetAction({}, fd({ requestType: "NEW_ASSET", title: `Smoke monitor ${stamp}`, reason: "Second screen for design work", categoryId: cat.values!.id }));
    if (req.values?.id) made.requests.push(req.values.id);
    check("She requests an asset", req.ok === true, req.message);
    const reqs = await render(pages.mine, { view: "requests" }, undefined, "/me/assets");
    check("Her requests list shows it", reqs.includes(`Smoke monitor ${stamp}`));
    check("Its drawer opens with the activity", (await render(pages.mine, { view: "requests", req: req.values!.id }, undefined, "/me/assets")).includes("raised the request"));
    check("She cannot record a recovery", (await A.recordDamageRecoveryAction({}, fd({ assignmentId: asg!.id, method: "COLLECTED", note: "x" }))).ok === false);

    await signInAs(admin.email);
    check("The manager sees her request", (await render(pages.requests, { q: `Smoke monitor ${stamp}` })).includes(`Smoke monitor ${stamp}`));
    const noNote = await A.recoverAssetAction({}, fd({ assignmentId: asg!.id, conditionIn: "DAMAGED", damageCharge: "4500" }));
    check("A damage charge needs a description", noNote.ok === false && !!noNote.errors?.damageNote, noNote.message);
    const rec = await A.recoverAssetAction({}, fd({ assignmentId: asg!.id, conditionIn: "DAMAGED", damageCharge: "4500", damageNote: "Cracked screen" }));
    const after = await prisma.asset.findUnique({ where: { id: asset!.id } });
    check("The asset is recovered damaged and goes to repair", rec.ok === true && after?.status === "IN_REPAIR" && after.condition === "DAMAGED", rec.message);
    check("The damage recovery tab lists the charge", (await render(pages.recovery, { q: asset!.assetTag })).includes("Cracked screen"));
    const csvRec = await download(`view=recovery&q=${asset!.assetTag}`);
    check("…and its download has the same row", csvRec.status === 200 && csvRec.text.includes(asset!.assetTag) && csvRec.text.includes("4500"));
    const noHow = await A.recordDamageRecoveryAction({}, fd({ assignmentId: asg!.id, method: "COLLECTED" }));
    check("Recording a recovery needs how it was collected", noHow.ok === false && !!noHow.errors?.note, noHow.message);
    const col = await A.recordDamageRecoveryAction({}, fd({ assignmentId: asg!.id, method: "COLLECTED", note: "Paid by UPI" }));
    check("The recovery is recorded", col.ok === true && (await prisma.assetAssignment.findUnique({ where: { id: asg!.id } }))?.chargeRecovered === true, col.message);
    check("Recording it twice is refused", (await A.recordDamageRecoveryAction({}, fd({ assignmentId: asg!.id, method: "COLLECTED", note: "again" }))).ok === false);
    check("It moves to the Recovered tab", (await render(pages.recovery, { tab: "recovered", q: asset!.assetTag })).includes(asset!.assetTag) && !(await render(pages.recovery, { q: asset!.assetTag })).includes("Cracked screen"));
    const avail = await A.markAssetAvailableAction({}, fd({ assetId: asset!.id }));
    check("Back from repair, it is marked available", avail.ok === true && (await prisma.asset.findUnique({ where: { id: asset!.id } }))?.status === "AVAILABLE", avail.message);
    check("The audit history records each step", (await prisma.assetEvent.count({ where: { assetId: asset!.id } })) >= 6);

    // -------------------------------------------------------------------------
    section("Bulk import");
    const csv = `Asset ID,Asset Name,Asset Location,Asset Category,Asset Type,Asset Condition,Asset Status,Serial Number\nSMK${stamp}-B1,Bulk One,${loc.name},Smoke Gear ${stamp},Smoke Laptop,Good,Available,B1\nSMK${stamp}-B2,Bulk Two,Nowhere,Smoke Gear ${stamp},Smoke Laptop,Good,Available,B2\n`;
    const up = fd({ mode: "ADD", assetTypeId: typeId });
    up.set("file", new File([csv], "assets.csv", { type: "text/csv" }));
    const start = await A.startAssetImportAction({}, up);
    if (start.values?.id) made.imports.push(start.values.id);
    check("A CSV is uploaded", start.ok === true && !!start.values?.id, start.message);
    check("The mapping step renders with the columns pre-mapped", (await render(pages.importStep, {}, { id: start.values!.id })).includes("Map the columns"));
    const imp = await prisma.assetImport.findUniqueOrThrow({ where: { id: start.values!.id } });
    const mapping = imp.mapping as Record<string, string>;
    const mapFd = fd({ id: imp.id });
    (imp.headers as string[]).forEach((h, i) => { if (mapping[h]) mapFd.set(`map_${i}`, mapping[h]); });
    const mapped = await A.mapAssetImportAction({}, mapFd);
    check("Mapping validates the rows: one good, one with an unknown location", mapped.ok === true && /1 row/.test(mapped.message ?? ""), mapped.message);
    check("The review step lists the problem", (await render(pages.importStep, {}, { id: imp.id })).includes("is not a location"));
    const commit = await A.commitAssetImportAction({}, fd({ id: imp.id }));
    const b1 = await prisma.asset.findFirst({ where: { tenantId, assetTag: `SMK${stamp}-B1` } });
    if (b1) made.assets.push(b1.id);
    check("Importing adds the valid row only", commit.ok === true && !!b1 && !(await prisma.asset.findFirst({ where: { tenantId, assetTag: `SMK${stamp}-B2` } })), commit.message);
    check("The done step renders", (await render(pages.importStep, {}, { id: imp.id })).includes("Back to the asset list"));

    // -------------------------------------------------------------------------
    section("Reports, schedules and downloads");
    const sch = await A.scheduleAssetReportAction({}, fd({ reportKey: "asset-warranty", name: `Smoke warranty ${stamp}`, recipients: "ops@acme.test", frequency: "WEEKLY", dayOfWeek: "1" }));
    const schRow = await prisma.scheduledReport.findFirst({ where: { tenantId, name: `Smoke warranty ${stamp}` } });
    if (schRow) made.schedules.push(schRow.id);
    check("A report is scheduled", sch.ok === true && !!schRow && schRow.nextRunAt > started, sch.message);
    check("A bad recipient is refused", (await A.scheduleAssetReportAction({}, fd({ reportKey: "asset-warranty", name: "x y", recipients: "not-an-email", frequency: "DAILY" }))).ok === false);
    check("The report page lists the schedule", (await render(pages.reports, { report: "asset-warranty" })).includes(`Smoke warranty ${stamp}`));
    const del = await A.deleteScheduledAssetReportAction({}, fd({ id: schRow!.id }));
    check("…and it can be deleted", del.ok === true && !(await prisma.scheduledReport.findUnique({ where: { id: schRow!.id } })));
    for (const r of ASSET_REPORTS) {
      const d = await download(`report=${r.key}`);
      check(`Report download: ${r.title}`, d.status === 200 && d.text.includes(r.key === "asset-requests" ? "Requested By" : "Asset ID"));
    }
    const inv = await download("report=asset-inventory");
    check("The inventory report includes the new asset", inv.text.includes(asset!.assetTag));
    for (const v of ["list", "summary-assigned", "summary-available", "summary-unavailable", "assigned", "requests", "requests-closed", "acks", "acks-completed", "recovery", "template&mode=ADD", `template&mode=UPDATE&type=${typeId}`]) {
      const d = await download(`view=${v}`);
      check(`Download: ${v}`, d.status === 200 && d.text.split("\r\n").length >= 2);
    }
    check("The bulk-update template lists the type's assets", (await download(`view=template&mode=UPDATE&type=${typeId}`)).text.includes(asset!.assetTag));
    check("An unknown download is a 404", (await download("view=nope")).status === 404);

    // -------------------------------------------------------------------------
    section("Clean-up rules");
    const delType = await A.deleteAssetTypeAction({}, fd({ id: typeId }));
    check("A type that still holds assets cannot be deleted", delType.ok === false, delType.message);
  } finally {
    // Requests first (they point at categories), then assets (cascading their assignments and events).
    await prisma.assetRequest.deleteMany({ where: { id: { in: made.requests } } });
    await prisma.asset.deleteMany({ where: { id: { in: made.assets } } });
    await prisma.assetCategory.deleteMany({ where: { id: { in: made.categories } } });
    await prisma.assetIdSeries.deleteMany({ where: { id: { in: made.series } } });
    await prisma.scheduledReport.deleteMany({ where: { id: { in: made.schedules } } });
    await prisma.assetImport.deleteMany({ where: { id: { in: made.imports } } });
    const files = await prisma.storedFile.findMany({ where: { tenantId, relatedType: { in: ["AssetImport", "Asset"] }, createdAt: { gte: started }, uploadedBy: admin.id } });
    for (const f of files) await unlink(path.join(process.env.STORAGE_DIR ?? path.resolve(__dirname, "../.storage"), f.storageKey)).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    await prisma.notification.deleteMany({ where: { tenantId, kind: "ASSET", createdAt: { gte: started } } });
    if (settingsBefore) {
      const { id: _id, tenantId: _t, updatedAt: _u, ...rest } = settingsBefore;
      await prisma.assetSettings.update({ where: { tenantId }, data: { ...rest, requestApprovalChain: rest.requestApprovalChain ?? undefined } });
    } else await prisma.assetSettings.deleteMany({ where: { tenantId } });
    await prisma.$disconnect();
  }
  report("Asset pages");
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
