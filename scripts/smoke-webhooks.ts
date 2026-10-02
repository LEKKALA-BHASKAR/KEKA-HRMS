/**
 * Webhooks and the read API: endpoints must be public https addresses;
 * events queue only for endpoints listening for them; deliveries are signed,
 * retried with backoff, failed after the last attempt and can be retried;
 * an endpoint that keeps failing is paused. API keys read the directory,
 * leave and payroll only within their scope and their company, and never see
 * pay or identity fields. Endpoints point at hooks.example.test and keys are
 * named "Smoke API"; both are removed at the end.
 */
import { createHmac } from "node:crypto";
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const svc = await import("../packages/services/src/index");
  const act = await import("../apps/web/src/app/actions/integrations");
  const empRoute = await import("../apps/web/src/app/api/v1/employees/route");
  const oneRoute = await import("../apps/web/src/app/api/v1/employees/[id]/route");
  const leaveRoute = await import("../apps/web/src/app/api/v1/leave/requests/route");
  const payRoute = await import("../apps/web/src/app/api/v1/payroll/runs/route");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const cleanup = async () => {
    await prisma.webhookEndpoint.deleteMany({ where: { tenantId: tenant.id, url: { contains: "hooks.example.test" } } });
    await prisma.apiKey.deleteMany({ where: { name: "Smoke API" } });
  };
  await cleanup();
  try {
    section("Endpoints");
    await signInAs("meera.krishnan@acme.test");
    let threw = false;
    try { await act.createWebhookAction({}, fd({ url: "https://hooks.example.test/x", events: "employee.created" })); } catch { threw = true; }
    check("An employee cannot add webhooks", threw);
    await signInAs("vikram.menon@acme.test");
    for (const [url, why] of [["http://hooks.example.test/x", "plain http"], ["https://localhost/x", "localhost"], ["https://10.1.2.3/x", "a private address"], ["https://169.254.169.254/latest", "the metadata address"], ["https://[::1]/x", "IPv6 loopback"]] as const) {
      const r = await act.createWebhookAction({}, fd({ url, events: "employee.created" }));
      check(`An endpoint at ${why} is refused`, r.ok === false, r.message);
    }
    const noEvents = await svc.createWebhook({ tenantId: tenant.id, url: "https://hooks.example.test/a", events: [], createdBy: null, resolve: false });
    check("An endpoint needs at least one event", noEvents.ok === false);
    const a = await svc.createWebhook({ tenantId: tenant.id, url: "https://hooks.example.test/a", events: ["employee.created", "leave.approved"], createdBy: null, resolve: false });
    const b = await svc.createWebhook({ tenantId: tenant.id, url: "https://hooks.example.test/b", events: ["payroll.finalized"], createdBy: null, resolve: false });
    check("A valid endpoint gets a one-time signing secret", a.ok && !!a.secret?.startsWith("whsec_"), a.message);

    section("Queueing and delivery");
    const n = await svc.emitEvent(tenant.id, "employee.created", { employeeId: "e1", employeeNumber: "SMK1" });
    check("An event queues only for endpoints listening for it", n === 1 && (await prisma.webhookDelivery.count({ where: { endpointId: b.id! } })) === 0);
    const seen: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const ok = await svc.deliverWebhooks({ resolve: false, send: async (url, init) => { seen.push({ url, ...init }); return { status: 204 }; } });
    const h = seen[0]?.headers ?? {};
    const expected = `sha256=${createHmac("sha256", a.secret!).update(`${h["X-Keka-Timestamp"]}.${seen[0]?.body}`).digest("hex")}`;
    check("The delivery is sent once, signed with the endpoint's secret", ok.sent === 1 && seen.length === 1 && h["X-Keka-Signature"] === expected && h["X-Keka-Event"] === "employee.created");
    check("The body carries the delivery id and the event data", JSON.parse(seen[0]!.body).id === h["X-Keka-Delivery"] && JSON.parse(seen[0]!.body).data.employeeNumber === "SMK1");
    const again = await svc.deliverWebhooks({ resolve: false, send: async () => { throw new Error("should not send"); } });
    check("A delivered event is not sent again", again.sent === 0 && again.failed === 0 && again.retrying === 0);

    await svc.emitEvent(tenant.id, "leave.approved", { requestId: "r1" });
    const t0 = new Date();
    const first = await svc.deliverWebhooks({ resolve: false, now: t0, send: async () => ({ status: 500 }) });
    const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: a.id!, event: "leave.approved" } });
    check("A failed attempt is retried later, not straight away", first.retrying === 1 && d.status === "PENDING" && d.nextAttemptAt.getTime() - t0.getTime() === 60_000 && d.error === "Responded 500");
    const early = await svc.deliverWebhooks({ resolve: false, now: new Date(t0.getTime() + 30_000), send: async () => ({ status: 200 }) });
    check("…and not before its retry time", early.sent === 0);
    let at = t0.getTime();
    for (let i = 1; i < svc.MAX_ATTEMPTS; i++) { at += 24 * 3_600_000; await svc.deliverWebhooks({ resolve: false, now: new Date(at), send: async () => ({ status: 503 }) }); }
    const dead = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } });
    check("After the last attempt the delivery is failed", dead.status === "FAILED" && dead.attempts === svc.MAX_ATTEMPTS, `${dead.status} ${dead.attempts}`);
    const retry = await act.retryDeliveryAction({}, fd({ id: d.id }));
    check("A failed delivery can be sent again", retry.ok && (await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).status === "PENDING", retry.message);
    await prisma.webhookEndpoint.update({ where: { id: a.id! }, data: { failureCount: svc.PAUSE_AFTER_FAILURES - 1 } });
    await svc.deliverWebhooks({ resolve: false, send: async () => ({ status: 500 }) });
    check("An endpoint that keeps failing is paused", (await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: a.id! } })).isActive === false);
    check("A paused endpoint gets no new events", (await svc.emitEvent(tenant.id, "employee.created", {})) === 0);
    const resumed = await act.webhookOpAction({}, fd({ id: a.id!, op: "resume" }));
    const ping = await act.webhookOpAction({}, fd({ id: a.id!, op: "ping" }));
    check("Resuming clears the failures and a test event can be sent", resumed.ok && ping.ok && (await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: a.id! } })).failureCount === 0, ping.message);

    section("Read API");
    const keyA = await svc.createApiKey({ tenantId: tenant.id, name: "Smoke API", scopes: ["employees:read"], createdBy: null });
    const keyB = await svc.createApiKey({ tenantId: tenant.id, name: "Smoke API", scopes: ["leave:read", "payroll:read"], createdBy: null });
    if (!keyA.ok || !keyB.ok) throw new Error("keys");
    const get = (url: string, key?: string) => new Request(`http://acme.localhost${url}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    check("No key, no data", (await empRoute.GET(get("/api/v1/employees"))).status === 401);
    check("A key without the scope is refused", (await empRoute.GET(get("/api/v1/employees", keyB.key))).status === 403);
    const p1 = await (await empRoute.GET(get("/api/v1/employees?limit=5", keyA.key))).json();
    const p2 = await (await empRoute.GET(get(`/api/v1/employees?limit=5&cursor=${p1.nextCursor}`, keyA.key))).json();
    check("The directory pages with a cursor, without repeats", p1.data.length === 5 && !!p1.nextCursor && p2.data.length > 0 && !p2.data.some((e: { id: string }) => p1.data.some((x: { id: string }) => x.id === e.id)));
    const fields = Object.keys(p1.data[0]);
    check("No pay, bank, identity or personal fields are exposed", !fields.some((f) => /ctc|salary|bank|pan|aadhaar|personal|mobile|dateOfBirth/i.test(f)), fields.join(","));
    const one = await (await oneRoute.GET(get("/api/v1/employees/ACM0009", keyA.key), { params: Promise.resolve({ id: "ACM0009" }) })).json();
    check("One employee can be read by employee number", one.data?.employeeNumber === "ACM0009");
    const other = await prisma.employee.findFirst({ where: { tenantId: { not: tenant.id } } });
    if (other) check("…but never another company's", (await oneRoute.GET(get(`/api/v1/employees/${other.id}`, keyA.key), { params: Promise.resolve({ id: other.id }) })).status === 404);
    const leave = await (await leaveRoute.GET(get("/api/v1/leave/requests?from=2026-01-01&to=2027-12-31", keyB.key))).json();
    check("Leave is listed without the reason", Array.isArray(leave.data) && leave.data.every((l: Record<string, unknown>) => !("reason" in l)));
    const bad = await leaveRoute.GET(get("/api/v1/leave/requests?from=yesterday", keyB.key));
    check("A malformed date is a 400", bad.status === 400);
    const runs = await (await payRoute.GET(get("/api/v1/payroll/runs", keyB.key))).json();
    check("Payroll runs are finalised totals only", Array.isArray(runs.data) && runs.data.every((r: Record<string, unknown>) => typeof r.netPay === "number" && !("lines" in r)));
  } finally {
    await cleanup();
  }
}

main().then(() => report("Webhooks and API")).catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
