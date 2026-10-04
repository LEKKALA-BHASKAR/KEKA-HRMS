-- AlterTable
ALTER TABLE "bgv_checks" ADD COLUMN     "amendedAt" TIMESTAMP(3),
ADD COLUMN     "assigneeUserId" TEXT,
ADD COLUMN     "consentExpiresAt" TIMESTAMP(3),
ADD COLUMN     "consentGivenAt" TIMESTAMP(3),
ADD COLUMN     "consentRequestedAt" TIMESTAMP(3),
ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "escalationLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "packageId" TEXT,
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "proposedStatus" TEXT,
ADD COLUMN     "resultWorkflowRequestId" TEXT,
ADD COLUMN     "slaDueAt" TIMESTAMP(3),
ADD COLUMN     "vendorId" TEXT;

-- AlterTable
ALTER TABLE "holiday_calendars" ADD COLUMN     "country" TEXT,
ADD COLUMN     "state" TEXT;

-- AlterTable
ALTER TABLE "holidays" ADD COLUMN     "dayType" TEXT;

-- AlterTable
ALTER TABLE "journey_task_templates" ADD COLUMN     "needsApproval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "journey_tasks" ADD COLUMN     "approvalStatus" TEXT,
ADD COLUMN     "delegatedFromEmployeeId" TEXT,
ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "escalationLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "needsApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "workflowRequestId" TEXT;

-- AlterTable
ALTER TABLE "journey_templates" ADD COLUMN     "jobTitle" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "journeys" ADD COLUMN     "certificateIssuedAt" TIMESTAMP(3),
ADD COLUMN     "planStatus" TEXT,
ADD COLUMN     "planWorkflowRequestId" TEXT;

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "segments" JSONB;

-- CreateTable
CREATE TABLE "join_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "preboardingReminderDays" INTEGER NOT NULL DEFAULT 3,
    "preboardingReminderMax" INTEGER NOT NULL DEFAULT 3,
    "bgvDefaultSlaDays" INTEGER NOT NULL DEFAULT 10,
    "bgvConsentValidDays" INTEGER NOT NULL DEFAULT 90,
    "journeyEscalationDays" INTEGER NOT NULL DEFAULT 2,
    "swapRequiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "swapMinNoticeHours" INTEGER NOT NULL DEFAULT 24,
    "swapSameDepartmentOnly" BOOLEAN NOT NULL DEFAULT true,
    "swapMaxPerMonth" INTEGER NOT NULL DEFAULT 4,
    "minRestHours" INTEGER NOT NULL DEFAULT 11,
    "holidayMinCount" INTEGER NOT NULL DEFAULT 0,
    "holidayMaxCount" INTEGER NOT NULL DEFAULT 0,
    "compOffReminderDays" INTEGER NOT NULL DEFAULT 7,
    "otAnomalyDailyMinutes" INTEGER NOT NULL DEFAULT 360,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "join_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preboarding_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "departmentId" TEXT,
    "locationId" TEXT,
    "jobTitle" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preboarding_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preboarding_template_items" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOM',
    "refId" TEXT,
    "daysBeforeJoining" INTEGER NOT NULL DEFAULT 7,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "preboarding_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preboarding_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "templateItemId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOM',
    "refId" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "response" JSONB,
    "viewedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "workflowRequestId" TEXT,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastRemindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preboarding_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "new_hire_forms" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fields" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "new_hire_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "new_hire_form_submissions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "taskId" TEXT,
    "formVersion" INTEGER NOT NULL DEFAULT 1,
    "answers" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "workflowRequestId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decisionNote" TEXT,

    CONSTRAINT "new_hire_form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prejoin_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'WELCOME',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "daysBeforeJoining" INTEGER NOT NULL DEFAULT 7,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prejoin_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prejoin_message_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT,
    "toAddress" TEXT,
    "outboxId" TEXT,
    "sentBy" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prejoin_message_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preboarding_provisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "details" TEXT,
    "assetId" TEXT,
    "neededBy" TIMESTAMP(3) NOT NULL,
    "ownerTeam" TEXT NOT NULL DEFAULT 'IT',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "assigneeUserId" TEXT,
    "requestedBy" TEXT,
    "note" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preboarding_provisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_buddies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "buddyEmployeeId" TEXT NOT NULL,
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3) NOT NULL,
    "goals" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "workflowRequestId" TEXT,
    "assignedBy" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "feedbackRating" INTEGER,
    "feedbackNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_buddies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_buddy_checkins" (
    "id" TEXT NOT NULL,
    "buddyId" TEXT NOT NULL,
    "heldOn" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL,
    "byEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_buddy_checkins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orientation_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ORIENTATION',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "meetingLink" TEXT,
    "hostEmployeeId" TEXT,
    "capacity" INTEGER,
    "agenda" TEXT,
    "courseId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orientation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orientation_attendees" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "orientation_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_milestones" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "objectives" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "managerRating" INTEGER,
    "managerNote" TEXT,
    "managerDoneAt" TIMESTAMP(3),
    "hireRating" INTEGER,
    "hireComment" TEXT,
    "hireDoneAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journey_template_revisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journey_template_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bgv_vendors" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT,
    "slaDays" INTEGER NOT NULL DEFAULT 7,
    "checkTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "costPerCheck" JSONB,
    "stages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bgv_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bgv_packages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "checkTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "vendorId" TEXT,
    "slaDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bgv_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bgv_check_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bgvCheckId" TEXT NOT NULL,
    "checkType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "proposedStatus" TEXT,
    "details" JSONB,
    "reasonCode" TEXT,
    "severity" TEXT,
    "findings" TEXT,
    "vendorStage" TEXT,
    "slaDueAt" TIMESTAMP(3),
    "cost" DECIMAL(12,2),
    "recheckOfId" TEXT,
    "workflowRequestId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bgv_check_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bgv_case_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bgvCheckId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bgv_case_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_swap_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requesterDate" TIMESTAMP(3) NOT NULL,
    "requesterShiftId" TEXT,
    "counterpartId" TEXT,
    "counterpartDate" TIMESTAMP(3),
    "counterpartShiftId" TEXT,
    "isMarketplace" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PEER',
    "workflowRequestId" TEXT,
    "peerRespondedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_swap_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "open_shifts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "slots" INTEGER NOT NULL DEFAULT 1,
    "departmentId" TEXT,
    "locationId" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "open_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "open_shift_bids" (
    "id" TEXT NOT NULL,
    "openShiftId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'BID',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "open_shift_bids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_preferences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "preferredShiftIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avoidWeekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "maxNightsPerWeek" INTEGER,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staffing_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shiftId" TEXT,
    "departmentId" TEXT,
    "locationId" TEXT,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "minStaff" INTEGER NOT NULL DEFAULT 0,
    "maxStaff" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staffing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_publications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "departmentId" TEXT,
    "locationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "snapshot" JSONB,
    "assignmentCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "workflowRequestId" TEXT,
    "submittedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roster_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_config_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "workflowRequestId" TEXT,
    "requestedBy" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_config_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_calendar_revisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "calendarId" TEXT,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "country" TEXT,
    "state" TEXT,
    "locationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "holidays" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holiday_calendar_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "calendarId" TEXT,
    "config" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holiday_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_day_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holiday_day_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shutdown_periods" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "calendarId" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "holidaysAdded" INTEGER NOT NULL DEFAULT 0,
    "appliedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shutdown_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_exceptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "calendar_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "bandIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payGradeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "shiftIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tiers" JSONB NOT NULL,
    "windows" JSONB,
    "weeklyThresholdMinutes" INTEGER,
    "dailyCapMinutes" INTEGER,
    "weeklyCapMinutes" INTEGER,
    "monthlyCapMinutes" INTEGER,
    "minMinutes" INTEGER NOT NULL DEFAULT 0,
    "requirePreApproval" BOOLEAN NOT NULL DEFAULT false,
    "postFactoDays" INTEGER,
    "alertMonthlyMinutes" INTEGER,
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overtime_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_exceptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "excessMinutes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "ruleId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "overtimeEntryId" TEXT,
    "raisedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overtime_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_alerts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overtime_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "join_settings_tenantId_key" ON "join_settings"("tenantId");

-- CreateIndex
CREATE INDEX "preboarding_templates_tenantId_idx" ON "preboarding_templates"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "preboarding_templates_tenantId_name_key" ON "preboarding_templates"("tenantId", "name");

-- CreateIndex
CREATE INDEX "preboarding_template_items_templateId_idx" ON "preboarding_template_items"("templateId");

-- CreateIndex
CREATE INDEX "preboarding_tasks_tenantId_status_idx" ON "preboarding_tasks"("tenantId", "status");

-- CreateIndex
CREATE INDEX "preboarding_tasks_employeeId_idx" ON "preboarding_tasks"("employeeId");

-- CreateIndex
CREATE INDEX "new_hire_forms_tenantId_idx" ON "new_hire_forms"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "new_hire_forms_tenantId_name_key" ON "new_hire_forms"("tenantId", "name");

-- CreateIndex
CREATE INDEX "new_hire_form_submissions_tenantId_status_idx" ON "new_hire_form_submissions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "new_hire_form_submissions_formId_idx" ON "new_hire_form_submissions"("formId");

-- CreateIndex
CREATE INDEX "new_hire_form_submissions_employeeId_idx" ON "new_hire_form_submissions"("employeeId");

-- CreateIndex
CREATE INDEX "prejoin_messages_tenantId_status_idx" ON "prejoin_messages"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "prejoin_messages_tenantId_name_key" ON "prejoin_messages"("tenantId", "name");

-- CreateIndex
CREATE INDEX "prejoin_message_logs_tenantId_sentAt_idx" ON "prejoin_message_logs"("tenantId", "sentAt");

-- CreateIndex
CREATE INDEX "prejoin_message_logs_employeeId_idx" ON "prejoin_message_logs"("employeeId");

-- CreateIndex
CREATE INDEX "preboarding_provisions_tenantId_status_idx" ON "preboarding_provisions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "preboarding_provisions_employeeId_idx" ON "preboarding_provisions"("employeeId");

-- CreateIndex
CREATE INDEX "onboarding_buddies_tenantId_status_idx" ON "onboarding_buddies"("tenantId", "status");

-- CreateIndex
CREATE INDEX "onboarding_buddies_employeeId_idx" ON "onboarding_buddies"("employeeId");

-- CreateIndex
CREATE INDEX "onboarding_buddies_buddyEmployeeId_idx" ON "onboarding_buddies"("buddyEmployeeId");

-- CreateIndex
CREATE INDEX "onboarding_buddy_checkins_buddyId_idx" ON "onboarding_buddy_checkins"("buddyId");

-- CreateIndex
CREATE INDEX "orientation_sessions_tenantId_startsAt_idx" ON "orientation_sessions"("tenantId", "startsAt");

-- CreateIndex
CREATE INDEX "orientation_attendees_employeeId_idx" ON "orientation_attendees"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "orientation_attendees_sessionId_employeeId_key" ON "orientation_attendees"("sessionId", "employeeId");

-- CreateIndex
CREATE INDEX "onboarding_milestones_tenantId_dueDate_idx" ON "onboarding_milestones"("tenantId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_milestones_employeeId_kind_key" ON "onboarding_milestones"("employeeId", "kind");

-- CreateIndex
CREATE INDEX "journey_template_revisions_templateId_idx" ON "journey_template_revisions"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "bgv_vendors_tenantId_name_key" ON "bgv_vendors"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bgv_packages_tenantId_name_key" ON "bgv_packages"("tenantId", "name");

-- CreateIndex
CREATE INDEX "bgv_check_items_bgvCheckId_idx" ON "bgv_check_items"("bgvCheckId");

-- CreateIndex
CREATE INDEX "bgv_check_items_tenantId_status_idx" ON "bgv_check_items"("tenantId", "status");

-- CreateIndex
CREATE INDEX "bgv_case_events_bgvCheckId_idx" ON "bgv_case_events"("bgvCheckId");

-- CreateIndex
CREATE INDEX "bgv_case_events_tenantId_createdAt_idx" ON "bgv_case_events"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "shift_swap_requests_tenantId_status_idx" ON "shift_swap_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "shift_swap_requests_requesterId_idx" ON "shift_swap_requests"("requesterId");

-- CreateIndex
CREATE INDEX "shift_swap_requests_counterpartId_idx" ON "shift_swap_requests"("counterpartId");

-- CreateIndex
CREATE INDEX "open_shifts_tenantId_date_idx" ON "open_shifts"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "open_shift_bids_openShiftId_employeeId_key" ON "open_shift_bids"("openShiftId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "shift_preferences_employeeId_key" ON "shift_preferences"("employeeId");

-- CreateIndex
CREATE INDEX "shift_preferences_tenantId_idx" ON "shift_preferences"("tenantId");

-- CreateIndex
CREATE INDEX "staffing_rules_tenantId_idx" ON "staffing_rules"("tenantId");

-- CreateIndex
CREATE INDEX "roster_publications_tenantId_status_idx" ON "roster_publications"("tenantId", "status");

-- CreateIndex
CREATE INDEX "time_config_changes_tenantId_status_idx" ON "time_config_changes"("tenantId", "status");

-- CreateIndex
CREATE INDEX "holiday_calendar_revisions_tenantId_status_idx" ON "holiday_calendar_revisions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "holiday_rules_tenantId_idx" ON "holiday_rules"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_day_types_tenantId_code_key" ON "holiday_day_types"("tenantId", "code");

-- CreateIndex
CREATE INDEX "shutdown_periods_tenantId_idx" ON "shutdown_periods"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_exceptions_tenantId_key_key" ON "calendar_exceptions"("tenantId", "key");

-- CreateIndex
CREATE INDEX "overtime_rules_tenantId_status_idx" ON "overtime_rules"("tenantId", "status");

-- CreateIndex
CREATE INDEX "overtime_exceptions_tenantId_status_idx" ON "overtime_exceptions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "overtime_alerts_tenantId_status_idx" ON "overtime_alerts"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_alerts_tenantId_employeeId_kind_periodKey_key" ON "overtime_alerts"("tenantId", "employeeId", "kind", "periodKey");

-- AddForeignKey
ALTER TABLE "join_settings" ADD CONSTRAINT "join_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preboarding_templates" ADD CONSTRAINT "preboarding_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preboarding_template_items" ADD CONSTRAINT "preboarding_template_items_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "preboarding_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preboarding_tasks" ADD CONSTRAINT "preboarding_tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_hire_forms" ADD CONSTRAINT "new_hire_forms_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_hire_form_submissions" ADD CONSTRAINT "new_hire_form_submissions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_hire_form_submissions" ADD CONSTRAINT "new_hire_form_submissions_formId_fkey" FOREIGN KEY ("formId") REFERENCES "new_hire_forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prejoin_messages" ADD CONSTRAINT "prejoin_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prejoin_message_logs" ADD CONSTRAINT "prejoin_message_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preboarding_provisions" ADD CONSTRAINT "preboarding_provisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_buddies" ADD CONSTRAINT "onboarding_buddies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_buddy_checkins" ADD CONSTRAINT "onboarding_buddy_checkins_buddyId_fkey" FOREIGN KEY ("buddyId") REFERENCES "onboarding_buddies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orientation_sessions" ADD CONSTRAINT "orientation_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orientation_attendees" ADD CONSTRAINT "orientation_attendees_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "orientation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_milestones" ADD CONSTRAINT "onboarding_milestones_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_template_revisions" ADD CONSTRAINT "journey_template_revisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bgv_vendors" ADD CONSTRAINT "bgv_vendors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bgv_packages" ADD CONSTRAINT "bgv_packages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bgv_check_items" ADD CONSTRAINT "bgv_check_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bgv_check_items" ADD CONSTRAINT "bgv_check_items_bgvCheckId_fkey" FOREIGN KEY ("bgvCheckId") REFERENCES "bgv_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bgv_case_events" ADD CONSTRAINT "bgv_case_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_shifts" ADD CONSTRAINT "open_shifts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_shift_bids" ADD CONSTRAINT "open_shift_bids_openShiftId_fkey" FOREIGN KEY ("openShiftId") REFERENCES "open_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_preferences" ADD CONSTRAINT "shift_preferences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staffing_rules" ADD CONSTRAINT "staffing_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_publications" ADD CONSTRAINT "roster_publications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_config_changes" ADD CONSTRAINT "time_config_changes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday_calendar_revisions" ADD CONSTRAINT "holiday_calendar_revisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday_rules" ADD CONSTRAINT "holiday_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday_day_types" ADD CONSTRAINT "holiday_day_types_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shutdown_periods" ADD CONSTRAINT "shutdown_periods_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_exceptions" ADD CONSTRAINT "calendar_exceptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_rules" ADD CONSTRAINT "overtime_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_exceptions" ADD CONSTRAINT "overtime_exceptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_alerts" ADD CONSTRAINT "overtime_alerts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
