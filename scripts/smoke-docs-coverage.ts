/**
 * Coverage for flows that already worked but had no test: the Documents
 * pages (every tab, letter and template lists with search, a letter and a
 * template page), document verification and policy acknowledgement (with
 * their audit entries), and the approve / reject step of an employee's asset
 * request. Everything created is removed afterwards.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import Module from "node:module";
import type { ReactElement, ReactNode } from "react";

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
type Page = (props: { searchParams: Promise<SP>; params: Promise<Record<string, string>> }) => Promise<unknown>;

async function main() {
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { SearchParamsContext, PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const noop = () => {};
  const router = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop, hmrRefresh: noop };
  async function resolve(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) return Promise.all(node.map(resolve));
    if (!React.isValidElement(node)) return node;
    const el = node as ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolve(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el.props ?? {})) if (k !== "children") props[k] = React.isValidElement(v) || Array.isArray(v) ? await resolve(v) : v;
    const children = el.props?.children;
    return Array.isArray(children) ? React.cloneElement(el, props, ...((await resolve(children)) as ReactNode[])) : React.cloneElement(el, props, (await resolve(children)) as ReactNode);
  }
  async function render(page: Page, url: string, params: Record<string, string> = {}): Promise<string> {
    const u = new URL(url, "http://acme.test");
    try {
      const tree = (await resolve(await page({ searchParams: Promise.resolve(Object.fromEntries(u.searchParams.entries())), params: Promise.resolve(params) }))) as ReactNode;
      return renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(PathnameContext.Provider, { value: u.pathname },
          React.createElement(SearchParamsContext.Provider, { value: u.searchParams as never }, tree))));
    } catch (err) {
      const e = err as { digest?: string; message?: string };
      const d = `${e.digest ?? ""} ${e.message ?? ""}`;
      const r = /NEXT_REDIRECT;[a-z]+;([^;]+);/.exec(d);
      if (r) return `redirect:${r[1]}`;
      if (/HTTP_ERROR_FALLBACK;404/.test(d)) return "404";
      if (/HTTP_ERROR_FALLBACK;403/.test(d)) return "403";
      throw err;
    }
  }
  const ok = (h: string) => !/^(redirect:|404$|403$)/.test(h);

  const LT = await import("../apps/web/src/app/actions/letters");
  const WP = await import("../apps/web/src/app/actions/workplace");
  const AS = await import("../apps/web/src/app/actions/assets");
  const load = async (p: string) => (await import(`../apps/web/src/app/(app)/${p}/page`)).default as Page;
  const pages = { documents: await load("documents"), letter: await load("documents/letters/[id]"), template: await load("documents/templates/[id]") };

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const tenantId = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { email, tenantId }, include: { employee: true } });
  const [admin, hr, meera] = await Promise.all([user("vikram.menon@acme.test"), user("priya.sharma@acme.test"), user("meera.krishnan@acme.test")]);
  const started = new Date();
  const tag = `DC${String(Date.now()).slice(-6)}`;
  const made = { letters: [] as string[], folders: [] as string[], requests: [] as string[], ack: null as string | null };

  console.log("\nDocuments coverage\n" + "=".repeat(72));
  try {
    // -------------------------------------------------------------------------
    section("Documents pages and list search");
    const experience = await prisma.documentTemplate.findFirstOrThrow({ where: { tenantId, name: "Experience Letter" } });
    await signInAs(hr.email);
    for (const t of ["pending", "expiring", "policies", "letters", "templates", "mine"]) check(`Documents tab ${t} renders for HR`, ok(await render(pages.documents, `/documents?tab=${t}`)));
    const gen = await LT.generateLetterAction({}, fd({ employeeId: meera.employee!.id, templateId: experience.id }));
    check("HR generates a letter", gen.ok === true, gen.message);
    const letter = await prisma.generatedDocument.findFirstOrThrow({ where: { employeeId: meera.employee!.id, templateId: experience.id, issuedOn: { gte: new Date(started.getTime() - 60_000) } }, orderBy: { issuedOn: "desc" } });
    made.letters.push(letter.id);
    const letters = await render(pages.documents, "/documents?tab=letters&q=Meera");
    check("Letter search by employee name finds the letter", letters.includes(`/documents/letters/${letter.id}`));
    const none = await render(pages.documents, `/documents?tab=letters&q=${tag}nomatch`);
    check("…and a search with no match shows none", !none.includes(`/documents/letters/${letter.id}`) && none.includes("Letters (0)"));
    const tpls = await render(pages.documents, "/documents?tab=templates&q=experience");
    check("Template search filters the list", tpls.includes("Experience Letter") && !tpls.includes("Offer Letter"));
    check("A letter page renders", ok(await render(pages.letter, `/documents/letters/${letter.id}`, { id: letter.id })));
    const tplPage = await render(pages.template, `/documents/templates/${experience.id}`, { id: experience.id });
    check("A template page renders with its owner and revisions", ok(tplPage) && tplPage.includes("Ownership and approval") && tplPage.includes("Revisions"));
    check("The new-template page renders", ok(await render(pages.template, "/documents/templates/new", { id: "new" })));
    check("An unknown template is not found", (await render(pages.template, "/documents/templates/nope", { id: "nope" })) === "404");
    await signInAs(meera.email);
    const mine = await render(pages.documents, "/documents?tab=mine");
    check("The employee's own tab renders", ok(mine));
    check("…and the HR-only letters list stays hidden", !(await render(pages.documents, "/documents?tab=letters")).includes(`/documents/letters/${letter.id}`));
    const denied = await render(pages.template, `/documents/templates/${experience.id}`, { id: experience.id });
    check("An employee cannot open the template editor", denied === "403", denied.slice(0, 40));

    // -------------------------------------------------------------------------
    section("Document verification and policy acknowledgement");
    const folder = await prisma.documentFolder.create({ data: { tenantId, name: `${tag} Folder` } });
    made.folders.push(folder.id);
    const type = await prisma.documentType.create({ data: { folderId: folder.id, name: `${tag} Address proof` } });
    const pending = await prisma.employeeDocument.create({ data: { tenantId, employeeId: meera.employee!.id, folderId: folder.id, documentTypeId: type.id, name: type.name, status: "PENDING_VERIFICATION", fileUrl: "/files/none", uploadedAt: new Date() } });
    const rejected = await prisma.employeeDocument.create({ data: { tenantId, employeeId: meera.employee!.id, folderId: folder.id, documentTypeId: type.id, name: `${type.name} 2`, status: "PENDING_VERIFICATION", fileUrl: "/files/none", uploadedAt: new Date() } });
    await signInAs(meera.email);
    let threw = false;
    try { await WP.verifyDocument(fd({ id: pending.id, decision: "approve" })); } catch { threw = true; }
    check("An employee cannot verify documents", threw);
    await signInAs(hr.email);
    check("HR sees it in the verification queue", (await render(pages.documents, "/documents?tab=pending")).includes(type.name));
    threw = false;
    try { await WP.verifyDocument(fd({ id: rejected.id, decision: "reject" })); } catch { threw = true; }
    check("Rejecting needs a reason", threw);
    await WP.verifyDocument(fd({ id: pending.id, decision: "approve" }));
    check("HR verifies a document", (await prisma.employeeDocument.findUniqueOrThrow({ where: { id: pending.id } })).status === "VERIFIED");
    check("…and the verification is audited", !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "EmployeeDocument", entityId: pending.id, action: "APPROVE" } })));
    await WP.verifyDocument(fd({ id: rejected.id, decision: "reject", reason: "Blurred scan" }));
    const rej = await prisma.employeeDocument.findUniqueOrThrow({ where: { id: rejected.id } });
    check("HR rejects one with a reason", rej.status === "REJECTED" && rej.rejectReason === "Blurred scan");
    check("…also audited", !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "EmployeeDocument", entityId: rejected.id, action: "REJECT" } })));
    const policy = await prisma.orgDocument.findFirst({ where: { tenantId } });
    if (policy) {
      const had = await prisma.orgDocumentAck.findUnique({ where: { documentId_employeeId: { documentId: policy.id, employeeId: meera.employee!.id } } });
      await signInAs(meera.email);
      await WP.acknowledgeOrgDocument(fd({ documentId: policy.id }));
      const ack = await prisma.orgDocumentAck.findUniqueOrThrow({ where: { documentId_employeeId: { documentId: policy.id, employeeId: meera.employee!.id } } });
      if (!had) made.ack = ack.id;
      check("An employee acknowledges a policy", !!ack);
      check("…and the acknowledgement is audited", !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "OrgDocument", entityId: policy.id, createdAt: { gte: started } } })));
    } else check("A seeded policy exists to acknowledge", false);

    // -------------------------------------------------------------------------
    section("Asset requests · approve and reject");
    await signInAs(meera.email);
    const r1 = await AS.requestAssetAction({}, fd({ requestType: "NEW_ASSET", title: `${tag} Monitor`, reason: "Second screen for spreadsheets" }));
    const r2 = await AS.requestAssetAction({}, fd({ requestType: "NEW_ASSET", title: `${tag} Headset`, reason: "Calls with customers" }));
    check("An employee raises two asset requests", r1.ok === true && r2.ok === true, `${r1.message} ${r2.message}`);
    const [req1, req2] = await Promise.all([
      prisma.assetRequest.findFirstOrThrow({ where: { tenantId, title: `${tag} Monitor` } }),
      prisma.assetRequest.findFirstOrThrow({ where: { tenantId, title: `${tag} Headset` } }),
    ]);
    made.requests.push(req1.id, req2.id);
    check("An employee cannot decide their own request", (await AS.decideAssetRequestAction({}, fd({ requestId: req1.id, decision: "approve" }))).ok === false);
    await signInAs(admin.email);
    check("Rejecting needs a reason", (await AS.decideAssetRequestAction({}, fd({ requestId: req2.id, decision: "reject" }))).ok === false);
    check("An asset manager rejects with a reason", (await AS.decideAssetRequestAction({}, fd({ requestId: req2.id, decision: "reject", note: "Use the shared pool headsets" }))).ok === true);
    const rq2 = await prisma.assetRequest.findUniqueOrThrow({ where: { id: req2.id } });
    check("…the request is rejected with the reason", rq2.status === "REJECTED" && rq2.rejectReason === "Use the shared pool headsets");
    check("…and audited as a rejection", !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "AssetRequest", entityId: req2.id, action: "REJECT" } })));
    const ap = await AS.decideAssetRequestAction({}, fd({ requestId: req1.id, decision: "approve" }));
    check("An asset manager approves the other", ap.ok === true, ap.message);
    let rq1 = await prisma.assetRequest.findUniqueOrThrow({ where: { id: req1.id } });
    for (let i = 0; i < 4 && rq1.status === "PENDING"; i++) { await AS.decideAssetRequestAction({}, fd({ requestId: req1.id, decision: "approve" })); rq1 = await prisma.assetRequest.findUniqueOrThrow({ where: { id: req1.id } }); }
    check("…the request ends approved", rq1.status === "APPROVED", rq1.status);
    check("…and audited as an approval", !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "AssetRequest", entityId: req1.id, action: "APPROVE" } })));
    check("A decided request cannot be decided again", (await AS.decideAssetRequestAction({}, fd({ requestId: req2.id, decision: "approve" }))).ok === false);
  } finally {
    await prisma.generatedDocument.deleteMany({ where: { id: { in: made.letters } } });
    await prisma.employeeDocument.deleteMany({ where: { folderId: { in: made.folders } } });
    await prisma.documentFolder.deleteMany({ where: { id: { in: made.folders } } });
    if (made.ack) await prisma.orgDocumentAck.deleteMany({ where: { id: made.ack } });
    await prisma.assetRequest.deleteMany({ where: { id: { in: made.requests } } });
    await prisma.notification.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.$disconnect();
  }
  report("Documents coverage");
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
