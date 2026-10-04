-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'SCHEDULED', 'APPLIED', 'REJECTED', 'WITHDRAWN', 'FAILED');

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "divisionId" TEXT;

-- CreateTable
CREATE TABLE "company_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalName" TEXT,
    "brandName" TEXT,
    "industry" TEXT,
    "website" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'IN',
    "foundedYear" INTEGER,
    "about" TEXT,
    "brandColor" TEXT NOT NULL DEFAULT '#1266a8',
    "locale" TEXT NOT NULL DEFAULT 'en-IN',
    "dateFormat" TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_years" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "calendarSet" TEXT NOT NULL DEFAULT 'STATUTORY',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workDays" TEXT[] DEFAULT ARRAY['MON', 'TUE', 'WED', 'THU', 'FRI']::TEXT[],
    "weekStartsOn" TEXT NOT NULL DEFAULT 'MON',
    "standardHoursPerDay" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "standardHoursPerWeek" DECIMAL(5,2) NOT NULL DEFAULT 40,
    "halfDayMinHours" DECIMAL(4,2) NOT NULL DEFAULT 4,
    "maxConsecutiveWorkDays" INTEGER NOT NULL DEFAULT 6,
    "overtimeAfterHours" DECIMAL(4,2) NOT NULL DEFAULT 9,
    "maxSpanOfControl" INTEGER NOT NULL DEFAULT 12,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "working_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_approval_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "change_approval_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_change_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "employeeId" TEXT,
    "operation" TEXT NOT NULL DEFAULT 'UPDATE',
    "title" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "previous" JSONB,
    "reason" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approverType" TEXT NOT NULL DEFAULT 'HR',
    "requestedBy" TEXT NOT NULL,
    "requestedByEmployeeId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "appliedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "record_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "divisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessUnitId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "headId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "divisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_teams" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "departmentId" TEXT,
    "divisionId" TEXT,
    "leadId" TEXT,
    "isCrossFunctional" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_team_members" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "role" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secondary_managers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DOTTED_LINE',
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secondary_managers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_delegations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "delegatorId" TEXT NOT NULL,
    "delegateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DELEGATE',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_request_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "templateId" TEXT NOT NULL,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_request_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "self_service_document_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "addressedTo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "letterId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "self_service_document_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mass_update_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "valueLabel" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "total" INTEGER NOT NULL DEFAULT 0,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" TIMESTAMP(3),
    "rolledBackBy" TEXT,

    CONSTRAINT "mass_update_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mass_update_items" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "jobChangeId" TEXT,

    CONSTRAINT "mass_update_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_checklist_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "description" TEXT,
    "items" JSONB NOT NULL,
    "requiresSignOff" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_checklists" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assignedBy" TEXT NOT NULL,
    "signedOffBy" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "signOffNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_checklist_items" (
    "id" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "owner" TEXT NOT NULL DEFAULT 'HR',
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneBy" TEXT,
    "doneAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "hr_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_internal_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'MANAGERS_AND_HR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_internal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_id_cards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "cardNumber" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "issuedBy" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "employee_id_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_saved_searches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "directory_saved_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_search_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "directory_search_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_address_history" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "validTo" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT,

    CONSTRAINT "employee_address_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_profiles_tenantId_key" ON "company_profiles"("tenantId");

-- CreateIndex
CREATE INDEX "fiscal_years_tenantId_calendarSet_startDate_idx" ON "fiscal_years"("tenantId", "calendarSet", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_years_tenantId_calendarSet_name_key" ON "fiscal_years"("tenantId", "calendarSet", "name");

-- CreateIndex
CREATE UNIQUE INDEX "working_rules_tenantId_key" ON "working_rules"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "change_approval_settings_tenantId_targetType_key" ON "change_approval_settings"("tenantId", "targetType");

-- CreateIndex
CREATE INDEX "record_change_requests_tenantId_status_idx" ON "record_change_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "record_change_requests_tenantId_category_status_idx" ON "record_change_requests"("tenantId", "category", "status");

-- CreateIndex
CREATE INDEX "record_change_requests_employeeId_status_idx" ON "record_change_requests"("employeeId", "status");

-- CreateIndex
CREATE INDEX "record_change_requests_status_effectiveDate_idx" ON "record_change_requests"("status", "effectiveDate");

-- CreateIndex
CREATE INDEX "divisions_tenantId_idx" ON "divisions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "divisions_tenantId_name_key" ON "divisions"("tenantId", "name");

-- CreateIndex
CREATE INDEX "org_teams_tenantId_idx" ON "org_teams"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "org_teams_tenantId_name_key" ON "org_teams"("tenantId", "name");

-- CreateIndex
CREATE INDEX "org_team_members_employeeId_idx" ON "org_team_members"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "org_team_members_teamId_employeeId_key" ON "org_team_members"("teamId", "employeeId");

-- CreateIndex
CREATE INDEX "secondary_managers_tenantId_managerId_idx" ON "secondary_managers"("tenantId", "managerId");

-- CreateIndex
CREATE UNIQUE INDEX "secondary_managers_employeeId_managerId_kind_key" ON "secondary_managers"("employeeId", "managerId", "kind");

-- CreateIndex
CREATE INDEX "manager_delegations_tenantId_delegateId_idx" ON "manager_delegations"("tenantId", "delegateId");

-- CreateIndex
CREATE INDEX "manager_delegations_tenantId_delegatorId_idx" ON "manager_delegations"("tenantId", "delegatorId");

-- CreateIndex
CREATE UNIQUE INDEX "document_request_types_tenantId_name_key" ON "document_request_types"("tenantId", "name");

-- CreateIndex
CREATE INDEX "self_service_document_requests_tenantId_status_idx" ON "self_service_document_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "self_service_document_requests_employeeId_idx" ON "self_service_document_requests"("employeeId");

-- CreateIndex
CREATE INDEX "mass_update_batches_tenantId_createdAt_idx" ON "mass_update_batches"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "mass_update_items_batchId_idx" ON "mass_update_items"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_checklist_templates_tenantId_name_key" ON "hr_checklist_templates"("tenantId", "name");

-- CreateIndex
CREATE INDEX "hr_checklists_tenantId_status_idx" ON "hr_checklists"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hr_checklists_employeeId_idx" ON "hr_checklists"("employeeId");

-- CreateIndex
CREATE INDEX "hr_checklist_items_checklistId_idx" ON "hr_checklist_items"("checklistId");

-- CreateIndex
CREATE INDEX "employee_internal_notes_tenantId_employeeId_idx" ON "employee_internal_notes"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_id_cards_cardNumber_key" ON "employee_id_cards"("cardNumber");

-- CreateIndex
CREATE INDEX "employee_id_cards_tenantId_employeeId_idx" ON "employee_id_cards"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "directory_saved_searches_tenantId_userId_idx" ON "directory_saved_searches"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "directory_saved_searches_userId_name_key" ON "directory_saved_searches"("userId", "name");

-- CreateIndex
CREATE INDEX "directory_search_logs_tenantId_createdAt_idx" ON "directory_search_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "directory_search_logs_userId_createdAt_idx" ON "directory_search_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "employee_address_history_tenantId_employeeId_idx" ON "employee_address_history"("tenantId", "employeeId");

-- AddForeignKey
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_rules" ADD CONSTRAINT "working_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_approval_settings" ADD CONSTRAINT "change_approval_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_change_requests" ADD CONSTRAINT "record_change_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "divisions" ADD CONSTRAINT "divisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_teams" ADD CONSTRAINT "org_teams_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_team_members" ADD CONSTRAINT "org_team_members_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "org_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secondary_managers" ADD CONSTRAINT "secondary_managers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_delegations" ADD CONSTRAINT "manager_delegations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_request_types" ADD CONSTRAINT "document_request_types_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_service_document_requests" ADD CONSTRAINT "self_service_document_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_service_document_requests" ADD CONSTRAINT "self_service_document_requests_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "document_request_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mass_update_batches" ADD CONSTRAINT "mass_update_batches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mass_update_items" ADD CONSTRAINT "mass_update_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "mass_update_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_checklist_templates" ADD CONSTRAINT "hr_checklist_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_checklists" ADD CONSTRAINT "hr_checklists_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_checklists" ADD CONSTRAINT "hr_checklists_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "hr_checklist_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_checklist_items" ADD CONSTRAINT "hr_checklist_items_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "hr_checklists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_internal_notes" ADD CONSTRAINT "employee_internal_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_id_cards" ADD CONSTRAINT "employee_id_cards_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_saved_searches" ADD CONSTRAINT "directory_saved_searches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_search_logs" ADD CONSTRAINT "directory_search_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_address_history" ADD CONSTRAINT "employee_address_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
