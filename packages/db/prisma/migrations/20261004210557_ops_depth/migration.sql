-- AlterTable
ALTER TABLE "hr_activities" ADD COLUMN     "approvalStatus" TEXT,
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "editedBy" TEXT;

-- AlterTable
ALTER TABLE "time_entries" ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "milestoneId" TEXT,
ADD COLUMN     "timeCode" TEXT,
ADD COLUMN     "workPackageId" TEXT;

-- CreateTable
CREATE TABLE "ops_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "approvalKinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attendanceCutoffDay" INTEGER NOT NULL DEFAULT 25,
    "cutoffAlertDaysBefore" INTEGER NOT NULL DEFAULT 3,
    "deviceStaleMinutes" INTEGER NOT NULL DEFAULT 240,
    "deviceOfflineMinutes" INTEGER NOT NULL DEFAULT 1440,
    "anomalyNotify" BOOLEAN NOT NULL DEFAULT true,
    "sourceMismatchMinutes" INTEGER NOT NULL DEFAULT 15,
    "requireEntryComment" BOOLEAN NOT NULL DEFAULT false,
    "entryCommentMinLength" INTEGER NOT NULL DEFAULT 0,
    "requireTimeCode" BOOLEAN NOT NULL DEFAULT false,
    "requireAttestation" BOOLEAN NOT NULL DEFAULT false,
    "timesheetCutoffDays" INTEGER,
    "taskBudgetMode" TEXT NOT NULL DEFAULT 'OFF',
    "taskBudgetTolerancePct" INTEGER NOT NULL DEFAULT 0,
    "projectVarianceAlertPct" INTEGER NOT NULL DEFAULT 10,
    "standardDailyHours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "leaveWithdrawalWindowDays" INTEGER,
    "requireLeaveCancellationApproval" BOOLEAN NOT NULL DEFAULT false,
    "leaveEscalationHours" INTEGER,
    "leaveCalendarVisibility" TEXT NOT NULL DEFAULT 'TEAM',
    "leaveCalendarHideType" BOOLEAN NOT NULL DEFAULT false,
    "requireBalanceAdjustmentApproval" BOOLEAN NOT NULL DEFAULT false,
    "netPayRoundTo" INTEGER NOT NULL DEFAULT 1,
    "netPayRoundingMode" TEXT NOT NULL DEFAULT 'NEAREST',
    "negativeNetPayAction" TEXT NOT NULL DEFAULT 'WARN',
    "requirePayslipApproval" BOOLEAN NOT NULL DEFAULT false,
    "requireFilingApproval" BOOLEAN NOT NULL DEFAULT false,
    "requireCloseChecklist" BOOLEAN NOT NULL DEFAULT false,
    "eventTypesNeedingApproval" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contractAlertDays" INTEGER[] DEFAULT ARRAY[60, 30, 7]::INTEGER[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_approval_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT,
    "targetLabel" TEXT NOT NULL,
    "employeeId" TEXT,
    "payload" JSONB,
    "previous" JSONB,
    "effectiveFrom" TIMESTAMP(3),
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_policy_versions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "approvalId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_reason_codes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "appliesTo" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_reason_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_period_locks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'LOCKED',
    "reason" TEXT,
    "lockedBy" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedBy" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenReason" TEXT,

    CONSTRAINT "ops_period_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_attendance_certifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "departmentKey" TEXT NOT NULL DEFAULT 'ALL',
    "summary" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "certifiedBy" TEXT NOT NULL,
    "certifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvalId" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ops_attendance_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_attendance_anomalies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "notifiedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_attendance_anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_early_departure_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyKey" TEXT NOT NULL DEFAULT 'ALL',
    "graceMinutes" INTEGER NOT NULL DEFAULT 15,
    "exemptPerMonth" INTEGER NOT NULL DEFAULT 2,
    "penaltyDays" DECIMAL(4,2) NOT NULL DEFAULT 0.5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_early_departure_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_device_statuses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastPunchAt" TIMESTAMP(3),
    "punches24h" INTEGER NOT NULL DEFAULT 0,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_device_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_break_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "maxMinutes" INTEGER NOT NULL,
    "maxPerDay" INTEGER NOT NULL DEFAULT 1,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_break_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_break_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "ruleId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "minutes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "editedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_break_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_alert_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "userIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_alert_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_time_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "employeeId" TEXT,
    "rows" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_time_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_time_codes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "billable" BOOLEAN,
    "requiresTask" BOOLEAN NOT NULL DEFAULT false,
    "requiresComment" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_time_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_work_packages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "budgetHours" DECIMAL(10,2),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_work_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_idle_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_idle_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_time_certifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "timesheetId" TEXT,
    "projectId" TEXT,
    "employeeId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(10,2) NOT NULL,
    "statement" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "certifiedBy" TEXT NOT NULL,
    "certifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvalId" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ops_time_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_export_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "columns" TEXT[],
    "clientId" TEXT,
    "projectId" TEXT,
    "billableOnly" BOOLEAN NOT NULL DEFAULT false,
    "approvedOnly" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_export_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_project_overtime_allocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "overtimeEntryId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(9,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_project_overtime_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_leave_blackouts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "departmentId" TEXT,
    "locationId" TEXT,
    "leaveTypeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxConcurrent" INTEGER,
    "maxConcurrentPct" INTEGER,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_leave_blackouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_absence_cases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reasonCode" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "expectedReturn" TIMESTAMP(3) NOT NULL,
    "actualReturn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "previousStatus" TEXT,
    "approvalId" TEXT,
    "checklist" JSONB,
    "rtwRequired" BOOLEAN NOT NULL DEFAULT true,
    "fitForWork" BOOLEAN,
    "restrictions" TEXT,
    "rtwNote" TEXT,
    "rtwFileId" TEXT,
    "rtwCertifiedBy" TEXT,
    "rtwCertifiedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_absence_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "hostDepartmentId" TEXT,
    "hostLocationId" TEXT,
    "hostOrganisation" TEXT,
    "role" TEXT,
    "hostManagerId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "originalEndDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "extensions" INTEGER NOT NULL DEFAULT 0,
    "costSharePct" INTEGER,
    "approvalId" TEXT,
    "note" TEXT,
    "returnNote" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_status_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonLabel" TEXT NOT NULL,
    "effectiveOn" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_confirmation_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "probationPolicyId" TEXT,
    "minServiceDays" INTEGER NOT NULL DEFAULT 0,
    "maxLopDays" DECIMAL(6,2),
    "maxLateMarks" INTEGER,
    "noWarningsMonths" INTEGER,
    "requireEvaluation" BOOLEAN NOT NULL DEFAULT false,
    "minRating" DECIMAL(4,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_confirmation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_employment_stints" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "stintNo" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "employeeNumber" TEXT,
    "exitType" TEXT,
    "exitReason" TEXT,
    "rehireEligible" BOOLEAN,
    "override" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_employment_stints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_fte_conversions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "fromFte" DECIMAL(4,2) NOT NULL,
    "toFte" DECIMAL(4,2) NOT NULL,
    "fromWeeklyHours" DECIMAL(5,2) NOT NULL,
    "toWeeklyHours" DECIMAL(5,2) NOT NULL,
    "fromCtc" DECIMAL(18,2) NOT NULL,
    "toCtc" DECIMAL(18,2) NOT NULL,
    "workerTypeId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvalId" TEXT,
    "jobChangeId" TEXT,
    "revisionId" TEXT,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_fte_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_component_groups" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "componentCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_component_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_recurring_component_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "frequency" TEXT NOT NULL,
    "months" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "payGroupId" TEXT,
    "departmentId" TEXT,
    "locationId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_recurring_component_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_variance_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "componentCode" TEXT,
    "thresholdPct" DECIMAL(6,2),
    "thresholdAmount" DECIMAL(18,2),
    "severity" TEXT NOT NULL DEFAULT 'WARN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_variance_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_variance_reviews" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "reviewedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_variance_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_payroll_close_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneBy" TEXT,
    "doneAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "ops_payroll_close_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_payroll_validations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "errors" INTEGER NOT NULL,
    "warnings" INTEGER NOT NULL,
    "issues" JSONB NOT NULL,
    "ranBy" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_payroll_validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_statutory_exceptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "employeeId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_statutory_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_settings_tenantId_key" ON "ops_settings"("tenantId");

-- CreateIndex
CREATE INDEX "ops_approval_requests_tenantId_kind_status_idx" ON "ops_approval_requests"("tenantId", "kind", "status");

-- CreateIndex
CREATE INDEX "ops_approval_requests_targetId_idx" ON "ops_approval_requests"("targetId");

-- CreateIndex
CREATE INDEX "ops_policy_versions_tenantId_kind_targetId_idx" ON "ops_policy_versions"("tenantId", "kind", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_policy_versions_kind_targetId_version_key" ON "ops_policy_versions"("kind", "targetId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ops_reason_codes_tenantId_kind_code_key" ON "ops_reason_codes"("tenantId", "kind", "code");

-- CreateIndex
CREATE INDEX "ops_period_locks_tenantId_domain_status_idx" ON "ops_period_locks"("tenantId", "domain", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ops_attendance_certifications_tenantId_scope_periodStart_de_key" ON "ops_attendance_certifications"("tenantId", "scope", "periodStart", "departmentKey");

-- CreateIndex
CREATE INDEX "ops_attendance_anomalies_tenantId_status_date_idx" ON "ops_attendance_anomalies"("tenantId", "status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ops_attendance_anomalies_employeeId_date_kind_key" ON "ops_attendance_anomalies"("employeeId", "date", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ops_early_departure_rules_tenantId_policyKey_key" ON "ops_early_departure_rules"("tenantId", "policyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ops_device_statuses_tenantId_deviceKey_key" ON "ops_device_statuses"("tenantId", "deviceKey");

-- CreateIndex
CREATE UNIQUE INDEX "ops_break_rules_tenantId_code_key" ON "ops_break_rules"("tenantId", "code");

-- CreateIndex
CREATE INDEX "ops_break_logs_tenantId_date_idx" ON "ops_break_logs"("tenantId", "date");

-- CreateIndex
CREATE INDEX "ops_break_logs_employeeId_date_idx" ON "ops_break_logs"("employeeId", "date");

-- CreateIndex
CREATE INDEX "ops_alert_logs_tenantId_kind_createdAt_idx" ON "ops_alert_logs"("tenantId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ops_alert_logs_tenantId_kind_dedupeKey_key" ON "ops_alert_logs"("tenantId", "kind", "dedupeKey");

-- CreateIndex
CREATE INDEX "ops_time_templates_tenantId_employeeId_idx" ON "ops_time_templates"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_time_codes_tenantId_code_key" ON "ops_time_codes"("tenantId", "code");

-- CreateIndex
CREATE INDEX "ops_work_packages_tenantId_idx" ON "ops_work_packages"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_work_packages_projectId_code_key" ON "ops_work_packages"("projectId", "code");

-- CreateIndex
CREATE INDEX "ops_idle_logs_tenantId_date_idx" ON "ops_idle_logs"("tenantId", "date");

-- CreateIndex
CREATE INDEX "ops_idle_logs_employeeId_date_idx" ON "ops_idle_logs"("employeeId", "date");

-- CreateIndex
CREATE INDEX "ops_time_certifications_tenantId_scope_status_idx" ON "ops_time_certifications"("tenantId", "scope", "status");

-- CreateIndex
CREATE INDEX "ops_time_certifications_timesheetId_idx" ON "ops_time_certifications"("timesheetId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_export_profiles_tenantId_name_key" ON "ops_export_profiles"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ops_project_overtime_allocations_tenantId_projectId_idx" ON "ops_project_overtime_allocations"("tenantId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_project_overtime_allocations_overtimeEntryId_projectId_key" ON "ops_project_overtime_allocations"("overtimeEntryId", "projectId");

-- CreateIndex
CREATE INDEX "ops_leave_blackouts_tenantId_startDate_idx" ON "ops_leave_blackouts"("tenantId", "startDate");

-- CreateIndex
CREATE INDEX "ops_absence_cases_tenantId_status_idx" ON "ops_absence_cases"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ops_absence_cases_employeeId_idx" ON "ops_absence_cases"("employeeId");

-- CreateIndex
CREATE INDEX "ops_assignments_tenantId_status_idx" ON "ops_assignments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ops_assignments_employeeId_idx" ON "ops_assignments"("employeeId");

-- CreateIndex
CREATE INDEX "ops_status_changes_tenantId_employeeId_idx" ON "ops_status_changes"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_confirmation_rules_tenantId_name_key" ON "ops_confirmation_rules"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ops_employment_stints_tenantId_idx" ON "ops_employment_stints"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_employment_stints_employeeId_stintNo_key" ON "ops_employment_stints"("employeeId", "stintNo");

-- CreateIndex
CREATE INDEX "ops_fte_conversions_tenantId_status_idx" ON "ops_fte_conversions"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ops_component_groups_tenantId_kind_name_key" ON "ops_component_groups"("tenantId", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ops_recurring_component_rules_tenantId_name_key" ON "ops_recurring_component_rules"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ops_variance_rules_tenantId_name_key" ON "ops_variance_rules"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ops_variance_reviews_runId_employeeId_ruleId_key" ON "ops_variance_reviews"("runId", "employeeId", "ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_payroll_close_items_runId_key_key" ON "ops_payroll_close_items"("runId", "key");

-- CreateIndex
CREATE INDEX "ops_payroll_validations_runId_ranAt_idx" ON "ops_payroll_validations"("runId", "ranAt");

-- CreateIndex
CREATE INDEX "ops_statutory_exceptions_tenantId_status_idx" ON "ops_statutory_exceptions"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ops_statutory_exceptions_tenantId_dedupeKey_key" ON "ops_statutory_exceptions"("tenantId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "ops_settings" ADD CONSTRAINT "ops_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_approval_requests" ADD CONSTRAINT "ops_approval_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_policy_versions" ADD CONSTRAINT "ops_policy_versions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_reason_codes" ADD CONSTRAINT "ops_reason_codes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_reason_codes" ADD CONSTRAINT "ops_reason_codes_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ops_reason_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_period_locks" ADD CONSTRAINT "ops_period_locks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_attendance_certifications" ADD CONSTRAINT "ops_attendance_certifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_attendance_anomalies" ADD CONSTRAINT "ops_attendance_anomalies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_early_departure_rules" ADD CONSTRAINT "ops_early_departure_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_device_statuses" ADD CONSTRAINT "ops_device_statuses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_break_rules" ADD CONSTRAINT "ops_break_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_break_logs" ADD CONSTRAINT "ops_break_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_break_logs" ADD CONSTRAINT "ops_break_logs_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ops_break_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_alert_logs" ADD CONSTRAINT "ops_alert_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_time_templates" ADD CONSTRAINT "ops_time_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_time_codes" ADD CONSTRAINT "ops_time_codes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_work_packages" ADD CONSTRAINT "ops_work_packages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_idle_logs" ADD CONSTRAINT "ops_idle_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_time_certifications" ADD CONSTRAINT "ops_time_certifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_export_profiles" ADD CONSTRAINT "ops_export_profiles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_project_overtime_allocations" ADD CONSTRAINT "ops_project_overtime_allocations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_leave_blackouts" ADD CONSTRAINT "ops_leave_blackouts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_absence_cases" ADD CONSTRAINT "ops_absence_cases_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_assignments" ADD CONSTRAINT "ops_assignments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_status_changes" ADD CONSTRAINT "ops_status_changes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_confirmation_rules" ADD CONSTRAINT "ops_confirmation_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_employment_stints" ADD CONSTRAINT "ops_employment_stints_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_fte_conversions" ADD CONSTRAINT "ops_fte_conversions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_component_groups" ADD CONSTRAINT "ops_component_groups_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_component_groups" ADD CONSTRAINT "ops_component_groups_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ops_component_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_recurring_component_rules" ADD CONSTRAINT "ops_recurring_component_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_variance_rules" ADD CONSTRAINT "ops_variance_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_variance_reviews" ADD CONSTRAINT "ops_variance_reviews_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_payroll_close_items" ADD CONSTRAINT "ops_payroll_close_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_payroll_validations" ADD CONSTRAINT "ops_payroll_validations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_statutory_exceptions" ADD CONSTRAINT "ops_statutory_exceptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
