import { randomBytes } from "node:crypto";
import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { applyJobChange } from "./job-changes";
import { idCardNumber, idCardValidity } from "./core-hr-depth-math";
import {
  CONFIG_FORMAT_VERSION, configSummary, recordAsOf, normaliseReorgMoves, hierarchyCycle,
  type ConfigPayload, type ConfigSection, type OrgSnapshotPayload, type SnapshotUnit, type ReorgMove, type Core2WorkflowEntityType,
} from "./core2-math";

/**
 * Core HR depth, second pass — the database side: capturing and restoring
 * the company's configuration, org snapshots as of a date, applying
 * reorganisations and entity transitions, the outcomes of the core HR
 * workflow request types, and the HR operations exception checks.
 */

type R = { ok: boolean; message: string };
const DAY = 86_400_000;

async function core2Audit(tenantId: string, actorUserId: string | null, opts: { module?: "SYSTEM" | "EMPLOYEE"; action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" | "EXPORT"; entityType: string; entityId?: string | null; summary: string; oldValue?: unknown; newValue?: unknown }) {
  const actor = actorUserId ? await prisma.user.findFirst({ where: { id: actorUserId, tenantId }, select: { email: true } }) : null;
  await prisma.auditLog.create({
    data: {
      tenantId, module: opts.module ?? "SYSTEM", action: opts.action, entityType: opts.entityType, entityId: opts.entityId ?? null, summary: opts.summary,
      oldValue: opts.oldValue === undefined ? undefined : (opts.oldValue as Prisma.InputJsonValue),
      newValue: opts.newValue === undefined ? undefined : (opts.newValue as Prisma.InputJsonValue),
      actorId: actor ? actorUserId : null, actorLabel: actor?.email ?? "system",
    },
  });
}

// ---------------------------------------------------------------------------
//  Configuration capture and restore
// ---------------------------------------------------------------------------

const pick = <T extends object>(o: T | null | undefined, drop: string[] = ["id", "tenantId", "updatedAt", "updatedBy", "createdAt", "createdBy"]) =>
  o ? JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k))))) : null;

/** Everything a company has configured in the areas a snapshot covers. */
export async function captureConfig(tenantId: string): Promise<ConfigPayload> {
  const [tenant, company, rules, visibility, approvals, years, notes, series, countries, branding, statuses, dictionaries, slas, completeness, workerTypes] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, timezone: true, fyStartMonth: true } }),
    prisma.companyProfile.findUnique({ where: { tenantId } }),
    prisma.workingRules.findUnique({ where: { tenantId } }),
    prisma.tenantVisibilitySetting.findUnique({ where: { tenantId } }),
    prisma.changeApprovalSetting.findMany({ where: { tenantId }, orderBy: { targetType: "asc" } }),
    prisma.fiscalYear.findMany({ where: { tenantId }, orderBy: [{ calendarSet: "asc" }, { startDate: "asc" }] }),
    prisma.notificationSetting.findMany({ where: { tenantId }, orderBy: { event: "asc" } }),
    prisma.employeeNumberSeries.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.countryAvailability.findMany({ where: { tenantId }, orderBy: { countryCode: "asc" } }),
    prisma.brandingProfile.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.employeeStatusCatalog.findMany({ where: { tenantId }, orderBy: { code: "asc" } }),
    prisma.masterDictionary.findMany({ where: { tenantId }, include: { entries: { orderBy: { sortOrder: "asc" } } }, orderBy: { key: "asc" } }),
    prisma.hrSlaPolicy.findMany({ where: { tenantId }, orderBy: { transactionType: "asc" } }),
    prisma.fieldCompletenessRule.findMany({ where: { tenantId }, orderBy: { field: "asc" } }),
    prisma.workerType.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);
  const wt = new Map(workerTypes.map((w) => [w.id, w.name]));
  const sections: ConfigPayload["sections"] = {
    organisation: tenant,
    company: pick(company),
    workingRules: rules ? { ...pick(rules), standardHoursPerDay: Number(rules.standardHoursPerDay), standardHoursPerWeek: Number(rules.standardHoursPerWeek), halfDayMinHours: Number(rules.halfDayMinHours), overtimeAfterHours: Number(rules.overtimeAfterHours) } : null,
    visibility: pick(visibility),
    changeApprovals: approvals.map((a) => ({ targetType: a.targetType, requireApproval: a.requireApproval })),
    fiscalYears: years.map((y) => ({ name: y.name, calendarSet: y.calendarSet, startDate: y.startDate.toISOString().slice(0, 10), endDate: y.endDate.toISOString().slice(0, 10), status: y.status, isCurrent: y.isCurrent, note: y.note })),
    notificationSettings: notes.map((n) => ({ event: n.event, emailEnabled: n.emailEnabled, recipients: n.recipients, customEmails: n.customEmails })),
    numberSeries: series.map((s) => ({ name: s.name, description: s.description, prefix: s.prefix, digits: s.digits, suffix: s.suffix, isActive: s.isActive, isDefault: s.isDefault })),
    countries: countries.map((c) => ({ countryCode: c.countryCode, countryName: c.countryName, modules: c.modules, currency: c.currency, isActive: c.isActive, note: c.note })),
    branding: branding.map((b) => ({ name: b.name, portalTitle: b.portalTitle, primaryColor: b.primaryColor, accentColor: b.accentColor, logoText: b.logoText, welcomeMessage: b.welcomeMessage, isDefault: b.isDefault, isActive: b.isActive })),
    statusCatalog: statuses.map((s) => ({ code: s.code, label: s.label, baseStatus: s.baseStatus, description: s.description, color: s.color, isActive: s.isActive })),
    dictionaries: dictionaries.map((d) => ({ key: d.key, name: d.name, description: d.description, isActive: d.isActive, entries: d.entries.map((e) => ({ code: e.code, label: e.label, sortOrder: e.sortOrder, isActive: e.isActive })) })),
    slaPolicies: slas.map((s) => ({ transactionType: s.transactionType, targetHours: s.targetHours })),
    completenessRules: completeness.map((c) => ({ field: c.field, workerType: c.workerTypeId ? wt.get(c.workerTypeId) ?? null : null, severity: c.severity, isActive: c.isActive })),
  };
  return { format: "boos-hr-config", version: CONFIG_FORMAT_VERSION, exportedAt: new Date().toISOString(), sections };
}

/** Save a copy of the current configuration. */
export async function takeConfigSnapshot(input: { tenantId: string; name: string; environment?: string; kind?: string; note?: string | null; actorUserId: string | null; payload?: ConfigPayload }) {
  const payload = input.payload ?? await captureConfig(input.tenantId);
  return prisma.configSnapshot.create({
    data: {
      tenantId: input.tenantId, name: input.name, environment: input.environment ?? "PRODUCTION", kind: input.kind ?? "CHECKPOINT",
      payload: payload as unknown as Prisma.InputJsonValue, summary: configSummary(payload) as Prisma.InputJsonValue, note: input.note ?? null, createdBy: input.actorUserId,
    },
  });
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

/**
 * Apply a configuration copy to the company. A copy of what is there now is
 * saved first (kind AUTO), so a restore can itself be rolled back. Lists are
 * matched on their natural key (code, name, event...); items the copy does
 * not mention are left alone, except in the company's own catalogs
 * (branding, statuses, dictionaries, countries, SLAs, completeness rules),
 * which become exactly what the copy holds.
 */
export async function restoreConfig(input: { tenantId: string; payload: ConfigPayload; actorUserId: string | null; sections?: ConfigSection[]; label: string }): Promise<R & { applied: Record<string, number>; backupId?: string }> {
  const t = input.tenantId;
  const want = (s: ConfigSection) => (!input.sections || input.sections.includes(s)) && (input.payload.sections as Obj)[s] !== undefined;
  const sec = input.payload.sections as Obj;
  const applied: Record<string, number> = {};
  if (want("organisation") && sec.organisation) {
    const o = sec.organisation as Obj;
    if (o.fyStartMonth !== undefined) {
      const cur = await prisma.tenant.findUniqueOrThrow({ where: { id: t }, select: { fyStartMonth: true } });
      if (Number(o.fyStartMonth) !== cur.fyStartMonth && await prisma.payrollRun.count({ where: { tenantId: t, status: "FINALIZED" } }) > 0) {
        return { ok: false, message: "This copy moves the financial year, which cannot change once payroll has been finalised. Leave out organisation settings.", applied };
      }
    }
  }
  const backup = await takeConfigSnapshot({ tenantId: t, name: `Before ${input.label}`, kind: "AUTO", actorUserId: input.actorUserId });
  await prisma.$transaction(async (tx) => {
    if (want("organisation") && sec.organisation) {
      const o = sec.organisation as Obj;
      await tx.tenant.update({ where: { id: t }, data: { ...(o.name ? { name: String(o.name) } : {}), ...(o.timezone ? { timezone: String(o.timezone) } : {}), ...(o.fyStartMonth ? { fyStartMonth: Number(o.fyStartMonth) } : {}) } });
      applied.organisation = Object.keys(o).length;
    }
    if (want("company") && sec.company) {
      const c = pick(sec.company as Obj) as Obj;
      await tx.companyProfile.upsert({ where: { tenantId: t }, create: { tenantId: t, ...(c as object), updatedBy: input.actorUserId }, update: { ...(c as object), updatedBy: input.actorUserId } });
      applied.company = Object.keys(c).length;
    }
    if (want("workingRules") && sec.workingRules) {
      const r = pick(sec.workingRules as Obj) as Obj;
      await tx.workingRules.upsert({ where: { tenantId: t }, create: { tenantId: t, ...(r as object), updatedBy: input.actorUserId }, update: { ...(r as object), updatedBy: input.actorUserId } });
      applied.workingRules = Object.keys(r).length;
    }
    if (want("visibility") && sec.visibility) {
      const v = pick(sec.visibility as Obj) as Obj;
      await tx.tenantVisibilitySetting.upsert({ where: { tenantId: t }, create: { tenantId: t, ...(v as object) }, update: v as object });
      applied.visibility = Object.keys(v).length;
    }
    if (want("changeApprovals")) {
      const rows = sec.changeApprovals as Obj[];
      for (const a of rows) await tx.changeApprovalSetting.upsert({ where: { tenantId_targetType: { tenantId: t, targetType: String(a.targetType) } }, create: { tenantId: t, targetType: String(a.targetType), requireApproval: !!a.requireApproval, updatedBy: input.actorUserId }, update: { requireApproval: !!a.requireApproval, updatedBy: input.actorUserId } });
      applied.changeApprovals = rows.length;
    }
    if (want("fiscalYears")) {
      const rows = sec.fiscalYears as Obj[];
      for (const y of rows) {
        const data = { startDate: new Date(String(y.startDate)), endDate: new Date(String(y.endDate)), status: String(y.status ?? "OPEN"), isCurrent: !!y.isCurrent, note: str(y.note) };
        await tx.fiscalYear.upsert({ where: { tenantId_calendarSet_name: { tenantId: t, calendarSet: String(y.calendarSet), name: String(y.name) } }, create: { tenantId: t, name: String(y.name), calendarSet: String(y.calendarSet), ...data, createdBy: input.actorUserId }, update: data });
      }
      applied.fiscalYears = rows.length;
    }
    if (want("notificationSettings")) {
      const rows = sec.notificationSettings as Obj[];
      for (const n of rows) {
        const data = { emailEnabled: !!n.emailEnabled, recipients: (n.recipients as string[]) ?? [], customEmails: (n.customEmails as string[]) ?? [], updatedBy: input.actorUserId };
        await tx.notificationSetting.upsert({ where: { tenantId_event: { tenantId: t, event: String(n.event) } }, create: { tenantId: t, event: String(n.event), ...data }, update: data });
      }
      applied.notificationSettings = rows.length;
    }
    if (want("numberSeries")) {
      const rows = sec.numberSeries as Obj[];
      for (const s of rows) {
        const data = { description: str(s.description), prefix: String(s.prefix ?? ""), digits: Number(s.digits ?? 4), suffix: String(s.suffix ?? ""), isActive: s.isActive !== false, isDefault: !!s.isDefault };
        await tx.employeeNumberSeries.upsert({ where: { tenantId_name: { tenantId: t, name: String(s.name) } }, create: { tenantId: t, name: String(s.name), ...data }, update: data });
      }
      applied.numberSeries = rows.length;
    }
    if (want("countries")) {
      const rows = sec.countries as Obj[];
      await tx.countryAvailability.deleteMany({ where: { tenantId: t, countryCode: { notIn: rows.map((c) => String(c.countryCode)) } } });
      for (const c of rows) {
        const data = { countryName: String(c.countryName ?? c.countryCode), modules: (c.modules as string[]) ?? [], currency: str(c.currency), isActive: c.isActive !== false, note: str(c.note) };
        await tx.countryAvailability.upsert({ where: { tenantId_countryCode: { tenantId: t, countryCode: String(c.countryCode) } }, create: { tenantId: t, countryCode: String(c.countryCode), ...data }, update: data });
      }
      applied.countries = rows.length;
    }
    if (want("branding")) {
      const rows = sec.branding as Obj[];
      await tx.brandingProfile.deleteMany({ where: { tenantId: t, name: { notIn: rows.map((b) => String(b.name)) } } });
      for (const b of rows) {
        const data = { portalTitle: String(b.portalTitle ?? b.name), primaryColor: String(b.primaryColor ?? "#1266a8"), accentColor: String(b.accentColor ?? "#0f8a5f"), logoText: str(b.logoText), welcomeMessage: str(b.welcomeMessage), isDefault: !!b.isDefault, isActive: b.isActive !== false };
        await tx.brandingProfile.upsert({ where: { tenantId_name: { tenantId: t, name: String(b.name) } }, create: { tenantId: t, name: String(b.name), ...data }, update: data });
      }
      applied.branding = rows.length;
    }
    if (want("statusCatalog")) {
      const rows = sec.statusCatalog as Obj[];
      const keep = rows.map((s) => String(s.code));
      const unused = await tx.employeeStatusCatalog.findMany({ where: { tenantId: t, code: { notIn: keep } }, select: { id: true } });
      const tagged = new Set((await tx.employeeStatusTag.findMany({ where: { tenantId: t, catalogId: { in: unused.map((u) => u.id) } }, select: { catalogId: true } })).map((x) => x.catalogId));
      await tx.employeeStatusCatalog.deleteMany({ where: { id: { in: unused.filter((u) => !tagged.has(u.id)).map((u) => u.id) } } });
      await tx.employeeStatusCatalog.updateMany({ where: { id: { in: [...tagged] } }, data: { isActive: false } });
      for (const s of rows) {
        const data = { label: String(s.label), baseStatus: String(s.baseStatus), description: str(s.description), color: String(s.color ?? "#6b7280"), isActive: s.isActive !== false };
        await tx.employeeStatusCatalog.upsert({ where: { tenantId_code: { tenantId: t, code: String(s.code) } }, create: { tenantId: t, code: String(s.code), ...data }, update: data });
      }
      applied.statusCatalog = rows.length;
    }
    if (want("dictionaries")) {
      const rows = sec.dictionaries as Obj[];
      await tx.masterDictionary.deleteMany({ where: { tenantId: t, key: { notIn: rows.map((d) => String(d.key)) } } });
      for (const d of rows) {
        const dict = await tx.masterDictionary.upsert({ where: { tenantId_key: { tenantId: t, key: String(d.key) } }, create: { tenantId: t, key: String(d.key), name: String(d.name), description: str(d.description), isActive: d.isActive !== false }, update: { name: String(d.name), description: str(d.description), isActive: d.isActive !== false } });
        const entries = (d.entries as Obj[]) ?? [];
        await tx.masterDictionaryEntry.deleteMany({ where: { dictionaryId: dict.id, code: { notIn: entries.map((e) => String(e.code)) } } });
        for (const e of entries) await tx.masterDictionaryEntry.upsert({ where: { dictionaryId_code: { dictionaryId: dict.id, code: String(e.code) } }, create: { dictionaryId: dict.id, code: String(e.code), label: String(e.label), sortOrder: Number(e.sortOrder ?? 0), isActive: e.isActive !== false }, update: { label: String(e.label), sortOrder: Number(e.sortOrder ?? 0), isActive: e.isActive !== false } });
      }
      applied.dictionaries = rows.length;
    }
    if (want("slaPolicies")) {
      const rows = sec.slaPolicies as Obj[];
      await tx.hrSlaPolicy.deleteMany({ where: { tenantId: t, transactionType: { notIn: rows.map((s) => String(s.transactionType)) } } });
      for (const s of rows) await tx.hrSlaPolicy.upsert({ where: { tenantId_transactionType: { tenantId: t, transactionType: String(s.transactionType) } }, create: { tenantId: t, transactionType: String(s.transactionType), targetHours: Number(s.targetHours) }, update: { targetHours: Number(s.targetHours) } });
      applied.slaPolicies = rows.length;
    }
    if (want("completenessRules")) {
      const rows = sec.completenessRules as Obj[];
      const types = await tx.workerType.findMany({ where: { tenantId: t }, select: { id: true, name: true } });
      const byName = new Map(types.map((w) => [w.name.toLowerCase(), w.id]));
      await tx.fieldCompletenessRule.deleteMany({ where: { tenantId: t } });
      if (rows.length) await tx.fieldCompletenessRule.createMany({ data: rows.map((r) => ({ tenantId: t, field: String(r.field), workerTypeId: r.workerType ? byName.get(String(r.workerType).toLowerCase()) ?? null : null, severity: String(r.severity ?? "ERROR"), isActive: r.isActive !== false })) });
      applied.completenessRules = rows.length;
    }
  });
  const total = Object.values(applied).reduce((s, n) => s + n, 0);
  return { ok: true, message: `Applied ${total} setting(s) across ${Object.keys(applied).length} section(s). A copy of the previous configuration was kept.`, applied, backupId: backup.id };
}

// ---------------------------------------------------------------------------
//  Statutory registrations through a change request
// ---------------------------------------------------------------------------

const dateOrNull = (v: unknown) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00Z`) : null);
const numOr = (v: unknown, d: number) => (v === null || v === undefined || v === "" ? d : Number(v));

/**
 * Apply an approved establishment (PT / LWF state registration) or
 * registration-profile (a pay group's PAN, TAN, PF and ESI filing details)
 * change. Called from the change-request engine.
 */
export async function applyStatutoryRegistrationChange(tenantId: string, target: "ESTABLISHMENT" | "REGISTRATION_PROFILE", c: Record<string, unknown>): Promise<R> {
  const group = await prisma.payGroup.findFirst({ where: { id: String(c.payGroupId ?? ""), tenantId }, select: { id: true, name: true } });
  if (!group) return { ok: false, message: "That pay group no longer exists." };
  if (target === "REGISTRATION_PROFILE") {
    const { payGroupId: _p, ...rest } = c;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (k.endsWith("Date")) data[k] = dateOrNull(v);
      // Flags first: pfCapAtCeiling ends in "Ceiling" but is a yes/no.
      else if (typeof v === "boolean" || k.startsWith("esiEmployerInsideCtc") || k.startsWith("esiHide") || k.startsWith("esiInclude") || k === "pfCapAtCeiling") data[k] = v === true || v === "true" || v === "on";
      else if (/Rate$|Ceiling$|Limit$/.test(k)) data[k] = numOr(v, 0);
      else data[k] = v ?? null;
    }
    await prisma.payGroupFilingDetail.upsert({ where: { payGroupId: group.id }, create: { payGroupId: group.id, ...(data as object) }, update: data as object });
    return { ok: true, message: `Saved the filing details of ${group.name}.` };
  }
  const stateCode = String(c.stateCode ?? "").toUpperCase();
  const locationIds = Array.isArray(c.locationIds) ? (c.locationIds as string[]) : [];
  if (locationIds.length) {
    const locs = await prisma.location.findMany({ where: { id: { in: locationIds }, tenantId }, select: { stateCode: true } });
    if (locs.length !== new Set(locationIds).size || locs.some((l) => l.stateCode !== stateCode)) return { ok: false, message: "A linked location is missing or not in that state." };
  }
  const common = { stateName: String(c.stateName ?? stateCode), establishmentId: (c.establishmentId as string | null) ?? null, registrationDate: dateOrNull(c.registrationDate), signatoryName: (c.signatoryName as string | null) ?? null };
  await prisma.$transaction(async (tx) => {
    if (c.kind === "LWF") {
      const flags = { employerInsideCtc: c.employerInsideCtc === true, hideEmployerOnPayslip: c.hideEmployerOnPayslip === true, prorateNewJoiners: c.prorateNewJoiners === true };
      const reg = await tx.lwfStateRegistration.upsert({ where: { payGroupId_stateCode: { payGroupId: group.id, stateCode } }, create: { payGroupId: group.id, stateCode, ...common, ...flags }, update: { ...common, ...flags } });
      await tx.lwfStateRegistrationLocation.deleteMany({ where: { OR: [{ registrationId: reg.id }, { locationId: { in: locationIds }, registration: { payGroupId: group.id } }] } });
      if (locationIds.length) await tx.lwfStateRegistrationLocation.createMany({ data: locationIds.map((locationId) => ({ registrationId: reg.id, locationId })) });
    } else {
      const localBodyType = String(c.localBodyType ?? "");
      const frequency = (["MONTHLY", "HALF_YEARLY", "ANNUAL"].includes(String(c.frequency)) ? String(c.frequency) : "MONTHLY") as "MONTHLY" | "HALF_YEARLY" | "ANNUAL";
      const reg = await tx.ptStateRegistration.upsert({
        where: { payGroupId_stateCode_localBodyType: { payGroupId: group.id, stateCode, localBodyType } },
        create: { payGroupId: group.id, stateCode, localBodyType, frequency, ...common }, update: { frequency, ...common },
      });
      await tx.ptStateRegistrationLocation.deleteMany({ where: { OR: [{ registrationId: reg.id }, { locationId: { in: locationIds }, registration: { payGroupId: group.id } }] } });
      if (locationIds.length) await tx.ptStateRegistrationLocation.createMany({ data: locationIds.map((locationId) => ({ registrationId: reg.id, locationId })) });
    }
  });
  return { ok: true, message: `Saved the ${stateCode} ${c.kind === "LWF" ? "LWF" : "PT"} registration of ${group.name}.` };
}

// ---------------------------------------------------------------------------
//  Org snapshots (as of a date)
// ---------------------------------------------------------------------------

/**
 * The organisation as it stood on a date: units as they are now (with
 * their parent, head and active flag), and each person's job record in
 * force on that date — so a past date shows past departments and managers.
 */
export async function orgAsOf(tenantId: string, asOf: Date): Promise<OrgSnapshotPayload> {
  const [entities, units, divisions, depts, locs, people] = await Promise.all([
    prisma.legalEntity.findMany({ where: { tenantId }, select: { id: true, name: true, isActive: true } }),
    prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true, headId: true, isActive: true } }),
    prisma.division.findMany({ where: { tenantId }, select: { id: true, name: true, headId: true, isActive: true } }),
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true, headId: true, isActive: true } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true, parentId: true, isActive: true } }),
    prisma.employee.findMany({
      where: { tenantId, dateOfJoining: { lte: asOf }, OR: [{ lastWorkingDay: null }, { lastWorkingDay: { gte: asOf } }], status: { not: "PREBOARDING" } },
      select: { id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true, departmentId: true, reportingManagerId: true, locationId: true, legalEntityId: true, businessUnitId: true, jobTitleName: true, jobHistory: { select: { effectiveFrom: true, effectiveTo: true, departmentId: true, reportingManagerId: true, locationId: true, legalEntityId: true, businessUnitId: true, jobTitle: { select: { name: true } } } } },
      orderBy: { employeeNumber: "asc" },
    }),
  ]);
  const unit = (type: string, u: { id: string; name: string; parentId?: string | null; headId?: string | null; isActive: boolean }): SnapshotUnit => ({ id: u.id, type, name: u.name, parentId: u.parentId ?? null, headId: u.headId ?? null, isActive: u.isActive });
  return {
    asOf: asOf.toISOString().slice(0, 10),
    units: [...entities.map((u) => unit("LEGAL_ENTITY", u)), ...units.map((u) => unit("BUSINESS_UNIT", u)), ...divisions.map((u) => unit("DIVISION", u)), ...depts.map((u) => unit("DEPARTMENT", u)), ...locs.map((u) => unit("LOCATION", u))],
    people: people.map((p) => {
      const r = recordAsOf(p.jobHistory, asOf);
      return {
        id: p.id, number: p.employeeNumber, name: p.displayName ?? `${p.firstName} ${p.lastName}`,
        departmentId: r ? r.departmentId : p.departmentId, managerId: r ? r.reportingManagerId : p.reportingManagerId, locationId: r ? r.locationId : p.locationId,
        legalEntityId: r ? r.legalEntityId : p.legalEntityId, businessUnitId: r ? r.businessUnitId : p.businessUnitId, title: r?.jobTitle?.name ?? p.jobTitleName,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
//  Applying reorganisations and entity transitions
// ---------------------------------------------------------------------------

/** Record a move as an applied job change, so job history and reports show it. */
async function moveEmployee(tenantId: string, employeeId: string, actorUserId: string | null, reason: "TRANSFER" | "DEPARTMENT_CHANGE" | "MANAGER_CHANGE", fields: { departmentId?: string | null; reportingManagerId?: string | null; legalEntityId?: string | null; businessUnitId?: string | null }, effectiveFrom: Date, note: string) {
  const change = await prisma.jobChange.create({
    data: {
      tenantId, employeeId, effectiveFrom, reason, status: "SCHEDULED", note, requestedBy: actorUserId, source: "MANUAL",
      departmentId: fields.departmentId ?? null, reportingManagerId: fields.reportingManagerId ?? null, legalEntityId: fields.legalEntityId ?? null, businessUnitId: fields.businessUnitId ?? null,
    },
  });
  await applyJobChange(change.id);
}

export async function applyReorgScenario(tenantId: string, scenarioId: string, actorUserId: string | null): Promise<R> {
  const s = await prisma.reorgScenario.findFirst({ where: { id: scenarioId, tenantId } });
  if (!s) return { ok: false, message: "Scenario not found." };
  if (s.status === "APPLIED") return { ok: false, message: "This scenario was already applied." };
  const moves = normaliseReorgMoves((s.moves ?? []) as unknown as ReorgMove[]);
  const people = await prisma.employee.findMany({ where: { tenantId, status: { notIn: ["EXITED"] } }, select: { id: true, reportingManagerId: true, departmentId: true } });
  const managerOf = new Map(people.map((p) => [p.id, p.reportingManagerId]));
  for (const m of moves) if (m.reportingManagerId !== undefined) managerOf.set(m.employeeId, m.reportingManagerId ?? null);
  for (const m of moves) {
    if (m.reportingManagerId && hierarchyCycle(m.employeeId, m.reportingManagerId, new Map([...managerOf].map(([k, v]) => [k, k === m.employeeId ? null : v])))) return { ok: false, message: "The scenario would create a reporting loop." };
  }
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const cur = new Map(people.map((p) => [p.id, p]));
  let n = 0;
  for (const m of moves) {
    const p = cur.get(m.employeeId);
    if (!p) continue;
    const dept = m.departmentId !== undefined && m.departmentId !== p.departmentId ? m.departmentId : undefined;
    const mgr = m.reportingManagerId !== undefined && m.reportingManagerId !== p.reportingManagerId ? m.reportingManagerId : undefined;
    if (!dept && !mgr) continue;
    await moveEmployee(tenantId, m.employeeId, actorUserId, dept ? "DEPARTMENT_CHANGE" : "MANAGER_CHANGE", { departmentId: dept ?? null, reportingManagerId: mgr ?? null }, today, `Reorganisation: ${s.name}`);
    n++;
  }
  await prisma.reorgScenario.update({ where: { id: s.id }, data: { status: "APPLIED", appliedAt: new Date(), appliedBy: actorUserId } });
  await core2Audit(tenantId, actorUserId, { action: "UPDATE", entityType: "ReorgScenario", entityId: s.id, summary: `Applied reorganisation "${s.name}": ${n} people moved` });
  return { ok: true, message: `Applied "${s.name}": ${n} people moved.` };
}

export async function applyEntityTransition(tenantId: string, transitionId: string, actorUserId: string | null): Promise<R> {
  const tr = await prisma.entityTransition.findFirst({ where: { id: transitionId, tenantId } });
  if (!tr) return { ok: false, message: "Transition not found." };
  if (tr.status === "APPLIED") return { ok: false, message: "Already applied." };
  const target = await prisma.legalEntity.findFirst({ where: { id: tr.targetEntityId, tenantId } });
  if (!target) return { ok: false, message: "The target entity no longer exists." };
  const mapping = (tr.mapping ?? []) as Array<{ employeeId: string; businessUnitId?: string | null; departmentId?: string | null }>;
  const people = await prisma.employee.findMany({ where: { tenantId, id: { in: mapping.map((m) => m.employeeId) } }, select: { id: true, legalEntityId: true, businessUnitId: true, departmentId: true } });
  const byId = new Map(people.map((p) => [p.id, p]));
  const units = await prisma.businessUnit.findMany({ where: { tenantId, legalEntityId: target.id }, select: { id: true } });
  const unitIds = new Set(units.map((u) => u.id));
  let n = 0;
  for (const m of mapping) {
    const p = byId.get(m.employeeId);
    if (!p) continue;
    const bu = m.businessUnitId && unitIds.has(m.businessUnitId) ? m.businessUnitId : null;
    await moveEmployee(tenantId, p.id, actorUserId, "TRANSFER", { legalEntityId: target.id, businessUnitId: bu, departmentId: m.departmentId || null }, tr.effectiveDate <= new Date() ? tr.effectiveDate : new Date(), `${tr.kind.toLowerCase()} ${tr.name}`);
    n++;
  }
  if (tr.kind === "MERGER" && tr.deactivateSource && tr.sourceEntityId) await prisma.legalEntity.updateMany({ where: { id: tr.sourceEntityId, tenantId }, data: { isActive: false } });
  await prisma.entityTransition.update({ where: { id: tr.id }, data: { status: "APPLIED", appliedAt: new Date(), stepsDone: tr.kind === "ACQUISITION" ? [...new Set([...tr.stepsDone, "mapping"])] : tr.stepsDone } });
  await core2Audit(tenantId, actorUserId, { action: "UPDATE", entityType: "EntityTransition", entityId: tr.id, summary: `Applied ${tr.kind.toLowerCase()} "${tr.name}": ${n} people moved to ${target.name}` });
  return { ok: true, message: `Applied: ${n} people moved to ${target.name}.` };
}

// ---------------------------------------------------------------------------
//  Workflow outcomes
// ---------------------------------------------------------------------------

/** Issue a card for an employee (old cards stop verifying). */
export async function issueIdCardFor(tenantId: string, employeeId: string, actorUserId: string | null): Promise<{ id: string; cardNumber: string }> {
  const [tenant, emp] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { subdomain: true } }),
    prisma.employee.findFirstOrThrow({ where: { id: employeeId, tenantId }, select: { employeeNumber: true } }),
  ]);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.employeeIdCard.updateMany({ where: { tenantId, employeeId, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now } });
    return tx.employeeIdCard.create({ data: { tenantId, employeeId, cardNumber: idCardNumber(tenant.subdomain, emp.employeeNumber, randomBytes(3).toString("hex")), validUntil: idCardValidity(now), issuedBy: actorUserId }, select: { id: true, cardNumber: true } });
  });
}

/**
 * What a finished core HR workflow request does to the record behind it.
 * Called by the workflow engine for CORE2_WORKFLOW_ENTITY_TYPES.
 */
export async function applyCore2Effect(req: { id: string; tenantId: string; entityType: string; entityId: string | null }, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const t = req.tenantId, id = req.entityId;
  if (!id) return;
  const approved = outcome === "APPROVED";
  const closed = outcome === "WITHDRAWN" ? "WITHDRAWN" : "REJECTED";
  switch (req.entityType as Core2WorkflowEntityType) {
    case "PRIVACY_REQUEST":
    case "DIRECTORY_LISTING": {
      const pr = await prisma.privacyRequest.findFirst({ where: { id, tenantId: t } });
      if (!pr || pr.status !== "PENDING") return;
      if (approved && pr.kind === "DIRECTORY_HIDE") {
        await prisma.employeeProfileExtra.upsert({ where: { employeeId: pr.employeeId }, create: { tenantId: t, employeeId: pr.employeeId, hideFromDirectory: true }, update: { hideFromDirectory: true } });
      }
      // ACCESS, RECTIFICATION, ERASURE and RESTRICTION are fulfilled by the
      // compliance team once approved, and closed as COMPLETED from the queue.
      await prisma.privacyRequest.update({ where: { id }, data: approved ? { status: pr.kind === "DIRECTORY_HIDE" ? "COMPLETED" : "APPROVED", closedAt: pr.kind === "DIRECTORY_HIDE" ? new Date() : null } : { status: closed, closedAt: new Date() } });
      await core2Audit(t, actorUserId, { module: "EMPLOYEE", action: approved ? "APPROVE" : "REJECT", entityType: "PrivacyRequest", entityId: id, summary: `Privacy request (${pr.kind.toLowerCase()}) ${approved ? "approved" : outcome.toLowerCase()}` });
      return;
    }
    case "ID_CARD_REQUEST": {
      const r = await prisma.idCardRequest.findFirst({ where: { id, tenantId: t } });
      if (!r || r.status !== "PENDING") return;
      if (approved) {
        const card = await issueIdCardFor(t, r.employeeId, actorUserId);
        await prisma.idCardRequest.update({ where: { id }, data: { status: "ISSUED", cardId: card.id, decidedAt: new Date() } });
        await core2Audit(t, actorUserId, { module: "EMPLOYEE", action: "APPROVE", entityType: "EmployeeIdCard", entityId: card.id, summary: `Issued ID card ${card.cardNumber} on an approved request` });
      } else {
        await prisma.idCardRequest.update({ where: { id }, data: { status: closed, decidedAt: new Date() } });
      }
      return;
    }
    case "INTERCOMPANY_ASSIGNMENT": {
      const a = await prisma.intercompanyAssignment.findFirst({ where: { id, tenantId: t } });
      if (!a || a.status !== "PENDING_APPROVAL") return;
      await prisma.intercompanyAssignment.update({ where: { id }, data: { status: approved ? "ACTIVE" : "REJECTED" } });
      await core2Audit(t, actorUserId, { action: approved ? "APPROVE" : "REJECT", entityType: "IntercompanyAssignment", entityId: id, summary: `Intercompany assignment ${approved ? "approved" : outcome.toLowerCase()}` });
      return;
    }
    case "ENTITY_TRANSITION": {
      const tr = await prisma.entityTransition.findFirst({ where: { id, tenantId: t } });
      if (!tr || tr.status !== "PENDING_APPROVAL") return;
      await prisma.entityTransition.update({ where: { id }, data: { status: approved ? "APPROVED" : outcome === "WITHDRAWN" ? "DRAFT" : "REJECTED" } });
      if (approved && tr.effectiveDate <= new Date()) {
        const res = await applyEntityTransition(t, id, actorUserId);
        if (!res.ok) throw new Error(res.message);
      }
      return;
    }
    case "REORG_PLAN": {
      const s = await prisma.reorgScenario.findFirst({ where: { id, tenantId: t } });
      if (!s || s.status !== "PENDING_APPROVAL") return;
      await prisma.reorgScenario.update({ where: { id }, data: { status: approved ? "APPROVED" : outcome === "WITHDRAWN" ? "DRAFT" : "REJECTED" } });
      await core2Audit(t, actorUserId, { action: approved ? "APPROVE" : "REJECT", entityType: "ReorgScenario", entityId: id, summary: `Reorganisation "${s.name}" ${approved ? "approved" : outcome.toLowerCase()}` });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
//  HR operations exception checks
// ---------------------------------------------------------------------------

export interface HrOpsFinding { fingerprint: string; kind: string; severity: "HIGH" | "MEDIUM" | "LOW"; message: string; link: string | null; employeeId: string | null }

/** Look for data and process exceptions HR should act on. */
export async function findHrOpsExceptions(tenantId: string, now: Date = new Date()): Promise<HrOpsFinding[]> {
  const out: HrOpsFinding[] = [];
  const active = { tenantId, status: { notIn: ["EXITED" as const, "PREBOARDING" as const] } };
  const [noManager, noDept, inactiveDeptPeople, inactiveLocPeople, overdueChanges, expiring, emptyDepts, headless] = await Promise.all([
    prisma.employee.findMany({ where: { ...active, reportingManagerId: null }, select: { id: true, displayName: true, employeeNumber: true } }),
    prisma.employee.findMany({ where: { ...active, departmentId: null }, select: { id: true, displayName: true, employeeNumber: true } }),
    prisma.employee.groupBy({ by: ["departmentId"], where: { ...active, department: { isActive: false } }, _count: { _all: true } }),
    prisma.employee.groupBy({ by: ["locationId"], where: { ...active, location: { isActive: false } }, _count: { _all: true } }),
    prisma.recordChangeRequest.findMany({ where: { tenantId, status: "PENDING", createdAt: { lt: new Date(now.getTime() - 7 * DAY) } }, select: { id: true, title: true } }),
    prisma.employeeDocument.findMany({ where: { tenantId, expiresOn: { gte: now, lte: new Date(now.getTime() + 30 * DAY) } }, select: { id: true, employeeId: true, expiresOn: true } }).catch(() => [] as Array<{ id: string; employeeId: string; expiresOn: Date | null }>),
    prisma.department.findMany({ where: { tenantId, isActive: true, employees: { none: {} } }, select: { id: true, name: true } }),
    prisma.department.findMany({ where: { tenantId, isActive: true, headId: null, employees: { some: {} } }, select: { id: true, name: true } }),
  ]);
  // Work authorisation: a passport (and the visa or permit in it) running out within 90 days.
  const passports = await prisma.employeeIdentity.findMany({ where: { type: "PASSPORT", expiryDate: { lte: new Date(now.getTime() + 90 * DAY) }, employee: { tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } } }, select: { id: true, employeeId: true, expiryDate: true, employee: { select: { displayName: true, employeeNumber: true } } } });
  for (const p of passports) {
    const expired = p.expiryDate! < now;
    out.push({ fingerprint: `WORK_AUTH:${p.id}:${p.expiryDate!.toISOString().slice(0, 10)}`, kind: "WORK_AUTH_EXPIRING", severity: expired ? "HIGH" : "MEDIUM", message: `${p.employee.displayName ?? p.employee.employeeNumber}'s passport ${expired ? "expired" : "expires"} on ${p.expiryDate!.toISOString().slice(0, 10)}; check their work authorisation.`, link: `/employees/${p.employeeId}`, employeeId: p.employeeId });
  }
  // The person at the top of the company has no manager by design.
  for (const e of noManager.slice(1)) out.push({ fingerprint: `NO_MANAGER:${e.id}`, kind: "NO_MANAGER", severity: "MEDIUM", message: `${e.displayName ?? e.employeeNumber} has no reporting manager.`, link: `/employees/${e.id}`, employeeId: e.id });
  for (const e of noDept) out.push({ fingerprint: `NO_DEPARTMENT:${e.id}`, kind: "NO_DEPARTMENT", severity: "MEDIUM", message: `${e.displayName ?? e.employeeNumber} is not in a department.`, link: `/employees/${e.id}`, employeeId: e.id });
  for (const g of inactiveDeptPeople) out.push({ fingerprint: `INACTIVE_DEPARTMENT:${g.departmentId}`, kind: "INACTIVE_UNIT", severity: "HIGH", message: `${g._count._all} people are still in an inactive department.`, link: "/org/structure?tab=ownership", employeeId: null });
  for (const g of inactiveLocPeople) out.push({ fingerprint: `INACTIVE_LOCATION:${g.locationId}`, kind: "INACTIVE_UNIT", severity: "HIGH", message: `${g._count._all} people are still at an inactive location.`, link: "/org/structure?tab=ownership", employeeId: null });
  for (const c of overdueChanges) out.push({ fingerprint: `OVERDUE_CHANGE:${c.id}`, kind: "OVERDUE_TRANSACTION", severity: "MEDIUM", message: `"${c.title}" has waited more than a week for a decision.`, link: "/admin/change-requests", employeeId: null });
  for (const d of expiring) out.push({ fingerprint: `DOCUMENT_EXPIRING:${d.id}`, kind: "DOCUMENT_EXPIRING", severity: "LOW", message: `A document expires on ${d.expiresOn?.toISOString().slice(0, 10)}.`, link: `/employees/${d.employeeId}`, employeeId: d.employeeId });
  for (const d of emptyDepts) out.push({ fingerprint: `ORPHAN_UNIT:${d.id}`, kind: "ORPHAN_UNIT", severity: "LOW", message: `Department ${d.name} is active but has nobody in it.`, link: "/org/structure?tab=ownership", employeeId: null });
  for (const d of headless) out.push({ fingerprint: `VACANT_HEAD:${d.id}`, kind: "VACANT_HEAD", severity: "MEDIUM", message: `Department ${d.name} has no head.`, link: "/org/structure?tab=ownership", employeeId: null });
  return out;
}

/**
 * Run the checks: open an alert for each new finding (re-opening one that
 * was resolved but has come back), resolve alerts whose cause is gone, and
 * tell HR about the new ones.
 */
export async function runHrOpsChecks(tenantId: string, actorUserId: string | null = null, now: Date = new Date()): Promise<{ opened: number; resolved: number; open: number }> {
  const findings = await findHrOpsExceptions(tenantId, now);
  const existing = await prisma.hrOpsAlert.findMany({ where: { tenantId } });
  const byFp = new Map(existing.map((a) => [a.fingerprint, a]));
  const seen = new Set(findings.map((f) => f.fingerprint));
  let opened = 0;
  for (const f of findings) {
    const cur = byFp.get(f.fingerprint);
    if (!cur) { await prisma.hrOpsAlert.create({ data: { tenantId, ...f } }); opened++; }
    else if (cur.status !== "OPEN") { await prisma.hrOpsAlert.update({ where: { id: cur.id }, data: { status: "OPEN", message: f.message, severity: f.severity, resolvedAt: null, resolvedBy: null, createdAt: now } }); opened++; }
  }
  const gone = existing.filter((a) => a.status === "OPEN" && !seen.has(a.fingerprint)).map((a) => a.id);
  if (gone.length) await prisma.hrOpsAlert.updateMany({ where: { id: { in: gone } }, data: { status: "RESOLVED", resolvedAt: now, resolvedBy: actorUserId } });
  if (opened) {
    await notify({ tenantId, userIds: await usersWithPermission(tenantId, "employee.record.update"), kind: "EMPLOYEE", title: `${opened} new HR operations alert${opened === 1 ? "" : "s"}`, body: "Open HR operations to review them.", link: "/hr-ops/desk?tab=alerts" });
  }
  return { opened, resolved: gone.length, open: findings.length };
}

// ---------------------------------------------------------------------------
//  Manager digest and the nightly core HR job
// ---------------------------------------------------------------------------

export const MANAGER_DIGEST_SECTIONS = ["approvals", "team-leave", "probation", "documents"] as const;

/** The lines of a manager's team digest for the people given. */
export async function buildManagerDigest(tenantId: string, team: string[], sections: readonly string[], now: Date = new Date()): Promise<string[]> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const week = new Date(today.getTime() + 7 * DAY);
  const lines: string[] = [];
  if (sections.includes("approvals")) {
    const [leave, att] = await Promise.all([
      prisma.leaveRequest.count({ where: { tenantId, employeeId: { in: team }, status: "PENDING" } }),
      prisma.attendanceRequest.count({ where: { tenantId, employeeId: { in: team }, status: "PENDING" } }),
    ]);
    lines.push(`Waiting on you: ${leave} leave and ${att} attendance request(s).`);
  }
  if (sections.includes("team-leave")) lines.push(`On leave in the next 7 days: ${await prisma.leaveRequest.count({ where: { tenantId, employeeId: { in: team }, status: "APPROVED", fromDate: { lte: week }, toDate: { gte: today } } })}.`);
  if (sections.includes("probation")) lines.push(`Probations ending within 30 days: ${await prisma.employeeProbation.count({ where: { tenantId, employeeId: { in: team }, status: "ACTIVE", endDate: { lte: new Date(today.getTime() + 30 * DAY) } } })}.`);
  if (sections.includes("documents")) lines.push(`Documents awaiting verification: ${await prisma.employeeDocument.count({ where: { tenantId, employeeId: { in: team }, status: "PENDING_VERIFICATION" } })}.`);
  return lines;
}

/** Queue a digest email (at most one a day per person). Returns false when one already went today. */
export async function queueManagerDigest(tenantId: string, userId: string, to: string, team: string[], sections: readonly string[], now: Date = new Date()): Promise<boolean> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (await prisma.emailOutbox.count({ where: { tenantId, relatedType: "ManagerDigest", relatedId: userId, createdAt: { gte: start } } })) return false;
  const lines = await buildManagerDigest(tenantId, team, sections, now);
  await prisma.emailOutbox.create({ data: { tenantId, toAddress: to, subject: `Your BooS-HR team digest (${team.length} people)`, textBody: `${lines.join("\n")}\n\nOpen BooS-HR to act on them.`, relatedType: "ManagerDigest", relatedId: userId } });
  return true;
}

/** Send scheduled digests: daily ones every day, weekly ones on Mondays. */
export async function runManagerDigests(tenantId: string, now: Date = new Date()): Promise<number> {
  const prefs = await prisma.userPreference.findMany({ where: { tenantId, digestFrequency: now.getUTCDay() === 1 ? { in: ["DAILY", "WEEKLY"] } : "DAILY" } });
  let sent = 0;
  for (const p of prefs) {
    const user = await prisma.user.findFirst({ where: { id: p.userId, tenantId }, select: { email: true, employee: { select: { id: true } } } });
    if (!user?.employee) continue;
    const team = (await prisma.employee.findMany({ where: { tenantId, reportingManagerId: user.employee.id, status: { not: "EXITED" } }, select: { id: true } })).map((e) => e.id);
    if (!team.length) continue;
    if (await queueManagerDigest(tenantId, p.userId, user.email, team, p.digestSections.length ? p.digestSections : MANAGER_DIGEST_SECTIONS, now)) sent++;
  }
  return sent;
}

/** Nightly: HR exception checks, manager digests, and approved entity transitions whose date has come. */
export async function runCore2Job(tenantId: string, now: Date = new Date()): Promise<Record<string, number>> {
  const checks = await runHrOpsChecks(tenantId, null, now);
  const digests = await runManagerDigests(tenantId, now);
  let transitions = 0;
  for (const tr of await prisma.entityTransition.findMany({ where: { tenantId, status: "APPROVED", effectiveDate: { lte: now } }, select: { id: true } })) {
    if ((await applyEntityTransition(tenantId, tr.id, null)).ok) transitions++;
  }
  return { alertsOpened: checks.opened, alertsResolved: checks.resolved, digests, transitionsApplied: transitions };
}
