/**
 * Employee lifecycle through the real actions: create, edit, promote, revise
 * salary, and confirm the new record actually processes in a payroll run.
 *
 * A create form that produces a record payroll cannot pay is the failure mode
 * worth guarding against, so the last check runs the engine.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { formatINR } from "@keka/shared";

const prisma = new PrismaClient();
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  await signInAs("vikram.menon@acme.test");
  const employee = await import("../apps/web/src/app/actions/employee");
  const approvals = await import("../apps/web/src/app/actions/payroll-approvals");
  // Salary changes go through the pay group's approval chain (HR Manager, then
  // Global Admin, which the requester holds and so is skipped). Priya signs off.
  const approveRevisionOf = async (employeeId: string) => {
    const req = await prisma.payrollApprovalRequest.findFirst({
      where: { action: "COMPENSATION_CHANGE", status: "PENDING", payload: { path: ["employeeId"], equals: employeeId } },
      orderBy: { requestedAt: "desc" },
    });
    await signInAs("priya.sharma@acme.test");
    const res = req ? await approvals.decideApprovalAction({}, fd({ requestId: req.id, decision: "approve" })) : { ok: false, message: "no request" };
    await signInAs("vikram.menon@acme.test");
    return res;
  };
  const { createRun, calculateRun } = await import("@keka/services");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });

  // A run that died before its cleanup leaves its employee behind; clear it so
  // one failure cannot cascade into the next run.
  const leftovers = await prisma.employee.findMany({
    where: { tenantId: tenant.id, workEmail: "aarti.menon@acme.test" }, select: { id: true, userId: true },
  });
  for (const l of leftovers) {
    await prisma.employee.delete({ where: { id: l.id } });
    if (l.userId) await prisma.user.delete({ where: { id: l.userId } });
  }
  await prisma.user.deleteMany({ where: { tenantId: tenant.id, email: "aarti.menon@acme.test" } });
  const entity = await prisma.legalEntity.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const location = await prisma.location.findFirstOrThrow({
    where: { tenantId: tenant.id, stateCode: "KA" },
  });
  const dept = await prisma.department.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const payGroup = await prisma.payGroup.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const manager = await prisma.employee.findFirstOrThrow({
    where: { tenantId: tenant.id, employeeNumber: "ACM0005" },
  });
  const jobTitle = await prisma.jobTitle.findFirstOrThrow({
    where: { tenantId: tenant.id, name: "Software Engineer" },
  });

  console.log("\nEmployee lifecycle\n" + "=".repeat(72));

  // -----------------------------------------------------------------
  section("Validation refuses an unusable record");

  const noName = await employee.createEmployee({}, fd({
    firstName: "", lastName: "Testcase", workEmail: "bad@acme.test",
    dateOfJoining: "2026-10-01", legalEntityId: entity.id, locationId: location.id,
  }));
  check("Blank first name is rejected", noName.ok !== true && !!noName.errors?.firstName,
    noName.errors?.firstName ?? noName.message);

  const badEmail = await employee.createEmployee({}, fd({
    firstName: "Test", lastName: "Case", workEmail: "not-an-email",
    dateOfJoining: "2026-10-01", legalEntityId: entity.id, locationId: location.id,
  }));
  check("Malformed email is rejected", badEmail.ok !== true && !!badEmail.errors?.workEmail,
    badEmail.errors?.workEmail ?? badEmail.message);

  const salaryNoGroup = await employee.createEmployee({
  }, fd({
    firstName: "Test", lastName: "Case", workEmail: "test.case@acme.test",
    dateOfJoining: "2026-10-01", legalEntityId: entity.id, locationId: location.id,
    annualCtc: "1200000",
  }));
  check("A salary without a pay group is refused",
    salaryNoGroup.ok !== true && /pay group/i.test(salaryNoGroup.message ?? ""),
    salaryNoGroup.message);

  // -----------------------------------------------------------------
  section("Create — full record in one transaction");

  const seriesBefore = await prisma.employeeNumberSeries.findFirstOrThrow({
    where: { tenantId: tenant.id, isDefault: true },
  });
  // The allocator steps past numbers already in use, so the expected value is
  // the first free slot at or after the series counter — not the counter itself.
  const taken = new Set(
    (await prisma.employee.findMany({
      where: { tenantId: tenant.id }, select: { employeeNumber: true },
    })).map((e) => e.employeeNumber),
  );
  let probe = seriesBefore.nextNumber;
  const numberFor = (n: number) =>
    `${seriesBefore.prefix}${String(n).padStart(seriesBefore.digits, "0")}${seriesBefore.suffix}`;
  while (taken.has(numberFor(probe))) probe++;
  const expectedNumber = numberFor(probe);
  const expectedNextAfter = probe + 1;

  const created = await employee.createEmployee({}, fd({
    firstName: "Aarti", lastName: "Menon", workEmail: "aarti.menon@acme.test",
    personalEmail: "aarti.m@gmail.test", mobile: "+919812345678",
    dateOfBirth: "1996-04-18", gender: "FEMALE", maritalStatus: "SINGLE",
    dateOfJoining: "2026-10-01",
    jobTitleId: jobTitle.id, legalEntityId: entity.id, departmentId: dept.id,
    locationId: location.id, reportingManagerId: manager.id, status: "PROBATION",
    attendanceNumber: "2001", inviteToPortal: true,
    payGroupId: payGroup.id, annualCtc: "1400000", taxRegime: "NEW",
  }));
  check("Created the employee", created.ok === true, created.message);

  const emp = await prisma.employee.findFirst({
    where: { tenantId: tenant.id, workEmail: "aarti.menon@acme.test" },
    include: {
      user: true, statutoryProfile: true,
      jobHistory: true, salaryRevisions: { include: { structure: true } },
    },
  });
  check("Record persisted", !!emp);
  check("Number came from the default series", emp?.employeeNumber === expectedNumber,
    `${emp?.employeeNumber} vs expected ${expectedNumber}`);

  const seriesAfter = await prisma.employeeNumberSeries.findUniqueOrThrow({
    where: { id: seriesBefore.id },
  });
  check("The series counter advanced past the issued number",
    seriesAfter.nextNumber === expectedNextAfter,
    `${seriesBefore.nextNumber} -> ${seriesAfter.nextNumber}, expected ${expectedNextAfter}`);

  check("A login was created", !!emp?.user, emp?.user?.email);
  check("A statutory profile was seeded", !!emp?.statutoryProfile,
    `regime ${emp?.statutoryProfile?.taxRegime}`);
  check("The first job history row exists", emp?.jobHistory.length === 1,
    emp?.jobHistory[0]?.reason);
  check("Opening salary was written", emp?.salaryRevisions.length === 1,
    emp?.salaryRevisions[0] ? formatINR(Number(emp.salaryRevisions[0].annualCtc)) : "");
  check("A structure was matched to the CTC by range",
    !!emp?.salaryRevisions[0]?.structureId,
    emp?.salaryRevisions[0]?.structure?.name ?? "");
  check("Profile completion was computed", (emp?.profileCompletion ?? 0) > 0,
    `${emp?.profileCompletion}%`);

  const dupEmail = await employee.createEmployee({}, fd({
    firstName: "Another", lastName: "Person", workEmail: "aarti.menon@acme.test",
    dateOfJoining: "2026-10-01", legalEntityId: entity.id, locationId: location.id,
    inviteToPortal: true,
  }));
  check("A duplicate login email is refused",
    dupEmail.ok !== true && /already exists/i.test(dupEmail.message ?? ""), dupEmail.message);

  // -----------------------------------------------------------------
  section("Edit — personal details and sub-records");

  const edited = await employee.updatePersonalDetails({}, fd({
    employeeId: emp!.id, firstName: "Aarti", lastName: "Menon",
    displayName: "Aarti Menon", workEmail: "aarti.menon@acme.test",
    mobile: "+919812340000", gender: "FEMALE", nationality: "Indian",
  }));
  check("Updated personal details", edited.ok === true, edited.message);

  const badPan = await employee.saveIdentity({}, fd({
    employeeId: emp!.id, type: "PAN", number: "NOTAPAN",
  }));
  check("Malformed PAN is refused", badPan.ok !== true && !!badPan.errors?.number,
    badPan.errors?.number ?? badPan.message);

  const pan = await employee.saveIdentity({}, fd({
    employeeId: emp!.id, type: "PAN", number: "abcpm1234k", nameOnDoc: "Aarti Menon",
  }));
  check("Valid PAN accepted", pan.ok === true, pan.message);
  const panRow = await prisma.employeeIdentity.findFirst({
    where: { employeeId: emp!.id, type: "PAN" },
  });
  check("PAN stored upper-cased", panRow?.number === "ABCPM1234K", panRow?.number);

  const badAadhaar = await employee.saveIdentity({}, fd({
    employeeId: emp!.id, type: "AADHAAR", number: "123",
  }));
  check("Short Aadhaar is refused", badAadhaar.ok !== true, badAadhaar.message);

  const uan = await employee.saveIdentity({}, fd({
    employeeId: emp!.id, type: "UAN", number: "100999888777",
  }));
  check("UAN accepted", uan.ok === true, uan.message);
  const prof = await prisma.employeeStatutoryProfile.findUniqueOrThrow({
    where: { employeeId: emp!.id },
  });
  check("UAN synced onto the statutory profile", prof.uan === "100999888777", prof.uan ?? "");

  const badIfsc = await employee.saveEmployeeBank({}, fd({
    employeeId: emp!.id, bankName: "HDFC Bank", accountNumber: "123456789",
    ifsc: "BADIFSC", branch: "Bengaluru", isPrimary: true,
  }));
  check("Malformed IFSC is refused", badIfsc.ok !== true && !!badIfsc.errors?.ifsc,
    badIfsc.errors?.ifsc ?? badIfsc.message);

  const bank = await employee.saveEmployeeBank({}, fd({
    employeeId: emp!.id, bankName: "HDFC Bank", accountNumber: "50200098765432",
    ifsc: "hdfc0000123", branch: "Bengaluru", accountHolder: "Aarti Menon", isPrimary: true,
  }));
  check("Valid bank account added", bank.ok === true, bank.message);

  const addr = await employee.saveAddress({}, fd({
    employeeId: emp!.id, type: "CURRENT", line1: "42 Residency Road",
    city: "Bengaluru", state: "Karnataka", stateCode: "KA", postalCode: "560025",
  }));
  check("Address saved", addr.ok === true, addr.message);

  const after = await prisma.employee.findUniqueOrThrow({ where: { id: emp!.id } });
  check("Completion rose after filling the record",
    after.profileCompletion > (emp?.profileCompletion ?? 0),
    `${emp?.profileCompletion}% -> ${after.profileCompletion}%`);

  // -----------------------------------------------------------------
  section("Promotion — effective-dated job change");

  const staffTitle = await prisma.jobTitle.findFirstOrThrow({
    where: { tenantId: tenant.id, name: "Senior Software Engineer" },
  });
  const promo = await employee.recordJobChange({}, fd({
    employeeId: emp!.id, effectiveFrom: "2026-11-01", reason: "PROMOTION",
    jobTitleId: staffTitle.id, note: "Strong first quarter", logActivity: true,
  }));
  check("Recorded the promotion", promo.ok === true, promo.message);

  const history = await prisma.employeeJobRecord.findMany({
    where: { employeeId: emp!.id }, orderBy: { effectiveFrom: "asc" },
  });
  check("A second job record exists", history.length === 2, `${history.length} rows`);
  check("The earlier row was closed off", history[0].effectiveTo !== null,
    history[0].effectiveTo ? iso(history[0].effectiveTo) : "still open");
  check("Closed the day before the new one starts",
    history[0].effectiveTo?.getTime() === history[1].effectiveFrom.getTime() - 86_400_000);

  const promoted = await prisma.employee.findUniqueOrThrow({ where: { id: emp!.id } });
  check("Current job title was updated", promoted.jobTitleName === "Senior Software Engineer",
    promoted.jobTitleName ?? "");

  const activity = await prisma.hrActivity.findFirst({
    where: { employeeId: emp!.id, type: "PROMOTION" },
  });
  check("It also landed on the HR activity timeline", !!activity, activity?.title);

  // -----------------------------------------------------------------
  section("Salary revision — forward-dated and back-dated");

  const forward = await employee.reviseSalary({}, fd({
    employeeId: emp!.id, effectiveFrom: "2026-11-01",
    annualCtc: "1650000", reason: "Promotion to Senior",
  }));
  check("Forward-dated revision saved", forward.ok === true, forward.message);
  check("It went to the approval chain first", /approval/i.test(forward.message ?? ""), forward.message);
  check("It is not live until approved",
    (await prisma.salaryRevision.findFirst({ where: { employeeId: emp!.id, annualCtc: 1650000 } }))?.status === "PENDING_APPROVAL");
  const fwdApproved = await approveRevisionOf(emp!.id);
  check("The HR Manager approved it and it applied", fwdApproved.ok === true, fwdApproved.message);
  const rev = await prisma.salaryRevision.findFirst({
    where: { employeeId: emp!.id }, orderBy: { effectiveFrom: "desc" },
  });
  check("Previous CTC was captured for the % change",
    Number(rev?.previousCtc) === 1400000, String(rev?.previousCtc));
  check("No arrears for a forward-dated rise",
    (await prisma.arrear.count({ where: { employeeId: emp!.id } })) === 0);

  // Arrears only arise when a revision pre-dates a FINALISED run, so stand one
  // up here rather than depending on whatever earlier scripts happened to leave.
  // Use the seeded finalised July if it exists; never touch a run we did not make.
  const seededJuly = await prisma.payrollRun.findFirst({
    where: { payGroupId: payGroup.id, year: 2026, month: 7, status: "FINALIZED", rolledBackAt: null },
  });
  let arrearRunId: string | null = null;
  if (!seededJuly) {
    arrearRunId = await createRun({ tenantId: tenant.id, payGroupId: payGroup.id, year: 2026, month: 7 });
    await calculateRun(arrearRunId);
    await prisma.payrollRun.update({ where: { id: arrearRunId }, data: { status: "FINALIZED", finalizedAt: new Date() } });
  }

  const existing = await prisma.employee.findFirstOrThrow({
    where: { tenantId: tenant.id, employeeNumber: "ACM0010" },
    include: { salaryRevisions: { orderBy: { effectiveFrom: "desc" }, take: 1 } },
  });
  const currentCtc = Number(existing.salaryRevisions[0].annualCtc);
  const arrearsBefore = await prisma.arrear.count({ where: { employeeId: existing.id } });

  const backdated = await employee.reviseSalary({}, fd({
    employeeId: existing.id, effectiveFrom: "2026-07-01",
    annualCtc: String(currentCtc + 120000), reason: "Back-dated correction",
  }));
  check("Back-dated revision saved", backdated.ok === true, backdated.message);
  const backApproved = await approveRevisionOf(existing.id);
  check("Once approved, it said arrears were raised",
    /arrear/i.test(backApproved.message ?? ""), backApproved.message);
  const arrearsAfter = await prisma.arrear.count({ where: { employeeId: existing.id } });
  check("Arrears were actually created", arrearsAfter > arrearsBefore,
    `${arrearsBefore} -> ${arrearsAfter}`);

  // -----------------------------------------------------------------
  section("The new employee processes in payroll");

  const runId = await createRun({
    tenantId: tenant.id, payGroupId: payGroup.id, year: 2026, month: 11,
  });
  await calculateRun(runId);

  const line = await prisma.payrollRunEmployee.findUnique({
    where: { runId_employeeId: { runId, employeeId: emp!.id } },
    include: { lines: true },
  });
  check("They appear in the November run", !!line);
  check("Gross earnings were computed", Number(line?.grossEarnings) > 0,
    formatINR(Number(line?.grossEarnings ?? 0)));
  check("PF was deducted", Number(line?.pfEmployee) > 0,
    formatINR(Number(line?.pfEmployee ?? 0)));
  check("Karnataka PT applied at 200", Number(line?.professionalTax) === 200,
    formatINR(Number(line?.professionalTax ?? 0)));
  check("Net pay is positive", Number(line?.netPay) > 0,
    formatINR(Number(line?.netPay ?? 0)));
  check("The revised CTC was used, not the original",
    Number(line?.annualCtc) === 1650000, String(line?.annualCtc));
  check("Payslip lines were generated", (line?.lines.length ?? 0) > 3,
    `${line?.lines.length} lines`);

  const gross = Number(line?.grossEarnings ?? 0);
  const ded = Number(line?.totalDeductions ?? 0);
  const net = Number(line?.netPay ?? 0);
  check("Their payslip reconciles", Math.abs(gross - ded - net) < 0.01,
    `${formatINR(gross)} - ${formatINR(ded)} = ${formatINR(net)}`);

  // -----------------------------------------------------------------
  section("Access controls");

  const disabled = await employee.setLoginAccess({}, fd({
    employeeId: emp!.id, mode: "disable",
  }));
  check("Login disabled", disabled.ok === true, disabled.message);
  const disabledUser = await prisma.user.findUniqueOrThrow({ where: { id: emp!.user!.id } });
  check("The flag is set", disabledUser.loginDisabled === true);

  const self = await employee.setLoginAccess({}, fd({
    employeeId: (await prisma.employee.findFirstOrThrow({
      where: { user: { email: "vikram.menon@acme.test" } },
    })).id,
    mode: "disable",
  }));
  check("You cannot disable your own login",
    self.ok !== true && /your own/i.test(self.message ?? ""), self.message);

  // -----------------------------------------------------------------
  //  Clean up so repeat runs stay deterministic.
  await prisma.payrollRun.deleteMany({ where: { id: { in: [runId, ...(arrearRunId ? [arrearRunId] : [])] } } });
  await prisma.arrear.deleteMany({ where: { employeeId: existing.id, source: "BACKDATED_REVISION" } });
  await prisma.salaryRevision.deleteMany({
    where: { employeeId: existing.id, reason: "Back-dated correction" },
  });
  await prisma.employee.delete({ where: { id: emp!.id } });
  await prisma.user.delete({ where: { id: emp!.user!.id } });
  await prisma.employeeNumberSeries.update({
    where: { id: seriesBefore.id }, data: { nextNumber: seriesBefore.nextNumber },
  });

  report("Employee lifecycle");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
