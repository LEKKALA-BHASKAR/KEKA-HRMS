/**
 * Growth & Retention, Attrition Analysis, the chart export, and the Time,
 * Documents, Assets, Expenses and Performance tabs on an employee's profile:
 * each renders for an admin, stays inside a scoped HR user's people, and is
 * refused to an employee.
 */
import { signInAs, check, section, report } from "./_test-bootstrap";
import type { ReactNode } from "react";

const ADMIN = "vikram.menon@acme.test";
const SCOPED = "deepak.chauhan@acme.test"; // HR Executive scoped to Platform and Product
const EMPLOYEE = "meera.krishnan@acme.test"; // Product

async function main() {
  // tsx compiles JSX in classic mode; pages expect React in scope.
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToReadableStream } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { SearchParamsContext, PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const { NextRequest } = await import("next/server");
  const { prisma } = await import("@keka/db");

  const growth = (await import("../apps/web/src/app/(app)/analytics/growth/page")).default;
  const attrition = (await import("../apps/web/src/app/(app)/analytics/attrition/page")).default;
  const profile = (await import("../apps/web/src/app/(app)/employees/[id]/page")).default;
  const exporter = (await import("../apps/web/src/app/(app)/analytics/export/route")).GET;

  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  /** Render a page's element tree to HTML, async server components and client hooks included. */
  async function html(node: unknown, path: string, search: Record<string, string> = {}): Promise<string> {
    const tree = React.createElement(AppRouterContext.Provider, { value: router as never },
      React.createElement(PathnameContext.Provider, { value: path },
        React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) }, node as ReactNode)));
    const stream = await renderToReadableStream(tree, { onError() {} });
    await stream.allReady;
    return await new Response(stream).text();
  }
  /** "ok" with the markup, or "denied" when the page refuses (403/404/redirect). */
  async function open(fn: () => Promise<unknown>, path: string, search: Record<string, string> = {}): Promise<{ state: "ok" | "denied"; text: string }> {
    try { return { state: "ok", text: await html(await fn(), path, search) }; } catch (err) {
      const e = err as { digest?: string; message?: string };
      if (/HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`)) return { state: "denied", text: "" };
      throw err;
    }
  }
  const sp = (o: Record<string, string> = {}) => ({ searchParams: Promise.resolve(o) });
  const page = (o: Record<string, string> = {}) => ({ id: "", ...o });
  const viewGrowth = (o: Record<string, string> = {}) => open(() => growth(sp(o)), "/analytics/growth", o);
  const viewAttrition = (o: Record<string, string> = {}) => open(() => attrition(sp(o)), "/analytics/attrition", o);
  const viewProfile = (id: string, tab: string) => open(() => profile({ params: Promise.resolve(page({ id })), searchParams: Promise.resolve({ tab }) }), `/employees/${id}`, { tab });
  const exportCsv = async (q: string) => { const res = await exporter(new NextRequest(`http://localhost/analytics/export?${q}`)); return { status: res.status, type: res.headers.get("content-type") ?? "", body: res.status === 200 && !/pdf/.test(res.headers.get("content-type") ?? "") ? await res.text() : "" }; };

  const emp = async (number: string) => (await prisma.employee.findFirstOrThrow({ where: { employeeNumber: number, tenant: { subdomain: "acme" } }, select: { id: true } })).id;
  const startedAt = new Date();
  const meera = await emp("ACM0009");
  const rahul = await emp("ACM0015"); // Sales: outside the scoped HR user's departments
  const sales = await prisma.department.findFirstOrThrow({ where: { code: "SALES", tenant: { subdomain: "acme" } }, select: { name: true } });
  const product = await prisma.department.findFirstOrThrow({ where: { code: "PROD", tenant: { subdomain: "acme" } }, select: { name: true } });
  const TABS = ["time", "documents", "assets", "expenses", "performance"] as const;
  const SECTION: Record<(typeof TABS)[number], string> = { time: "attendance", documents: "documents", assets: "assets", expenses: "expenses", performance: "goals" };
  const tabLink = (text: string, id: string, t: string) => text.includes(`href="/employees/${id}?tab=${t}"`);

  try {
    section("Analytics — admin");
    await signInAs(ADMIN);
    const g = await viewGrowth();
    check("Growth & Retention renders for an admin", g.state === "ok" && g.text.includes("Growth &amp; Retention"));
    for (const k of ["gr-growth", "gr-flow", "gr-retention", "gr-newhire", "gr-tenure"]) check(`…with the ${k} chart`, g.text.includes(`data-chart-card="${k}"`));
    for (const k of ["headcount", "growth", "retention", "newhire"]) check(`…and the ${k} KPI`, g.text.includes(`data-kpi="${k}"`));
    check("…and a pill to every analytics page, each of which now exists", ["headcount", "growth", "attrition"].every((p) => g.text.includes(`href="/analytics/${p}`)));
    const gRaw = await viewGrowth({ range: "6m", raw: "gr-retained" });
    check("A KPI's raw-data list opens (retained employees)", gRaw.state === "ok" && gRaw.text.includes("Employee Name"));
    const a = await viewAttrition();
    check("Attrition Analysis renders for an admin", a.state === "ok" && a.text.includes("Attrition Analysis") && a.text.includes('data-chart-card="at-overall"'));
    for (const k of ["rate", "voluntary", "monthly", "regretted"]) check(`…with the ${k} KPI`, a.text.includes(`data-kpi="${k}"`));
    for (const v of ["rate", "kind", "exit-reason", "regretted", "department", "location", "tenure", "manager"]) {
      const r = await viewAttrition({ view: v });
      check(`…the ${v} view renders`, r.state === "ok" && r.text.includes(`data-chart-card="at-${v}"`));
    }
    const aDept = await viewAttrition({ view: "department" });
    check("The department view has a rate table that includes Sales for an admin", aDept.text.includes('data-rate-table="department"') && aDept.text.includes(`<td>${sales.name}</td>`));
    check("The count/% toggle works on the overall view", (await viewAttrition({ m: "pct" })).text.includes("Attrition Rate"));
    const csv = await exportCsv("key=gr-flow&format=csv&range=12m");
    check("A chart exports as CSV", csv.status === 200 && csv.body.includes("Joiners") && csv.body.includes("Leavers"));
    const pdf = await exportCsv("key=at-overall&format=pdf&range=12m");
    check("…and as PDF", pdf.status === 200 && pdf.type === "application/pdf");
    const rawCsv = await exportCsv("key=at-department&format=raw&range=12m");
    check("…and its raw data as CSV", rawCsv.status === 200 && /^\uFEFF?Employee Name,Employee Number,Department\r\n/.test(rawCsv.body));
    check("An unknown chart is a 404", (await exportCsv("key=zz-nope&format=csv")).status === 404);

    section("Employee profile — admin");
    for (const t of TABS) {
      const r = await viewProfile(meera, t);
      check(`The ${t} tab renders real data for an admin`, r.state === "ok" && r.text.includes(`data-section="${SECTION[t]}"`) && !r.text.includes("not in this milestone"));
    }
    const adminTime = await viewProfile(meera, "time");
    check("…the time tab shows leave as well as attendance", adminTime.text.includes('data-section="leave-requests"'));
    check("…every module tab is offered to an admin", TABS.every((t) => tabLink(adminTime.text, meera, t)));

    section("Scoped HR");
    await signInAs(SCOPED);
    const sg = await viewGrowth();
    check("A scoped HR user's Growth & Retention renders", sg.state === "ok" && sg.text.includes('data-chart-card="gr-flow"'));
    const sDept = await viewAttrition({ view: "department" });
    check("A scoped HR user's attrition by department renders", sDept.state === "ok" && sDept.text.includes('data-rate-table="department"'));
    check("…shows their own departments and leaves out Sales", sDept.text.includes(`<td>${product.name}</td>`) && !sDept.text.includes(`<td>${sales.name}</td>`));
    const sRaw = await exportCsv("key=at-department&format=raw&range=12m");
    check("…as does its export", sRaw.status === 200 && sRaw.body.includes(product.name) && !sRaw.body.includes(sales.name));
    for (const t of ["time", "documents", "assets"] as const) {
      const r = await viewProfile(meera, t);
      check(`The ${t} tab renders for someone in scope`, r.state === "ok" && r.text.includes(`data-section="${SECTION[t]}"`));
    }
    const sTime = await viewProfile(meera, "time");
    for (const t of ["expenses", "performance"] as const) {
      check(`The ${t} tab is not offered without ${t} rights`, !tabLink(sTime.text, meera, t));
      const r = await viewProfile(meera, t);
      check(`…and opening it directly is refused`, r.state === "ok" && r.text.includes("You do not have access") && !r.text.includes(`data-section="${SECTION[t]}"`));
    }
    const out = await viewProfile(rahul, "time");
    check("Someone outside the scope is refused", out.text.includes("You do not have access") && !out.text.includes('data-section="attendance"'));

    section("Employees");
    await signInAs(EMPLOYEE);
    check("An employee cannot open Growth & Retention", (await viewGrowth()).state === "denied");
    check("An employee cannot open Attrition Analysis", (await viewAttrition()).state === "denied");
    check("An employee cannot export a chart", (await exportCsv("key=gr-flow&format=csv")).status === 403);
    for (const t of TABS) {
      const r = await viewProfile(rahul, t);
      check(`An employee is refused a colleague's ${t} tab`, r.text.includes("You do not have access") && !r.text.includes(`data-section="${SECTION[t]}"`));
    }
    for (const t of TABS) {
      const r = await viewProfile(meera, t);
      check(`An employee sees their own ${t} tab`, r.state === "ok" && r.text.includes(`data-section="${SECTION[t]}"`));
    }
  } finally {
    // Exports write an audit entry each; nothing else is created.
    await prisma.auditLog.deleteMany({ where: { module: "ANALYTICS", action: "EXPORT", entityType: "AnalyticsChart", createdAt: { gte: startedAt } } });
    await prisma.$disconnect();
  }
  report("Analytics and profile tabs");
}

main().catch((e) => { console.error(e); process.exit(1); });
