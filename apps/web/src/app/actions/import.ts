"use server";

import { prisma } from "@keka/db";
import { parseCsv, mapRows, normaliseDate, normaliseYesNo, normaliseAmount } from "@keka/services";
import { requireAuth, type Viewer } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { IMPORTS, IMPORT_KINDS, type ImportKind } from "@/lib/imports";
import { createEmployee, reviseSalary, saveEmployeeBank } from "./employee";
import { adjustBalanceAction } from "./time";
import { scheduleBonusAction } from "./bonuses";
import { addCandidateAction } from "./hiring";

/**
 * Bulk import from CSV.
 *
 * Two passes. The check pass reads every row, resolves names to records and
 * reports every problem at once, changing nothing. The import pass repeats
 * the check and refuses the whole file if anything is wrong; otherwise it
 * hands each row to the same server action a person would use for one record
 * (create employee, revise salary, add bank account, adjust a balance), so an
 * import obeys every rule, scope and audit the screens do. A row the action
 * itself refuses is reported and the rest carry on.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;

type Built = { form: FormData; label: string } | { error: string };
type Builder = (values: Record<string, string>) => Promise<Built>;

const lower = (s: string) => s.trim().toLowerCase();

function form(fields: Record<string, string | null | undefined | boolean>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === false || v === "") continue;
    f.set(k, v === true ? "on" : v);
  }
  return f;
}

/** Look records up by name (or code) without a query per row. */
async function lookups(tenantId: string) {
  const [entities, locations, departments, titles, payGroups, plans, leaveTypes, employees, bonusTypes] = await Promise.all([
    prisma.legalEntity.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.jobTitle.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.payGroup.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.leavePlan.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.leaveType.findMany({ where: { tenantId }, select: { id: true, name: true, code: true } }),
    prisma.employee.findMany({ where: { tenantId }, select: { id: true, employeeNumber: true, workEmail: true } }),
    prisma.bonusType.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true } }),
  ]);
  const jobs = await prisma.job.findMany({ where: { tenantId, code: { not: null } }, select: { id: true, code: true, status: true } });
  const byName = (rows: Array<{ id: string; name: string }>) => new Map(rows.map((r) => [lower(r.name), r.id]));
  const types = new Map<string, string>();
  for (const t of leaveTypes) { types.set(lower(t.name), t.id); types.set(lower(t.code), t.id); }
  return {
    entity: byName(entities), location: byName(locations), department: byName(departments), title: byName(titles),
    payGroup: byName(payGroups), plan: byName(plans), leaveType: types, bonusType: byName(bonusTypes),
    employee: new Map(employees.map((e) => [lower(e.employeeNumber), e.id])),
    emails: new Set(employees.map((e) => e.workEmail ? lower(e.workEmail) : "").filter(Boolean)),
    job: new Map(jobs.map((j) => [lower(j.code!), j] as const)),
  };
}

type Lookups = Awaited<ReturnType<typeof lookups>>;

function builders(l: Lookups): Record<ImportKind, Builder> {
  // Within one file, an employee number or email may appear only once, and a
  // row may name a manager created earlier in the same file.
  const seenNumbers = new Set<string>();
  const seenEmails = new Set<string>();
  const seenApplications = new Set<string>();

  const employeeId = (n: string) => l.employee.get(lower(n));
  const ref = (map: Map<string, string>, value: string, what: string, required = false): { id?: string; error?: string } => {
    if (!value) return required ? { error: `${what} is required` } : {};
    const id = map.get(lower(value));
    return id ? { id } : { error: `No ${what.toLowerCase()} called “${value}”` };
  };

  return {
    async employees(v) {
      const problems: string[] = [];
      for (const k of ["first_name", "last_name", "work_email"] as const) if (!v[k]) problems.push(`${IMPORTS.employees.columns.find((c) => c.key === k)!.label} is required`);
      const email = lower(v.work_email ?? "");
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push(`“${v.work_email}” is not an email address`);
      else if (email && (l.emails.has(email) || seenEmails.has(email))) problems.push(`${v.work_email} already belongs to an employee`);
      const number = v.employee_number ?? "";
      if (number && (employeeId(number) || seenNumbers.has(lower(number)))) problems.push(`Employee number ${number} is already taken`);
      const doj = normaliseDate(v.date_of_joining ?? "");
      if (!doj) problems.push(v.date_of_joining ? `“${v.date_of_joining}” is not a date` : "Date of joining is required");
      const dob = v.date_of_birth ? normaliseDate(v.date_of_birth) : null;
      if (v.date_of_birth && !dob) problems.push(`“${v.date_of_birth}” is not a date of birth`);
      const entity = ref(l.entity, v.legal_entity ?? "", "Legal entity", true);
      const location = ref(l.location, v.location ?? "", "Location", true);
      const department = ref(l.department, v.department ?? "", "Department");
      const title = ref(l.title, v.job_title ?? "", "Job title");
      const payGroup = ref(l.payGroup, v.pay_group ?? "", "Pay group");
      const plan = ref(l.plan, v.leave_plan ?? "", "Leave plan");
      for (const r of [entity, location, department, title, payGroup, plan]) if (r.error) problems.push(r.error);
      let managerId: string | undefined;
      if (v.reporting_manager) {
        managerId = employeeId(v.reporting_manager);
        if (!managerId && !seenNumbers.has(lower(v.reporting_manager))) problems.push(`No employee ${v.reporting_manager} to report to`);
      }
      const status = (v.status || "PROBATION").toUpperCase();
      if (!["PROBATION", "CONFIRMED", "ONBOARDING", "PREBOARDING"].includes(status)) problems.push(`Status “${v.status}” is not one of PROBATION, CONFIRMED, ONBOARDING, PREBOARDING`);
      const gender = v.gender ? v.gender.toUpperCase() : "";
      if (gender && !["MALE", "FEMALE", "OTHER", "UNDISCLOSED"].includes(gender)) problems.push(`Gender “${v.gender}” is not recognised`);
      const regime = (v.tax_regime || "NEW").toUpperCase();
      if (!["NEW", "OLD"].includes(regime)) problems.push(`Tax regime “${v.tax_regime}” must be NEW or OLD`);
      const ctc = v.annual_ctc ? normaliseAmount(v.annual_ctc) : null;
      if (v.annual_ctc && !ctc) problems.push(`Annual CTC “${v.annual_ctc}” is not a number`);
      if (ctc && Number(ctc) > 0 && !payGroup.id) problems.push("A pay group is required when an annual CTC is given");
      const invite = normaliseYesNo(v.invite ?? "", false);
      if (invite === null) problems.push(`Invite “${v.invite}” must be yes or no`);
      if (problems.length) return { error: problems.join("; ") };

      if (number) seenNumbers.add(lower(number));
      seenEmails.add(email);
      return {
        label: `${v.first_name} ${v.last_name}`,
        form: form({
          employeeNumberOverride: number, firstName: v.first_name, lastName: v.last_name, workEmail: email,
          dateOfJoining: doj, dateOfBirth: dob, legalEntityId: entity.id, locationId: location.id, departmentId: department.id,
          jobTitleId: title.id, status, gender, mobile: v.mobile, payGroupId: payGroup.id, annualCtc: ctc, taxRegime: regime,
          leavePlanId: plan.id, inviteToPortal: !!invite,
          // Resolved when the row runs, so a manager created earlier in the file is found.
          reportingManagerNumber: managerId ? undefined : v.reporting_manager,
          reportingManagerId: managerId,
        }),
      };
    },

    async "leave-balances"(v) {
      const problems: string[] = [];
      const emp = employeeId(v.employee_number ?? "");
      if (!emp) problems.push(v.employee_number ? `No employee ${v.employee_number}` : "Employee number is required");
      const type = ref(l.leaveType, v.leave_type ?? "", "Leave type", true);
      if (type.error) problems.push(type.error);
      const days = normaliseAmount(v.days ?? "");
      if (!days) problems.push(v.days ? `Days “${v.days}” is not a number` : "Days is required");
      else if (Number(days) === 0) problems.push("Days cannot be zero");
      if (problems.length) return { error: problems.join("; ") };
      return { label: `${v.employee_number} ${v.leave_type}`, form: form({ employeeId: emp, leaveTypeId: type.id, days, note: v.note || "Opening balance import" }) };
    },

    async salaries(v) {
      const problems: string[] = [];
      const emp = employeeId(v.employee_number ?? "");
      if (!emp) problems.push(v.employee_number ? `No employee ${v.employee_number}` : "Employee number is required");
      const from = normaliseDate(v.effective_from ?? "");
      if (!from) problems.push(v.effective_from ? `“${v.effective_from}” is not a date` : "Effective from is required");
      const ctc = normaliseAmount(v.annual_ctc ?? "");
      if (!ctc || Number(ctc) <= 0) problems.push(v.annual_ctc ? `Annual CTC “${v.annual_ctc}” must be a positive number` : "Annual CTC is required");
      if (problems.length) return { error: problems.join("; ") };
      return { label: `${v.employee_number} → ${ctc}`, form: form({ employeeId: emp, effectiveFrom: from, annualCtc: ctc, reason: v.reason || "Bulk salary import" }) };
    },

    async "bank-accounts"(v) {
      const problems: string[] = [];
      const emp = employeeId(v.employee_number ?? "");
      if (!emp) problems.push(v.employee_number ? `No employee ${v.employee_number}` : "Employee number is required");
      if (!v.bank_name) problems.push("Bank name is required");
      if (!v.account_number) problems.push("Account number is required");
      else if (!/^\d{6,20}$/.test(v.account_number.replace(/\s/g, ""))) problems.push(`Account number “${v.account_number}” should be 6–20 digits`);
      const ifsc = (v.ifsc ?? "").toUpperCase();
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) problems.push(v.ifsc ? `“${v.ifsc}” is not a valid IFSC` : "IFSC is required");
      const primary = normaliseYesNo(v.primary ?? "", true);
      if (primary === null) problems.push(`Primary “${v.primary}” must be yes or no`);
      if (problems.length) return { error: problems.join("; ") };
      return {
        label: `${v.employee_number} ${v.bank_name}`,
        form: form({ employeeId: emp, bankName: v.bank_name, accountNumber: v.account_number.replace(/\s/g, ""), ifsc, branch: v.branch, accountHolder: v.account_holder, isPrimary: !!primary }),
      };
    },

    async bonuses(v) {
      const problems: string[] = [];
      const emp = employeeId(v.employee_number ?? "");
      if (!emp) problems.push(v.employee_number ? `No employee ${v.employee_number}` : "Employee number is required");
      const type = ref(l.bonusType, v.bonus_type ?? "", "Bonus type", true);
      if (type.error) problems.push(type.error);
      const amount = normaliseAmount(v.amount ?? "");
      if (!amount || Number(amount) <= 0) problems.push(v.amount ? `Amount “${v.amount}” must be a positive number` : "Amount is required");
      const raw = (v.payout_month ?? "").trim();
      const payout = /^\d{4}-\d{1,2}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(5).padStart(2, "0")}` : normaliseDate(raw)?.slice(0, 7) ?? null;
      if (!payout || Number(payout.slice(5)) < 1 || Number(payout.slice(5)) > 12) problems.push(raw ? `Payout month “${raw}” should look like 2026-11` : "Payout month is required");
      if (problems.length) return { error: problems.join("; ") };
      return { label: `${v.employee_number} ${v.bonus_type}`, form: form({ employeeId: emp, bonusTypeId: type.id, amount, payout, note: v.note }) };
    },

    async candidates(v) {
      const problems: string[] = [];
      const job = v.job ? l.job.get(lower(v.job)) : undefined;
      if (!v.job) problems.push("Job is required (its code, like JOB-1004)");
      else if (!job) problems.push(`No job with code ${v.job}`);
      else if (job.status !== "OPEN") problems.push(`${v.job} is not open`);
      if (!v.first_name) problems.push("First name is required");
      if (!v.last_name) problems.push("Last name is required");
      const email = lower(v.email ?? "");
      if (!email) problems.push("Email is required");
      else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push(`“${v.email}” is not an email address`);
      else if (job && seenApplications.has(`${job.id}|${email}`)) problems.push(`${v.email} appears twice for ${v.job}`);
      const num = (key: string, label: string, max: number) => {
        if (!v[key]) return undefined;
        const n = normaliseAmount(v[key]!);
        if (n === null || Number(n) < 0 || Number(n) > max) { problems.push(`${label} “${v[key]}” is not a number between 0 and ${max.toLocaleString("en-IN")}`); return undefined; }
        return n;
      };
      const experience = num("experience_years", "Experience", 50);
      const current = num("current_ctc", "Current CTC", 1e9);
      const expected = num("expected_ctc", "Expected CTC", 1e9);
      const notice = num("notice_days", "Notice period", 365);
      const source = (v.source || "DIRECT_SOURCING").toUpperCase().replace(/[\s-]+/g, "_");
      if (!["CAREER_PORTAL", "REFERRAL", "INTERNAL", "JOB_BOARD", "AGENCY", "DIRECT_SOURCING", "WALK_IN"].includes(source)) problems.push(`Source “${v.source}” is not recognised`);
      if (problems.length) return { error: problems.join("; ") };
      seenApplications.add(`${job!.id}|${email}`);
      return {
        label: `${v.first_name} ${v.last_name} → ${v.job}`,
        form: form({
          jobId: job!.id, firstName: v.first_name, lastName: v.last_name, email, phone: v.phone, currentEmployer: v.current_employer, currentTitle: v.current_title,
          totalExperienceYears: experience, currentAnnualCtc: current, expectedAnnualCtc: expected, noticePeriodDays: notice, source,
        }),
      };
    },
  };
}

const RUN: Record<ImportKind, (prev: ActionState, f: FormData) => Promise<ActionState>> = {
  employees: createEmployee,
  "leave-balances": adjustBalanceAction,
  salaries: reviseSalary,
  "bank-accounts": saveEmployeeBank,
  bonuses: scheduleBonusAction,
  candidates: addCandidateAction,
};

async function readFile(formData: FormData): Promise<{ text?: string; error?: string }> {
  const file = formData.get("file");
  if (typeof file === "string" && file.trim()) return { text: file };
  if (!file || typeof file === "string" || file.size === 0) return { error: "Choose a CSV file to upload." };
  if (file.size > MAX_BYTES) return { error: "The file is larger than 2 MB. Split it into smaller files." };
  return { text: await file.text() };
}

export interface ImportResult extends ActionState {
  checked?: number;
  imported?: number;
  /** One entry per row with a problem: the spreadsheet line and what is wrong. */
  rowErrors?: Array<{ line: number; message: string }>;
}

export async function runImportAction(_prev: ImportResult, formData: FormData): Promise<ImportResult> {
  const kind = String(formData.get("kind")) as ImportKind;
  if (!IMPORT_KINDS.includes(kind)) return { ok: false, message: "Unknown import type." };
  const spec = IMPORTS[kind];
  const viewer: Viewer = await requireAuth(spec.permission);
  const commit = formData.get("mode") === "import";

  const file = await readFile(formData);
  if (file.error) return { ok: false, message: file.error };
  const mapped = mapRows(parseCsv(file.text!), spec.columns);
  if (mapped.missing.length) return { ok: false, message: `The file is missing required column(s): ${mapped.missing.join(", ")}. Download the template for the exact headers.` };
  if (mapped.rows.length === 0) return { ok: false, message: "The file has a header row but no data rows." };
  if (mapped.rows.length > MAX_ROWS) return { ok: false, message: `The file has ${mapped.rows.length} rows; the limit is ${MAX_ROWS}. Split it into smaller files.` };
  const note = mapped.unknown.length ? ` Ignored column(s) the import does not use: ${mapped.unknown.join(", ")}.` : "";

  const l = await lookups(viewer.tenantId);
  // Candidates imported from a job's page go to that job unless a row names another.
  const pinned = kind === "candidates" && formData.get("jobId") ? await prisma.job.findFirst({ where: { id: String(formData.get("jobId")), tenantId: viewer.tenantId }, select: { id: true, code: true, status: true } }) : null;
  if (pinned && !pinned.code) return { ok: false, message: "This job has no code to import against." };
  if (pinned) l.job.set(lower(pinned.code!), pinned);
  const build = builders(l)[kind];
  const built: Array<{ line: number } & Built> = [];
  for (const r of mapped.rows) built.push({ line: r.line, ...(await build(pinned && !r.values.job ? { ...r.values, job: pinned.code! } : r.values)) });
  const rowErrors = built.flatMap((b) => ("error" in b ? [{ line: b.line, message: b.error }] : []));

  if (rowErrors.length) {
    return {
      ok: false, checked: built.length, rowErrors,
      message: `${rowErrors.length} of ${built.length} row(s) need fixing. ${commit ? "Nothing was imported." : "Nothing has been changed."}${note}`,
    };
  }
  if (!commit) return { ok: true, checked: built.length, message: `All ${built.length} row(s) look right. Import when ready.${note}` };

  let imported = 0;
  const failures: Array<{ line: number; message: string }> = [];
  for (const b of built) {
    if ("error" in b) continue;
    const f = b.form;
    // A manager created earlier in this same file now has an id.
    const managerNumber = f.get("reportingManagerNumber");
    if (typeof managerNumber === "string") {
      f.delete("reportingManagerNumber");
      const m = await prisma.employee.findFirst({ where: { tenantId: viewer.tenantId, employeeNumber: managerNumber }, select: { id: true } });
      if (!m) { failures.push({ line: b.line, message: `No employee ${managerNumber} to report to` }); continue; }
      f.set("reportingManagerId", m.id);
    }
    const res = await RUN[kind]({}, f);
    if (res.ok) imported++;
    else {
      const fields = res.errors ? Object.entries(res.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
      failures.push({ line: b.line, message: [res.message, fields].filter(Boolean).join(" — ") || "Refused" });
    }
  }
  await writeAudit(viewer, {
    module: kind === "leave-balances" ? "LEAVE" : kind === "employees" || kind === "candidates" ? "EMPLOYEE" : kind === "bonuses" ? "PAYROLL" : "FINANCE",
    action: "CREATE", entityType: "BulkImport",
    summary: `Imported ${imported} of ${built.length} ${spec.label.toLowerCase()} row(s) from CSV${failures.length ? `; ${failures.length} refused` : ""}`,
  });
  const result = done(["/admin/import", "/employees", "/leave", "/payroll/bonuses", ...(kind === "candidates" ? ["/hiring/jobs"] : [])], failures.length
    ? `Imported ${imported} of ${built.length} row(s). ${failures.length} were refused; fix those rows and import them again.`
    : `Imported all ${imported} row(s).`);
  return { ...result, ok: failures.length === 0, checked: built.length, imported, rowErrors: failures };
}
