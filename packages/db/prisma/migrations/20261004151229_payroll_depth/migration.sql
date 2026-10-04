-- CreateEnum
CREATE TYPE "TaxWindowKind" AS ENUM ('DECLARATION', 'PROOF');

-- CreateEnum
CREATE TYPE "TaxWindowState" AS ENUM ('OPEN', 'LOCKED');

-- AlterTable
ALTER TABLE "payroll_run_employees" ADD COLUMN     "autoPayableUnits" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "employee_component_overrides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "monthlyAmount" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_component_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_preferences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "hideMyPayPage" BOOLEAN NOT NULL DEFAULT false,
    "gratuityEligibilityYears" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "gratuityDaysPerYear" INTEGER NOT NULL DEFAULT 15,
    "gratuityDivisor" INTEGER NOT NULL DEFAULT 26,
    "gratuityCap" DECIMAL(18,2) NOT NULL DEFAULT 2000000,
    "gratuityWageCodes" JSONB,
    "bonusEnabled" BOOLEAN NOT NULL DEFAULT true,
    "bonusEligibilityCeiling" DECIMAL(18,2) NOT NULL DEFAULT 21000,
    "bonusCalculationCeiling" DECIMAL(18,2) NOT NULL DEFAULT 7000,
    "bonusMinimumWage" DECIMAL(18,2),
    "bonusPercent" DECIMAL(5,2) NOT NULL DEFAULT 8.33,
    "bonusMinWorkingDays" INTEGER NOT NULL DEFAULT 30,
    "bonusWageCodes" JSONB,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_window_overrides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT,
    "fyStartYear" INTEGER NOT NULL,
    "kind" "TaxWindowKind" NOT NULL,
    "state" "TaxWindowState" NOT NULL,
    "until" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_window_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_contractors" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pan" TEXT,
    "section" TEXT NOT NULL DEFAULT '194C',
    "tdsRate" DECIMAL(5,2) NOT NULL DEFAULT 1,
    "deducteeType" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_contractors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "section" TEXT NOT NULL,
    "tdsRate" DECIMAL(5,2) NOT NULL,
    "tdsAmount" DECIMAL(18,2) NOT NULL,
    "invoiceNumber" TEXT,
    "bsrCode" TEXT,
    "challanNumber" TEXT,
    "depositDate" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contractor_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_policy_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "payGroupId" TEXT,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_policy_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_budget_scenarios" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultPercent" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "departmentPercents" JSONB,
    "effectiveYear" INTEGER NOT NULL,
    "effectiveMonth" INTEGER NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comp_budget_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "minimum_wage_rates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'UNSKILLED',
    "monthlyAmount" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "minimum_wage_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_component_overrides_tenantId_idx" ON "employee_component_overrides"("tenantId");

-- CreateIndex
CREATE INDEX "employee_component_overrides_employeeId_effectiveFrom_idx" ON "employee_component_overrides"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_preferences_tenantId_key" ON "payroll_preferences"("tenantId");

-- CreateIndex
CREATE INDEX "tax_window_overrides_tenantId_fyStartYear_kind_idx" ON "tax_window_overrides"("tenantId", "fyStartYear", "kind");

-- CreateIndex
CREATE INDEX "tax_window_overrides_employeeId_idx" ON "tax_window_overrides"("employeeId");

-- CreateIndex
CREATE INDEX "tds_contractors_tenantId_idx" ON "tds_contractors"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tds_contractors_tenantId_name_key" ON "tds_contractors"("tenantId", "name");

-- CreateIndex
CREATE INDEX "contractor_payments_tenantId_paymentDate_idx" ON "contractor_payments"("tenantId", "paymentDate");

-- CreateIndex
CREATE INDEX "contractor_payments_contractorId_idx" ON "contractor_payments"("contractorId");

-- CreateIndex
CREATE INDEX "loan_policy_assignments_tenantId_idx" ON "loan_policy_assignments"("tenantId");

-- CreateIndex
CREATE INDEX "loan_policy_assignments_policyId_idx" ON "loan_policy_assignments"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "comp_budget_scenarios_tenantId_name_key" ON "comp_budget_scenarios"("tenantId", "name");

-- CreateIndex
CREATE INDEX "minimum_wage_rates_tenantId_stateCode_idx" ON "minimum_wage_rates"("tenantId", "stateCode");

-- CreateIndex
CREATE UNIQUE INDEX "minimum_wage_rates_tenantId_stateCode_category_effectiveFro_key" ON "minimum_wage_rates"("tenantId", "stateCode", "category", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "employee_component_overrides" ADD CONSTRAINT "employee_component_overrides_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_component_overrides" ADD CONSTRAINT "employee_component_overrides_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_component_overrides" ADD CONSTRAINT "employee_component_overrides_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "salary_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_preferences" ADD CONSTRAINT "payroll_preferences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_window_overrides" ADD CONSTRAINT "tax_window_overrides_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_window_overrides" ADD CONSTRAINT "tax_window_overrides_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_contractors" ADD CONSTRAINT "tds_contractors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_payments" ADD CONSTRAINT "contractor_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_payments" ADD CONSTRAINT "contractor_payments_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "tds_contractors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_policy_assignments" ADD CONSTRAINT "loan_policy_assignments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_policy_assignments" ADD CONSTRAINT "loan_policy_assignments_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "loan_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_policy_assignments" ADD CONSTRAINT "loan_policy_assignments_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_policy_assignments" ADD CONSTRAINT "loan_policy_assignments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_budget_scenarios" ADD CONSTRAINT "comp_budget_scenarios_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "minimum_wage_rates" ADD CONSTRAINT "minimum_wage_rates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
