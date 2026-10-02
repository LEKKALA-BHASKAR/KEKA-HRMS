/**
 * Hiring, expense and attendance dashboards: each needs analytics plus the
 * module's own permission, renders for an admin, stays inside a scoped HR
 * user's people, and is refused to an employee.
 */
import { signInAs, check, section, report } from "./_test-bootstrap";

async function render(fn: () => Promise<unknown>): Promise<"ok" | "denied"> {
  try { await fn(); return "ok"; } catch (err) {
    const e = err as { digest?: string; message?: string };
    if (/HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`)) return "denied";
    throw err;
  }
}

async function main() {
  // tsx compiles JSX in classic mode; pages expect React in scope.
  (globalThis as { React?: unknown }).React = await import("react");
  const pages = {
    hiring: (await import("../apps/web/src/app/(app)/analytics/hiring/page")).default,
    expenses: (await import("../apps/web/src/app/(app)/analytics/expenses/page")).default,
    attendance: (await import("../apps/web/src/app/(app)/analytics/attendance/page")).default,
  };
  const sp = (o: Record<string, string> = {}) => ({ searchParams: Promise.resolve(o) });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const text = (node: unknown) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);

  section("Admin");
  await signInAs("vikram.menon@acme.test");
  for (const [k, page] of Object.entries(pages)) check(`The ${k} dashboard renders for an admin`, (await render(() => page(sp()))) === "ok");
  check("The admin's attendance dashboard includes Sales", /title="Sales"/.test(text(await pages.attendance(sp()))));
  check("Windows are accepted", (await render(() => pages.attendance(sp({ weeks: "12" })))) === "ok" && (await render(() => pages.hiring(sp({ months: "12" })))) === "ok");

  section("Scope");
  await signInAs("deepak.chauhan@acme.test");
  const att = text(await pages.attendance(sp()));
  check("A scoped HR user's attendance dashboard renders", att.includes("Attendance dashboard"));
  check("…and leaves out Sales", !/title="Sales"/.test(att));
  check("A scoped HR user without hiring rights cannot open the hiring dashboard", (await render(() => pages.hiring(sp()))) === "denied");

  section("Employees");
  await signInAs("meera.krishnan@acme.test");
  for (const [k, page] of Object.entries(pages)) check(`An employee cannot open the ${k} dashboard`, (await render(() => page(sp()))) === "denied");
  report("Dashboards");
}

main().catch((e) => { console.error(e); process.exit(1); });
