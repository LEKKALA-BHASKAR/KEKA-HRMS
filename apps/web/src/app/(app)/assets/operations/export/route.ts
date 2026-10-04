import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { stockLevels, DISPOSAL_METHODS, MAINTENANCE_KINDS } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { csv, csvResponse, ymd } from "@/lib/cases-docs";

/** CSV for the asset operations tabs (maintenance, bookings, stock, disposals, stock-take). Asset managers only. */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer || !can(viewer, PERMISSIONS.ASSET_MANAGE)) return new Response("Not found.", { status: 404 });
  const t = viewer.tenantId;
  const sp = new URL(req.url).searchParams;
  const tab = sp.get("tab") ?? "stock";
  const assets = new Map((await prisma.asset.findMany({ where: { tenantId: t }, select: { id: true, assetTag: true, name: true, assetType: { select: { name: true } } } })).map((a) => [a.id, { tag: a.assetTag, name: a.name ?? a.assetType.name }]));
  const A = (id: string) => [assets.get(id)?.tag ?? "", assets.get(id)?.name ?? ""];
  let name: string, body: string;
  if (tab === "maintenance") {
    const rows = await prisma.assetMaintenance.findMany({ where: { tenantId: t }, orderBy: { scheduledOn: "asc" } });
    name = "maintenance";
    body = csv(["Asset tag", "Asset", "Kind", "Title", "Scheduled", "Status", "Vendor", "Cost", "Completed"], rows.map((r) => [...A(r.assetId), MAINTENANCE_KINDS[r.kind as keyof typeof MAINTENANCE_KINDS] ?? r.kind, r.title, ymd(r.scheduledOn), r.status, r.vendor ?? "", r.cost?.toString() ?? "", ymd(r.completedOn)]));
  } else if (tab === "pools") {
    const rows = await prisma.assetReservation.findMany({ where: { tenantId: t }, orderBy: { fromDate: "asc" } });
    const people = new Map((await prisma.employee.findMany({ where: { tenantId: t, id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, employeeNumber: true, displayName: true } })).map((e) => [e.id, e]));
    name = "bookings";
    body = csv(["Asset tag", "Asset", "Employee no.", "Employee", "From", "To", "Purpose", "Status"], rows.map((r) => [...A(r.assetId), people.get(r.employeeId)?.employeeNumber ?? "", people.get(r.employeeId)?.displayName ?? "", ymd(r.fromDate), ymd(r.toDate), r.purpose, r.status]));
  } else if (tab === "disposal") {
    const rows = await prisma.assetDisposal.findMany({ where: { tenantId: t }, orderBy: { createdAt: "asc" } });
    name = "disposals";
    body = csv(["Asset tag", "Asset", "Method", "Reason", "Book value", "Expected", "Realised", "Buyer", "Status", "Requested", "Completed"], rows.map((r) => [...A(r.assetId), DISPOSAL_METHODS[r.method as keyof typeof DISPOSAL_METHODS] ?? r.method, r.reason, r.bookValue?.toString() ?? "", r.expectedValue?.toString() ?? "", r.realisedValue?.toString() ?? "", r.buyer ?? "", r.status, ymd(r.createdAt), ymd(r.completedAt)]));
  } else if (tab === "reconciliation") {
    const rec = sp.get("id") ? await prisma.assetReconciliation.findFirst({ where: { id: sp.get("id")!, tenantId: t }, include: { lines: true } }) : await prisma.assetReconciliation.findFirst({ where: { tenantId: t }, orderBy: { createdAt: "desc" }, include: { lines: true } });
    if (!rec) return new Response("Not found.", { status: 404 });
    name = `stock-take-${rec.name.replace(/[^\w-]+/g, "-").toLowerCase()}`;
    body = csv(["Asset tag", "Asset", "Expected status", "Expected holder", "Expected location", "Result", "Found at", "Condition", "Note", "Checked"], rec.lines.map((l) => [...A(l.assetId), l.expectedStatus, l.expectedHolder ?? "", l.expectedLocation ?? "", l.found === null ? "Not checked" : l.found ? "Found" : "Missing", l.foundLocation ?? "", l.foundCondition ?? "", l.note ?? "", ymd(l.checkedAt)]));
  } else {
    const rows = await stockLevels(t);
    name = "stock-levels";
    body = csv(["Type", "Category", "Available", "Assigned", "In repair", "Total", "Minimum", "Below minimum"], rows.map((r) => [r.name, r.category, r.available, r.assigned, r.inRepair, r.total, r.minAvailable ?? "", r.low ? "Yes" : "No"]));
  }
  await prisma.auditLog.create({ data: { tenantId: t, module: "ASSET", action: "EXPORT", entityType: "Asset", summary: `Exported asset ${name.replace(/-/g, " ")}`, actorId: viewer.user.id, actorLabel: viewer.user.email } });
  return csvResponse(`asset-${name}-${ymd(new Date())}.csv`, body);
}
