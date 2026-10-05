-- AlterTable
ALTER TABLE "goals" ADD COLUMN     "approvalRequestId" TEXT,
ADD COLUMN     "approvalStatus" TEXT,
ADD COLUMN     "checkInCadence" TEXT,
ADD COLUMN     "closedOutAt" TIMESTAMP(3),
ADD COLUMN     "confidence" INTEGER,
ADD COLUMN     "riskNote" TEXT,
ADD COLUMN     "riskReviewedAt" TIMESTAMP(3),
ADD COLUMN     "stretchValue" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "goal_check_ins" ADD COLUMN     "confidence" INTEGER;

-- AlterTable
ALTER TABLE "review_cycles" ADD COLUMN     "ratingScaleId" TEXT;

-- AlterTable
ALTER TABLE "review_responses" ADD COLUMN     "remindedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "feedback" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "sentiment" TEXT,
ADD COLUMN     "sentimentScore" INTEGER,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "templateId" TEXT,
ADD COLUMN     "topicId" TEXT;

-- AlterTable
ALTER TABLE "scheduled_reports" ADD COLUMN     "approvalStatus" TEXT,
ADD COLUMN     "workflowRequestId" TEXT;

-- AlterTable
ALTER TABLE "saved_reports" ADD COLUMN     "publishRequestId" TEXT,
ADD COLUMN     "publishStatus" TEXT;

-- AlterTable
ALTER TABLE "review_form_sections" ADD COLUMN     "conditionOp" TEXT,
ADD COLUMN     "conditionQuestionId" TEXT,
ADD COLUMN     "conditionValue" DECIMAL(9,2);

-- AlterTable
ALTER TABLE "review_form_questions" ADD COLUMN     "weight" DECIMAL(9,2);

-- AlterTable
ALTER TABLE "feedback_requests" ADD COLUMN     "remindedAt" TIMESTAMP(3),
ADD COLUMN     "withdrawnAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "feedback_settings" ADD COLUMN     "minAnonymousResponses" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "pip_check_ins" ADD COLUMN     "signoffStatus" TEXT;

-- CreateTable
CREATE TABLE "insight_metrics" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "calculator" TEXT NOT NULL,
    "params" JSONB,
    "description" TEXT,
    "formula" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'COUNT',
    "direction" TEXT NOT NULL DEFAULT 'UP_GOOD',
    "warnAt" DECIMAL(18,4),
    "alertAt" DECIMAL(18,4),
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "previousId" TEXT,
    "workflowRequestId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "lastValue" DECIMAL(18,4),
    "lastComputedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_kras" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "jobTitle" TEXT,
    "departmentId" TEXT,
    "weight" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "previousId" TEXT,
    "workflowRequestId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_kras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_kpis" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'COUNT',
    "direction" TEXT NOT NULL DEFAULT 'UP_GOOD',
    "calcKind" TEXT NOT NULL DEFAULT 'MANUAL',
    "metricKey" TEXT,
    "kraId" TEXT,
    "ownerEmployeeId" TEXT,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "greenAt" DECIMAL(9,2) NOT NULL DEFAULT 100,
    "amberAt" DECIMAL(9,2) NOT NULL DEFAULT 80,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_kpis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_kpi_targets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "target" DECIMAL(18,4) NOT NULL,
    "stretch" DECIMAL(18,4),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_kpi_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_kpi_readings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,
    "note" TEXT,
    "rag" TEXT,
    "targetVersion" INTEGER,
    "alertedAt" TIMESTAMP(3),
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_kpi_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_dashboards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOM',
    "ownerUserId" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "refreshedAt" TIMESTAMP(3),
    "refreshStatus" TEXT,
    "refreshMs" INTEGER,
    "refreshError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_dashboard_widgets" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "refKey" TEXT NOT NULL,
    "viz" TEXT NOT NULL DEFAULT 'NUMBER',
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "value" DECIMAL(18,4),
    "series" JSONB,
    "computedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "insight_dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_dashboard_shares" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_dashboard_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_dashboard_notes" (
    "id" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "widgetId" TEXT,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "insight_dashboard_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_report_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "format" TEXT,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "error" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_report_grants" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "days" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),
    "workflowRequestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_report_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_export_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'CSV',
    "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "includeTotals" BOOLEAN NOT NULL DEFAULT true,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_export_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_export_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requesterUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "workflowRequestId" TEXT,
    "downloadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_export_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_filter_presets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_filter_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_report_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "note" TEXT,
    "takenBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_report_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_cohorts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filters" JSONB NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_hiring_costs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "requisitionId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_hiring_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_alerts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_cycle_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_cycle_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_rating_scales" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "points" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_rating_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_calibration_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_calibration_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_review_reopens" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "workflowRequestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_review_reopens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_perf_exceptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_perf_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_goal_links" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromGoalId" TEXT NOT NULL,
    "toGoalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_goal_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_okr_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requireApproval" BOOLEAN NOT NULL DEFAULT false,
    "defaultCadence" TEXT NOT NULL DEFAULT 'MONTHLY',
    "graceDays" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_okr_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_okr_closeouts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "workflowRequestId" TEXT,
    "summary" JSONB,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_okr_closeouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_goal_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "closeoutId" TEXT,
    "label" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "ownerName" TEXT,
    "progress" DECIMAL(9,2) NOT NULL,
    "status" TEXT NOT NULL,
    "targetValue" DECIMAL(18,2) NOT NULL,
    "currentValue" DECIMAL(18,2) NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_goal_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_feedback_topics" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_feedback_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_feedback_followups" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "ownerEmployeeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_feedback_followups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_feedback_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "keyword" TEXT,
    "topicId" TEXT,
    "notify" TEXT NOT NULL DEFAULT 'HR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_feedback_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_feedback_escalations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "notifiedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_feedback_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_pip_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PIP',
    "name" TEXT NOT NULL,
    "reason" TEXT,
    "objectives" TEXT,
    "durationDays" INTEGER NOT NULL DEFAULT 60,
    "milestones" JSONB,
    "checklist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sessionEveryDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_pip_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_pip_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "minTenureDays" INTEGER NOT NULL DEFAULT 90,
    "maxRating" DECIMAL(9,2),
    "blockProbation" BOOLEAN NOT NULL DEFAULT true,
    "blockNotice" BOOLEAN NOT NULL DEFAULT true,
    "requireChecklist" BOOLEAN NOT NULL DEFAULT true,
    "defaultChecklist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coachingReminderDays" INTEGER NOT NULL DEFAULT 14,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_pip_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_pip_objectives" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pipId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "measure" TEXT,
    "target" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_pip_objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_pip_evidence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pipId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'DOCUMENT',
    "fileId" TEXT,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_pip_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_pip_checklist_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pipId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT,
    "note" TEXT,

    CONSTRAINT "insight_pip_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_behavior_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "pipId" TEXT,
    "coachingPlanId" TEXT,
    "behaviour" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "note" TEXT,
    "observedOn" TIMESTAMP(3) NOT NULL,
    "observedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_behavior_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_pip_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pipId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "days" INTEGER,
    "checkInId" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "workflowRequestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_pip_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insight_metrics_tenantId_status_idx" ON "insight_metrics"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "insight_metrics_tenantId_key_version_key" ON "insight_metrics"("tenantId", "key", "version");

-- CreateIndex
CREATE INDEX "insight_kras_tenantId_status_idx" ON "insight_kras"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "insight_kras_tenantId_name_version_key" ON "insight_kras"("tenantId", "name", "version");

-- CreateIndex
CREATE INDEX "insight_kpis_tenantId_isActive_idx" ON "insight_kpis"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "insight_kpis_tenantId_name_key" ON "insight_kpis"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "insight_kpi_targets_kpiId_version_key" ON "insight_kpi_targets"("kpiId", "version");

-- CreateIndex
CREATE INDEX "insight_kpi_readings_tenantId_period_idx" ON "insight_kpi_readings"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "insight_kpi_readings_kpiId_period_key" ON "insight_kpi_readings"("kpiId", "period");

-- CreateIndex
CREATE INDEX "insight_dashboards_tenantId_ownerUserId_idx" ON "insight_dashboards"("tenantId", "ownerUserId");

-- CreateIndex
CREATE INDEX "insight_dashboards_tenantId_status_idx" ON "insight_dashboards"("tenantId", "status");

-- CreateIndex
CREATE INDEX "insight_dashboard_widgets_dashboardId_position_idx" ON "insight_dashboard_widgets"("dashboardId", "position");

-- CreateIndex
CREATE INDEX "insight_dashboard_shares_userId_idx" ON "insight_dashboard_shares"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "insight_dashboard_shares_dashboardId_userId_key" ON "insight_dashboard_shares"("dashboardId", "userId");

-- CreateIndex
CREATE INDEX "insight_dashboard_notes_dashboardId_createdAt_idx" ON "insight_dashboard_notes"("dashboardId", "createdAt");

-- CreateIndex
CREATE INDEX "insight_report_runs_tenantId_createdAt_idx" ON "insight_report_runs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "insight_report_runs_tenantId_reportKey_idx" ON "insight_report_runs"("tenantId", "reportKey");

-- CreateIndex
CREATE INDEX "insight_report_grants_tenantId_userId_status_idx" ON "insight_report_grants"("tenantId", "userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "insight_export_profiles_tenantId_name_key" ON "insight_export_profiles"("tenantId", "name");

-- CreateIndex
CREATE INDEX "insight_export_requests_tenantId_requesterUserId_idx" ON "insight_export_requests"("tenantId", "requesterUserId");

-- CreateIndex
CREATE INDEX "insight_filter_presets_tenantId_dataset_idx" ON "insight_filter_presets"("tenantId", "dataset");

-- CreateIndex
CREATE UNIQUE INDEX "insight_filter_presets_tenantId_createdBy_dataset_name_key" ON "insight_filter_presets"("tenantId", "createdBy", "dataset", "name");

-- CreateIndex
CREATE INDEX "insight_report_snapshots_tenantId_reportKey_createdAt_idx" ON "insight_report_snapshots"("tenantId", "reportKey", "createdAt");

-- CreateIndex
CREATE INDEX "insight_cohorts_tenantId_createdBy_idx" ON "insight_cohorts"("tenantId", "createdBy");

-- CreateIndex
CREATE INDEX "insight_hiring_costs_tenantId_month_idx" ON "insight_hiring_costs"("tenantId", "month");

-- CreateIndex
CREATE INDEX "insight_alerts_tenantId_kind_createdAt_idx" ON "insight_alerts"("tenantId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "insight_alerts_entityId_kind_idx" ON "insight_alerts"("entityId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "insight_cycle_templates_tenantId_name_key" ON "insight_cycle_templates"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "insight_rating_scales_tenantId_name_key" ON "insight_rating_scales"("tenantId", "name");

-- CreateIndex
CREATE INDEX "insight_calibration_notes_tenantId_cycleId_idx" ON "insight_calibration_notes"("tenantId", "cycleId");

-- CreateIndex
CREATE INDEX "insight_review_reopens_tenantId_status_idx" ON "insight_review_reopens"("tenantId", "status");

-- CreateIndex
CREATE INDEX "insight_review_reopens_reviewId_idx" ON "insight_review_reopens"("reviewId");

-- CreateIndex
CREATE INDEX "insight_perf_exceptions_tenantId_status_idx" ON "insight_perf_exceptions"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "insight_perf_exceptions_reviewId_kind_key" ON "insight_perf_exceptions"("reviewId", "kind");

-- CreateIndex
CREATE INDEX "insight_goal_links_tenantId_idx" ON "insight_goal_links"("tenantId");

-- CreateIndex
CREATE INDEX "insight_goal_links_toGoalId_idx" ON "insight_goal_links"("toGoalId");

-- CreateIndex
CREATE UNIQUE INDEX "insight_goal_links_fromGoalId_toGoalId_kind_key" ON "insight_goal_links"("fromGoalId", "toGoalId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "insight_okr_settings_tenantId_key" ON "insight_okr_settings"("tenantId");

-- CreateIndex
CREATE INDEX "insight_okr_closeouts_tenantId_timeframe_idx" ON "insight_okr_closeouts"("tenantId", "timeframe");

-- CreateIndex
CREATE INDEX "insight_goal_snapshots_tenantId_label_idx" ON "insight_goal_snapshots"("tenantId", "label");

-- CreateIndex
CREATE INDEX "insight_goal_snapshots_goalId_idx" ON "insight_goal_snapshots"("goalId");

-- CreateIndex
CREATE UNIQUE INDEX "insight_feedback_topics_tenantId_name_key" ON "insight_feedback_topics"("tenantId", "name");

-- CreateIndex
CREATE INDEX "insight_feedback_followups_tenantId_status_idx" ON "insight_feedback_followups"("tenantId", "status");

-- CreateIndex
CREATE INDEX "insight_feedback_followups_feedbackId_idx" ON "insight_feedback_followups"("feedbackId");

-- CreateIndex
CREATE UNIQUE INDEX "insight_feedback_rules_tenantId_name_key" ON "insight_feedback_rules"("tenantId", "name");

-- CreateIndex
CREATE INDEX "insight_feedback_escalations_tenantId_status_idx" ON "insight_feedback_escalations"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "insight_feedback_escalations_ruleId_feedbackId_key" ON "insight_feedback_escalations"("ruleId", "feedbackId");

-- CreateIndex
CREATE UNIQUE INDEX "insight_pip_templates_tenantId_kind_name_key" ON "insight_pip_templates"("tenantId", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "insight_pip_settings_tenantId_key" ON "insight_pip_settings"("tenantId");

-- CreateIndex
CREATE INDEX "insight_pip_objectives_pipId_idx" ON "insight_pip_objectives"("pipId");

-- CreateIndex
CREATE INDEX "insight_pip_evidence_pipId_idx" ON "insight_pip_evidence"("pipId");

-- CreateIndex
CREATE INDEX "insight_pip_checklist_items_pipId_idx" ON "insight_pip_checklist_items"("pipId");

-- CreateIndex
CREATE INDEX "insight_behavior_logs_tenantId_employeeId_idx" ON "insight_behavior_logs"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "insight_pip_requests_tenantId_status_idx" ON "insight_pip_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "insight_pip_requests_pipId_idx" ON "insight_pip_requests"("pipId");

-- AddForeignKey
ALTER TABLE "insight_metrics" ADD CONSTRAINT "insight_metrics_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_kras" ADD CONSTRAINT "insight_kras_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_kpis" ADD CONSTRAINT "insight_kpis_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_kpi_targets" ADD CONSTRAINT "insight_kpi_targets_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "insight_kpis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_kpi_readings" ADD CONSTRAINT "insight_kpi_readings_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "insight_kpis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_dashboards" ADD CONSTRAINT "insight_dashboards_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_dashboard_widgets" ADD CONSTRAINT "insight_dashboard_widgets_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "insight_dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_dashboard_shares" ADD CONSTRAINT "insight_dashboard_shares_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "insight_dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_dashboard_notes" ADD CONSTRAINT "insight_dashboard_notes_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "insight_dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_report_runs" ADD CONSTRAINT "insight_report_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_report_grants" ADD CONSTRAINT "insight_report_grants_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_export_profiles" ADD CONSTRAINT "insight_export_profiles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_export_requests" ADD CONSTRAINT "insight_export_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_filter_presets" ADD CONSTRAINT "insight_filter_presets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_report_snapshots" ADD CONSTRAINT "insight_report_snapshots_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_cohorts" ADD CONSTRAINT "insight_cohorts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_hiring_costs" ADD CONSTRAINT "insight_hiring_costs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_alerts" ADD CONSTRAINT "insight_alerts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_cycle_templates" ADD CONSTRAINT "insight_cycle_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_rating_scales" ADD CONSTRAINT "insight_rating_scales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_calibration_notes" ADD CONSTRAINT "insight_calibration_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_review_reopens" ADD CONSTRAINT "insight_review_reopens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_perf_exceptions" ADD CONSTRAINT "insight_perf_exceptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_goal_links" ADD CONSTRAINT "insight_goal_links_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_okr_settings" ADD CONSTRAINT "insight_okr_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_okr_closeouts" ADD CONSTRAINT "insight_okr_closeouts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_goal_snapshots" ADD CONSTRAINT "insight_goal_snapshots_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_feedback_topics" ADD CONSTRAINT "insight_feedback_topics_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_feedback_followups" ADD CONSTRAINT "insight_feedback_followups_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_feedback_rules" ADD CONSTRAINT "insight_feedback_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_feedback_escalations" ADD CONSTRAINT "insight_feedback_escalations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_pip_templates" ADD CONSTRAINT "insight_pip_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_pip_settings" ADD CONSTRAINT "insight_pip_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_pip_objectives" ADD CONSTRAINT "insight_pip_objectives_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_pip_evidence" ADD CONSTRAINT "insight_pip_evidence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_pip_checklist_items" ADD CONSTRAINT "insight_pip_checklist_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_behavior_logs" ADD CONSTRAINT "insight_behavior_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_pip_requests" ADD CONSTRAINT "insight_pip_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

