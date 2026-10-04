/**
 * The platform admin panel: onboarding a company from nothing but its
 * subdomain and admin email, module switches, suspension, sign-in routed by
 * host, and the platform team's own login. Cleans up every company and
 * platform admin it creates.
 */
import { setTestSession, setTestHeaders, testCookie, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SUBS = ["bluecloud-smoke", "greenfield-smoke"];
const PLATFORM_EMAIL = "platform.smoke@boss-hr.test";
const ACTOR = { id: null, email: "smoke test" };

async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (err) {
    const d = (err as { digest?: string }).digest ?? "";
    if (!d.startsWith("NEXT_REDIRECT")) throw err;
    return d.split(";")[2] ?? "";
  }
}

async function cleanup() {
  await prisma.tenant.deleteMany({ where: { subdomain: { in: SUBS } } });
  await prisma.platformAuditLog.deleteMany({ where: { OR: [{ adminEmail: PLATFORM_EMAIL }, { adminEmail: ACTOR.email }] } });
  await prisma.platformAdmin.deleteMany({ where: { email: PLATFORM_EMAIL } });
}

async function main() {
  const tenants = await import("../apps/web/src/lib/platform/tenants");
  const admins = await import("../apps/web/src/lib/platform/admins");
  const auth = await import("../apps/web/src/app/actions/auth");
  const { viewerForUser } = await import("../apps/web/src/lib/context");
  const { buildNav, quickActions } = await import("../apps/web/src/lib/nav");
  const { subdomainFromHost } = await import("../apps/web/src/lib/tenant-host-shared");
  const { PERMISSIONS } = await import("@keka/rbac");
  process.env.APP_BASE_DOMAIN = "boss-hr.test";
  await cleanup();

  try {
    section("Subdomains");
    check("A full address is reduced to its subdomain", tenants.normaliseSubdomain("https://BlueCloud-Smoke.boss-hr.com/", "boss-hr.com") === "bluecloud-smoke");
    check("Reserved names are refused", !!tenants.subdomainProblem("www") && !!tenants.subdomainProblem("platform"));
    check("Bad characters are refused", !!tenants.subdomainProblem("blue_cloud") && !!tenants.subdomainProblem("-blue"));
    check("Host acme.boss-hr.com is company acme", subdomainFromHost("acme.boss-hr.com", "boss-hr.com") === "acme");
    check("The bare domain is no company", subdomainFromHost("boss-hr.com", "boss-hr.com") === null);
    check("A deeper host is no company", subdomainFromHost("a.b.boss-hr.com", "boss-hr.com") === null);
    check("Another site's host is no company", subdomainFromHost("acme.evil.com", "boss-hr.com") === null);
    check("Dev hosts like acme.localhost work", subdomainFromHost("acme.localhost:3100", "") === "acme");

    section("Onboarding a company");
    const made = await tenants.onboardCompany({
      name: "Blue Cloud Softech", subdomain: "https://bluecloud-smoke.boss-hr.test/", plan: "GROWTH",
      modules: ["payroll", "expenses", "assets", "helpdesk", "performance", "engage", "learn", "analytics"],
      admin: { firstName: "Asha", lastName: "Rao", email: "Asha.Rao@BlueCloud.test" },
    }, ACTOR);
    check("The company is created", made.ok, made.ok ? "" : made.message);
    if (!made.ok) return;
    check("…at the subdomain typed as a full address", made.subdomain === "bluecloud-smoke");
    check("…with the admin email lower-cased", made.adminEmail === "asha.rao@bluecloud.test");
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: made.tenantId } });
    check("Unticked modules are off (hire, projects)", t.disabledModules.includes("hire") && t.disabledModules.includes("projects") && !t.hasHire && !t.hasPsa);
    const roles = await prisma.role.count({ where: { tenantId: t.id } });
    check("All standard roles exist", roles >= 11, `${roles} roles`);
    const user = await prisma.user.findUniqueOrThrow({ where: { tenantId_email: { tenantId: t.id, email: made.adminEmail } }, include: { employee: true, roleAssignments: { include: { role: true } } } });
    check("The admin must change the temporary password", user.mustChangePassword);
    check("The admin holds Global Admin", user.roleAssignments.some((r) => r.role.key === "GLOBAL_ADMIN"));
    check("The admin has an employee record", !!user.employee && user.employee.status === "CONFIRMED");
    const dup = await tenants.onboardCompany({ name: "Copy", subdomain: "bluecloud-smoke", admin: { firstName: "A", lastName: "B", email: "a@b.test" } }, ACTOR);
    check("A taken subdomain is refused", !dup.ok);
    const reserved = await tenants.onboardCompany({ name: "Copy", subdomain: "admin", admin: { firstName: "A", lastName: "B", email: "a@b.test" } }, ACTOR);
    check("A reserved subdomain is refused", !reserved.ok);

    section("Signing in to the new company");
    setTestSession(null);
    setTestHeaders({ host: "bluecloud-smoke.boss-hr.test", "x-forwarded-for": "198.51.100.7" });
    const first = await redirectOf(() => auth.signIn({}, fd({ email: made.adminEmail, password: made.tempPassword })));
    check("The host alone picks the company; first sign-in asks for a new password", first === "/account/password?required=1", String(first));
    check("A session cookie is issued", !!testCookie("keka_session"));
    setTestSession(null);
    const codeIgnored = await redirectOf(() => auth.signIn({}, fd({ email: made.adminEmail, password: made.tempPassword, subdomain: "acme" })));
    check("A company code in the form cannot override the host", codeIgnored === "/account/password?required=1", String(codeIgnored));
    setTestHeaders({ host: "acme.boss-hr.test", "x-forwarded-for": "198.51.100.8" });
    setTestSession(null);
    const crossed = await auth.signIn({}, fd({ email: made.adminEmail, password: made.tempPassword }));
    check("Its admin cannot sign in at another company's address", !!crossed.error && !testCookie("keka_session"));
    setTestHeaders({ host: "boss-hr.test", "x-forwarded-for": "198.51.100.9" });
    const noCode = await auth.signIn({}, fd({ email: made.adminEmail, password: made.tempPassword }));
    check("On the bare domain a company code is required", noCode.error === "Enter your company code.");
    const viaCode = await redirectOf(() => auth.signIn({}, fd({ email: made.adminEmail, password: made.tempPassword, subdomain: "bluecloud-smoke" })));
    check("…and the company code works there", viaCode === "/account/password?required=1", String(viaCode));

    section("What the company admin can do");
    const v = await viewerForUser(user.id);
    check("The admin's view loads", !!v);
    if (v) {
      check("They can manage employees and roles", v.permissions.has(PERMISSIONS.EMPLOYEE_CREATE) && v.permissions.has(PERMISSIONS.ROLE_MANAGE));
      check("They can run payroll (module on)", v.permissions.has(PERMISSIONS.PAYROLL_RUN));
      check("They have no hiring permissions (module off)", ![...v.permissions].some((p) => p.startsWith("hire.")));
      check("They see no other company's employees", (await prisma.employee.count({ where: { tenantId: v.tenantId } })) === 1);
      const nav = buildNav(v, {} as never, { hasExit: false, managesProject: false });
      const links = nav.flatMap((sec) => [sec.href, ...sec.tabs.map((t) => t.href)]).concat(quickActions(v).map((q) => q.href));
      const leaked = links.filter((h) => h.startsWith("/hiring") || h.startsWith("/projects"));
      check("Navigation and shortcuts hide the hiring and projects modules", leaked.length === 0, leaked.join(" "));
    }
    const off = await tenants.updateCompany(t.id, { modules: ["expenses"] }, ACTOR);
    const v2 = await viewerForUser(user.id);
    check("Turning payroll off removes its permissions at once", off.ok && !!v2 && !v2.permissions.has(PERMISSIONS.PAYROLL_RUN));
    check("…without touching core HR", !!v2 && v2.permissions.has(PERMISSIONS.EMPLOYEE_CREATE));

    section("Suspension");
    const noReason = await tenants.setCompanyActive(t.id, false, "", ACTOR);
    check("Suspending needs a reason", !noReason.ok);
    await tenants.setCompanyActive(t.id, false, "Invoice overdue", ACTOR);
    check("A suspended company's sessions stop working", (await viewerForUser(user.id)) === null);
    setTestHeaders({ host: "bluecloud-smoke.boss-hr.test", "x-forwarded-for": "198.51.100.10" });
    const blocked = await auth.signIn({}, fd({ email: made.adminEmail, password: made.tempPassword }));
    check("…and nobody can sign in", !!blocked.error?.includes("suspended"));
    await tenants.setCompanyActive(t.id, true, null, ACTOR);
    check("Reactivating restores access", !!(await viewerForUser(user.id)));

    section("More admins and password resets");
    const added = await tenants.addCompanyAdmin(t.id, { firstName: "Ravi", lastName: "Kumar", email: "ravi@bluecloud.test" }, ACTOR);
    check("A second Global Admin can be added", added.ok);
    check("…and is listed", (await tenants.companyAdmins(t.id)).length === 2);
    const reset = await tenants.resetCompanyUserPassword(t.id, user.id, ACTOR);
    check("A company admin's password can be reset", reset.ok && reset.tempPassword !== made.tempPassword);
    const other = await prisma.user.findFirstOrThrow({ where: { email: "vikram.menon@acme.test" } });
    const cross = await tenants.resetCompanyUserPassword(t.id, other.id, ACTOR);
    check("…but not a user of another company through it", !cross.ok);

    section("Platform team login");
    const pa = await admins.upsertPlatformAdmin(PLATFORM_EMAIL, "Smoke Admin", ACTOR);
    check("A platform admin is created with a temporary password", pa.ok && pa.created);
    if (pa.ok) {
      const good = await admins.verifyPlatformLogin(PLATFORM_EMAIL, pa.tempPassword);
      check("They can sign in", good.ok && good.admin.mustChangePassword);
      check("A weak new password is refused", !!admins.platformPasswordProblem("password1"));
      for (let i = 0; i < 5; i++) await admins.verifyPlatformLogin(PLATFORM_EMAIL, "wrong");
      const locked = await admins.verifyPlatformLogin(PLATFORM_EMAIL, pa.tempPassword);
      check("Five wrong passwords lock the account", !locked.ok);
      const ghost = await admins.verifyPlatformLogin("nobody@boss-hr.test", "wrong");
      check("An unknown email gets the generic message", !ghost.ok && ghost.message.includes("not recognised"));
      const me = await prisma.platformAdmin.findUniqueOrThrow({ where: { email: PLATFORM_EMAIL } });
      const self = await admins.setPlatformAdminActive(me.id, false, { id: me.id, email: PLATFORM_EMAIL });
      check("Nobody can disable themselves", !self.ok);
    }
    check("Every change is in the platform activity log", (await prisma.platformAuditLog.count({ where: { tenantId: t.id } })) >= 5);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  report("Platform admin");
}

main().catch((e) => { console.error(e); process.exit(1); });
