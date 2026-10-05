import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { CHANGE_TARGETS, CALENDAR_SETS, fiscalYearOn, suggestFiscalYear } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout, KeyValue } from "@/components/ui";
import { SpecForm, ActionButton, type FieldSpec } from "@/components/spec-form";
import {
  saveCompanyProfileAction, saveFiscalYearAction, deleteFiscalYearAction, saveWorkingRulesAction, saveChangeApprovalSettingAction,
} from "@/app/actions/core-hr-depth";

export const metadata = { title: "Company setup — BooS-HR" };

const P = PERMISSIONS;
const TABS = { profile: "Company profile", years: "Fiscal years", rules: "Working rules", approvals: "Change approval" } as const;
type Tab = keyof typeof TABS;
const DAYS = [["MON", "Mon"], ["TUE", "Tue"], ["WED", "Wed"], ["THU", "Thu"], ["FRI", "Fri"], ["SAT", "Sat"], ["SUN", "Sun"]] as const;
const SET_LABEL: Record<string, string> = { STATUTORY: "Statutory (tax & payroll)", REPORTING: "Reporting", LEAVE: "Leave year", PERFORMANCE: "Performance cycle" };
const propose: FieldSpec = { name: "propose", label: "Send for a second administrator's approval instead of saving now", kind: "checkbox", wide: true };
const reason: FieldSpec = { name: "reason", label: "Reason (shown to the approver)", wide: true };

/**
 * Settings › Company: the company profile, fiscal years for each calendar
 * set, working rules, and which configuration changes need a second
 * administrator's approval before they take effect.
 */
export default async function CompanySetupPage({ searchParams }: { searchParams: Promise<{ tab?: string; edit?: string }> }) {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const sp = await searchParams;
  const tab = (sp.tab && sp.tab in TABS ? sp.tab : "profile") as Tab;
  const t = viewer.tenantId;
  const pending = await prisma.recordChangeRequest.count({ where: { tenantId: t, category: "CONFIG", status: { in: ["PENDING", "SCHEDULED"] } } });
  return (
    <>
      <PageHead title="Company setup" subtitle="Who the company is, its years, and how a working week runs"
        actions={<><Link className="btn" href="/admin/setup">Setup health &amp; configuration</Link><a className="btn" href="/exports/core2/company-profile">Export profile</a><a className="btn" href="/exports/core2/working-rules">Export working rules</a><a className="btn" href="/exports/core2/settings">Export settings</a><Link className="btn" href="/admin/settings">All settings</Link><Link className="btn" href="/admin/change-requests?category=CONFIG">Pending changes{pending ? ` (${pending})` : ""}</Link></>} />
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((k) => <Link key={k} href={`/admin/company?tab=${k}`} className={`tab${tab === k ? " active" : ""}`}>{TABS[k]}</Link>)}
      </div>
      {tab === "profile" ? <Profile tenantId={t} /> : null}
      {tab === "years" ? <Years tenantId={t} edit={sp.edit} /> : null}
      {tab === "rules" ? <Rules tenantId={t} /> : null}
      {tab === "approvals" ? <Approvals tenantId={t} /> : null}
    </>
  );
}

async function Profile({ tenantId }: { tenantId: string }) {
  const [p, tenant] = await Promise.all([
    prisma.companyProfile.findUnique({ where: { tenantId } }),
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, subdomain: true } }),
  ]);
  const fields: FieldSpec[] = [
    { name: "legalName", label: "Registered (legal) name", defaultValue: p?.legalName ?? tenant.name },
    { name: "brandName", label: "Brand name", defaultValue: p?.brandName },
    { name: "industry", label: "Industry", defaultValue: p?.industry },
    { name: "foundedYear", label: "Founded", kind: "number", defaultValue: p?.foundedYear, step: "1" },
    { name: "website", label: "Website", defaultValue: p?.website, placeholder: "https://" },
    { name: "email", label: "Contact email", kind: "email", defaultValue: p?.email },
    { name: "phone", label: "Phone", defaultValue: p?.phone },
    { name: "brandColor", label: "Brand colour", kind: "color", defaultValue: p?.brandColor ?? "#1266a8" },
    { name: "addressLine1", label: "Head office address", defaultValue: p?.addressLine1, wide: true },
    { name: "addressLine2", label: "Address line 2", defaultValue: p?.addressLine2, wide: true },
    { name: "city", label: "City", defaultValue: p?.city },
    { name: "state", label: "State", defaultValue: p?.state },
    { name: "postalCode", label: "PIN code", defaultValue: p?.postalCode },
    { name: "locale", label: "Language & number format", kind: "select", required: true, defaultValue: p?.locale ?? "en-IN", options: [{ value: "en-IN", label: "English (India)" }, { value: "en-GB", label: "English (UK)" }, { value: "en-US", label: "English (US)" }] },
    { name: "dateFormat", label: "Date format", kind: "select", required: true, defaultValue: p?.dateFormat ?? "DD/MM/YYYY", options: ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD MMM YYYY"].map((v) => ({ value: v, label: v })) },
    { name: "about", label: "About the company", kind: "textarea", defaultValue: p?.about },
    propose, reason,
  ];
  return (
    <div className="grid grid-2" style={{ alignItems: "start", gridTemplateColumns: "2fr 1fr" }}>
      <Card title="Company profile" description="Shown on letters, ID cards and the directory.">
        <SpecForm action={saveCompanyProfileAction} fields={fields} submitLabel="Save profile" />
      </Card>
      <Card title="On record">
        {p ? (
          <KeyValue items={[
            ["Legal name", p.legalName ?? "—"], ["Brand", p.brandName ?? "—"], ["Industry", p.industry ?? "—"],
            ["Head office", [p.addressLine1, p.city, p.state, p.postalCode].filter(Boolean).join(", ") || "—"],
            ["Brand colour", <span key="c" className="row gap-1"><span style={{ width: 14, height: 14, borderRadius: 3, background: p.brandColor, display: "inline-block" }} />{p.brandColor}</span>],
            ["Company URL", `${tenant.subdomain}`], ["Last changed", formatDate(p.updatedAt)],
          ]} />
        ) : <Empty title="No profile saved yet" />}
      </Card>
    </div>
  );
}

async function Years({ tenantId, edit }: { tenantId: string; edit?: string }) {
  const [years, tenant] = await Promise.all([
    prisma.fiscalYear.findMany({ where: { tenantId }, orderBy: [{ calendarSet: "asc" }, { startDate: "desc" }] }),
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { fyStartMonth: true } }),
  ]);
  const cur = edit ? years.find((y) => y.id === edit) : undefined;
  const next = suggestFiscalYear(tenant.fyStartMonth ?? 4, new Date().getUTCFullYear());
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const fields: FieldSpec[] = [
    { name: "name", label: "Name", required: true, defaultValue: cur?.name ?? next.name, placeholder: "FY 2026-27" },
    { name: "calendarSet", label: "Calendar set", kind: "select", required: true, defaultValue: cur?.calendarSet ?? "STATUTORY", options: CALENDAR_SETS.map((c) => ({ value: c, label: SET_LABEL[c] ?? c })) },
    { name: "startDate", label: "Starts", kind: "date", required: true, defaultValue: iso(cur?.startDate ?? next.startDate) },
    { name: "endDate", label: "Ends", kind: "date", required: true, defaultValue: iso(cur?.endDate ?? next.endDate) },
    { name: "status", label: "Status", kind: "select", required: true, defaultValue: cur?.status ?? "OPEN", options: [{ value: "OPEN", label: "Open" }, { value: "CLOSED", label: "Closed (locked)" }] },
    { name: "isCurrent", label: "This is the current year for its set", kind: "checkbox", defaultChecked: cur?.isCurrent ?? false },
    { name: "note", label: "Note", wide: true, defaultValue: cur?.note },
    propose, reason,
  ];
  const today = new Date();
  return (
    <div className="stack gap-4">
      <Card title={cur ? `Edit ${cur.name}` : "Add a fiscal year"} description={`Years in one calendar set cannot overlap. The company's statutory year starts in month ${tenant.fyStartMonth ?? 4}.`}>
        <SpecForm action={saveFiscalYearAction} hidden={cur ? { id: cur.id } : undefined} fields={fields} submitLabel={cur ? "Save" : "Add year"} />
        {cur ? <Link className="btn ghost sm" href="/admin/company?tab=years">Done editing</Link> : null}
      </Card>
      <Card title="Fiscal years" tight action={<Link className="btn sm" href="/exports/core-hr/fiscal-years">Export CSV</Link>}>
        {years.length === 0 ? <Empty title="No fiscal years yet">Add the statutory year first; leave and performance can follow their own.</Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Year</th><th>Calendar set</th><th>From</th><th>To</th><th>Status</th><th /></tr></thead>
            <tbody>{years.map((y) => {
              const running = fiscalYearOn(years.filter((x) => x.calendarSet === y.calendarSet), today)?.id === y.id;
              return (
                <tr key={y.id}><td className="strong">{y.name} {y.isCurrent ? <Badge tone="brand">Current</Badge> : null}</td><td>{SET_LABEL[y.calendarSet] ?? y.calendarSet}</td>
                  <td>{formatDate(y.startDate)}</td><td>{formatDate(y.endDate)}</td>
                  <td>{y.status === "CLOSED" ? <Badge>Closed</Badge> : running ? <Badge tone="success">Running today</Badge> : <Badge tone="info">Open</Badge>}</td>
                  <td className="right"><div className="row gap-1" style={{ justifyContent: "flex-end" }}><Link className="btn sm" href={`/admin/company?tab=years&edit=${y.id}`}>Edit</Link>{!y.isCurrent && y.status !== "CLOSED" ? <ActionButton action={deleteFiscalYearAction} hidden={{ id: y.id }} label="Delete" confirm={`Delete ${y.name}?`} /> : null}</div></td></tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

async function Rules({ tenantId }: { tenantId: string }) {
  const r = await prisma.workingRules.findUnique({ where: { tenantId } });
  const n = (v: unknown, d: number) => (v == null ? d : Number(v));
  const fields: FieldSpec[] = [
    { name: "workDays", label: "Working days", kind: "checks", options: DAYS.map(([v, l]) => ({ value: v, label: l })), defaultValues: r?.workDays ?? ["MON", "TUE", "WED", "THU", "FRI"], wide: true },
    { name: "weekStartsOn", label: "Week starts on", kind: "select", required: true, defaultValue: r?.weekStartsOn ?? "MON", options: DAYS.map(([v, l]) => ({ value: v, label: l })) },
    { name: "standardHoursPerDay", label: "Standard hours a day", kind: "number", required: true, defaultValue: n(r?.standardHoursPerDay, 8) },
    { name: "standardHoursPerWeek", label: "Standard hours a week", kind: "number", required: true, defaultValue: n(r?.standardHoursPerWeek, 40) },
    { name: "halfDayMinHours", label: "Hours that count as a half day", kind: "number", required: true, defaultValue: n(r?.halfDayMinHours, 4) },
    { name: "overtimeAfterHours", label: "Overtime starts after (hours in a day)", kind: "number", required: true, defaultValue: n(r?.overtimeAfterHours, 9) },
    { name: "maxConsecutiveWorkDays", label: "Most days in a row someone may work", kind: "number", required: true, defaultValue: n(r?.maxConsecutiveWorkDays, 6), step: "1" },
    { name: "maxSpanOfControl", label: "Most direct reports per manager", kind: "number", required: true, defaultValue: n(r?.maxSpanOfControl, 12), step: "1", hint: "Managers over this are flagged on the structure health view and the manager dashboard." },
    propose, reason,
  ];
  return (
    <div className="grid grid-2" style={{ alignItems: "start", gridTemplateColumns: "2fr 1fr" }}>
      <Card title="Working rules" description="The company-wide defaults; shifts and attendance policies can be stricter.">
        <SpecForm action={saveWorkingRulesAction} fields={fields} submitLabel="Save rules" />
      </Card>
      <Card title="In force">
        {r ? <KeyValue items={[
          ["Working days", r.workDays.join(", ")], ["Week starts", r.weekStartsOn], ["Day", `${Number(r.standardHoursPerDay)} h`], ["Week", `${Number(r.standardHoursPerWeek)} h`],
          ["Half day", `${Number(r.halfDayMinHours)} h`], ["Overtime after", `${Number(r.overtimeAfterHours)} h`], ["Span of control", `${r.maxSpanOfControl}`], ["Last changed", formatDate(r.updatedAt)],
        ]} /> : <Empty title="Using the defaults">Mon–Fri, 8 hours a day.</Empty>}
      </Card>
    </div>
  );
}

async function Approvals({ tenantId }: { tenantId: string }) {
  const settings = await prisma.changeApprovalSetting.findMany({ where: { tenantId } });
  const on = new Map(settings.map((s) => [s.targetType, s.requireApproval]));
  // The settings saved on this page; org-unit changes proposed under Org › Divisions & teams always need approval.
  const targets = (["COMPANY_PROFILE", "FISCAL_YEAR", "WORKING_RULES"] as const);
  return (
    <div className="stack gap-4">
      <Callout title="Maker-checker for configuration">When a kind of change needs approval, saving it raises a change request instead; another administrator approves it in Change requests (or the Inbox), and it applies then — or on its effective date. Profile changes from employees always need approval.</Callout>
      <Card title="Which changes need a second administrator" tight>
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Kind of change</th><th>Area</th><th>Now</th><th /></tr></thead>
          <tbody>{targets.map((k) => {
            const req = on.get(k) ?? false;
            return (
              <tr key={k}><td className="strong">{CHANGE_TARGETS[k].label}</td><td>Settings</td>
                <td>{req ? <Badge tone="brand">Needs approval</Badge> : <Badge>Applies directly</Badge>}</td>
                <td className="right"><ActionButton action={saveChangeApprovalSettingAction} hidden={req ? { targetType: k } : { targetType: k, requireApproval: "on" }} label={req ? "Apply directly" : "Require approval"} /></td></tr>
            );
          })}</tbody>
        </table></div>
      </Card>
    </div>
  );
}
