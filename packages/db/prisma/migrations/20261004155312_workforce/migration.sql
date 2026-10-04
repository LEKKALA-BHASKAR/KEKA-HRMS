-- CreateEnum
CREATE TYPE "WorkforceRecordStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'RETIRED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('PROPOSED', 'VACANT', 'FILLED', 'FROZEN', 'CLOSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WorkforceRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "workforce_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "payload" JSONB,
    "reason" TEXT,
    "status" "WorkforceRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "workforce_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_families" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "parentId" TEXT,
    "status" "WorkforceRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_levels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "track" TEXT NOT NULL DEFAULT 'IC',
    "careerDefinition" TEXT,
    "bandId" TEXT,
    "payGradeId" TEXT,
    "status" "WorkforceRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "familyId" TEXT,
    "levelId" TEXT,
    "jobTitleId" TEXT,
    "summary" TEXT,
    "responsibilities" TEXT,
    "qualifications" TEXT,
    "competencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "WorkforceRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_description_versions" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "summary" TEXT,
    "responsibilities" TEXT,
    "qualifications" TEXT,
    "competencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "WorkforceRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "job_description_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "jobId" TEXT,
    "departmentId" TEXT,
    "locationId" TEXT,
    "costCenterId" TEXT,
    "payGradeId" TEXT,
    "reportsToId" TEXT,
    "status" "PositionStatus" NOT NULL DEFAULT 'PROPOSED',
    "isHeadcount" BOOLEAN NOT NULL DEFAULT true,
    "fte" DECIMAL(4,2) NOT NULL DEFAULT 1,
    "budgetedAnnualSalary" DECIMAL(18,2),
    "budgetStatus" TEXT NOT NULL DEFAULT 'BUDGETED',
    "incumbentEmployeeId" TEXT,
    "filledAt" TIMESTAMP(3),
    "vacantSince" TIMESTAMP(3),
    "vacancyReason" TEXT,
    "criticality" TEXT NOT NULL DEFAULT 'MEDIUM',
    "workMode" TEXT NOT NULL DEFAULT 'ONSITE',
    "allowedLocationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "frozenAt" TIMESTAMP(3),
    "frozenReason" TEXT,
    "requisitionId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_incumbencies" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_incumbencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workforce_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "departmentId" TEXT,
    "status" "WorkforceRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isScenario" BOOLEAN NOT NULL DEFAULT false,
    "baseplanId" TEXT,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "attritionPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "salaryIncreasePct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "benefitsLoadPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "overtimePct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "contractorCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workforce_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workforce_plan_lines" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "locationId" TEXT,
    "jobId" TEXT,
    "plannedHeadcount" INTEGER NOT NULL,
    "newHires" INTEGER NOT NULL DEFAULT 0,
    "replacementHires" INTEGER NOT NULL DEFAULT 0,
    "avgAnnualSalary" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "hireMonth" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,

    CONSTRAINT "workforce_plan_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workforce_budgets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "departmentId" TEXT,
    "planId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "previousId" TEXT,
    "salaryBudget" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "benefitsBudget" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "hiringBudget" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "contractorBudget" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "WorkforceRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workforce_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "WorkforceRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capacity_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_plan_lines" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "departmentId" TEXT,
    "demandFte" DECIMAL(8,2) NOT NULL,
    "note" TEXT,

    CONSTRAINT "capacity_plan_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contingent_vendors" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ONBOARDING',
    "checklist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contingent_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_documents" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "number" TEXT,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contingent_workers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "workerKind" TEXT NOT NULL DEFAULT 'CONTRACTOR',
    "engagementType" TEXT NOT NULL DEFAULT 'FIXED_TERM',
    "vendorId" TEXT,
    "pan" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "departmentId" TEXT,
    "managerEmployeeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "convertedEmployeeId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contingent_workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "departmentId" TEXT,
    "projectId" TEXT,
    "managerEmployeeId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "rateType" TEXT NOT NULL DEFAULT 'MONTHLY',
    "rate" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "poNumber" TEXT,
    "poAmount" DECIMAL(18,2),
    "sowReference" TEXT,
    "sowDescription" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "endReason" TEXT,
    "extensions" INTEGER NOT NULL DEFAULT 0,
    "alertedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sow_milestones" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sow_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_payment_profiles" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "payee" TEXT NOT NULL DEFAULT 'WORKER',
    "rateType" TEXT NOT NULL DEFAULT 'MONTHLY',
    "gstRegistered" BOOLEAN NOT NULL DEFAULT false,
    "gstin" TEXT,
    "gstRatePct" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "tdsSection" TEXT NOT NULL DEFAULT '194J',
    "tdsRatePct" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "ifsc" TEXT,
    "accountHolder" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractor_payment_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_rate_cards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorId" TEXT,
    "role" TEXT NOT NULL,
    "rateType" TEXT NOT NULL DEFAULT 'HOURLY',
    "rate" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contractor_rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_timesheets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(8,2) NOT NULL,
    "daysPresent" DECIMAL(5,1) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "note" TEXT,
    "submittedBy" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contractor_timesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_expenses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contractor_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_access" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'STANDARD',
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contractor_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_feedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "givenBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contractor_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workforce_requests_tenantId_status_idx" ON "workforce_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "workforce_requests_tenantId_entityType_entityId_idx" ON "workforce_requests"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "job_families_tenantId_status_idx" ON "job_families"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "job_families_tenantId_name_key" ON "job_families"("tenantId", "name");

-- CreateIndex
CREATE INDEX "job_levels_tenantId_status_idx" ON "job_levels"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "job_levels_tenantId_name_key" ON "job_levels"("tenantId", "name");

-- CreateIndex
CREATE INDEX "job_profiles_tenantId_status_idx" ON "job_profiles"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "job_profiles_tenantId_code_key" ON "job_profiles"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "job_description_versions_jobId_version_key" ON "job_description_versions"("jobId", "version");

-- CreateIndex
CREATE INDEX "positions_tenantId_status_idx" ON "positions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "positions_tenantId_departmentId_idx" ON "positions"("tenantId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "positions_tenantId_code_key" ON "positions"("tenantId", "code");

-- CreateIndex
CREATE INDEX "position_incumbencies_positionId_idx" ON "position_incumbencies"("positionId");

-- CreateIndex
CREATE INDEX "position_incumbencies_employeeId_idx" ON "position_incumbencies"("employeeId");

-- CreateIndex
CREATE INDEX "workforce_plans_tenantId_fiscalYear_idx" ON "workforce_plans"("tenantId", "fiscalYear");

-- CreateIndex
CREATE INDEX "workforce_plan_lines_planId_idx" ON "workforce_plan_lines"("planId");

-- CreateIndex
CREATE INDEX "workforce_budgets_tenantId_fiscalYear_idx" ON "workforce_budgets"("tenantId", "fiscalYear");

-- CreateIndex
CREATE INDEX "capacity_plans_tenantId_idx" ON "capacity_plans"("tenantId");

-- CreateIndex
CREATE INDEX "capacity_plan_lines_planId_idx" ON "capacity_plan_lines"("planId");

-- CreateIndex
CREATE INDEX "contingent_vendors_tenantId_idx" ON "contingent_vendors"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "contingent_vendors_tenantId_name_key" ON "contingent_vendors"("tenantId", "name");

-- CreateIndex
CREATE INDEX "vendor_documents_vendorId_idx" ON "vendor_documents"("vendorId");

-- CreateIndex
CREATE INDEX "contingent_workers_tenantId_status_idx" ON "contingent_workers"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contingent_workers_tenantId_code_key" ON "contingent_workers"("tenantId", "code");

-- CreateIndex
CREATE INDEX "contract_assignments_tenantId_status_idx" ON "contract_assignments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "contract_assignments_workerId_idx" ON "contract_assignments"("workerId");

-- CreateIndex
CREATE INDEX "contract_assignments_tenantId_endDate_idx" ON "contract_assignments"("tenantId", "endDate");

-- CreateIndex
CREATE INDEX "sow_milestones_assignmentId_idx" ON "sow_milestones"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "contractor_payment_profiles_workerId_key" ON "contractor_payment_profiles"("workerId");

-- CreateIndex
CREATE INDEX "contractor_rate_cards_tenantId_role_idx" ON "contractor_rate_cards"("tenantId", "role");

-- CreateIndex
CREATE INDEX "contractor_timesheets_tenantId_status_idx" ON "contractor_timesheets"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contractor_timesheets_assignmentId_periodStart_key" ON "contractor_timesheets"("assignmentId", "periodStart");

-- CreateIndex
CREATE INDEX "contractor_expenses_tenantId_status_idx" ON "contractor_expenses"("tenantId", "status");

-- CreateIndex
CREATE INDEX "contractor_access_workerId_idx" ON "contractor_access"("workerId");

-- CreateIndex
CREATE INDEX "contractor_feedback_workerId_idx" ON "contractor_feedback"("workerId");

-- AddForeignKey
ALTER TABLE "workforce_requests" ADD CONSTRAINT "workforce_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_families" ADD CONSTRAINT "job_families_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_families" ADD CONSTRAINT "job_families_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "job_families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_levels" ADD CONSTRAINT "job_levels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_profiles" ADD CONSTRAINT "job_profiles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_profiles" ADD CONSTRAINT "job_profiles_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "job_families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_profiles" ADD CONSTRAINT "job_profiles_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "job_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_description_versions" ADD CONSTRAINT "job_description_versions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_reportsToId_fkey" FOREIGN KEY ("reportsToId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_incumbencies" ADD CONSTRAINT "position_incumbencies_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_plans" ADD CONSTRAINT "workforce_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_plans" ADD CONSTRAINT "workforce_plans_baseplanId_fkey" FOREIGN KEY ("baseplanId") REFERENCES "workforce_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_plan_lines" ADD CONSTRAINT "workforce_plan_lines_planId_fkey" FOREIGN KEY ("planId") REFERENCES "workforce_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_budgets" ADD CONSTRAINT "workforce_budgets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_plans" ADD CONSTRAINT "capacity_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_plan_lines" ADD CONSTRAINT "capacity_plan_lines_planId_fkey" FOREIGN KEY ("planId") REFERENCES "capacity_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contingent_vendors" ADD CONSTRAINT "contingent_vendors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "contingent_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contingent_workers" ADD CONSTRAINT "contingent_workers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contingent_workers" ADD CONSTRAINT "contingent_workers_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "contingent_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_assignments" ADD CONSTRAINT "contract_assignments_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "contingent_workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sow_milestones" ADD CONSTRAINT "sow_milestones_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "contract_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_payment_profiles" ADD CONSTRAINT "contractor_payment_profiles_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "contingent_workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_rate_cards" ADD CONSTRAINT "contractor_rate_cards_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_rate_cards" ADD CONSTRAINT "contractor_rate_cards_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "contingent_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_timesheets" ADD CONSTRAINT "contractor_timesheets_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "contract_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_expenses" ADD CONSTRAINT "contractor_expenses_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "contract_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_access" ADD CONSTRAINT "contractor_access_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "contingent_workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_feedback" ADD CONSTRAINT "contractor_feedback_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "contingent_workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grant the new workforce permissions to existing tenants' built-in roles,
-- matching packages/rbac/src/roles.ts (new tenants are seeded from there).
INSERT INTO "role_permissions" ("id", "roleId", "permission")
SELECT 'rpwf' || md5(r."id" || p.perm), r."id", p.perm
FROM "roles" r
JOIN (VALUES
  ('GLOBAL_ADMIN', 'org.position.view'), ('GLOBAL_ADMIN', 'org.position.manage'), ('GLOBAL_ADMIN', 'org.position.approve'),
  ('GLOBAL_ADMIN', 'org.workforce_plan.view'), ('GLOBAL_ADMIN', 'org.workforce_plan.manage'), ('GLOBAL_ADMIN', 'org.workforce_plan.approve'),
  ('GLOBAL_ADMIN', 'org.contingent.view'), ('GLOBAL_ADMIN', 'org.contingent.manage'), ('GLOBAL_ADMIN', 'org.contingent.approve'),
  ('HR_MANAGER', 'org.position.view'), ('HR_MANAGER', 'org.position.manage'), ('HR_MANAGER', 'org.position.approve'),
  ('HR_MANAGER', 'org.workforce_plan.view'), ('HR_MANAGER', 'org.workforce_plan.manage'), ('HR_MANAGER', 'org.workforce_plan.approve'),
  ('HR_MANAGER', 'org.contingent.view'), ('HR_MANAGER', 'org.contingent.manage'), ('HR_MANAGER', 'org.contingent.approve'),
  ('HR_EXECUTIVE', 'org.position.view'), ('HR_EXECUTIVE', 'org.workforce_plan.view'),
  ('HR_EXECUTIVE', 'org.contingent.view'), ('HR_EXECUTIVE', 'org.contingent.manage'),
  ('PAYROLL_ADMIN', 'org.workforce_plan.view'), ('PAYROLL_ADMIN', 'org.contingent.view'),
  ('REQUISITION_MANAGER', 'org.position.view'), ('REQUISITION_MANAGER', 'org.workforce_plan.view')
) AS p(role_key, perm) ON p.role_key = r."key"
WHERE r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
