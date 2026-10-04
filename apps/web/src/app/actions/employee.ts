"use server";

import bcrypt from "bcryptjs";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { selectStructureForCtc } from "@keka/payroll";
import { startJourney, recomputeProfileCompletion, enrolInMandatoryCourses, startProbation, requestMandatoryDocuments, emitEvent, openApproval, applySalaryRevision, requestJobChange, jobChangeLabel, jobChangeDue, beyondPlanWarning } from "@keka/services";
import { requireAuth, requireViewer } from "@/lib/context";
import { foreignReference } from "@/lib/ownership";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done, formList,
  zName, zOptional, zNumber, zRequiredNumber, zDate, zRequiredDate, zBool,
  zId, zOptionalId, zEmail, zRequiredEmail, zPan, zIfsc,
  type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

/**
 * Employee CRUD.
 *
 * Creating an employee is the one operation that touches the most subsystems:
 * it allocates a number from a series, optionally creates a login, writes the
 * first effective-dated job record, seeds a statutory profile, and lays down
 * the opening salary revision. Doing any of that partially leaves a record
 * that payroll cannot process, so the whole thing is one transaction.
 */

/** Allocate the next number from a series, inside the caller's transaction. */
async function allocateEmployeeNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  seriesId?: string | null,
): Promise<string> {
  const series = seriesId
    ? await tx.employeeNumberSeries.findFirst({ where: { id: seriesId, tenantId, isActive: true } })
    : await tx.employeeNumberSeries.findFirst({ where: { tenantId, isDefault: true, isActive: true } })
      ?? await tx.employeeNumberSeries.findFirst({ where: { tenantId, isActive: true } });

  if (!series) {
    throw new Error("No active employee number series. Create one under Organisation → Employee numbering.");
  }

  // Migrated or manually-entered numbers may already occupy slots, so step
  // past them. Bounded rather than recursive: a misconfigured series must fail
  // with a clear message, not exhaust the stack.
  const MAX_PROBES = 1000;
  let candidate = series.nextNumber;

  for (let probe = 0; probe < MAX_PROBES; probe++) {
    const value = `${series.prefix}${String(candidate).padStart(series.digits, "0")}${series.suffix}`;
    const clash = await tx.employee.findFirst({
      where: { tenantId, employeeNumber: value }, select: { id: true },
    });
    if (!clash) {
      await tx.employeeNumberSeries.update({
        where: { id: series.id },
        data: { nextNumber: candidate + 1 },
      });
      return value;
    }
    candidate++;
  }

  throw new Error(
    `Could not find a free employee number after ${MAX_PROBES} attempts on series "${series.name}". ` +
    `Check its next-number value under Organisation → Employee numbering.`,
  );
}

/** Profile completeness, recomputed whenever the record changes (one definition, in services). */
async function recomputeCompletion(employeeId: string): Promise<void> {
  await recomputeProfileCompletion(employeeId);
}

/** Guard: can the caller act on this specific employee record? */
async function assertEmployeeAccess(
  viewerPromise: ReturnType<typeof requireAuth>,
  employeeId: string,
  permission: (typeof P)[keyof typeof P],
) {
  const viewer = await viewerPromise;
  const target = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: {
      id: true, departmentId: true, locationId: true,
      legalEntityId: true, businessUnitId: true, reportingManagerId: true,
      displayName: true, employeeNumber: true,
    },
  });
  if (!target) return { viewer, target: null as never, denied: "Employee not found" };
  if (!canAccessEmployee(viewer, target, permission)) {
    return { viewer, target, denied: "Your roles do not reach this employee record." };
  }
  return { viewer, target, denied: null };
}

// ---------------------------------------------------------------------------
//  CREATE
// ---------------------------------------------------------------------------

const createSchema = z.object({
  // Step 1 — basic details
  firstName: zName(60),
  middleName: zOptional(60),
  lastName: zName(60),
  workEmail: zRequiredEmail(),
  personalEmail: zEmail(),
  mobile: zOptional(20),
  dateOfBirth: zDate(),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNDISCLOSED"]).optional(),
  maritalStatus: z.enum(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "UNDISCLOSED"]).optional(),

  // Step 2 — job details
  dateOfJoining: zRequiredDate(),
  jobTitleId: zOptionalId(),
  legalEntityId: zId(),
  businessUnitId: zOptionalId(),
  departmentId: zOptionalId(),
  locationId: zId(),
  costCenterId: zOptionalId(),
  bandId: zOptionalId(),
  payGradeId: zOptionalId(),
  workerTypeId: zOptionalId(),
  reportingManagerId: zOptionalId(),
  status: z.enum(["PROBATION", "CONFIRMED", "ONBOARDING", "PREBOARDING"]).default("PROBATION"),

  // Step 3 — work details
  numberSeriesId: zOptionalId(),
  employeeNumberOverride: zOptional(30),
  attendanceNumber: zOptional(20),
  inviteToPortal: zBool(),
  leavePlanId: zOptionalId(),

  // Step 4 — compensation
  payGroupId: zOptionalId(),
  annualCtc: zNumber({ min: 0 }),
  salaryStructureId: zOptionalId(),
  taxRegime: z.enum(["OLD", "NEW"]).default("NEW"),
});

export async function createEmployee(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_CREATE);
  const parsed = parseForm(createSchema, formData);
  if (parsed.state) return parsed.state;
  {
    const d0 = parsed.data;
    const foreign = await foreignReference(viewer.tenantId, {
      department: d0.departmentId, businessUnit: d0.businessUnitId, costCenter: d0.costCenterId, band: d0.bandId, payGrade: d0.payGradeId,
      workerType: d0.workerTypeId, jobTitle: d0.jobTitleId, employee: d0.reportingManagerId, payGroup: d0.payGroupId,
      salaryStructure: d0.salaryStructureId, leavePlan: d0.leavePlanId, numberSeries: d0.numberSeriesId,
    });
    if (foreign) return { ok: false, message: foreign };
  }
  const d = parsed.data;

  // Cross-field checks the schema cannot express.
  if (d.annualCtc && d.annualCtc > 0 && !d.payGroupId) {
    return {
      ok: false,
      message: "A salary needs a pay group — that is what carries the statutory configuration.",
      errors: { payGroupId: "Required when a salary is set" },
      values: formData ? Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)])) : undefined,
    };
  }

  try {
    const employeeId = await prisma.$transaction(async (tx) => {
      // Validate the referenced org objects belong to this tenant.
      const entity = await tx.legalEntity.findFirst({
        where: { id: d.legalEntityId, tenantId: viewer.tenantId }, select: { id: true },
      });
      if (!entity) throw new Error("Legal entity not found");
      const location = await tx.location.findFirst({
        where: { id: d.locationId, tenantId: viewer.tenantId }, select: { id: true, stateCode: true },
      });
      if (!location) throw new Error("Location not found");
      if (!location.stateCode) {
        throw new Error("That location has no state set, so Professional Tax cannot be determined. Set it first.");
      }

      const employeeNumber = d.employeeNumberOverride
        ?? await allocateEmployeeNumber(tx, viewer.tenantId, d.numberSeriesId);

      // A login is optional at creation; an employee can be invited later.
      let userId: string | null = null;
      if (d.inviteToPortal) {
        const existing = await tx.user.findFirst({
          where: { tenantId: viewer.tenantId, email: d.workEmail },
        });
        if (existing) throw new Error(`A login already exists for ${d.workEmail}`);
        // A random unusable password: the invite flow sets a real one.
        const placeholder = await bcrypt.hash(`invite-${employeeNumber}-${Date.now()}`, 10);
        const user = await tx.user.create({
          data: {
            tenantId: viewer.tenantId, email: d.workEmail,
            passwordHash: placeholder, phone: d.mobile,
          },
        });
        userId = user.id;
      }

      const jobTitleName = d.jobTitleId
        ? (await tx.jobTitle.findUnique({ where: { id: d.jobTitleId }, select: { name: true } }))?.name ?? null
        : null;

      const employee = await tx.employee.create({
        data: {
          tenantId: viewer.tenantId,
          employeeNumber,
          attendanceNumber: d.attendanceNumber,
          userId,
          firstName: d.firstName, middleName: d.middleName, lastName: d.lastName,
          displayName: [d.firstName, d.lastName].filter(Boolean).join(" "),
          workEmail: d.workEmail, personalEmail: d.personalEmail, mobile: d.mobile,
          dateOfBirth: d.dateOfBirth, gender: d.gender, maritalStatus: d.maritalStatus,
          status: d.status,
          dateOfJoining: d.dateOfJoining,
          legalEntityId: d.legalEntityId,
          businessUnitId: d.businessUnitId,
          departmentId: d.departmentId,
          locationId: d.locationId,
          costCenterId: d.costCenterId,
          bandId: d.bandId,
          payGradeId: d.payGradeId,
          workerTypeId: d.workerTypeId,
          reportingManagerId: d.reportingManagerId,
          jobTitleName,
          payGroupId: d.payGroupId,
          // The first effective-dated job record — this is what change history
          // is built from, so it has to exist from day one.
          jobHistory: {
            create: [{
              effectiveFrom: d.dateOfJoining,
              reason: "NEW_HIRE",
              jobTitleId: d.jobTitleId,
              departmentId: d.departmentId,
              businessUnitId: d.businessUnitId,
              locationId: d.locationId,
              legalEntityId: d.legalEntityId,
              bandId: d.bandId,
              payGradeId: d.payGradeId,
              workerTypeId: d.workerTypeId,
              reportingManagerId: d.reportingManagerId,
              note: "Initial appointment",
              createdBy: viewer.user.id,
            }],
          },
          // Statutory defaults; PF and ESI applicability are recomputed by the
          // engine from the actual wage each run.
          statutoryProfile: {
            create: {
              pfEnabled: true, esiEnabled: true, ptEnabled: true, lwfEnabled: true,
              taxRegime: d.taxRegime,
            },
          },
        },
      });

      // Opening compensation.
      if (d.annualCtc && d.annualCtc > 0 && d.payGroupId) {
        let structureId = d.salaryStructureId;
        if (!structureId) {
          // Pick the range-based structure whose band contains this CTC.
          const structures = await tx.salaryStructure.findMany({
            where: { payGroupId: d.payGroupId, isActive: true },
            select: { id: true, minAnnualCtc: true, maxAnnualCtc: true, isDefault: true },
          });
          const chosen = selectStructureForCtc(
            structures.map((s) => ({
              ...s,
              minAnnualCtc: s.minAnnualCtc === null ? null : Number(s.minAnnualCtc),
              maxAnnualCtc: s.maxAnnualCtc === null ? null : Number(s.maxAnnualCtc),
            })),
            d.annualCtc,
          );
          structureId = chosen?.id ?? null;
        }
        if (!structureId) {
          throw new Error("No salary structure covers that CTC. Add one to the pay group first.");
        }
        await tx.salaryRevision.create({
          data: {
            employeeId: employee.id,
            structureId,
            effectiveFrom: d.dateOfJoining,
            annualCtc: d.annualCtc,
            remunerationType: "MONTHLY",
            status: "APPLIED",
            reason: "Initial compensation on joining",
            createdBy: viewer.user.id,
          },
        });
      }

      // Leave plan assignment.
      if (d.leavePlanId) {
        await tx.leavePlanAssignment.create({
          data: {
            planId: d.leavePlanId, employeeId: employee.id,
            effectiveFrom: d.dateOfJoining,
          },
        });
      }

      return employee.id;
    }, { timeout: 30_000 });

    await recomputeCompletion(employeeId);

    const created = await prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { employeeNumber: true, displayName: true },
    });

    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "CREATE", entityType: "Employee", entityId: employeeId,
      summary: `Created employee ${created.employeeNumber} ${created.displayName}`,
      newValue: { employeeNumber: created.employeeNumber, annualCtc: d.annualCtc },
    });

    // Joining is an event: start the onboarding journey it calls for.
    const journey = await startJourney({
      employeeId, trigger: "JOINING", anchorDate: d.dateOfJoining, createdBy: viewer.user.id,
      sourceType: "Employee", sourceId: employeeId,
    });
    // ...and enrol them in the courses everyone must take.
    await enrolInMandatoryCourses(viewer.tenantId, employeeId, viewer.employee?.id ?? null);
    // ...and a joiner on probation starts the default probation policy's clock.
    const probation = d.status === "PROBATION" ? await startProbation({ employeeId }) : null;
    // ...and ask them for the documents everyone must provide.
    const docs = await requestMandatoryDocuments(employeeId);
    await emitEvent(viewer.tenantId, "employee.created", {
      employeeId, employeeNumber: created.employeeNumber, displayName: created.displayName, dateOfJoining: d.dateOfJoining.toISOString().slice(0, 10), status: d.status,
    });

    return done(
      ["/employees", "/org", "/", "/onboarding"],
      `Created ${created.displayName} as ${created.employeeNumber}.` +
        (d.inviteToPortal ? " A login was created — send them a password reset to activate it." : "") +
        (journey.created ? ` Onboarding started with ${journey.tasks} task(s).` : "") +
        (probation?.created ? ` ${probation.message}` : "") +
        (docs ? ` Requested ${docs} mandatory document(s).` : "") +
        // Hiring past the department's active workforce plan is allowed, but flagged.
        (await beyondPlanWarning(viewer.tenantId, d.departmentId)),
    );
  } catch (err) {
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  EDIT — personal details
// ---------------------------------------------------------------------------

const personalSchema = z.object({
  employeeId: zId(),
  firstName: zName(60),
  middleName: zOptional(60),
  lastName: zName(60),
  displayName: zOptional(120),
  workEmail: zEmail(),
  personalEmail: zEmail(),
  mobile: zOptional(20),
  alternatePhone: zOptional(20),
  dateOfBirth: zDate(),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNDISCLOSED"]).optional(),
  maritalStatus: z.enum(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "UNDISCLOSED"]).optional(),
  bloodGroup: z.enum(["A_POS","A_NEG","B_POS","B_NEG","AB_POS","AB_NEG","O_POS","O_NEG","UNKNOWN"]).optional(),
  nationality: zOptional(60),
});

export async function updatePersonalDetails(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(personalSchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, ...data } = parsed.data;

  const { viewer, target, denied } = await assertEmployeeAccess(
    requireAuth(P.EMPLOYEE_UPDATE), employeeId, P.EMPLOYEE_UPDATE,
  );
  if (denied) return { ok: false, message: denied };

  try {
    await prisma.employee.update({
      where: { id: employeeId },
      data: {
        ...data,
        displayName: data.displayName ?? [data.firstName, data.lastName].filter(Boolean).join(" "),
      },
    });
    await recomputeCompletion(employeeId);
    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "UPDATE", entityType: "Employee", entityId: employeeId,
      summary: `Updated personal details for ${target.employeeNumber}`,
    });
    return done([`/employees/${employeeId}`, "/employees"], "Saved.");
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

// ---------------------------------------------------------------------------
//  EDIT — job change, effective-dated
// ---------------------------------------------------------------------------

const jobChangeSchema = z.object({
  employeeId: zId(),
  effectiveFrom: zRequiredDate(),
  reason: z.enum([
    "PROMOTION", "TRANSFER", "DEPARTMENT_CHANGE", "LOCATION_CHANGE",
    "MANAGER_CHANGE", "CONFIRMATION", "DEMOTION", "WORKER_TYPE_CHANGE",
  ]),
  jobTitleId: zOptionalId(),
  departmentId: zOptionalId(),
  businessUnitId: zOptionalId(),
  locationId: zOptionalId(),
  legalEntityId: zOptionalId(),
  bandId: zOptionalId(),
  payGradeId: zOptionalId(),
  workerTypeId: zOptionalId(),
  reportingManagerId: zOptionalId(),
  note: zOptional(400),
  /// Also record it on the HR activity timeline.
  logActivity: zBool(),
  /// Wait for the effective date rather than writing the record now (bulk import).
  holdUntilEffective: zBool(),
});

/**
 * There is no separate transfer or promotion module. A position change is an
 * effective-dated job record plus an update to the denormalised fields the
 * rest of the system reads. When the employee's pay group has a job-change
 * approval rule the change waits for its chain (and then for its effective
 * date, if that is still ahead); otherwise it is written straight away. The
 * bulk import asks for future-dated rows to wait for their date
 * (`holdUntilEffective`), so its job records appear on the day they start.
 */
export async function recordJobChange(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(jobChangeSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;

  const { viewer, target, denied } = await assertEmployeeAccess(
    requireAuth(P.EMPLOYEE_UPDATE), d.employeeId, P.EMPLOYEE_UPDATE,
  );
  if (denied) return { ok: false, message: denied };
  const foreign = await foreignReference(viewer.tenantId, {
    department: d.departmentId, location: d.locationId, businessUnit: d.businessUnitId, legalEntity: d.legalEntityId,
    jobTitle: d.jobTitleId, band: d.bandId, payGrade: d.payGradeId, workerType: d.workerTypeId, employee: d.reportingManagerId,
  });
  if (foreign) return { ok: false, message: foreign };
  if (d.reportingManagerId === d.employeeId) {
    return { ok: false, message: "Someone cannot report to themselves.", errors: { reportingManagerId: "Choose someone else" } };
  }
  if (await prisma.jobChange.count({ where: { employeeId: d.employeeId, status: "PENDING_APPROVAL" } })) {
    return { ok: false, message: "A job change for this employee is already waiting for approval. Approve, reject or withdraw it first." };
  }

  const before = await prisma.employee.findUniqueOrThrow({
    where: { id: d.employeeId },
    include: { department: { select: { name: true } }, location: { select: { name: true } } },
  });
  const day = d.effectiveFrom.toISOString().slice(0, 10);
  const what = d.reason.replace(/_/g, " ").toLowerCase();

  try {
    const { holdUntilEffective, employeeId: _e, ...fields } = d;
    const res = await requestJobChange({
      tenantId: viewer.tenantId, employeeId: d.employeeId, requestedBy: viewer.user.id, fields,
      source: holdUntilEffective ? "IMPORT" : "MANUAL", holdUntilEffective,
      summary: `${jobChangeLabel(d.reason)} for ${target.employeeNumber} (${before.displayName ?? before.firstName}) from ${day}`,
    });
    const state = res.applied?.stateChange;
    const note = state
      ? ` Their state changed from ${state.from ?? "none"} to ${state.to ?? "none"}, so Professional Tax and LWF will follow the new state from the next run.`
      : "";

    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "UPDATE", entityType: res.status === "APPLIED" ? "EmployeeJobRecord" : "JobChange",
      entityId: res.status === "APPLIED" ? d.employeeId : res.jobChangeId,
      summary: res.status === "PENDING_APPROVAL"
        ? `Requested ${what} for ${target.employeeNumber}, effective ${day} — sent for approval`
        : res.status === "SCHEDULED"
          ? `Scheduled ${what} for ${target.employeeNumber}, effective ${day}`
          : `${what} for ${target.employeeNumber}, effective ${day}${note}`,
      oldValue: { jobTitle: before.jobTitleName, department: before.department?.name, location: before.location?.name },
    });

    return done(
      [`/employees/${d.employeeId}`, "/employees", "/activities", "/onboarding", "/inbox", "/payroll/approvals"],
      res.status === "PENDING_APPROVAL"
        ? `Sent for approval. The change takes effect once every approver in the job-change chain signs off${jobChangeDue(d.effectiveFrom) ? "" : `, on ${day}`}.`
        : res.status === "SCHEDULED"
          ? `Scheduled. The job record is written on ${day}.`
          : `Recorded the change effective ${day}.${note}` +
            (res.applied?.journeyTasks ? ` ${res.applied.journeyTasks} follow-up task(s) were created.` : ""),
    );
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

// ---------------------------------------------------------------------------
//  EDIT — salary revision
// ---------------------------------------------------------------------------

const revisionSchema = z.object({
  employeeId: zId(),
  effectiveFrom: zRequiredDate(),
  annualCtc: zRequiredNumber({ min: 1 }),
  structureId: zOptionalId(),
  reason: zOptional(300),
});

/**
 * A revision effective in a past period does not change that month's salary —
 * it produces arrears, which the run picks up in step 5. Raising the arrear
 * here is what makes that work.
 */
export async function reviseSalary(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(revisionSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;

  const { viewer, target, denied } = await assertEmployeeAccess(
    requireAuth(P.SALARY_REVISE), d.employeeId, P.EMPLOYEE_VIEW_FINANCIALS,
  );
  if (denied) return { ok: false, message: denied };

  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: d.employeeId },
    include: {
      payGroup: { select: { id: true } },
      salaryRevisions: { where: { status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, take: 1 },
    },
  });
  if (!employee.payGroupId) {
    return { ok: false, message: "Assign a pay group before setting a salary." };
  }
  // A chosen structure must be one of the employee's own pay group's.
  if (d.structureId && !(await prisma.salaryStructure.count({ where: { id: d.structureId, payGroupId: employee.payGroupId } }))) {
    return { ok: false, message: "That structure is not in the employee's pay group.", errors: { structureId: "Not in this pay group" } };
  }

  const previous = employee.salaryRevisions[0];
  const previousCtc = previous ? Number(previous.annualCtc) : null;

  try {
    let structureId = d.structureId;
    if (!structureId) {
      const structures = await prisma.salaryStructure.findMany({
        where: { payGroupId: employee.payGroupId, isActive: true },
        select: { id: true, minAnnualCtc: true, maxAnnualCtc: true, isDefault: true },
      });
      const chosen = selectStructureForCtc(
        structures.map((s) => ({
          ...s,
          minAnnualCtc: s.minAnnualCtc === null ? null : Number(s.minAnnualCtc),
          maxAnnualCtc: s.maxAnnualCtc === null ? null : Number(s.maxAnnualCtc),
        })),
        d.annualCtc,
      );
      structureId = chosen?.id ?? previous?.structureId ?? null;
    }
    if (!structureId) {
      return { ok: false, message: "No salary structure covers that CTC. Add one to the pay group first." };
    }

    if (await prisma.salaryRevision.count({ where: { employeeId: d.employeeId, status: "PENDING_APPROVAL" } })) {
      return { ok: false, message: "A salary change for this employee is already waiting for approval. Approve, reject or withdraw it first." };
    }

    const revision = await prisma.salaryRevision.create({
      data: {
        employeeId: d.employeeId,
        structureId,
        effectiveFrom: d.effectiveFrom,
        annualCtc: d.annualCtc,
        previousCtc,
        remunerationType: previous?.remunerationType ?? "MONTHLY",
        status: "PENDING_APPROVAL",
        reason: d.reason,
        createdBy: viewer.user.id,
      },
    });

    const pct = previousCtc && previousCtc > 0
      ? (((d.annualCtc - previousCtc) / previousCtc) * 100).toFixed(1)
      : null;
    const summary = `Salary change for ${target.employeeNumber}: ${d.annualCtc.toLocaleString("en-IN")}${pct ? ` (${pct}%)` : ""} from ${d.effectiveFrom.toISOString().slice(0, 10)}`;

    // Maker-checker: with a compensation-change rule on the pay group the
    // revision waits for its approval chain; otherwise it applies now.
    const approval = await openApproval({
      tenantId: viewer.tenantId, payGroupId: employee.payGroupId, action: "COMPENSATION_CHANGE", requestedBy: viewer.user.id,
      revisionId: revision.id, employeeId: d.employeeId, summary, link: "/payroll/approvals",
    });
    const pending = approval.required && approval.status === "PENDING";
    const applied = pending ? null : await prisma.$transaction((tx) => applySalaryRevision(revision.id, tx));

    await writeAudit(viewer, {
      module: "PAYROLL", action: "UPDATE", entityType: "SalaryRevision", entityId: d.employeeId,
      summary: `${pending ? "Requested" : "Revised"} ${target.employeeNumber} to ${d.annualCtc}${pct ? ` (${pct}%)` : ""}, effective ${d.effectiveFrom.toISOString().slice(0, 10)}${applied?.arrears ? " — arrears raised" : ""}${pending ? " — sent for approval" : ""}`,
      oldValue: { annualCtc: previousCtc },
      newValue: { annualCtc: d.annualCtc },
    });

    return done(
      [`/employees/${d.employeeId}`, "/employees", "/payroll/runs", "/payroll/approvals"],
      pending
        ? `Sent for approval${pct ? ` (${pct}%)` : ""}. It takes effect once every approver in the compensation-change chain signs off.`
        : applied?.backdated
          ? `Saved${pct ? ` (${pct}%)` : ""}. This is back-dated past a finalised run, so arrears were raised and will appear in step 5 of the next payroll.`
          : `Saved${pct ? ` (${pct}%)` : ""}. It takes effect from the run covering ${d.effectiveFrom.toISOString().slice(0, 10)}.`,
    );
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

// ---------------------------------------------------------------------------
//  SUB-RECORDS — address, identity, bank, education, experience, dependents
// ---------------------------------------------------------------------------

const addressSchema = z.object({
  employeeId: zId(),
  type: z.enum(["CURRENT", "PERMANENT", "EMERGENCY"]),
  line1: zName(200),
  line2: zOptional(200),
  city: zOptional(80),
  state: zOptional(80),
  stateCode: zOptional(4),
  postalCode: zOptional(12),
});

export async function saveAddress(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(addressSchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, type, ...rest } = parsed.data;

  const { denied } = await assertEmployeeAccess(
    requireAuth(P.EMPLOYEE_UPDATE), employeeId, P.EMPLOYEE_UPDATE,
  );
  if (denied) return { ok: false, message: denied };

  try {
    await prisma.employeeAddress.upsert({
      where: { employeeId_type: { employeeId, type } },
      create: { employeeId, type, ...rest },
      update: rest,
    });
    await recomputeCompletion(employeeId);
    return done([`/employees/${employeeId}`], `Saved the ${type.toLowerCase()} address.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

const identitySchema = z.object({
  employeeId: zId(),
  type: z.enum(["PAN", "AADHAAR", "VOTER_ID", "DRIVING_LICENCE", "PASSPORT", "UAN", "ESIC_NUMBER"]),
  number: zName(30),
  nameOnDoc: zOptional(120),
  issuedDate: zDate(),
  expiryDate: zDate(),
});

export async function saveIdentity(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(identitySchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, type, ...rest } = parsed.data;

  const { viewer, denied } = await assertEmployeeAccess(
    requireAuth(P.EMPLOYEE_UPDATE), employeeId, P.EMPLOYEE_UPDATE,
  );
  if (denied) return { ok: false, message: denied };

  // PAN is the payslip password and the key Form 16 files are matched on, so
  // validate its shape rather than accepting anything.
  if (type === "PAN") {
    const up = rest.number.toUpperCase();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(up)) {
      return {
        ok: false, message: "PAN must be 5 letters, 4 digits, then 1 letter.",
        errors: { number: "Invalid PAN format" },
      };
    }
    rest.number = up;
  }
  if (type === "AADHAAR" && !/^\d{12}$/.test(rest.number)) {
    return {
      ok: false, message: "Aadhaar must be 12 digits.",
      errors: { number: "Must be 12 digits" },
    };
  }

  try {
    await prisma.employeeIdentity.upsert({
      where: { employeeId_type: { employeeId, type } },
      create: { employeeId, type, ...rest },
      update: rest,
    });
    // Keep the statutory profile's UAN and ESIC in step.
    if (type === "UAN") {
      await prisma.employeeStatutoryProfile.upsert({
        where: { employeeId },
        create: { employeeId, uan: rest.number },
        update: { uan: rest.number },
      });
    }
    if (type === "ESIC_NUMBER") {
      await prisma.employeeStatutoryProfile.upsert({
        where: { employeeId },
        create: { employeeId, esicNumber: rest.number },
        update: { esicNumber: rest.number },
      });
    }
    await recomputeCompletion(employeeId);
    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeIdentity", entityId: employeeId,
      summary: `Recorded ${type.replace(/_/g, " ")} for an employee`,
    });
    return done([`/employees/${employeeId}`], `Saved the ${type.replace(/_/g, " ").toLowerCase()}.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

const bankSchema = z.object({
  employeeId: zId(),
  bankName: zName(120),
  accountNumber: zName(30),
  ifsc: zIfsc(),
  branch: zOptional(120),
  accountHolder: zOptional(120),
  isPrimary: zBool(),
});

export async function saveEmployeeBank(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(bankSchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, isPrimary, ...rest } = parsed.data;
  if (!rest.ifsc) {
    return { ok: false, message: "IFSC is required", errors: { ifsc: "Required" } };
  }

  const { viewer, denied } = await assertEmployeeAccess(
    requireAuth(P.EMPLOYEE_MANAGE_FINANCIALS), employeeId, P.EMPLOYEE_MANAGE_FINANCIALS,
  );
  if (denied) return { ok: false, message: denied };

  try {
    await prisma.$transaction(async (tx) => {
      if (isPrimary) {
        await tx.employeeBankAccount.updateMany({
          where: { employeeId }, data: { isPrimary: false },
        });
      }
      await tx.employeeBankAccount.create({
        data: { employeeId, isPrimary, ...rest, ifsc: rest.ifsc as string },
      });
    });
    await recomputeCompletion(employeeId);
    await writeAudit(viewer, {
      module: "FINANCE", action: "UPDATE", entityType: "EmployeeBankAccount", entityId: employeeId,
      summary: `Added a bank account for an employee (${rest.bankName})`,
    });
    return done([`/employees/${employeeId}`], `Added ${rest.bankName}.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

const educationSchema = z.object({
  employeeId: zId(),
  institution: zName(160),
  degree: zOptional(120),
  specialization: zOptional(120),
  fromYear: zNumber({ min: 1950, max: 2100 }),
  toYear: zNumber({ min: 1950, max: 2100 }),
  grade: zOptional(30),
});

export async function addEducation(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(educationSchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, ...rest } = parsed.data;
  const { denied } = await assertEmployeeAccess(
    requireAuth(P.EMPLOYEE_UPDATE), employeeId, P.EMPLOYEE_UPDATE,
  );
  if (denied) return { ok: false, message: denied };
  try {
    await prisma.employeeEducation.create({ data: { employeeId, ...rest } });
    return done([`/employees/${employeeId}`], "Added the qualification.");
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

const experienceSchema = z.object({
  employeeId: zId(),
  companyName: zName(160),
  jobTitle: zOptional(120),
  fromDate: zDate(),
  toDate: zDate(),
  description: zOptional(400),
});

export async function addExperience(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(experienceSchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, ...rest } = parsed.data;
  const { denied } = await assertEmployeeAccess(
    requireAuth(P.EMPLOYEE_UPDATE), employeeId, P.EMPLOYEE_UPDATE,
  );
  if (denied) return { ok: false, message: denied };
  try {
    await prisma.employeeExperience.create({ data: { employeeId, ...rest } });
    return done([`/employees/${employeeId}`], "Added the prior role.");
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

const dependentSchema = z.object({
  employeeId: zId(),
  name: zName(120),
  relationship: zName(40),
  dateOfBirth: zDate(),
  isNominee: zBool(),
});

export async function addDependent(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(dependentSchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, ...rest } = parsed.data;
  const { denied } = await assertEmployeeAccess(
    requireAuth(P.EMPLOYEE_UPDATE), employeeId, P.EMPLOYEE_UPDATE,
  );
  if (denied) return { ok: false, message: denied };
  try {
    await prisma.dependent.create({ data: { employeeId, ...rest } });
    return done([`/employees/${employeeId}`], "Added the dependent.");
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

const emergencySchema = z.object({
  employeeId: zId(),
  name: zName(120),
  relationship: zName(40),
  phone: zName(20),
  email: zEmail(),
  isPrimary: zBool(),
});

export async function addEmergencyContact(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(emergencySchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, ...rest } = parsed.data;
  const { denied } = await assertEmployeeAccess(
    requireAuth(P.EMPLOYEE_UPDATE), employeeId, P.EMPLOYEE_UPDATE,
  );
  if (denied) return { ok: false, message: denied };
  try {
    await prisma.emergencyContact.create({ data: { employeeId, ...rest } });
    return done([`/employees/${employeeId}`], "Added the emergency contact.");
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

export async function deleteSubRecord(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const kind = String(formData.get("kind"));
  const id = String(formData.get("id"));
  const employeeId = String(formData.get("employeeId"));

  const { denied } = await assertEmployeeAccess(
    Promise.resolve(viewer) as never, employeeId, P.EMPLOYEE_UPDATE,
  );
  if (denied) return { ok: false, message: denied };

  const deleters: Record<string, () => Promise<unknown>> = {
    address: () => prisma.employeeAddress.deleteMany({ where: { id, employeeId } }),
    identity: () => prisma.employeeIdentity.deleteMany({ where: { id, employeeId } }),
    bank: () => prisma.employeeBankAccount.deleteMany({ where: { id, employeeId } }),
    education: () => prisma.employeeEducation.deleteMany({ where: { id, employeeId } }),
    experience: () => prisma.employeeExperience.deleteMany({ where: { id, employeeId } }),
    dependent: () => prisma.dependent.deleteMany({ where: { id, employeeId } }),
    emergency: () => prisma.emergencyContact.deleteMany({ where: { id, employeeId } }),
  };
  const fn = deleters[kind];
  if (!fn) return { ok: false, message: "Unknown record type" };
  await fn();
  await recomputeCompletion(employeeId);
  return done([`/employees/${employeeId}`], "Removed.");
}

// ---------------------------------------------------------------------------
//  ACCESS — invite, disable login, deactivate
// ---------------------------------------------------------------------------

export async function inviteToPortal(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_INVITE);
  const employeeId = String(formData.get("employeeId"));

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    include: { user: true },
  });
  if (!employee) return { ok: false, message: "Employee not found" };
  if (employee.user) return { ok: false, message: "This employee already has a login." };
  if (!employee.workEmail) return { ok: false, message: "Set a work email before inviting them." };

  try {
    const placeholder = await bcrypt.hash(`invite-${employee.employeeNumber}-${Date.now()}`, 10);
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId: viewer.tenantId,
          email: employee.workEmail!,
          passwordHash: placeholder,
          phone: employee.mobile,
        },
      });
      await tx.employee.update({ where: { id: employeeId }, data: { userId: user.id } });
    });
    await writeAudit(viewer, {
      module: "AUTH", action: "CREATE", entityType: "User", entityId: employeeId,
      summary: `Created a login for ${employee.employeeNumber} ${employee.displayName}`,
    });
    return done(
      [`/employees/${employeeId}`, "/employees"],
      `Created a login for ${employee.workEmail}. They need a password reset to activate it — no email is sent yet.`,
    );
  } catch (err) {
    return toErrorState(err);
  }
}

export async function setLoginAccess(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_DISABLE_LOGIN);
  const employeeId = String(formData.get("employeeId"));
  const mode = String(formData.get("mode")); // disable | enable | deactivate | reactivate

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    include: { user: true },
  });
  if (!employee) return { ok: false, message: "Employee not found" };
  if (!employee.user) return { ok: false, message: "This employee has no login." };
  if (employee.user.id === viewer.user.id) {
    return { ok: false, message: "You cannot disable your own login." };
  }

  const data =
    mode === "disable" ? { loginDisabled: true }
    : mode === "enable" ? { loginDisabled: false }
    : mode === "deactivate" ? { isDeactivated: true }
    : { isDeactivated: false };

  await prisma.user.update({ where: { id: employee.user.id }, data });
  await writeAudit(viewer, {
    module: "AUTH", action: "UPDATE", entityType: "User", entityId: employee.user.id,
    summary: `${mode === "disable" ? "Disabled login for" : mode === "enable" ? "Re-enabled login for" : mode === "deactivate" ? "Deactivated" : "Reactivated"} ${employee.employeeNumber} ${employee.displayName}`,
    newValue: data,
  });

  return done(
    [`/employees/${employeeId}`, "/employees"],
    mode === "disable"
      ? "Login disabled. It takes effect immediately — there is no grace period."
      : mode === "enable" ? "Login re-enabled."
      : mode === "deactivate" ? "Account deactivated."
      : "Account reactivated.",
  );
}

// ---------------------------------------------------------------------------
//  STATUTORY PROFILE
// ---------------------------------------------------------------------------

const statutorySchema = z.object({
  employeeId: zId(),
  pfEnabled: zBool(),
  uan: zOptional(20),
  pfAccountNumber: zOptional(40),
  vpfAmount: zNumber({ min: 0 }),
  vpfPercent: zNumber({ min: 0, max: 100 }),
  epsApplicable: zBool(),
  esiEnabled: zBool(),
  esicNumber: zOptional(20),
  ptEnabled: zBool(),
  lwfEnabled: zBool(),
  taxRegime: z.enum(["OLD", "NEW"]),
  flatTdsAmount: zNumber({ min: 0 }),
  tdsDisabled: zBool(),
  previousEmployerIncome: zNumber({ min: 0 }),
  previousEmployerTds: zNumber({ min: 0 }),
});

export async function saveStatutoryProfile(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(statutorySchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, ...data } = parsed.data;

  const { viewer, target, denied } = await assertEmployeeAccess(
    requireAuth(P.EMPLOYEE_MANAGE_FINANCIALS), employeeId, P.EMPLOYEE_MANAGE_FINANCIALS,
  );
  if (denied) return { ok: false, message: denied };

  // VPF as both an amount and a percentage is ambiguous; the engine prefers
  // the amount, so refuse rather than silently ignoring one.
  if (data.vpfAmount && data.vpfPercent) {
    return {
      ok: false,
      message: "Set VPF as either an amount or a percentage, not both.",
      errors: { vpfPercent: "Clear one of the two" },
    };
  }

  const before = await prisma.employeeStatutoryProfile.findUnique({ where: { employeeId } });

  try {
    await prisma.employeeStatutoryProfile.upsert({
      where: { employeeId },
      create: { employeeId, ...data },
      update: data,
    });
    const regimeChanged = before && before.taxRegime !== data.taxRegime;
    await writeAudit(viewer, {
      module: "PAYROLL", action: "UPDATE", entityType: "EmployeeStatutoryProfile", entityId: employeeId,
      summary: `Updated statutory profile for ${target.employeeNumber}${regimeChanged ? ` — tax regime ${before!.taxRegime} → ${data.taxRegime}` : ""}`,
      oldValue: before ? { taxRegime: before.taxRegime, pfEnabled: before.pfEnabled } : undefined,
      newValue: { taxRegime: data.taxRegime, pfEnabled: data.pfEnabled },
    });
    return done(
      [`/employees/${employeeId}`, "/payroll/runs"],
      regimeChanged
        ? `Saved. The regime change recalculates their TDS from the next run.`
        : "Saved.",
    );
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

// ---------------------------------------------------------------------------
//  BULK
// ---------------------------------------------------------------------------

export async function bulkAssignPayGroup(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_MANAGE_FINANCIALS);
  const payGroupId = String(formData.get("payGroupId"));
  const employeeIds = formList(formData, "employeeIds");

  if (employeeIds.length === 0) return { ok: false, message: "Select at least one employee." };

  const payGroup = await prisma.payGroup.findFirst({
    where: { id: payGroupId, tenantId: viewer.tenantId },
    select: { id: true, name: true, legalEntityId: true },
  });
  if (!payGroup) return { ok: false, message: "Pay group not found" };

  // Moving pay group synchronises the legal entity — that is the documented
  // mechanism for moving someone between companies.
  const updated = await prisma.employee.updateMany({
    where: { id: { in: employeeIds }, tenantId: viewer.tenantId },
    data: { payGroupId, legalEntityId: payGroup.legalEntityId },
  });

  await writeAudit(viewer, {
    module: "PAYROLL", action: "UPDATE", entityType: "Employee",
    summary: `Moved ${updated.count} employee(s) to pay group ${payGroup.name}, synchronising their legal entity`,
  });

  return done(
    ["/employees", "/payroll/pay-groups"],
    `Moved ${updated.count} employee(s) to ${payGroup.name}. Their legal entity was synchronised to match.`,
  );
}
