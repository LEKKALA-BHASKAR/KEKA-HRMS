import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  BGV_CHECKS, BGV_PRIORITIES, bgvQueueScore, bgvSlaState, bgvConsentState, bgvVendorStats, bgvCostFor, joinSettings, BGV_ITEM_OPEN,
} from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Stat, Badge } from "@/components/ui";
import { Tabs, Table, Pill, SearchBar } from "@/components/gov-ui";
import { SpecForm } from "@/components/gov-forms";
import { fmtDay, pretty, opts, matches } from "@/lib/engage-depth";
import { OnboardingNav } from "../_join/nav";
import { saveBgvVendorAction, saveBgvPackageAction, startBgvCaseAction } from "@/app/actions/join-bgv";
import { saveJoinSettingsAction } from "@/app/actions/join-preboarding";

const P = PERMISSIONS;
const TABS = { queue: "Queue", dashboard: "Completion dashboard", vendors: "Vendors & comparison", packages: "Packages", settings: "Settings" };
const SLA_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = { ON_TRACK: "success", DUE_SOON: "warning", BREACHED: "danger", MET: "success", MISSED: "danger", NONE: "neutral" };

/** Background verification: the prioritised case queue, the completion dashboard, vendors (turnaround, SLA, cost) and packages. */
export default async function VerificationPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; status?: string }> }) {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const { tab: raw, q, status } = await searchParams;
  const tab = raw && raw in TABS ? raw : "queue";
  const scope = scopedEmployeeWhere(viewer, P.BGV_MANAGE);
  const now = new Date();
  const [cases, vendors, packages, candidates, users] = await Promise.all([
    prisma.bgvCheck.findMany({ where: { tenantId: viewer.tenantId, employee: scope }, include: { items: true, employee: { select: { id: true, displayName: true, employeeNumber: true, dateOfJoining: true, status: true } } }, orderBy: { initiatedAt: "desc" } }),
    prisma.bgvVendor.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } }),
    prisma.bgvPackage.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { AND: [scope, { status: { in: ["PREBOARDING", "ONBOARDING", "PROBATION"] } }] }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" } }),
    prisma.user.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, email: true } }),
  ]);
  const email = new Map(users.map((u) => [u.id, u.email]));
  const open = cases.filter((c) => ["INITIATED", "IN_PROGRESS"].includes(c.status));
  return (
    <>
      <PageHead title="Background verification" subtitle="Cases, checks, vendors and packages. Vendor integrations are not connected — stages are tracked by hand."
        actions={<><a className="btn" href="/onboarding/export?kind=bgv">Cases CSV</a><a className="btn" href="/onboarding/export?kind=bgv-checks">Checks CSV</a></>} />
      <OnboardingNav viewer={viewer} active="verification" />
      <Tabs base="/onboarding/verification" tabs={TABS} active={tab} />
      {tab === "queue" ? (() => {
        const rows = (status === "closed" ? cases.filter((c) => !open.includes(c)) : open)
          .filter((c) => matches(q, c.employee?.displayName, c.employee?.employeeNumber, c.vendor))
          .map((c) => ({ c, score: bgvQueueScore({ priority: c.priority, slaDueAt: c.slaDueAt, joiningDate: c.employee?.status === "PREBOARDING" ? c.employee.dateOfJoining : null }, now) }))
          .sort((a, b) => a.score - b.score);
        return (
          <div className="stack gap-4">
            <Card title="Open a case" description="A package brings its checks, vendor and SLA; add more checks as needed. The candidate is asked for consent.">
              <SpecForm action={startBgvCaseAction} submitLabel="Open case" fields={[
                { name: "employeeId", label: "Employee", type: "select", required: true, options: candidates.map((e) => ({ value: e.id, label: `${e.employeeNumber} · ${e.displayName}` })) },
                { name: "packageId", label: "Package", type: "select", options: packages.filter((p) => p.isActive).map((p) => ({ value: p.id, label: p.name })), placeholder: "None" },
                { name: "vendorId", label: "Vendor", type: "select", options: vendors.filter((v) => v.isActive).map((v) => ({ value: v.id, label: v.name })), placeholder: "Package default / in-house" },
                { name: "priority", label: "Priority", type: "select", options: opts(BGV_PRIORITIES), defaultValue: "NORMAL" },
                { name: "slaDays", label: "SLA (days)", type: "number", hint: "Defaults from the package, vendor or settings" },
                { name: "checks", label: "Checks", type: "multiselect", options: opts(BGV_CHECKS) },
              ]} />
            </Card>
            <Card tight title={`${status === "closed" ? "Closed" : "Open"} cases (${rows.length})`} description="Ordered by priority, then the nearest SLA or joining date">
              <div style={{ padding: "12px 16px 0" }}>
                <SearchBar action="/onboarding/verification" tab="queue" q={q}>
                  <select className="select" name="status" defaultValue={status ?? ""} style={{ width: 140 }}><option value="">Open</option><option value="closed">Closed</option></select>
                </SearchBar>
              </div>
              <Table head={["Employee", "Priority", "Checks", "SLA", "Consent", "Assignee", "Status", ""]} empty={!rows.length}>
                {rows.map(({ c }) => {
                  const sla = bgvSlaState(c.slaDueAt, c.completedAt, now);
                  const cur = c.items.filter((i) => !c.items.some((n) => n.recheckOfId === i.id));
                  return (
                    <tr key={c.id}>
                      <td className="text-sm"><strong>{c.employee?.displayName}</strong><div className="text-xs subtle">{c.employee?.employeeNumber}{c.employee?.status === "PREBOARDING" ? ` · joins ${fmtDay(c.employee.dateOfJoining)}` : ""}</div></td>
                      <td><Badge tone={c.priority === "URGENT" ? "danger" : c.priority === "HIGH" ? "warning" : "neutral"}>{pretty(c.priority)}</Badge>{c.escalationLevel ? <div className="text-xs neg">escalated L{c.escalationLevel}</div> : null}</td>
                      <td className="text-xs">{cur.length ? `${cur.filter((i) => !BGV_ITEM_OPEN.includes(i.status)).length}/${cur.length} done` : (Array.isArray(c.checkTypes) ? (c.checkTypes as string[]).join(", ").toLowerCase() : "")}{cur.some((i) => i.status === "PENDING_REVIEW") ? <div className="neg">review pending</div> : null}</td>
                      <td><Badge tone={SLA_TONE[sla]}>{pretty(sla)}</Badge><div className="text-xs subtle">{fmtDay(c.slaDueAt)}</div></td>
                      <td className="text-xs">{pretty(bgvConsentState(c, now))}</td>
                      <td className="text-xs">{c.assigneeUserId ? email.get(c.assigneeUserId) : "—"}</td>
                      <td><Pill s={c.proposedStatus ? "PENDING_APPROVAL" : c.status} /></td>
                      <td className="right"><Link className="btn sm" href={`/onboarding/verification/${c.id}`}>Open</Link></td>
                    </tr>
                  );
                })}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "dashboard" ? (() => {
        const closed = cases.filter((c) => c.completedAt && c.status !== "CANCELLED");
        const byType = BGV_CHECKS.map((t) => {
          const items = cases.flatMap((c) => c.items.filter((i) => i.checkType === t && !c.items.some((n) => n.recheckOfId === i.id)));
          return { t, total: items.length, open: items.filter((i) => BGV_ITEM_OPEN.includes(i.status)).length, verified: items.filter((i) => i.status === "VERIFIED").length, adverse: items.filter((i) => ["DISCREPANCY", "FAILED", "UNABLE_TO_VERIFY"].includes(i.status)).length };
        });
        const breached = open.filter((c) => bgvSlaState(c.slaDueAt, null, now) === "BREACHED").length;
        return (
          <div className="stack gap-4">
            <div className="grid grid-4">
              <Stat label="Open cases" value={open.length} />
              <Stat label="SLA breached" value={breached} tone={breached ? "neg" : undefined} />
              <Stat label="Completed" value={closed.length} meta={`${closed.filter((c) => c.status === "CLEAR").length} clear`} />
              <Stat label="Adverse results" value={closed.filter((c) => ["DISCREPANCY", "FAILED"].includes(c.status)).length} />
            </div>
            <Card tight title="By check type">
              <Table head={["Check", "Total", "Open", "Verified", "Adverse"]}>
                {byType.map((r) => <tr key={r.t}><td className="text-sm">{pretty(r.t)}</td><td className="num">{r.total}</td><td className="num">{r.open}</td><td className="num">{r.verified}</td><td className={`num ${r.adverse ? "neg" : ""}`}>{r.adverse}</td></tr>)}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "vendors" ? (() => {
        const rates = new Map(vendors.map((v) => [v.id, v.costPerCheck]));
        const stats = bgvVendorStats(cases.map((c) => ({ vendor: c.vendor ?? "", initiatedAt: c.initiatedAt, completedAt: c.completedAt, slaDueAt: c.slaDueAt, status: c.status, cost: c.items.some((i) => i.cost !== null) ? c.items.reduce((s, i) => s + Number(i.cost ?? 0), 0) : bgvCostFor(c.vendorId ? rates.get(c.vendorId) : null, c.items.map((i) => i.checkType)) })));
        return (
          <div className="stack gap-4">
            <Card tight title="Vendor comparison" description="Turnaround, SLA adherence, adverse rate and cost" action={<a className="btn sm" href="/onboarding/export?kind=bgv-vendors">CSV</a>}>
              <Table head={["Vendor", "Cases", "Completed", "Avg turnaround", "SLA met", "Adverse", "Total cost", "Per case"]} empty={!stats.length}>
                {stats.map((s) => <tr key={s.vendor}><td className="text-sm strong">{s.vendor}</td><td className="num">{s.cases}</td><td className="num">{s.completed}</td><td className="num">{s.avgTatDays ?? "—"} d</td><td className="num">{s.slaMetPct ?? "—"}%</td><td className="num">{s.adversePct}%</td><td className="num">₹{s.totalCost.toLocaleString("en-IN")}</td><td className="num">₹{s.costPerCase.toLocaleString("en-IN")}</td></tr>)}
              </Table>
            </Card>
            {[...vendors, null].map((v) => (
              <Card key={v?.id ?? "new"} title={v ? v.name : "Add a vendor"} description={v ? `${v.slaDays}-day turnaround · stages: ${v.stages.join(" → ") || "none"}` : "Each vendor has its own stages (its workflow) and rates per check."}>
                <SpecForm action={saveBgvVendorAction} hidden={v ? { id: v.id } : undefined} submitLabel={v ? "Save vendor" : "Add vendor"} columns={3} fields={[
                  { name: "name", label: "Name", required: true, defaultValue: v?.name },
                  { name: "contactEmail", label: "Contact email", type: "email", defaultValue: v?.contactEmail },
                  { name: "slaDays", label: "Turnaround (days)", type: "number", defaultValue: v?.slaDays ?? 7 },
                  { name: "stages", label: "Stages (comma separated)", defaultValue: v?.stages.join(", "), placeholder: "Documents received, Field visit, Report", wide: true },
                  { name: "checkTypes", label: "Checks offered", type: "multiselect", options: opts(BGV_CHECKS), defaultValue: v?.checkTypes ?? [], wide: true },
                  ...BGV_CHECKS.map((c) => ({ name: `cost_${c}`, label: `₹ ${pretty(c).toLowerCase()}`, type: "number" as const, defaultValue: v && v.costPerCheck && typeof v.costPerCheck === "object" ? ((v.costPerCheck as Record<string, number>)[c] ?? null) : null })),
                  ...(v ? [{ name: "isActive", label: "Status", type: "select" as const, options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }], defaultValue: v.isActive ? "true" : "false" }] : []),
                ]} />
              </Card>
            ))}
          </div>
        );
      })() : null}
      {tab === "packages" ? (
        <div className="grid grid-2">
          {[...packages, null].map((p) => (
            <Card key={p?.id ?? "new"} title={p ? p.name : "New package"} description={p ? `${p.checkTypes.map((c) => pretty(c)).join(", ")}${p.isActive ? "" : " · inactive"}` : "A reusable set of checks with a default vendor and SLA."}>
              <SpecForm action={saveBgvPackageAction} hidden={p ? { id: p.id } : undefined} submitLabel={p ? "Save" : "Create"} fields={[
                { name: "name", label: "Name", required: true, defaultValue: p?.name },
                { name: "vendorId", label: "Vendor", type: "select", options: vendors.map((v) => ({ value: v.id, label: v.name })), placeholder: "None", defaultValue: p?.vendorId },
                { name: "slaDays", label: "SLA (days)", type: "number", defaultValue: p?.slaDays },
                { name: "description", label: "Description", defaultValue: p?.description },
                { name: "checkTypes", label: "Checks", type: "multiselect", options: opts(BGV_CHECKS), defaultValue: p?.checkTypes ?? [], wide: true },
                ...(p ? [{ name: "isActive", label: "Status", type: "select" as const, options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }], defaultValue: p.isActive ? "true" : "false" }] : []),
              ]} />
            </Card>
          ))}
        </div>
      ) : null}
      {tab === "settings" ? <Settings tenantId={viewer.tenantId} /> : null}
    </>
  );
}

async function Settings({ tenantId }: { tenantId: string }) {
  const s = await joinSettings(tenantId);
  return (
    <Card title="Verification settings">
      <SpecForm action={saveJoinSettingsAction} hidden={{ scope: "bgv" }} fields={[
        { name: "bgvDefaultSlaDays", label: "Default SLA (days)", type: "number", defaultValue: s.bgvDefaultSlaDays },
        { name: "bgvConsentValidDays", label: "Consent valid for (days)", type: "number", defaultValue: s.bgvConsentValidDays },
      ]} />
    </Card>
  );
}
