import path from "node:path";
import { config as loadEnv } from "dotenv";

// The seed runs as a plain script, not through the Prisma CLI, so it has to
// load the monorepo-root .env itself before the client is constructed.
loadEnv({ path: path.resolve(__dirname, "../../../../.env") });

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { SYSTEM_ROLES } from "../../../rbac/src/roles";
import { seedReferenceData } from "./reference";
import { SALARY_COMPONENTS, SALARY_STRUCTURES } from "./components";
import { seedWorkplace } from "./workplace";
import { seedTime } from "./time";
import { seedLifecycle } from "./lifecycle";
import { seedPayrollHistory } from "./payroll-history";
import { seedPerformance } from "./performance";
import { seedHiring } from "./hiring";
import { seedExpenses } from "./expenses";
import { seedProjects } from "./projects";
import { seedSelfService } from "./self-service";
import { seedToday } from "./today";
import { seedEngageLearn } from "./engage-learn";
import { seedProbation } from "./probation";
import { seedAccountingOpening, seedAccountingActivity } from "./accounting";
import { seedHelpdesk } from "./helpdesk";
import { seedAnalytics } from "./analytics";

const prisma = new PrismaClient();

const DEMO_PASSWORD = "Keka@2026";
const TENANT_SUBDOMAIN = "acme";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function log(step: string, detail = "") {
  console.log(`  ${step.padEnd(34)} ${detail}`);
}

async function main() {
  console.log("\nSeeding Keka platform\n" + "-".repeat(64));

  // ---------------------------------------------------------------------
  //  Reference data (tenant-independent statutory tables)
  // ---------------------------------------------------------------------
  const ref = await seedReferenceData(prisma);
  log("Statutory reference data",
    `${ref.ptSlabs} PT slabs, ${ref.lwfRules} LWF rules, ${ref.taxSlabs} tax slabs`);

  // ---------------------------------------------------------------------
  //  Tenant
  // ---------------------------------------------------------------------
  await prisma.tenant.deleteMany({ where: { subdomain: TENANT_SUBDOMAIN } });

  const tenant = await prisma.tenant.create({
    data: {
      subdomain: TENANT_SUBDOMAIN,
      name: "Acme Technologies",
      plan: "GROWTH",
      hasHire: true,
      hasPsa: true,
      countryCode: "IN",
      currency: "INR",
      fyStartMonth: 4,
      visibilitySetting: {
        create: {
          restrictByLegalEntity: false,
          restrictByBusinessUnit: false,
          managerReporteeOverride: true,
        },
      },
    },
  });
  log("Tenant", `${tenant.name} (${tenant.subdomain}.keka.local, ${tenant.plan})`);

  // ---------------------------------------------------------------------
  //  Roles — the eleven built-ins, seeded per tenant
  // ---------------------------------------------------------------------
  const roleByKey = new Map<string, string>();
  for (const def of SYSTEM_ROLES) {
    const role = await prisma.role.create({
      data: {
        tenantId: tenant.id,
        key: def.key,
        name: def.name,
        description: def.description,
        isSystem: true,
        permissions: {
          create: def.permissions.map((permission) => ({ permission })),
        },
      },
    });
    roleByKey.set(def.key, role.id);
  }
  // A custom role, to show the builder is real.
  const customRole = await prisma.role.create({
    data: {
      tenantId: tenant.id,
      name: "Finance Controller",
      description: "Read-only access to payroll registers and statutory reports, without the ability to run payroll.",
      isSystem: false,
      permissions: {
        create: [
          "payroll.run.view", "payroll.register.view", "payroll.payslip.view_all",
          "employee.financials.view", "admin.report.view", "admin.audit.view",
          "payroll.accounting.manage", "accounting.ledger.view", "accounting.account.view", "accounting.report.view",
        ].map((permission) => ({ permission })),
      },
    },
  });
  log("Roles", `${SYSTEM_ROLES.length} system + 1 custom`);

  // ---------------------------------------------------------------------
  //  Organisation structure
  // ---------------------------------------------------------------------
  const entityTech = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      name: "Acme Technologies",
      legalName: "Acme Technologies Private Limited",
      countryCode: "IN", currency: "INR",
      cin: "U72200KA2014PTC094953",
      dateOfIncorporation: utc(2014, 7, 21),
      businessType: "Private Limited Company",
      sector: "Information Technology",
      natureOfBusiness: "Software development and IT services",
      addressLine1: "Prestige Tech Park, Outer Ring Road",
      addressLine2: "Kadubeesanahalli",
      city: "Bengaluru", state: "Karnataka", postalCode: "560103",
      signatories: {
        create: [
          { name: "Ramesh Iyer", designation: "Chief Financial Officer", email: "ramesh.iyer@acme.test", fathersName: "Krishnan Iyer", pan: "ABCPI1234K" },
          { name: "Nandita Rao", designation: "Company Secretary", email: "nandita.rao@acme.test", pan: "AXZPR5678L" },
        ],
      },
      bankAccounts: {
        create: [{
          bankName: "HDFC Bank", accountNumber: "50200012345678",
          ifsc: "HDFC0000123", branch: "Marathahalli, Bengaluru",
          corporateId: "ACMETECH01", isPrimary: true,
        }],
      },
    },
  });

  const entityServices = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      name: "Acme Services",
      legalName: "Acme Business Services LLP",
      countryCode: "IN", currency: "INR",
      cin: "AAB-1234",
      dateOfIncorporation: utc(2019, 2, 11),
      businessType: "Limited Liability Partnership",
      sector: "Business Process Management",
      addressLine1: "Tidel Park, Taramani",
      city: "Chennai", state: "Tamil Nadu", postalCode: "600113",
      signatories: {
        create: [{ name: "Ramesh Iyer", designation: "Designated Partner", email: "ramesh.iyer@acme.test", pan: "ABCPI1234K" }],
      },
      bankAccounts: {
        create: [{
          bankName: "ICICI Bank", accountNumber: "002905001234",
          ifsc: "ICIC0000029", branch: "Taramani, Chennai", isPrimary: true,
        }],
      },
    },
  });
  log("Legal entities", "Acme Technologies Pvt Ltd, Acme Business Services LLP");

  const locations = await Promise.all([
    prisma.location.create({ data: { tenantId: tenant.id, name: "Bengaluru HQ", code: "BLR", city: "Bengaluru", state: "Karnataka", stateCode: "KA", postalCode: "560103", addressLine1: "Prestige Tech Park" } }),
    prisma.location.create({ data: { tenantId: tenant.id, name: "Mumbai Office", code: "BOM", city: "Mumbai", state: "Maharashtra", stateCode: "MH", postalCode: "400051", addressLine1: "Bandra Kurla Complex" } }),
    prisma.location.create({ data: { tenantId: tenant.id, name: "Chennai Delivery Centre", code: "MAA", city: "Chennai", state: "Tamil Nadu", stateCode: "TN", postalCode: "600113", addressLine1: "Tidel Park" } }),
    prisma.location.create({ data: { tenantId: tenant.id, name: "Hyderabad Office", code: "HYD", city: "Hyderabad", state: "Telangana", stateCode: "TS", postalCode: "500081", addressLine1: "HITEC City" } }),
  ]);
  const [blr, bom, maa, hyd] = locations;
  log("Locations", "Bengaluru (KA), Mumbai (MH), Chennai (TN), Hyderabad (TS)");

  const buEngineering = await prisma.businessUnit.create({ data: { tenantId: tenant.id, legalEntityId: entityTech.id, name: "Engineering", code: "ENG" } });
  const buRevenue = await prisma.businessUnit.create({ data: { tenantId: tenant.id, legalEntityId: entityTech.id, name: "Revenue", code: "REV" } });
  const buCorporate = await prisma.businessUnit.create({ data: { tenantId: tenant.id, legalEntityId: entityTech.id, name: "Corporate", code: "CORP" } });
  const buOperations = await prisma.businessUnit.create({ data: { tenantId: tenant.id, legalEntityId: entityServices.id, name: "Managed Services", code: "MS" } });

  const deptDefs = [
    { name: "Platform Engineering", code: "PLAT", bu: buEngineering.id },
    { name: "Product Engineering", code: "PROD", bu: buEngineering.id },
    { name: "Quality Assurance", code: "QA", bu: buEngineering.id },
    { name: "Design", code: "DSGN", bu: buEngineering.id },
    { name: "Sales", code: "SALES", bu: buRevenue.id },
    { name: "Customer Success", code: "CS", bu: buRevenue.id },
    { name: "Marketing", code: "MKTG", bu: buRevenue.id },
    { name: "Human Resources", code: "HR", bu: buCorporate.id },
    { name: "Finance", code: "FIN", bu: buCorporate.id },
    { name: "Information Technology", code: "IT", bu: buCorporate.id },
    { name: "Service Delivery", code: "SD", bu: buOperations.id },
  ];
  const departments = new Map<string, string>();
  for (const d of deptDefs) {
    const dept = await prisma.department.create({
      data: { tenantId: tenant.id, businessUnitId: d.bu, name: d.name, code: d.code },
    });
    departments.set(d.code, dept.id);
  }
  log("Business units / departments", `4 business units, ${deptDefs.length} departments`);

  const costCenters = new Map<string, string>();
  for (const [name, code] of [["Engineering R&D", "CC-ENG"], ["Sales & Marketing", "CC-GTM"], ["General & Administrative", "CC-GA"], ["Service Delivery", "CC-SD"]]) {
    const cc = await prisma.costCenter.create({ data: { tenantId: tenant.id, name, code } });
    costCenters.set(code, cc.id);
  }

  const bands = new Map<string, string>();
  for (const [i, name] of ["B1 — Associate", "B2 — Engineer", "B3 — Senior", "B4 — Lead", "B5 — Manager", "B6 — Director", "B7 — VP"].entries()) {
    const b = await prisma.band.create({ data: { tenantId: tenant.id, name, rank: i + 1 } });
    bands.set(name.slice(0, 2), b.id);
  }

  const grades = new Map<string, string>();
  const gradeDefs = [
    { name: "G1", min: 300000, max: 600000 }, { name: "G2", min: 600000, max: 1200000 },
    { name: "G3", min: 1200000, max: 2000000 }, { name: "G4", min: 2000000, max: 3500000 },
    { name: "G5", min: 3500000, max: 6000000 },
  ];
  for (const g of gradeDefs) {
    const pg = await prisma.payGrade.create({
      data: { tenantId: tenant.id, name: g.name, minAnnual: g.min, maxAnnual: g.max, midAnnual: (g.min + g.max) / 2 },
    });
    grades.set(g.name, pg.id);
  }

  const workerTypes = new Map<string, string>();
  for (const [name, contingent] of [["Permanent", false], ["Intern", false], ["Contract", true], ["Consultant", true]] as const) {
    const wt = await prisma.workerType.create({ data: { tenantId: tenant.id, name, isContingent: contingent } });
    workerTypes.set(name, wt.id);
  }

  const jobTitles = new Map<string, string>();
  const titleDefs = [
    "Software Engineer", "Senior Software Engineer", "Staff Engineer", "Engineering Manager",
    "QA Engineer", "Product Designer", "Product Manager", "Account Executive",
    "Customer Success Manager", "Marketing Manager", "HR Business Partner", "HR Executive",
    "Financial Analyst", "Payroll Specialist", "IT Administrator", "Service Delivery Lead",
    "Director of Engineering", "Chief Financial Officer", "Chief Executive Officer", "Intern",
  ];
  for (const name of titleDefs) {
    const jt = await prisma.jobTitle.create({ data: { tenantId: tenant.id, name } });
    jobTitles.set(name, jt.id);
  }

  await prisma.employeeNumberSeries.create({
    data: {
      tenantId: tenant.id, name: "Default", description: "Standard employee numbering",
      prefix: "ACM", digits: 4, suffix: "", nextNumber: 1, isActive: true, isDefault: true,
    },
  });
  await prisma.employeeNumberSeries.create({
    data: {
      tenantId: tenant.id, name: "Contract Workers", description: "Separate series for contingent workers",
      prefix: "ACM-C", digits: 3, suffix: "", nextNumber: 1, isActive: true, isDefault: false,
    },
  });
  log("Org objects", "4 cost centres, 7 bands, 5 pay grades, 4 worker types, 2 number series");

  // ---------------------------------------------------------------------
  //  Salary components (global repository)
  // ---------------------------------------------------------------------
  const componentByCode = new Map<string, string>();
  for (const c of SALARY_COMPONENTS) {
    const created = await prisma.salaryComponent.create({
      data: {
        tenantId: tenant.id,
        code: c.code, name: c.name, type: c.type,
        calculationType: c.calculationType, taxTreatment: c.taxTreatment,
        isRecurring: c.isRecurring, isSystem: c.isSystem ?? false,
        isPartOfFbp: c.isPartOfFbp ?? false, isOutsideCtc: c.isOutsideCtc ?? false,
        isLopApplicable: c.isLopApplicable ?? true,
        isArrearApplicable: c.isArrearApplicable ?? true,
        affectsPfWage: c.affectsPfWage ?? false,
        affectsEsiGross: c.affectsEsiGross ?? c.type === "EARNING",
        annualExemptLimit: c.annualExemptLimit ?? null,
        taxSection: c.taxSection ?? null,
        displayOrder: c.displayOrder,
      },
    });
    componentByCode.set(c.code, created.id);
  }
  log("Salary components", `${SALARY_COMPONENTS.length} in the global repository`);

  // ---------------------------------------------------------------------
  //  Pay group — the real segmentation unit
  // ---------------------------------------------------------------------
  const payGroup = await prisma.payGroup.create({
    data: {
      tenantId: tenant.id,
      legalEntityId: entityTech.id,
      name: "Acme India — Monthly",
      description: "Monthly payroll for Acme Technologies Pvt Ltd across all Indian locations",
      frequency: "MONTHLY",
      payPeriodStartDay: 1, payPeriodEndDay: 0, payDay: 1,
      attendanceCutoffDay: 25,
      pfEnabled: true, esiEnabled: true, ptEnabled: true, lwfEnabled: true, tdsEnabled: true,
      declarationOpenDay: 1, declarationCloseDay: 22,
      declarationFyCutoff: utc(2027, 1, 31),
      newJoinerWindowDays: 30,
      proofSubmissionDue: utc(2027, 2, 28),
      proofMandatory: true,
      allowRegimeChoice: true,
      regimeChangeCutoff: utc(2026, 12, 31),
      approvalWorkflowEnabled: true,
      filingDetail: {
        create: {
          pan: "AACCA1234K", tan: "BLRA12345F", tanCircle: "TDS Circle 1(1), Bengaluru",
          citTds: "CIT(TDS), Bengaluru",
          form16SignatoryName: "Ramesh Iyer",
          form16SignatoryDesignation: "Chief Financial Officer",
          form16SignatoryPan: "ABCPI1234K",
          responsiblePersonName: "Ramesh Iyer",
          responsiblePersonDesignation: "Chief Financial Officer",
          responsiblePersonPan: "ABCPI1234K",
          pfRegistrationNumber: "KN/BNG/0012345/000",
          pfRegistrationDate: utc(2014, 9, 1),
          pfSignatoryName: "Ramesh Iyer",
          esiRegistrationNumber: "53000123450000123",
          esiRegistrationDate: utc(2015, 4, 1),
          esiSignatoryName: "Ramesh Iyer",
        },
      },
      payslipSetting: {
        create: {
          layout: "THREE_SECTION", showCompanyLogo: true, showYtdTotals: true,
          showEmployerContributions: true, showLoanDetails: true,
          showArrearBreakup: true, passwordProtect: true,
        },
      },
      payRegisterConfig: { create: { columns: [] } },
    },
  });

  for (const c of SALARY_COMPONENTS) {
    await prisma.payGroupComponent.create({
      data: { payGroupId: payGroup.id, componentId: componentByCode.get(c.code)! },
    });
  }

  // PT registrations, one per state, each linked to its office locations.
  const ptRegs: Array<{ state: string; name: string; locId: string; freq: "MONTHLY" | "HALF_YEARLY"; body?: string }> = [
    { state: "KA", name: "Karnataka", locId: blr.id, freq: "MONTHLY" },
    { state: "MH", name: "Maharashtra", locId: bom.id, freq: "MONTHLY" },
    { state: "TN", name: "Tamil Nadu", locId: maa.id, freq: "HALF_YEARLY", body: "CORPORATION" },
    { state: "TS", name: "Telangana", locId: hyd.id, freq: "MONTHLY" },
  ];
  for (const [i, r] of ptRegs.entries()) {
    await prisma.ptStateRegistration.create({
      data: {
        payGroupId: payGroup.id, stateCode: r.state, stateName: r.name,
        localBodyType: r.body ?? "",
        establishmentId: `PT-${r.state}-${1000 + i}`,
        registrationDate: utc(2015, 4, 1),
        signatoryName: "Ramesh Iyer",
        frequency: r.freq,
        linkedLocations: { create: [{ locationId: r.locId }] },
      },
    });
  }

  for (const [i, r] of [
    { state: "KA", name: "Karnataka", locId: blr.id },
    { state: "MH", name: "Maharashtra", locId: bom.id },
    { state: "TN", name: "Tamil Nadu", locId: maa.id },
    { state: "TS", name: "Telangana", locId: hyd.id },
  ].entries()) {
    await prisma.lwfStateRegistration.create({
      data: {
        payGroupId: payGroup.id, stateCode: r.state, stateName: r.name,
        establishmentId: `LWF-${r.state}-${2000 + i}`,
        registrationDate: utc(2015, 4, 1),
        signatoryName: "Ramesh Iyer",
        employerInsideCtc: false,
        prorateNewJoiners: true,
        linkedLocations: { create: [{ locationId: r.locId }] },
      },
    });
  }

  await prisma.payrollApprovalRule.create({
    data: {
      payGroupId: payGroup.id,
      name: "Lock payroll — CFO sign-off",
      action: "LOCK_PAYROLL",
      approverRoleIds: [roleByKey.get("PAYROLL_ADMIN"), roleByKey.get("GLOBAL_ADMIN")],
    },
  });
  await prisma.payrollApprovalRule.create({
    data: {
      payGroupId: payGroup.id,
      name: "Compensation change — HR then CFO",
      action: "COMPENSATION_CHANGE",
      approverRoleIds: [roleByKey.get("HR_MANAGER"), roleByKey.get("GLOBAL_ADMIN")],
    },
  });
  log("Pay group", `${payGroup.name} — PT/LWF in 4 states, maker-checker on`);

  // ---------------------------------------------------------------------
  //  Salary structures
  // ---------------------------------------------------------------------
  const structureIds: Array<{ id: string; min: number | null; max: number | null; isDefault: boolean }> = [];
  for (const s of SALARY_STRUCTURES) {
    const structure = await prisma.salaryStructure.create({
      data: {
        payGroupId: payGroup.id,
        name: s.name, type: s.type,
        minAnnualCtc: s.minAnnualCtc, maxAnnualCtc: s.maxAnnualCtc,
        isDefault: s.isDefault ?? false,
        pfEnabled: true, esiEnabled: true, tdsMethod: "AVERAGE",
        roundComponents: true,
        components: {
          create: s.components.map((c) => ({
            componentId: componentByCode.get(c.code)!,
            calculationType: c.calculationType,
            formula: c.formula ?? null,
            fixedAmount: c.fixedAmount ?? null,
            sequence: c.sequence,
          })),
        },
      },
    });
    structureIds.push({ id: structure.id, min: s.minAnnualCtc, max: s.maxAnnualCtc, isDefault: s.isDefault ?? false });
  }
  log("Salary structures", `${SALARY_STRUCTURES.length} range-based (Class A-D)`);

  const pickStructure = (ctc: number) =>
    structureIds.find((s) => (s.min === null || ctc >= s.min) && (s.max === null || ctc <= s.max))
      ?? structureIds.find((s) => s.isDefault)!;

  // ---------------------------------------------------------------------
  //  Employees
  // ---------------------------------------------------------------------
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  interface EmpSeed {
    first: string; last: string; gender: "MALE" | "FEMALE";
    title: string; dept: string; bu: string; loc: string; entity: string;
    ctc: number; doj: [number, number, number]; dob: [number, number, number];
    band: string; grade: string; cc: string;
    manager?: string;        // employeeNumber of the manager
    roles?: string[];
    status?: "CONFIRMED" | "PROBATION" | "NOTICE_PERIOD";
    regime?: "OLD" | "NEW";
    worker?: string;
  }

  const emps: EmpSeed[] = [
    { first: "Vikram", last: "Menon", gender: "MALE", title: "Chief Executive Officer", dept: "FIN", bu: buCorporate.id, loc: blr.id, entity: entityTech.id, ctc: 6000000, doj: [2014, 7, 21], dob: [1978, 3, 12], band: "B7", grade: "G5", cc: "CC-GA", roles: ["GLOBAL_ADMIN"], regime: "OLD" },
    { first: "Ramesh", last: "Iyer", gender: "MALE", title: "Chief Financial Officer", dept: "FIN", bu: buCorporate.id, loc: blr.id, entity: entityTech.id, ctc: 4800000, doj: [2015, 1, 5], dob: [1975, 11, 2], band: "B7", grade: "G5", cc: "CC-GA", manager: "ACM0001", roles: ["PAYROLL_ADMIN"], regime: "OLD" },
    { first: "Priya", last: "Sharma", gender: "FEMALE", title: "HR Business Partner", dept: "HR", bu: buCorporate.id, loc: blr.id, entity: entityTech.id, ctc: 2400000, doj: [2016, 6, 1], dob: [1986, 7, 19], band: "B5", grade: "G4", cc: "CC-GA", manager: "ACM0001", roles: ["HR_MANAGER"], regime: "OLD" },
    { first: "Arjun", last: "Nair", gender: "MALE", title: "Director of Engineering", dept: "PLAT", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 4200000, doj: [2015, 9, 14], dob: [1982, 1, 30], band: "B6", grade: "G5", cc: "CC-ENG", manager: "ACM0001", regime: "NEW" },
    { first: "Sneha", last: "Reddy", gender: "FEMALE", title: "Engineering Manager", dept: "PLAT", bu: buEngineering.id, loc: hyd.id, entity: entityTech.id, ctc: 3200000, doj: [2017, 3, 20], dob: [1988, 5, 8], band: "B5", grade: "G4", cc: "CC-ENG", manager: "ACM0004", regime: "NEW" },
    { first: "Karthik", last: "Subramanian", gender: "MALE", title: "Staff Engineer", dept: "PLAT", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 2800000, doj: [2018, 1, 8], dob: [1989, 9, 14], band: "B4", grade: "G4", cc: "CC-ENG", manager: "ACM0005", regime: "NEW" },
    { first: "Ananya", last: "Ghosh", gender: "FEMALE", title: "Senior Software Engineer", dept: "PROD", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 1800000, doj: [2019, 7, 15], dob: [1992, 2, 23], band: "B3", grade: "G3", cc: "CC-ENG", manager: "ACM0005", regime: "OLD" },
    { first: "Rohit", last: "Deshmukh", gender: "MALE", title: "Senior Software Engineer", dept: "PROD", bu: buEngineering.id, loc: bom.id, entity: entityTech.id, ctc: 1650000, doj: [2020, 2, 10], dob: [1993, 6, 5], band: "B3", grade: "G3", cc: "CC-ENG", manager: "ACM0005", regime: "NEW" },
    { first: "Meera", last: "Krishnan", gender: "FEMALE", title: "Software Engineer", dept: "PROD", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 1200000, doj: [2022, 8, 1], dob: [1997, 10, 11], band: "B2", grade: "G2", cc: "CC-ENG", manager: "ACM0007", regime: "NEW" },
    { first: "Aditya", last: "Verma", gender: "MALE", title: "Software Engineer", dept: "PROD", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 1100000, doj: [2023, 1, 16], dob: [1998, 4, 2], band: "B2", grade: "G2", cc: "CC-ENG", manager: "ACM0007", regime: "NEW" },
    { first: "Divya", last: "Pillai", gender: "FEMALE", title: "QA Engineer", dept: "QA", bu: buEngineering.id, loc: maa.id, entity: entityTech.id, ctc: 900000, doj: [2021, 11, 22], dob: [1995, 12, 30], band: "B2", grade: "G2", cc: "CC-ENG", manager: "ACM0005", regime: "NEW" },
    { first: "Sanjay", last: "Gupta", gender: "MALE", title: "QA Engineer", dept: "QA", bu: buEngineering.id, loc: hyd.id, entity: entityTech.id, ctc: 780000, doj: [2023, 6, 5], dob: [1996, 8, 17], band: "B2", grade: "G1", cc: "CC-ENG", manager: "ACM0005", regime: "NEW" },
    { first: "Nikhil", last: "Joshi", gender: "MALE", title: "Product Designer", dept: "DSGN", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 1400000, doj: [2021, 4, 12], dob: [1994, 3, 25], band: "B3", grade: "G3", cc: "CC-ENG", manager: "ACM0004", regime: "NEW" },
    { first: "Kavya", last: "Bhat", gender: "FEMALE", title: "Product Manager", dept: "PROD", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 2200000, doj: [2019, 10, 1], dob: [1990, 6, 9], band: "B4", grade: "G4", cc: "CC-ENG", manager: "ACM0004", regime: "OLD" },
    { first: "Rahul", last: "Kapoor", gender: "MALE", title: "Account Executive", dept: "SALES", bu: buRevenue.id, loc: bom.id, entity: entityTech.id, ctc: 1500000, doj: [2020, 9, 7], dob: [1991, 1, 18], band: "B3", grade: "G3", cc: "CC-GTM", manager: "ACM0001", regime: "OLD" },
    { first: "Pooja", last: "Malhotra", gender: "FEMALE", title: "Account Executive", dept: "SALES", bu: buRevenue.id, loc: bom.id, entity: entityTech.id, ctc: 1350000, doj: [2022, 2, 14], dob: [1994, 9, 3], band: "B3", grade: "G3", cc: "CC-GTM", manager: "ACM0015", regime: "NEW" },
    { first: "Suresh", last: "Babu", gender: "MALE", title: "Customer Success Manager", dept: "CS", bu: buRevenue.id, loc: maa.id, entity: entityTech.id, ctc: 1250000, doj: [2021, 7, 19], dob: [1990, 11, 27], band: "B3", grade: "G3", cc: "CC-GTM", manager: "ACM0015", regime: "NEW" },
    { first: "Neha", last: "Agarwal", gender: "FEMALE", title: "Marketing Manager", dept: "MKTG", bu: buRevenue.id, loc: blr.id, entity: entityTech.id, ctc: 1600000, doj: [2020, 5, 4], dob: [1991, 7, 22], band: "B4", grade: "G3", cc: "CC-GTM", manager: "ACM0001", regime: "OLD" },
    { first: "Deepak", last: "Chauhan", gender: "MALE", title: "HR Executive", dept: "HR", bu: buCorporate.id, loc: blr.id, entity: entityTech.id, ctc: 700000, doj: [2023, 3, 13], dob: [1997, 2, 8], band: "B2", grade: "G1", cc: "CC-GA", manager: "ACM0003", roles: ["HR_EXECUTIVE"], regime: "NEW" },
    { first: "Lakshmi", last: "Narayanan", gender: "FEMALE", title: "Payroll Specialist", dept: "FIN", bu: buCorporate.id, loc: blr.id, entity: entityTech.id, ctc: 950000, doj: [2021, 8, 30], dob: [1993, 5, 15], band: "B2", grade: "G2", cc: "CC-GA", manager: "ACM0002", roles: ["PAYROLL_ADMIN"], regime: "NEW" },
    { first: "Manish", last: "Tiwari", gender: "MALE", title: "Financial Analyst", dept: "FIN", bu: buCorporate.id, loc: blr.id, entity: entityTech.id, ctc: 1100000, doj: [2022, 6, 20], dob: [1995, 1, 9], band: "B2", grade: "G2", cc: "CC-GA", manager: "ACM0002", regime: "NEW" },
    { first: "Ritu", last: "Saxena", gender: "FEMALE", title: "IT Administrator", dept: "IT", bu: buCorporate.id, loc: blr.id, entity: entityTech.id, ctc: 850000, doj: [2022, 10, 3], dob: [1994, 12, 1], band: "B2", grade: "G2", cc: "CC-GA", manager: "ACM0002", roles: ["ASSET_MANAGER"], regime: "NEW" },
    { first: "Imran", last: "Sheikh", gender: "MALE", title: "Service Delivery Lead", dept: "SD", bu: buOperations.id, loc: maa.id, entity: entityServices.id, ctc: 1300000, doj: [2019, 12, 2], dob: [1989, 4, 21], band: "B4", grade: "G3", cc: "CC-SD", manager: "ACM0001", regime: "NEW" },
    { first: "Swati", last: "Kulkarni", gender: "FEMALE", title: "Software Engineer", dept: "PLAT", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 1050000, doj: [2026, 6, 15], dob: [1999, 3, 7], band: "B2", grade: "G2", cc: "CC-ENG", manager: "ACM0006", status: "PROBATION", regime: "NEW" },
    { first: "Harish", last: "Prasad", gender: "MALE", title: "Software Engineer", dept: "PROD", bu: buEngineering.id, loc: hyd.id, entity: entityTech.id, ctc: 980000, doj: [2026, 8, 1], dob: [1998, 11, 19], band: "B2", grade: "G2", cc: "CC-ENG", manager: "ACM0007", status: "PROBATION", regime: "NEW" },
    { first: "Tanvi", last: "Shah", gender: "FEMALE", title: "Intern", dept: "DSGN", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 300000, doj: [2026, 7, 1], dob: [2003, 5, 12], band: "B1", grade: "G1", cc: "CC-ENG", manager: "ACM0013", worker: "Intern", regime: "NEW" },
    { first: "Gaurav", last: "Mishra", gender: "MALE", title: "Software Engineer", dept: "PROD", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 1150000, doj: [2021, 9, 6], dob: [1995, 8, 28], band: "B2", grade: "G2", cc: "CC-ENG", manager: "ACM0007", status: "NOTICE_PERIOD", regime: "NEW" },
    { first: "Anjali", last: "Desai", gender: "FEMALE", title: "Customer Success Manager", dept: "CS", bu: buRevenue.id, loc: bom.id, entity: entityTech.id, ctc: 1180000, doj: [2022, 4, 18], dob: [1994, 2, 14], band: "B3", grade: "G2", cc: "CC-GTM", manager: "ACM0015", regime: "OLD" },
    { first: "Varun", last: "Rathore", gender: "MALE", title: "Senior Software Engineer", dept: "PLAT", bu: buEngineering.id, loc: blr.id, entity: entityTech.id, ctc: 1900000, doj: [2019, 3, 25], dob: [1991, 10, 6], band: "B3", grade: "G3", cc: "CC-ENG", manager: "ACM0006", regime: "OLD" },
    { first: "Shreya", last: "Banerjee", gender: "FEMALE", title: "Senior Software Engineer", dept: "PLAT", bu: buEngineering.id, loc: maa.id, entity: entityTech.id, ctc: 1750000, doj: [2020, 7, 13], dob: [1992, 12, 25], band: "B3", grade: "G3", cc: "CC-ENG", manager: "ACM0006", regime: "NEW" },
  ];

  const empIdByNumber = new Map<string, string>();
  const created: Array<{ id: string; number: string; ctc: number; doj: Date }> = [];

  for (const [i, e] of emps.entries()) {
    const employeeNumber = `ACM${String(i + 1).padStart(4, "0")}`;
    const doj = utc(...e.doj);
    const dob = utc(...e.dob);
    const email = `${e.first.toLowerCase()}.${e.last.toLowerCase()}@acme.test`;

    const user = await prisma.user.create({
      data: { tenantId: tenant.id, email, passwordHash, phone: `+9198${String(40000000 + i * 137).padStart(8, "0")}` },
    });

    const employee = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        employeeNumber,
        attendanceNumber: String(1000 + i),
        userId: user.id,
        firstName: e.first, lastName: e.last, displayName: `${e.first} ${e.last}`,
        workEmail: email, personalEmail: `${e.first.toLowerCase()}${i}@gmail.test`,
        mobile: `+9198${String(40000000 + i * 137).padStart(8, "0")}`,
        dateOfBirth: dob, gender: e.gender,
        maritalStatus: i % 3 === 0 ? "MARRIED" : "SINGLE",
        nationality: "Indian",
        status: e.status ?? "CONFIRMED",
        dateOfJoining: doj,
        confirmationDate: e.status === "PROBATION" ? null : new Date(doj.getTime() + 180 * 86400000),
        legalEntityId: e.entity, businessUnitId: e.bu,
        departmentId: departments.get(e.dept)!, locationId: e.loc,
        costCenterId: costCenters.get(e.cc)!,
        bandId: bands.get(e.band)!, payGradeId: grades.get(e.grade)!,
        workerTypeId: workerTypes.get(e.worker ?? "Permanent")!,
        jobTitleName: e.title,
        payGroupId: payGroup.id,
        profileCompletion: 85 + (i % 15),
        addresses: {
          create: [{
            type: "CURRENT", line1: `${101 + i}, Residency Road`, city: "Bengaluru",
            state: "Karnataka", stateCode: "KA", postalCode: "560025",
          }],
        },
        identityDocs: {
          create: [
            { type: "PAN", number: `A${e.last.slice(0, 2).toUpperCase()}P${e.first.slice(0, 1).toUpperCase()}${String(1000 + i)}${"ABCDEFGHJK"[i % 10]}`, nameOnDoc: `${e.first} ${e.last}`, isVerified: true },
            { type: "AADHAAR", number: String(200000000000 + i * 7919), isVerified: true },
          ],
        },
        bankAccounts: {
          create: [{
            bankName: ["HDFC Bank", "ICICI Bank", "Axis Bank", "State Bank of India"][i % 4],
            accountNumber: String(50100000000000 + i * 31337),
            ifsc: ["HDFC0000123", "ICIC0000029", "UTIB0000456", "SBIN0000789"][i % 4],
            branch: "Bengaluru", accountHolder: `${e.first} ${e.last}`,
            isPrimary: true, isVerified: true,
          }],
        },
        statutoryProfile: {
          create: {
            pfEnabled: e.ctc > 300000,
            uan: String(100000000000 + i * 8191),
            pfAccountNumber: `KN/BNG/0012345/000/${String(i + 1).padStart(7, "0")}`,
            esiEnabled: true,
            esicNumber: e.ctc / 12 <= 25000 ? String(3100000000 + i * 613) : null,
            ptEnabled: true, lwfEnabled: true,
            taxRegime: e.regime ?? "NEW",
            vpfAmount: i % 7 === 0 ? 5000 : null,
          },
        },
        jobHistory: {
          create: [{
            effectiveFrom: doj, reason: "NEW_HIRE",
            jobTitleId: jobTitles.get(e.title) ?? null,
            departmentId: departments.get(e.dept)!, businessUnitId: e.bu,
            locationId: e.loc, legalEntityId: e.entity,
            bandId: bands.get(e.band)!, payGradeId: grades.get(e.grade)!,
            note: "Initial appointment",
          }],
        },
      },
    });

    empIdByNumber.set(employeeNumber, employee.id);
    created.push({ id: employee.id, number: employeeNumber, ctc: e.ctc, doj });

    // Role grants
    for (const roleKey of e.roles ?? []) {
      const roleId = roleByKey.get(roleKey);
      if (roleId) {
        await prisma.userRoleAssignment.create({ data: { userId: user.id, roleId } });
      }
    }

    // Salary
    const structure = pickStructure(e.ctc);
    await prisma.salaryRevision.create({
      data: {
        employeeId: employee.id,
        structureId: structure.id,
        effectiveFrom: doj,
        annualCtc: e.ctc,
        remunerationType: "MONTHLY",
        status: "APPLIED",
        reason: "Initial compensation on joining",
      },
    });
  }

  // The seed assigns numbers directly, so the series has to be advanced past
  // them. Leaving it at 1 makes the first real "add employee" walk the whole
  // clash-avoidance loop before it finds a free slot.
  await prisma.employeeNumberSeries.updateMany({
    where: { tenantId: tenant.id, name: "Default" },
    data: { nextNumber: created.length + 1 },
  });

  // Reporting lines and heads, now that every employee exists.
  for (const [i, e] of emps.entries()) {
    if (!e.manager) continue;
    const managerId = empIdByNumber.get(e.manager);
    if (!managerId) continue;
    await prisma.employee.update({
      where: { id: empIdByNumber.get(`ACM${String(i + 1).padStart(4, "0")}`)! },
      data: { reportingManagerId: managerId },
    });
  }
  await prisma.department.update({ where: { id: departments.get("PLAT")! }, data: { headId: empIdByNumber.get("ACM0005") } });
  await prisma.department.update({ where: { id: departments.get("PROD")! }, data: { headId: empIdByNumber.get("ACM0014") } });
  await prisma.department.update({ where: { id: departments.get("HR")! }, data: { headId: empIdByNumber.get("ACM0003") } });
  await prisma.department.update({ where: { id: departments.get("FIN")! }, data: { headId: empIdByNumber.get("ACM0002") } });
  await prisma.department.update({ where: { id: departments.get("SALES")! }, data: { headId: empIdByNumber.get("ACM0015") } });
  await prisma.businessUnit.update({ where: { id: buEngineering.id }, data: { headId: empIdByNumber.get("ACM0004") } });
  await prisma.businessUnit.update({ where: { id: buCorporate.id }, data: { headId: empIdByNumber.get("ACM0002") } });
  await prisma.businessUnit.update({ where: { id: buRevenue.id }, data: { headId: empIdByNumber.get("ACM0015") } });

  // A scoped role grant, to exercise the scoping layer.
  const hrExecUser = await prisma.employee.findFirst({
    where: { employeeNumber: "ACM0019" }, select: { userId: true },
  });
  if (hrExecUser?.userId) {
    const assignment = await prisma.userRoleAssignment.findFirst({
      where: { userId: hrExecUser.userId, roleId: roleByKey.get("HR_EXECUTIVE")! },
    });
    if (assignment) {
      await prisma.roleScope.create({
        data: { assignmentId: assignment.id, departmentId: departments.get("PLAT")! },
      });
      await prisma.roleScope.create({
        data: { assignmentId: assignment.id, departmentId: departments.get("PROD")! },
      });
    }
  }

  // Finance Controller custom role, granted to the financial analyst.
  const analyst = await prisma.employee.findFirst({ where: { employeeNumber: "ACM0021" }, select: { userId: true } });
  if (analyst?.userId) {
    await prisma.userRoleAssignment.create({ data: { userId: analyst.userId, roleId: customRole.id } });
  }

  log("Employees", `${created.length} with users, statutory profiles and salaries`);

  // ---------------------------------------------------------------------
  //  Leave, holidays, notice policy
  // ---------------------------------------------------------------------
  const leaveTypes = [
    { code: "EL", name: "Earned Leave", category: "REGULAR", quota: 18, isPaid: true, accrual: "MONTHLY", yearEnd: "CARRY_FORWARD_THEN_PAY", carryMax: 30, encash: true },
    { code: "CL", name: "Casual Leave", category: "REGULAR", quota: 8, isPaid: true, accrual: "MONTHLY", yearEnd: "RESET", carryMax: null, encash: false },
    { code: "SL", name: "Sick Leave", category: "REGULAR", quota: 12, isPaid: true, accrual: "MONTHLY", yearEnd: "RESET", carryMax: null, encash: false },
    { code: "ML", name: "Maternity Leave", category: "INCIDENT", quota: 182, isPaid: true, accrual: "UPFRONT", yearEnd: "RESET", carryMax: null, encash: false },
    { code: "PL", name: "Paternity Leave", category: "INCIDENT", quota: 5, isPaid: true, accrual: "UPFRONT", yearEnd: "RESET", carryMax: null, encash: false },
    { code: "LWP", name: "Leave Without Pay", category: "UNPAID", quota: 0, isPaid: false, accrual: "UPFRONT", yearEnd: "RESET", carryMax: null, encash: false },
    { code: "COMP", name: "Compensatory Off", category: "COMP_OFF", quota: 0, isPaid: true, accrual: "UPFRONT", yearEnd: "RESET", carryMax: null, encash: false },
    { code: "FLOAT", name: "Floating Holiday", category: "FLOATER", quota: 2, isPaid: true, accrual: "UPFRONT", yearEnd: "RESET", carryMax: null, encash: false },
  ] as const;

  const leaveTypeIds: string[] = [];
  for (const lt of leaveTypes) {
    const created = await prisma.leaveType.create({
      data: {
        tenantId: tenant.id, code: lt.code, name: lt.name,
        category: lt.category, isPaid: lt.isPaid,
        accrualFrequency: lt.accrual, annualQuota: lt.quota,
        yearEndAction: lt.yearEnd, carryForwardMax: lt.carryMax,
        encashmentEnabled: lt.encash,
        encashmentFormula: lt.encash ? "[BASIC] / 30" : null,
        allowHalfDay: true,
        prorateOnJoining: true,
        // Sandwich: a weekend between two leave days is consumed, and the
        // rule is clubbed across leave types.
        sandwichConfig: {
          weeklyOff: { between: true, before: false, after: false },
          holiday: { between: true, before: false, after: false },
          clubAcrossLeaveTypes: true,
          excludeHalfDay: true,
        },
      },
    });
    leaveTypeIds.push(created.id);
  }

  const leavePlan = await prisma.leavePlan.create({
    data: {
      tenantId: tenant.id, name: "India Standard", yearBasis: "FINANCIAL_APR",
      isDefault: true,
      types: { create: leaveTypeIds.map((leaveTypeId) => ({ leaveTypeId })) },
    },
  });

  const yearStart = utc(2026, 4, 1);
  for (const emp of created) {
    await prisma.leavePlanAssignment.create({
      data: { planId: leavePlan.id, employeeId: emp.id, effectiveFrom: emp.doj > yearStart ? emp.doj : yearStart },
    });
    // Balances are not written here. The real accrual job credits them later
    // in the seed, so every balance is backed by ledger entries.
  }

  const calendar = await prisma.holidayCalendar.create({
    data: {
      tenantId: tenant.id, name: "India 2026", year: 2026, isDefault: true,
      holidays: {
        create: [
          { name: "Republic Day", date: utc(2026, 1, 26) },
          { name: "Holi", date: utc(2026, 3, 4) },
          { name: "Ugadi", date: utc(2026, 3, 19), isOptional: true },
          { name: "Good Friday", date: utc(2026, 4, 3), isOptional: true },
          { name: "May Day", date: utc(2026, 5, 1) },
          { name: "Independence Day", date: utc(2026, 8, 15) },
          { name: "Ganesh Chaturthi", date: utc(2026, 9, 14) },
          { name: "Gandhi Jayanti", date: utc(2026, 10, 2) },
          { name: "Dussehra", date: utc(2026, 10, 20) },
          { name: "Diwali", date: utc(2026, 11, 8) },
          { name: "Kannada Rajyotsava", date: utc(2026, 11, 1), isOptional: true },
          { name: "Christmas", date: utc(2026, 12, 25) },
        ],
      },
    },
  });

  await prisma.noticePeriodPolicy.create({
    data: {
      tenantId: tenant.id, name: "Standard — 60 days",
      resignationDays: 60, terminationDays: 30, probationDays: 15,
      allowBuyout: true, buyoutBasis: "GROSS", isDefault: true,
    },
  });
  await prisma.noticePeriodPolicy.create({
    data: {
      tenantId: tenant.id, name: "Leadership — 90 days",
      resignationDays: 90, terminationDays: 60, probationDays: 30,
      allowBuyout: true, buyoutBasis: "GROSS",
    },
  });
  log("Leave & calendars", `${leaveTypes.length} leave types, 12 holidays, 2 notice policies`);

  // ---------------------------------------------------------------------
  //  Loans
  // ---------------------------------------------------------------------
  const loanCat = await prisma.loanCategory.create({
    data: { tenantId: tenant.id, name: "Personal Loan", description: "General-purpose employee loan", icon: "wallet", color: "#2563eb", isConcessional: true, sbiBenchmarkRate: 9.15 },
  });
  const emergencyCat = await prisma.loanCategory.create({
    data: { tenantId: tenant.id, name: "Emergency Advance", description: "Salary advance for emergencies", icon: "alert", color: "#dc2626", isConcessional: true, sbiBenchmarkRate: 9.15 },
  });
  const loanPolicy = await prisma.loanPolicy.create({
    data: {
      tenantId: tenant.id, name: "Standard Loan Policy",
      requireProbationComplete: true, minDaysFromJoining: 180,
      minAnnualSalary: 500000, blockOnNoticePeriod: true,
      approverRoleIds: [roleByKey.get("HR_MANAGER"), roleByKey.get("PAYROLL_ADMIN")],
      autoApproveAfterDays: 7,
      rules: {
        create: [
          { categoryId: loanCat.id, interestType: "NONE", maxInstallments: 24, commencementMonths: 1, maxPercentOfSalary: 25, requiresDocuments: true },
          { categoryId: emergencyCat.id, interestType: "NONE", maxInstallments: 6, commencementMonths: 1, maxAmount: 100000 },
        ],
      },
    },
  });

  // A live loan, so the payroll run has an EMI to deduct.
  const borrower = created.find((c) => c.number === "ACM0009")!;
  const loan = await prisma.loan.create({
    data: {
      employeeId: borrower.id, categoryId: loanCat.id, policyId: loanPolicy.id,
      principal: 240000, interestType: "NONE", interestRate: 0,
      installments: 24, emiAmount: 10000,
      status: "ACTIVE", approvedAt: utc(2026, 3, 20), disbursedAt: utc(2026, 4, 1),
      // Nothing repaid yet: the finalised payroll months deduct the EMIs, so
      // the loan, the payslips and the ledger all tell the same story.
      startYear: 2026, startMonth: 4, outstanding: 240000, totalRepaid: 0,
      purpose: "Home renovation",
    },
  });
  for (let n = 1; n <= 24; n++) {
    const m0 = 3 + (n - 1);
    await prisma.loanInstallment.create({
      data: {
        loanId: loan.id, sequence: n,
        year: 2026 + Math.floor(m0 / 12), month: (m0 % 12) + 1,
        principalPart: 10000, interestPart: 0, totalAmount: 10000,
        balanceAfter: 240000 - n * 10000,
        status: "SCHEDULED",
      },
    });
  }
  log("Loans", "2 categories, 1 policy, 1 active loan with a 24-month schedule");

  // ---------------------------------------------------------------------
  //  Accounting mappings for the journal voucher
  // ---------------------------------------------------------------------
  const mappings: Array<[string, string, string, string]> = [
    ["BASIC", "5001", "Salaries — Basic", "DEBIT"],
    ["HRA", "5002", "Salaries — HRA", "DEBIT"],
    ["SPECIAL", "5003", "Salaries — Special Allowance", "DEBIT"],
    ["CONVEYANCE", "5004", "Salaries — Conveyance", "DEBIT"],
    ["MEDICAL", "5005", "Salaries — Medical", "DEBIT"],
    ["LTA", "5006", "Salaries — LTA", "DEBIT"],
    ["PF_EMPLOYER", "5010", "Employer PF Contribution", "DEBIT"],
    ["ESI_EMPLOYER", "5011", "Employer ESI Contribution", "DEBIT"],
    ["GRATUITY_PROVISION", "5012", "Gratuity Provision", "DEBIT"],
    ["PF_EMPLOYEE", "2001", "PF Payable", "CREDIT"],
    ["ESI_EMPLOYEE", "2002", "ESI Payable", "CREDIT"],
    ["PT", "2003", "Professional Tax Payable", "CREDIT"],
    ["LWF_EMPLOYEE", "2004", "LWF Payable", "CREDIT"],
    ["TDS", "2005", "TDS Payable", "CREDIT"],
    ["NET_PAY", "2010", "Salary Payable", "CREDIT"],
  ];
  for (const [componentCode, accountCode, accountName, side] of mappings) {
    await prisma.accountMapping.create({
      data: { tenantId: tenant.id, componentCode, accountCode, accountName, side, target: "XLSX" },
    });
  }
  log("Accounting", `${mappings.length} GL mappings for journal-voucher export`);

  // ---------------------------------------------------------------------
  //  Workplace modules
  // ---------------------------------------------------------------------
  const wp = await seedWorkplace(prisma, {
    tenantId: tenant.id,
    employees: created,
    locationIds: locations.map((l) => l.id),
    departmentIds: departments,
    empIdByNumber,
  });
  log("Announcements", `${wp.announcements} (2 pinned, 1 scheduled, acknowledgement tracked)`);
  log("Awards & praise", `${wp.awardTypes} award types, ${wp.awards} granted, ${wp.praises} praises`);
  log("Assets", `${wp.assets} items across 4 categories, assigned with 1 damage recovery`);
  log("Documents", `${wp.orgDocuments} org policies, ${wp.templates} letter templates, per-employee docs`);
  log("Contracts", `1 per employee, mix of permanent and fixed-term`);
  log("HR activities", `${wp.activities} timeline events`);
  log("Training", `${wp.trainingPrograms} programmes with enrolments`);
  log("Meetings", `${wp.meetings} across ${wp.rooms} rooms, with minutes and action items`);

  const tm = await seedTime(prisma, {
    tenantId: tenant.id, employees: created, empIdByNumber,
  });
  log("Time policies", `${tm.shifts} shifts, ${tm.weeklyOffPolicies} weekly-off patterns, ${tm.attendancePolicies} attendance policies`);
  log("Leave accrual", `${tm.accrualCredits} ledger credits (${tm.accruedDays} days) across Apr–Sep via the accrual job`);
  log("Leave requests", `${tm.leaveApproved} approved, ${tm.leavePending} pending — raised through the real service`);
  log("Attendance", `${tm.punches} punches, ${tm.attendanceDays} days processed, ${tm.lopDays} LOP days`);

  const lc = await seedLifecycle(prisma, {
    tenantId: tenant.id, empIdByNumber,
    departmentIdByName: new Map((await prisma.department.findMany({ where: { tenantId: tenant.id } })).map((d) => [d.name, d.id])),
  });
  log("Journeys", `${lc.templates} templates, ${lc.journeys} journeys started from joining, promotion and exit events`);
  log("Exits", `3 at different stages; F&F ${lc.fnfMessage}`);
  log("Helpdesk", `${lc.categories} categories, ${lc.tickets} tickets across every status`);

  const finance = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: "ramesh.iyer@acme.test" } });
  await seedAccountingOpening(prisma, { tenantId: tenant.id, byUserId: finance.id });
  const ph = await seedPayrollHistory(prisma, { tenantId: tenant.id });
  log("Payroll history", `${ph.finalised} months finalised (Apr–Aug), ${ph.payslips} payslips released; September open`);

  const pf = await seedPerformance(prisma, { tenantId: tenant.id, empIdByNumber });
  log("Performance", `${pf.goals} goals with ${pf.checkIns} check-ins; ${pf.reviewsLastYear} reviews shared last year, ${pf.reviewsMidYear} mid-year in progress`);

  const hr = await seedHiring(prisma, { tenantId: tenant.id, empIdByNumber });
  log("Hiring", `${hr.candidates} candidates across the pipeline, ${hr.interviews} interviews; one offer accepted, ready to hire`);

  const ex = await seedExpenses(prisma, { tenantId: tenant.id, empIdByNumber });
  log("Expenses & travel", `${ex.categories} categories, ${ex.claims} claims at every stage, an advance part-settled, 3 trips`);

  const pj = await seedProjects(prisma, { tenantId: tenant.id, empIdByNumber });
  log("Projects & time", `${pj.clients} clients, ${pj.projects} projects (T&M, milestone, retainer, internal), ${pj.timesheets} timesheets, ${pj.invoices} invoices (${pj.overdue} overdue)`);

  const ss = await seedSelfService(prisma, { tenantId: tenant.id });
  log("Self-service", `${ss.about} profiles introduced, ${ss.praise} praises and ${ss.feedback} feedback notes, ${ss.declarations} tax declarations`);

  const el = await seedEngageLearn(prisma, { tenantId: tenant.id, empIdByNumber });
  log("Engagement & learning", `${el.surveys} surveys and polls (${el.responses} responses), ${el.skills} skills on ${el.skillRows} profiles, ${el.paths} career paths, ${el.courses} courses with ${el.enrolments} enrolments; comp-off and ${el.encash} encashment awaiting a decision`);

  const pr = await seedProbation(prisma, { tenantId: tenant.id, empIdByNumber });
  log("Probation", `${pr.policies} policies, ${pr.started} employees on probation; one ended with ${pr.reviews} reviews in, waiting on HR`);

  // Keka parity areas: one idempotent module per area, each runnable on its own.
  const hd = await seedHelpdesk(prisma, { tenantId: tenant.id });
  log("Helpdesk (Keka)", `${hd.categories} categories and subcategories, ${hd.tickets} tickets (${hd.open} open, ${hd.closed} closed) with threads, followers and SLA flags`);
  const an = await seedAnalytics(prisma, { tenantId: tenant.id });
  log("Org analytics", `${an.reasons} exit reasons, ${an.leavers} past leavers with history, ${an.raises} raise histories, ${an.snapshots} risk scores (${an.risk.HIGH} high, ${an.risk.MEDIUM} medium today), a shared storyboard`);
  // @keka-parity-seeds (each area adds its import above and its call above this line)

  const ac = await seedAccountingActivity(prisma, { tenantId: tenant.id, byUserId: finance.id });
  log("General ledger", `${ac.entries} ledger entries: opening, ${ac.paid} payroll accruals and payments, ${ac.remitted} statutory remittances, invoices and receipts; Apr–Jun closed; trial balance ₹${ac.total.toLocaleString("en-IN")} each side`);

  const td = await seedToday(prisma, { tenantId: tenant.id });
  log("Today", td.skipped ? "outside the demo year — left as seeded" : `attendance brought up to ${td.today}: ${td.punches} punches, ${td.days} days processed; leave, WFH, on-duty and a birthday today`);

  // ---------------------------------------------------------------------
  //  Summary
  // ---------------------------------------------------------------------
  console.log("-".repeat(64));
  console.log(`\n  Tenant URL    http://localhost:3100  (subdomain: ${TENANT_SUBDOMAIN})`);
  console.log(`  Password      ${DEMO_PASSWORD}   (every seeded account)\n`);
  console.log("  Sign in as:");
  console.log("    vikram.menon@acme.test        Global Admin");
  console.log("    ramesh.iyer@acme.test         Payroll Admin");
  console.log("    priya.sharma@acme.test        HR Manager");
  console.log("    deepak.chauhan@acme.test      HR Executive (scoped to 2 departments)");
  console.log("    manish.tiwari@acme.test       Finance Controller (custom role)");
  console.log("    sneha.reddy@acme.test         no explicit role — implicit Reporting Manager");
  console.log("    meera.krishnan@acme.test      no role — employee self-service only\n");
}

main()
  .catch((e) => {
    console.error("\nSeed failed:\n", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
