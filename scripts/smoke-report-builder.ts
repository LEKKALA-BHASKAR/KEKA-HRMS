/**
 * Custom report builder: every dataset loads through the viewer's own scope,
 * so a scoped HR user sees fewer people than an admin and nobody outside
 * their scope; specs naming unknown fields are refused; reports save, share
 * and copy, and only the owner can change or delete one; a shared report
 * over a dataset the viewer cannot read stays hidden; the CSV matches the
 * screen. Reports created here are named "Smoke report"; removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function attempt(fn: () => Promise<unknown>): Promise<{ redirected: string | null; denied: boolean; value?: unknown }> {
  try { return { redirected: null, denied: false, value: await fn() }; } catch (err) {
    const e = err as { digest?: string; message?: string };
    const s = `${e.digest ?? ""} ${e.message ?? ""}`;
    const m = /NEXT_REDIRECT;[^;]*;([^;]+);/.exec(s);
    if (m) return { redirected: m[1]!, denied: false };
    if (/HTTP_ERROR_FALLBACK;40[34]/.test(s)) return { redirected: null, denied: true };
    throw err;
  }
}

async function main() {
  const rb = await import("../apps/web/src/lib/report-builder");
  const ctx = await import("../apps/web/src/lib/context");
  const act = await import("../apps/web/src/app/actions/report-builder");
  const exportRoute = await import("../apps/web/src/app/(app)/reports/builder/export/route");
  const { NextRequest } = await import("next/server");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const cleanup = () => prisma.savedReport.deleteMany({ where: { tenantId: tenant.id, name: { startsWith: "Smoke report" } } });
  await cleanup();
  try {
    section("Scope");
    await signInAs("vikram.menon@acme.test");
    const admin = (await ctx.getViewer())!;
    const spec = { dataset: "employees", columns: ["employeeNumber", "name", "department"], filters: [], aggregates: [], groupBy: null, sort: { field: "employeeNumber", dir: "asc" as const } };
    const all = await rb.runCustomReport(admin, spec);
    check("An admin's employee report runs", all.ok && all.rows.length > 10, all.ok ? `${all.rows.length}` : all.errors.join(" "));
    await signInAs("deepak.chauhan@acme.test");
    const scoped = (await ctx.getViewer())!;
    const mine = await rb.runCustomReport(scoped, spec);
    check("A scoped HR user's report has fewer people", mine.ok && all.ok && mine.rows.length < all.rows.length, mine.ok ? `${mine.rows.length}` : mine.errors.join(" "));
    check("…and nobody from Sales", mine.ok && !mine.rows.some((r) => String(r.department ?? "").toLowerCase().includes("sales")));
    for (const ds of ["leave", "attendance", "payroll"]) {
      const a = await rb.runCustomReport(admin, { ...spec, dataset: ds, columns: ["employeeNumber", "department"], sort: null, from: "2025-01-01" });
      const s = can(scoped, rb.datasetFor(ds)!.permission) ? await rb.runCustomReport(scoped, { ...spec, dataset: ds, columns: ["employeeNumber", "department"], sort: null, from: "2025-01-01" }) : null;
      const allowed = s === null ? null : s.ok ? new Set(mine.ok ? mine.rows.map((r) => r.employeeNumber) : []) : null;
      check(`The ${ds} dataset runs for an admin`, a.ok, a.ok ? `${a.rows.length} rows` : a.errors.join(" "));
      if (s && s.ok && allowed) check(`The ${ds} dataset stays inside the scoped user's people`, s.rows.every((r) => allowed.has(r.employeeNumber)), `${s.rows.length} rows`);
    }

    section("Validation");
    const bad = await rb.runCustomReport(admin, { ...spec, columns: ["employeeNumber", "salary"] });
    check("An unknown column is refused", !bad.ok && bad.errors.some((e) => e.includes("salary")));
    const textSum = await rb.runCustomReport(admin, { ...spec, aggregates: [{ field: "name", fn: "sum" }] });
    check("Summing a text field is refused", !textSum.ok);
    await signInAs("meera.krishnan@acme.test");
    const emp = (await ctx.getViewer())!;
    const noPay = await rb.runCustomReport(emp, { ...spec, dataset: "payroll", columns: ["netPay"] });
    check("An employee cannot read the payroll dataset", !noPay.ok);
    const r0 = await attempt(() => act.saveCustomReportAction({}, fd({ name: "Smoke report X", spec: JSON.stringify(spec) })));
    check("An employee cannot save reports", r0.denied);

    section("Saving and sharing");
    await signInAs("vikram.menon@acme.test");
    const grouped = { dataset: "payroll", columns: [], filters: [], groupBy: "department", aggregates: [{ field: "netPay", fn: "sum" }, { field: "name", fn: "count" }], sort: { field: "sum_netPay", dir: "desc" } };
    const s1 = await attempt(() => act.saveCustomReportAction({}, fd({ name: "Smoke report payroll", spec: JSON.stringify(grouped), shared: "on" })));
    check("Saving a report opens it", !!s1.redirected?.startsWith("/reports/builder/"), JSON.stringify(s1));
    const saved = await prisma.savedReport.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke report payroll" } });
    check("The dataset and spec are stored", saved.dataset === "payroll" && (saved.spec as { groupBy?: string }).groupBy === "department" && saved.shared);
    const s2 = await attempt(() => act.saveCustomReportAction({}, fd({ name: "Smoke report emp", spec: JSON.stringify(spec), shared: "on" })));
    check("A shared employee report saves", !!s2.redirected);
    const empReport = await prisma.savedReport.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke report emp" } });
    const badSave = await attempt(() => act.saveCustomReportAction({}, fd({ name: "Smoke report bad", spec: JSON.stringify({ ...spec, columns: ["ssn"] }) })));
    check("A report with unknown fields does not save", (badSave.value as { ok?: boolean })?.ok === false);

    await signInAs("priya.sharma@acme.test");
    const hr = (await ctx.getViewer())!;
    const listHr = await rb.savedReportsFor(hr);
    check("A colleague sees the shared reports", listHr.some((r) => r.id === saved.id) === can(hr, rb.datasetFor("payroll")!.permission) && listHr.some((r) => r.id === empReport.id));
    const upd = await attempt(() => act.saveCustomReportAction({}, fd({ id: empReport.id, name: "Smoke report hijack", spec: JSON.stringify(spec) })));
    check("Only the owner can change a report", (upd.value as { ok?: boolean })?.ok === false);
    const copy = await attempt(() => act.saveCustomReportAction({}, fd({ id: empReport.id, copy: "1", name: "Smoke report copy", spec: JSON.stringify(spec) })));
    check("…but anyone who builds can save a copy", !!copy.redirected);
    const del = await attempt(() => act.deleteCustomReportAction({}, fd({ id: empReport.id })));
    check("Only the owner can delete a report", (del.value as { ok?: boolean })?.ok === false);
    check("The shared report still exists", !!(await prisma.savedReport.findUnique({ where: { id: empReport.id } })));

    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot open a shared payroll report", (await rb.savedReportFor(emp, saved.id)) === null);

    section("CSV");
    await signInAs("vikram.menon@acme.test");
    const res = await exportRoute.GET(new NextRequest(`http://acme.localhost:3100/reports/builder/export?id=${saved.id}`));
    const csv = (await res.text()).replace(/^﻿/, "").split("\r\n");
    const screen = await rb.runCustomReport(admin, rb.specOf(saved));
    check("The CSV has the screen's rows", res.status === 200 && screen.ok && csv.length === screen.rows.length + 1, `${csv.length} lines`);
    check("The CSV header names the grouped values", csv[0] === "Department,Sum of Net pay,Count", csv[0]);
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, entityType: "SavedReport", entityId: saved.id, action: "EXPORT" } });
    check("The download is audited", !!audit);

    section("Deleting");
    const d1 = await attempt(() => act.deleteCustomReportAction({}, fd({ id: saved.id })));
    check("The owner can delete a report", d1.redirected === "/reports/builder" && !(await prisma.savedReport.findUnique({ where: { id: saved.id } })));
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  report("Report builder");

  function can(v: Awaited<ReturnType<typeof ctx.getViewer>>, p: string) { return !!v && ctx.can(v, p as never); }
}

main().catch((e) => { console.error(e); process.exit(1); });
