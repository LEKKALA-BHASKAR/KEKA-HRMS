-- AlterTable
ALTER TABLE "announcements" ADD COLUMN     "approvalStatus" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "isEmergency" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastReminderAt" TIMESTAMP(3),
ADD COLUMN     "translations" JSONB,
ADD COLUMN     "workflowRequestId" TEXT;

-- AlterTable
ALTER TABLE "employee_awards" ADD COLUMN     "points" INTEGER,
ADD COLUMN     "programId" TEXT,
ADD COLUMN     "revokeReason" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "survey_questions" ADD COLUMN     "showIfQuestionId" TEXT,
ADD COLUMN     "showIfValues" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "survey_responses" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "surveys" ADD COLUMN     "approvalStatus" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "lastReminderAt" TIMESTAMP(3),
ADD COLUMN     "onSignIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "randomize" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reminderEveryDays" INTEGER,
ADD COLUMN     "scheduleId" TEXT,
ADD COLUMN     "workflowRequestId" TEXT;

-- CreateTable
CREATE TABLE "engage_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "surveyApproval" BOOLEAN NOT NULL DEFAULT false,
    "announcementApproval" BOOLEAN NOT NULL DEFAULT false,
    "pointsPerPraise" INTEGER NOT NULL DEFAULT 10,
    "anniversaryPoints" INTEGER NOT NULL DEFAULT 0,
    "checkInMinGroup" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engage_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_schedules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PULSE',
    "templateId" TEXT,
    "everyDays" INTEGER NOT NULL DEFAULT 30,
    "openDays" INTEGER NOT NULL DEFAULT 7,
    "nextRunOn" TIMESTAMP(3) NOT NULL,
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "onSignIn" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "runs" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'PULSE',
    "questions" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "survey_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_action_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "driver" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerEmployeeId" TEXT NOT NULL,
    "dueOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "progressNote" TEXT,
    "overdueNotifiedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "survey_action_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recognition_programs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'SPOT',
    "awardTypeId" TEXT,
    "pointsPerAward" INTEGER NOT NULL DEFAULT 0,
    "budgetPoints" INTEGER,
    "budgetAmount" DECIMAL(18,2),
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3),
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minTenureDays" INTEGER NOT NULL DEFAULT 0,
    "cooldownDays" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recognition_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "award_nominations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "programId" TEXT,
    "awardTypeId" TEXT NOT NULL,
    "nomineeId" TEXT NOT NULL,
    "nominatorId" TEXT NOT NULL,
    "nominatorUserId" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "awardId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "award_nominations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_point_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "programId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_point_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'VOUCHER',
    "pointsCost" INTEGER NOT NULL,
    "stock" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_redemptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "deliveryNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledBy" TEXT,
    "fulfilmentNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wellness_programs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'FITNESS',
    "kind" TEXT NOT NULL DEFAULT 'CHALLENGE',
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3) NOT NULL,
    "goalValue" INTEGER,
    "goalUnit" TEXT,
    "capacity" INTEGER,
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "providerName" TEXT,
    "pointsReward" INTEGER NOT NULL DEFAULT 0,
    "requireConsent" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wellness_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wellness_enrollments" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ENROLLED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "consentAt" TIMESTAMP(3),
    "showOnBoard" BOOLEAN NOT NULL DEFAULT true,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wellness_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wellness_logs" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "note" TEXT,
    "loggedOn" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wellness_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wellbeing_checkins" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "week" TIMESTAMP(3) NOT NULL,
    "departmentId" TEXT,
    "locationId" TEXT,
    "mood" INTEGER NOT NULL,
    "stress" INTEGER NOT NULL,
    "wantsSupport" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,

    CONSTRAINT "wellbeing_checkins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wellbeing_checkin_marks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "week" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wellbeing_checkin_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "slaDays" INTEGER NOT NULL DEFAULT 3,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "answers" JSONB,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "workflowRequestId" TEXT,
    "assignedToUserId" TEXT,
    "dueOn" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "fulfilmentNote" TEXT,
    "rating" INTEGER,
    "ratingComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_resources" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ARTICLE',
    "description" TEXT,
    "url" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_channels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "visibility" TEXT NOT NULL DEFAULT 'OPEN',
    "departmentId" TEXT,
    "postingRestricted" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_members" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "workflowRequestId" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_posts" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "parentId" TEXT,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "hiddenAt" TIMESTAMP(3),
    "hiddenBy" TEXT,
    "hideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_reports" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'GENERAL',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "onlineUrl" TEXT,
    "capacity" INTEGER,
    "rsvpBy" TIMESTAMP(3),
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowQuestions" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_rsvps" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "attended" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_rsvps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_questions" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "voterIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "engage_settings_tenantId_key" ON "engage_settings"("tenantId");

-- CreateIndex
CREATE INDEX "survey_schedules_tenantId_isActive_nextRunOn_idx" ON "survey_schedules"("tenantId", "isActive", "nextRunOn");

-- CreateIndex
CREATE UNIQUE INDEX "survey_templates_tenantId_name_key" ON "survey_templates"("tenantId", "name");

-- CreateIndex
CREATE INDEX "survey_action_plans_tenantId_status_dueOn_idx" ON "survey_action_plans"("tenantId", "status", "dueOn");

-- CreateIndex
CREATE INDEX "survey_action_plans_surveyId_idx" ON "survey_action_plans"("surveyId");

-- CreateIndex
CREATE INDEX "recognition_programs_tenantId_status_idx" ON "recognition_programs"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recognition_programs_tenantId_name_key" ON "recognition_programs"("tenantId", "name");

-- CreateIndex
CREATE INDEX "award_nominations_tenantId_status_idx" ON "award_nominations"("tenantId", "status");

-- CreateIndex
CREATE INDEX "award_nominations_nomineeId_idx" ON "award_nominations"("nomineeId");

-- CreateIndex
CREATE INDEX "reward_point_entries_tenantId_employeeId_idx" ON "reward_point_entries"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "reward_point_entries_tenantId_programId_idx" ON "reward_point_entries"("tenantId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "reward_point_entries_tenantId_source_sourceId_employeeId_key" ON "reward_point_entries"("tenantId", "source", "sourceId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "reward_items_tenantId_name_key" ON "reward_items"("tenantId", "name");

-- CreateIndex
CREATE INDEX "reward_redemptions_tenantId_status_idx" ON "reward_redemptions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "reward_redemptions_employeeId_idx" ON "reward_redemptions"("employeeId");

-- CreateIndex
CREATE INDEX "wellness_programs_tenantId_status_idx" ON "wellness_programs"("tenantId", "status");

-- CreateIndex
CREATE INDEX "wellness_enrollments_employeeId_idx" ON "wellness_enrollments"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "wellness_enrollments_programId_employeeId_key" ON "wellness_enrollments"("programId", "employeeId");

-- CreateIndex
CREATE INDEX "wellness_logs_enrollmentId_idx" ON "wellness_logs"("enrollmentId");

-- CreateIndex
CREATE INDEX "wellbeing_checkins_tenantId_week_idx" ON "wellbeing_checkins"("tenantId", "week");

-- CreateIndex
CREATE INDEX "wellbeing_checkin_marks_tenantId_week_idx" ON "wellbeing_checkin_marks"("tenantId", "week");

-- CreateIndex
CREATE UNIQUE INDEX "wellbeing_checkin_marks_employeeId_week_key" ON "wellbeing_checkin_marks"("employeeId", "week");

-- CreateIndex
CREATE UNIQUE INDEX "service_types_tenantId_name_key" ON "service_types"("tenantId", "name");

-- CreateIndex
CREATE INDEX "service_requests_tenantId_status_idx" ON "service_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "service_requests_employeeId_idx" ON "service_requests"("employeeId");

-- CreateIndex
CREATE INDEX "support_resources_tenantId_status_kind_idx" ON "support_resources"("tenantId", "status", "kind");

-- CreateIndex
CREATE INDEX "community_channels_tenantId_kind_idx" ON "community_channels"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "community_channels_tenantId_name_key" ON "community_channels"("tenantId", "name");

-- CreateIndex
CREATE INDEX "community_members_employeeId_idx" ON "community_members"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "community_members_channelId_employeeId_key" ON "community_members"("channelId", "employeeId");

-- CreateIndex
CREATE INDEX "community_posts_channelId_createdAt_idx" ON "community_posts"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "content_reports_tenantId_status_idx" ON "content_reports"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "content_reports_targetType_targetId_reporterId_key" ON "content_reports"("targetType", "targetId", "reporterId");

-- CreateIndex
CREATE INDEX "company_events_tenantId_status_startsAt_idx" ON "company_events"("tenantId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "event_rsvps_employeeId_idx" ON "event_rsvps"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "event_rsvps_eventId_employeeId_key" ON "event_rsvps"("eventId", "employeeId");

-- CreateIndex
CREATE INDEX "event_questions_eventId_idx" ON "event_questions"("eventId");

-- AddForeignKey
ALTER TABLE "engage_settings" ADD CONSTRAINT "engage_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_schedules" ADD CONSTRAINT "survey_schedules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_templates" ADD CONSTRAINT "survey_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_action_plans" ADD CONSTRAINT "survey_action_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognition_programs" ADD CONSTRAINT "recognition_programs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "award_nominations" ADD CONSTRAINT "award_nominations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_point_entries" ADD CONSTRAINT "reward_point_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_items" ADD CONSTRAINT "reward_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wellness_programs" ADD CONSTRAINT "wellness_programs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wellness_enrollments" ADD CONSTRAINT "wellness_enrollments_programId_fkey" FOREIGN KEY ("programId") REFERENCES "wellness_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wellness_logs" ADD CONSTRAINT "wellness_logs_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "wellness_enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wellbeing_checkins" ADD CONSTRAINT "wellbeing_checkins_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wellbeing_checkin_marks" ADD CONSTRAINT "wellbeing_checkin_marks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_types" ADD CONSTRAINT "service_types_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_resources" ADD CONSTRAINT "support_resources_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_channels" ADD CONSTRAINT "community_channels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "community_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "community_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_events" ADD CONSTRAINT "company_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "company_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_questions" ADD CONSTRAINT "event_questions_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "company_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grant the new engage permissions to the existing system roles (new tenants
-- get them from @keka/rbac SYSTEM_ROLES when they are created).
INSERT INTO "role_permissions" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", p.perm
FROM "roles" r
JOIN (VALUES
  ('GLOBAL_ADMIN', 'engagement.wellness.manage'), ('GLOBAL_ADMIN', 'engagement.service.manage'),
  ('HR_MANAGER', 'engagement.wellness.manage'), ('HR_MANAGER', 'engagement.service.manage'),
  ('HR_EXECUTIVE', 'engagement.service.manage')
) AS p(rolekey, perm) ON p.rolekey = r."key"
WHERE r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
