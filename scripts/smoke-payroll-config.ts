/**
 * Payroll configuration CRUD through the real actions.
 *
 * The valuable checks here are the refusals: a structure that would cycle, a
 * formula that would silently zero, a location mapped to the wrong state's
 * PT rules. Each of those reaches a payslip if it is allowed through.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await signInAs("vikram.menon@acme.test");
  const cfg = await import("../apps/web/src/app/actions/payroll-config");
  const { createRun, calculateRun } = await import("@keka/services");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const entity = await prisma.legalEntity.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const blr = await prisma.location.findFirstOrThrow({ where: { tenantId: tenant.id, stateCode: "KA" } });
  const bom = await prisma.location.findFirstOrThrow({ where: { tenantId: tenant.id, stateCode: "MH" } });

  console.log("\nPayroll configuration\n" + "=".repeat(72));

  // -----------------------------------------------------------------
  section("Pay group — create with defaults");

  const bad = await cfg.savePayGroup({}, fd({
    legalEntityId: entity.id, name: "Test Group",
    declarationOpenDay: "20", declarationCloseDay: "5",
  }));
  check("A window that closes before it opens is refused",
    bad.ok !== true && !!bad.errors?.declarationCloseDay, bad.errors?.declarationCloseDay ?? bad.message);

  const created = await cfg.savePayGroup({}, fd({
    legalEntityId: entity.id, name: "Test Group", frequency: "MONTHLY",
    payPeriodStartDay: "1", payPeriodEndDay: "0", payDay: "1", attendanceCutoffDay: "25",
    pfEnabled: true, esiEnabled: true, ptEnabled: true, lwfEnabled: true, tdsEnabled: true,
    declarationOpenDay: "1", declarationCloseDay: "22", newJoinerWindowDays: "30",
    proofMandatory: true, allowRegimeChoice: true,
  }));
  check("Created a pay group", created.ok === true, created.message);

  const group = await prisma.payGroup.findFirstOrThrow({
    where: { tenantId: tenant.id, name: "Test Group" },
    include: { filingDetail: true, payslipSetting: true, _count: { select: { componentLinks: true } } },
  });
  check("Filing detail was created with statutory defaults",
    Number(group.filingDetail?.pfWageCeiling) === 15000 && Number(group.filingDetail?.esiWageLimit) === 21000,
    `PF ceiling ${group.filingDetail?.pfWageCeiling}, ESI limit ${group.filingDetail?.esiWageLimit}`);
  check("Payslip settings were created", !!group.payslipSetting);
  check("Every active component was linked", group._count.componentLinks > 0,
    `${group._count.componentLinks} components`);

  // -----------------------------------------------------------------
  section("Filing details — identifier validation");

  const badTan = await cfg.saveFilingDetails({}, fd({
    payGroupId: group.id, tan: "NOTATAN",
    pfWageCeiling: "15000", pfCapAtCeiling: true, pfEmployeeRate: "12", pfEmployerRate: "12",
    epsRate: "8.33", epsWageCeiling: "15000", edliRate: "0.5", pfAdminRate: "0.5",
    esiWageLimit: "21000", esiEmployeeRate: "0.75", esiEmployerRate: "3.25",
  }));
  check("Malformed TAN is refused", badTan.ok !== true && !!badTan.errors?.tan,
    badTan.errors?.tan ?? badTan.message);

  const badEps = await cfg.saveFilingDetails({}, fd({
    payGroupId: group.id,
    pfWageCeiling: "15000", pfEmployeeRate: "12", pfEmployerRate: "12",
    epsRate: "15", epsWageCeiling: "15000", edliRate: "0.5", pfAdminRate: "0.5",
    esiWageLimit: "21000", esiEmployeeRate: "0.75", esiEmployerRate: "3.25",
  }));
  check("EPS above the employer PF rate is refused",
    badEps.ok !== true && !!badEps.errors?.epsRate, badEps.errors?.epsRate ?? badEps.message);

  const filing = await cfg.saveFilingDetails({}, fd({
    payGroupId: group.id, pan: "aaccb1234k", tan: "blrb12345c",
    pfWageCeiling: "15000", pfCapAtCeiling: true, pfEmployeeRate: "12", pfEmployerRate: "12",
    epsRate: "8.33", epsWageCeiling: "15000", edliRate: "0.5", pfAdminRate: "0.5",
    esiWageLimit: "21000", esiEmployeeRate: "0.75", esiEmployerRate: "3.25", esiIncludeArrears: true,
  }));
  check("Valid filing details saved", filing.ok === true, filing.message);
  const fd2 = await prisma.payGroupFilingDetail.findUniqueOrThrow({ where: { payGroupId: group.id } });
  check("PAN and TAN stored upper-cased", fd2.pan === "AACCB1234K" && fd2.tan === "BLRB12345C",
    `${fd2.pan} / ${fd2.tan}`);

  // -----------------------------------------------------------------
  section("State registrations — location must match the state");

  const wrongState = await cfg.savePtRegistration({}, (() => {
    const f = fd({ payGroupId: group.id, stateCode: "KA", stateName: "Karnataka", frequency: "MONTHLY" });
    f.append("locationIds", bom.id); // a Mumbai office under Karnataka rules
    return f;
  })());
  check("A Maharashtra office cannot follow Karnataka PT",
    wrongState.ok !== true && /not in KA/i.test(wrongState.message ?? ""), wrongState.message);

  const pt = await cfg.savePtRegistration({}, (() => {
    const f = fd({
      payGroupId: group.id, stateCode: "KA", stateName: "Karnataka",
      frequency: "MONTHLY", establishmentId: "PT-KA-TEST",
    });
    f.append("locationIds", blr.id);
    return f;
  })());
  check("Karnataka PT registration saved", pt.ok === true, pt.message);
  const ptLinks = await prisma.ptStateRegistrationLocation.count({
    where: { registration: { payGroupId: group.id, stateCode: "KA" } },
  });
  check("The Bengaluru location is linked", ptLinks === 1, `${ptLinks} link(s)`);

  const noSlabs = await cfg.savePtRegistration({}, fd({
    payGroupId: group.id, stateCode: "DL", stateName: "Delhi", frequency: "MONTHLY",
  }));
  check("A state with no PT slabs is saved but flagged",
    noSlabs.ok === true && /no PT slabs/i.test(noSlabs.message ?? ""), noSlabs.message);

  const lwf = await cfg.saveLwfRegistration({}, (() => {
    const f = fd({ payGroupId: group.id, stateCode: "KA", stateName: "Karnataka", prorateNewJoiners: true });
    f.append("locationIds", blr.id);
    return f;
  })());
  check("Karnataka LWF registration saved", lwf.ok === true, lwf.message);

  // -----------------------------------------------------------------
  section("Salary component — naming and type rules");

  const reserved = await cfg.saveComponent({}, fd({
    code: "GROSS", name: "Gross", type: "EARNING", calculationType: "FORMULA",
  }));
  check("A reserved engine code is refused",
    reserved.ok !== true && /reserved/i.test(reserved.message ?? ""), reserved.message);

  const badCode = await cfg.saveComponent({}, fd({
    code: "9LIVES", name: "Bad", type: "EARNING",
  }));
  check("A code starting with a digit is refused", badCode.ok !== true && !!badCode.errors?.code,
    badCode.errors?.code ?? badCode.message);

  const taxableReimb = await cfg.saveComponent({}, fd({
    code: "WIFI_REIMB", name: "Wifi", type: "REIMBURSEMENT", taxTreatment: "FULLY_TAXABLE",
  }));
  check("A taxable reimbursement is refused as a contradiction",
    taxableReimb.ok !== true && /tax-exempt by definition/i.test(taxableReimb.message ?? ""),
    taxableReimb.message);

  const comp = await cfg.saveComponent({}, fd({
    code: "internet", name: "Internet Allowance", type: "EARNING",
    calculationType: "FIXED", taxTreatment: "FULLY_TAXABLE",
    isRecurring: true, isLopApplicable: true, affectsEsiGross: true, showOnPayslip: true,
  }));
  check("Created a component", comp.ok === true, comp.message);
  const internet = await prisma.salaryComponent.findFirstOrThrow({
    where: { tenantId: tenant.id, code: "INTERNET" },
  });
  check("Code was upper-cased", internet.code === "INTERNET");

  // -----------------------------------------------------------------
  section("Salary structure — the engine dry-run guards");

  const overlap = await cfg.saveStructure({}, fd({
    payGroupId: (await prisma.payGroup.findFirstOrThrow({ where: { tenantId: tenant.id, name: { not: "Test Group" } } })).id,
    name: "Overlapping", type: "RANGE_BASED",
    minAnnualCtc: "500000", maxAnnualCtc: "900000",
    pfEnabled: true, esiEnabled: true, roundComponents: true, isActive: true,
  }));
  check("An overlapping range-based structure is refused",
    overlap.ok !== true && /overlaps/i.test(overlap.message ?? ""), overlap.message);

  const st = await cfg.saveStructure({}, fd({
    payGroupId: group.id, name: "Test Structure", type: "CUSTOM",
    minAnnualCtc: "600000", maxAnnualCtc: "1800000",
    pfEnabled: true, esiEnabled: true, roundComponents: true, isActive: true, isDefault: true,
  }));
  check("Created a structure", st.ok === true, st.message);
  const structure = await prisma.salaryStructure.findFirstOrThrow({
    where: { payGroupId: group.id, name: "Test Structure" },
  });

  const basic = await prisma.salaryComponent.findFirstOrThrow({ where: { tenantId: tenant.id, code: "BASIC" } });
  const hra = await prisma.salaryComponent.findFirstOrThrow({ where: { tenantId: tenant.id, code: "HRA" } });
  const special = await prisma.salaryComponent.findFirstOrThrow({ where: { tenantId: tenant.id, code: "SPECIAL" } });
  const pfEr = await prisma.salaryComponent.findFirstOrThrow({ where: { tenantId: tenant.id, code: "PF_EMPLOYER" } });

  const badFormula = await cfg.saveStructureLine({}, fd({
    structureId: structure.id, componentId: basic.id,
    calculationType: "FORMULA", formula: "[CTC_MONTHLY] * ", sequence: "1",
  }));
  check("A syntactically broken formula is refused",
    badFormula.ok !== true && !!badFormula.errors?.formula, badFormula.errors?.formula ?? badFormula.message);

  const l1 = await cfg.saveStructureLine({}, fd({
    structureId: structure.id, componentId: basic.id,
    calculationType: "FORMULA", formula: "[CTC_MONTHLY] * 0.4", sequence: "1",
  }));
  check("Basic at 40% of CTC saved", l1.ok === true, l1.message);

  const l2 = await cfg.saveStructureLine({}, fd({
    structureId: structure.id, componentId: hra.id,
    calculationType: "FORMULA", formula: "[BASIC] * 0.5", sequence: "2",
  }));
  check("HRA at 50% of Basic saved", l2.ok === true, l2.message);

  // Now make Basic depend on HRA — a cycle.
  const cycle = await cfg.saveStructureLine({}, fd({
    structureId: structure.id, componentId: basic.id,
    calculationType: "FORMULA", formula: "[HRA] * 2", sequence: "1",
  }));
  check("A formula that creates a cycle is refused",
    cycle.ok !== true && /circular/i.test(cycle.message ?? ""), cycle.message);

  const l3 = await cfg.saveStructureLine({}, fd({
    structureId: structure.id, componentId: pfEr.id,
    calculationType: "FORMULA", formula: "IF([BASIC] > 15000, 1800, [BASIC] * 0.12)", sequence: "10",
  }));
  check("Nested-IF employer PF saved", l3.ok === true, l3.message);

  const l4 = await cfg.saveStructureLine({}, fd({
    structureId: structure.id, componentId: special.id,
    calculationType: "BALANCE", sequence: "20",
  }));
  check("Special allowance as the balance saved", l4.ok === true, l4.message);

  const secondBalance = await cfg.saveStructureLine({}, fd({
    structureId: structure.id, componentId: internet.id,
    calculationType: "BALANCE", sequence: "21",
  }));
  check("A second BALANCE component is refused",
    secondBalance.ok !== true && /only one/i.test(secondBalance.message ?? ""), secondBalance.message);

  const missingPct = await cfg.saveStructureLine({}, fd({
    structureId: structure.id, componentId: internet.id,
    calculationType: "PERCENTAGE", percentage: "5", sequence: "3",
  }));
  check("A percentage without its base component is refused",
    missingPct.ok !== true && !!missingPct.errors?.percentageOf, missingPct.message);

  const referenced = await cfg.removeStructureLine({}, fd({
    structureId: structure.id, componentId: basic.id,
  }));
  check("Removing BASIC is refused while HRA and PF reference it",
    referenced.ok !== true && /reference/i.test(referenced.message ?? ""), referenced.message);

  // -----------------------------------------------------------------
  section("The configured group actually pays someone");

  const emp = await prisma.employee.findFirstOrThrow({
    where: { tenantId: tenant.id, employeeNumber: "ACM0010" },
    include: { salaryRevisions: { orderBy: { effectiveFrom: "desc" }, take: 1 } },
  });
  const originalGroup = emp.payGroupId;
  const originalStructure = emp.salaryRevisions[0].structureId;

  await prisma.employee.update({
    where: { id: emp.id }, data: { payGroupId: group.id, locationId: blr.id },
  });
  await prisma.salaryRevision.update({
    where: { id: emp.salaryRevisions[0].id }, data: { structureId: structure.id },
  });

  const runId = await createRun({ tenantId: tenant.id, payGroupId: group.id, year: 2026, month: 12 });
  await calculateRun(runId);
  const line = await prisma.payrollRunEmployee.findUniqueOrThrow({
    where: { runId_employeeId: { runId, employeeId: emp.id } },
    include: { lines: true },
  });
  const codes = line.lines.map((l) => l.code);
  check("Pay run produced a payslip", Number(line.netPay) > 0);
  check("The configured components appear", ["BASIC", "HRA", "SPECIAL"].every((c) => codes.includes(c)),
    codes.filter((c) => !c.startsWith("PF") && !["TDS", "PT", "EPS", "EDLI"].includes(c)).join(", "));
  check("Karnataka PT from the new registration applied", Number(line.professionalTax) === 200);
  check("December is Karnataka's LWF month, and it deducted",
    Number(line.lwfEmployee) === 20, `${line.lwfEmployee}`);

  // Clean up.
  await prisma.payrollRun.delete({ where: { id: runId } });
  await prisma.salaryRevision.update({
    where: { id: emp.salaryRevisions[0].id }, data: { structureId: originalStructure },
  });
  await prisma.employee.update({ where: { id: emp.id }, data: { payGroupId: originalGroup } });

  const deleteBlocked = await cfg.deleteComponent({}, fd({ id: internet.id }));
  check("A component in use by no structure deletes cleanly", deleteBlocked.ok === true, deleteBlocked.message);

  await prisma.salaryStructure.delete({ where: { id: structure.id } });
  const delGroup = await cfg.deletePayGroup({}, fd({ id: group.id }));
  check("The emptied pay group deletes", delGroup.ok === true, delGroup.message);

  report("Payroll configuration");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
