-- Keka parity schema (specs: analytics-ai, assets, finances-payroll, helpdesk,
-- hire, home-ess-wall, performance-learning, psa, time-inbox).
-- Additive only: new enums, enum values, tables, nullable/defaulted columns,
-- indexes and foreign keys. No existing column, table or enum value is removed
-- or changed. Generated with `prisma migrate diff` and then hand-edited:
--   1. AssetCondition.POOR is placed before DAMAGED (schema order).
--   2. Orphaned ids are nulled before the new assets.locationId and
--      asset_requests.assetTypeId foreign keys are added.
--   3. Three NO ACTION foreign keys are made DEFERRABLE INITIALLY DEFERRED
--      (the 20261001104418_deferrable_category_fks pattern) so tenant deletion
--      keeps working.
--   4. Backfills of the new columns that the specs ask for and that do not
--      use enum values added in this same migration.

-- CreateEnum
CREATE TYPE "PunchStatus" AS ENUM ('VALID', 'PENDING', 'REJECTED');

-- CreateEnum
CREATE TYPE "AssetAckStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "AssetRequestType" AS ENUM ('NEW_ASSET', 'REPLACEMENT', 'RETURN');

-- CreateEnum
CREATE TYPE "CourseState" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AllocationKind" AS ENUM ('SOFT', 'HARD');

-- CreateEnum
CREATE TYPE "RevenueRecognition" AS ENUM ('INCOME_TO_DATE', 'INVOICED_AMOUNT', 'COST_TO_COST', 'TIME_EXPENDED');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('TAX', 'PROFORMA');

-- CreateEnum
CREATE TYPE "HelpdeskAssignMode" AS ENUM ('HEAD', 'ROUND_ROBIN', 'UNASSIGNED');

-- CreateEnum
CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "DashboardWidgetType" AS ENUM ('QUICK_LINKS', 'ON_LEAVE_TODAY', 'LEAVE_BALANCES', 'TIME_TODAY', 'WORKING_REMOTELY', 'HOLIDAYS', 'INBOX', 'FEEDBACK_RECEIVED', 'PROJECT_TIME_TODAY', 'NEEDS_ATTENTION', 'TEAM_TODAY');

-- CreateEnum
CREATE TYPE "WallPostKind" AS ENUM ('POST', 'POLL', 'PRAISE', 'WISH');

-- CreateEnum
CREATE TYPE "WishOccasion" AS ENUM ('BIRTHDAY', 'WORK_ANNIVERSARY', 'NEW_JOINEE');

-- CreateEnum
CREATE TYPE "AssetApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AssetEventKind" AS ENUM ('CREATED', 'UPDATED', 'IMPORTED', 'ASSIGNED', 'ACKNOWLEDGED', 'ACK_REMINDED', 'RETURNED', 'CONDITION_CHANGED', 'STATUS_CHANGED', 'REQUEST_FULFILLED');

-- CreateEnum
CREATE TYPE "AssetImportMode" AS ENUM ('ADD', 'UPDATE');

-- CreateEnum
CREATE TYPE "AssetImportStatus" AS ENUM ('UPLOADED', 'MAPPED', 'VALIDATED', 'IMPORTED', 'FAILED');

-- CreateEnum
CREATE TYPE "BackfillReason" AS ENUM ('INTERNAL_MOVEMENT', 'MATERNITY_LEAVE', 'PROMOTION', 'RELIEVED', 'RELOCATED', 'RETIRED', 'OTHERS');

-- CreateEnum
CREATE TYPE "CourseModuleType" AS ENUM ('DOCUMENT', 'VIDEO', 'PAGE', 'ASSESSMENT');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE');

-- CreateEnum
CREATE TYPE "OpportunityStageKind" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('OPEN', 'WON', 'LOST', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EstimateType" AS ENUM ('TASK', 'RESOURCE');

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "EstimateLineKind" AS ENUM ('PHASE', 'TASK', 'MILESTONE', 'ROLE');

-- CreateEnum
CREATE TYPE "ProjectRequestSource" AS ENUM ('OPPORTUNITY', 'PROJECT');

-- CreateEnum
CREATE TYPE "ProjectRequestStatus" AS ENUM ('NEW', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ResourceRequestType" AS ENUM ('ROLE', 'RESOURCE');

-- CreateEnum
CREATE TYPE "ResourceRequestStatus" AS ENUM ('OPEN', 'HIRING', 'ALLOCATED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ResourceCostType" AS ENUM ('HOURLY', 'MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "ChargeKind" AS ENUM ('TIME', 'MILESTONE', 'RETAINER', 'EXPENSE', 'ADHOC');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('UNBILLED', 'INVOICED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChargeTemplate" AS ENUM ('NONE', 'TASK', 'ROLE', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "CreditNoteStatus" AS ENUM ('OPEN', 'APPLIED', 'VOID');

-- CreateEnum
CREATE TYPE "ShiftRequestKind" AS ENUM ('SHIFT_CHANGE', 'WEEKLY_OFF');

-- CreateEnum
CREATE TYPE "ExitReasonKind" AS ENUM ('VOLUNTARY', 'INVOLUNTARY', 'OTHER');

-- CreateEnum
CREATE TYPE "RiskBand" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "InsightKind" AS ENUM ('SUMMARY', 'PROMPT', 'RISK_EXPLAIN');

-- AlterEnum
ALTER TYPE "AssetCondition" ADD VALUE 'POOR' BEFORE 'DAMAGED';

-- AlterEnum
ALTER TYPE "AttendanceRequestType" ADD VALUE 'REMOTE_CLOCK_IN';

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'VIEW';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditModule" ADD VALUE 'ANALYTICS';
ALTER TYPE "AuditModule" ADD VALUE 'ASSET';
ALTER TYPE "AuditModule" ADD VALUE 'PROJECTS';

-- AlterEnum
ALTER TYPE "CaptureSource" ADD VALUE 'REMOTE';

-- AlterEnum
ALTER TYPE "CustomFieldEntity" ADD VALUE 'ASSET';

-- AlterEnum
ALTER TYPE "LoanStatus" ADD VALUE 'WITHDRAWN';

-- AlterEnum
ALTER TYPE "TicketPriority" ADD VALUE 'NA';

-- AlterEnum
ALTER TYPE "TicketStatus" ADD VALUE 'ON_HOLD';

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "candidateFeedback" TEXT,
ADD COLUMN     "candidateFeedbackAt" TIMESTAMP(3),
ADD COLUMN     "feedbackSummary" TEXT,
ADD COLUMN     "feedbackSummaryAt" TIMESTAMP(3),
ADD COLUMN     "feedbackSummaryById" TEXT,
ADD COLUMN     "feedbackSummaryDetail" JSONB;

-- AlterTable
ALTER TABLE "asset_assignments" ADD COLUMN     "ackRemindCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ackRemindedAt" TIMESTAMP(3),
ADD COLUMN     "ackStatus" "AssetAckStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "returnedBy" TEXT;

-- AlterTable
ALTER TABLE "asset_requests" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedBy" TEXT,
ADD COLUMN     "currentLevel" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "heldAssetId" TEXT,
ADD COLUMN     "requestType" "AssetRequestType" NOT NULL DEFAULT 'NEW_ASSET',
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "asset_types" ADD COLUMN     "description" TEXT,
ADD COLUMN     "icon" TEXT NOT NULL DEFAULT 'other',
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "customFields" JSONB,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "imageFileId" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "unavailableReason" TEXT;

-- AlterTable
ALTER TABLE "attendance_logs" ADD COLUMN     "attendanceRequestId" TEXT,
ADD COLUMN     "status" "PunchStatus" NOT NULL DEFAULT 'VALID';

-- AlterTable
ALTER TABLE "attendance_policies" ADD COLUMN     "allowHalfDayRemoteWork" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowHourlyRemoteWork" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowRemoteClockIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowShiftChangeRequests" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowWeeklyOffRequests" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "overtimeNeedsRequest" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "overtimeRequestWindowDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "penaltyBufferDays" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "remoteClockInNeedsApproval" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "attendance_requests" ADD COLUMN     "attachmentFileId" TEXT,
ADD COLUMN     "isHourly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notifyEmployeeIds" JSONB,
ADD COLUMN     "portion" "DayPortion",
ADD COLUMN     "proposedLogs" JSONB;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "professionalSummary" TEXT;

-- AlterTable
ALTER TABLE "exit_records" ADD COLUMN     "reasonId" TEXT;

-- AlterTable
ALTER TABLE "goals" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "tags" JSONB,
ADD COLUMN     "timeframe" TEXT,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'EVERYONE';

-- AlterTable
ALTER TABLE "helpdesk_categories" ADD COLUMN     "assignMode" "HelpdeskAssignMode" NOT NULL DEFAULT 'HEAD',
ADD COLUMN     "audience" JSONB,
ADD COLUMN     "businessHoursId" TEXT,
ADD COLUMN     "defaultPriority" "TicketPriority",
ADD COLUMN     "enableOnHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "firstResponseHours" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "lastAssignedUserId" TEXT,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "helpdesk_comments" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "helpdesk_tickets" ADD COLUMN     "closedByUserId" TEXT,
ADD COLUMN     "closingReasonId" TEXT,
ADD COLUMN     "firstResponseDueAt" TIMESTAMP(3),
ADD COLUMN     "lastRespondedAt" TIMESTAMP(3),
ADD COLUMN     "lastResponderUserId" TEXT,
ADD COLUMN     "missedFirstResponse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "missedResolution" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onHoldSince" TIMESTAMP(3),
ADD COLUMN     "reopenCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "attentionEmail" TEXT,
ADD COLUMN     "attentionName" TEXT,
ADD COLUMN     "billingEntityId" TEXT,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "convertedFromId" TEXT,
ADD COLUMN     "documentTitle" TEXT NOT NULL DEFAULT 'Tax Invoice',
ADD COLUMN     "kind" "InvoiceKind" NOT NULL DEFAULT 'TAX',
ADD COLUMN     "paymentTermDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "poNumber" TEXT,
ADD COLUMN     "writeOffAmount" DECIMAL(18,2),
ADD COLUMN     "writeOffReason" TEXT,
ADD COLUMN     "writtenOffAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "scorecardTemplate" JSONB;

-- AlterTable
ALTER TABLE "leave_ledger_entries" ADD COLUMN     "expiresOn" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "notifyEmployeeIds" JSONB;

-- AlterTable
ALTER TABLE "leave_types" ADD COLUMN     "allowEncashmentRequest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "compOffRequestWindowDays" INTEGER,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "encashmentMaxDaysPerYear" DECIMAL(9,2);

-- AlterTable
ALTER TABLE "loan_categories" ADD COLUMN     "code" TEXT;

-- AlterTable
ALTER TABLE "loans" ADD COLUMN     "expectedMonth" INTEGER,
ADD COLUMN     "expectedYear" INTEGER;

-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "aiSummary" JSONB,
ADD COLUMN     "aiSummaryAt" TIMESTAMP(3),
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "purpose" TEXT,
ADD COLUMN     "recurrence" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "seriesId" TEXT,
ADD COLUMN     "templateId" TEXT;

-- AlterTable
ALTER TABLE "praises" ADD COLUMN     "badgeId" TEXT,
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "wallPostId" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "businessUnitId" TEXT,
ADD COLUMN     "csat" TEXT,
ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "opportunityId" TEXT,
ADD COLUMN     "priority" TEXT,
ADD COLUMN     "rateCardId" TEXT,
ADD COLUMN     "revenueRecognition" "RevenueRecognition" NOT NULL DEFAULT 'INCOME_TO_DATE',
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "rate_cards" ADD COLUMN     "rateUnit" TEXT NOT NULL DEFAULT 'HOURLY';

-- AlterTable
ALTER TABLE "requisitions" ADD COLUMN     "approverUserId" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedBy" TEXT,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "employmentType" TEXT,
ADD COLUMN     "hiringManagerId" TEXT,
ADD COLUMN     "isPriority" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "jobType" TEXT NOT NULL DEFAULT 'FULL_TIME',
ADD COLUMN     "minExperienceYears" DECIMAL(9,1),
ADD COLUMN     "newPositions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recruiterId" TEXT,
ADD COLUMN     "salaryFrequency" TEXT,
ADD COLUMN     "salaryMax" DECIMAL(18,2),
ADD COLUMN     "salaryMin" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "resource_allocations" ADD COLUMN     "kind" "AllocationKind" NOT NULL DEFAULT 'HARD',
ADD COLUMN     "requestId" TEXT;

-- AlterTable
ALTER TABLE "scorecards" ADD COLUMN     "aiAssisted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "training_programs" ADD COLUMN     "authorId" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "courseState" "CourseState",
ADD COLUMN     "format" TEXT NOT NULL DEFAULT 'PROGRAMME',
ADD COLUMN     "isMandatory" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "selfEnrol" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ai_generations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "subjectId" TEXT,
    "inputChars" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_reports" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "params" JSONB,
    "recipients" JSONB NOT NULL,
    "frequency" "ReportFrequency" NOT NULL,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_widgets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "DashboardWidgetType" NOT NULL,
    "position" INTEGER NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'plain',
    "config" JSONB,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wall_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "allowPosts" BOOLEAN NOT NULL DEFAULT true,
    "allowPolls" BOOLEAN NOT NULL DEFAULT true,
    "allowPraise" BOOLEAN NOT NULL DEFAULT true,
    "allowComments" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wall_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wall_posts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "WallPostKind" NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageUrl" TEXT,
    "departmentId" TEXT,
    "pollExpiresAt" TIMESTAMP(3),
    "pollAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "pollNotify" BOOLEAN NOT NULL DEFAULT false,
    "wishForId" TEXT,
    "wishOccasion" "WishOccasion",
    "wishYear" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wall_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wall_poll_options" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "wall_poll_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wall_poll_votes" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wall_poll_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wall_likes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "postId" TEXT,
    "announcementId" TEXT,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wall_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wall_comments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "postId" TEXT,
    "announcementId" TEXT,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wall_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "praise_badges" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT NOT NULL DEFAULT 'star',
    "color" TEXT NOT NULL DEFAULT '#F5B83D',
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "praise_badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_questions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_answers" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_request_approvals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "approverKind" TEXT NOT NULL,
    "approverId" TEXT,
    "status" "AssetApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "actedById" TEXT,
    "actedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_request_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" "AssetEventKind" NOT NULL,
    "employeeId" TEXT,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "fromValue" JSONB,
    "toValue" JSONB,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_imports" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" "AssetImportMode" NOT NULL,
    "assetTypeId" TEXT,
    "fileId" TEXT NOT NULL,
    "status" "AssetImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "headers" JSONB NOT NULL,
    "mapping" JSONB,
    "rows" JSONB,
    "errors" JSONB,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "okRows" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "asset_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestApprovalChain" JSONB NOT NULL DEFAULT '["REPORTING_MANAGER","ASSET_MANAGER"]',
    "skipDuplicateApprover" BOOLEAN NOT NULL DEFAULT true,
    "allowEmployeeRequests" BOOLEAN NOT NULL DEFAULT true,
    "ackReminderDays" INTEGER DEFAULT 3,
    "warrantyAlertDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_category_agents" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_category_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_business_hours" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "schedule" JSONB NOT NULL DEFAULT '[]',
    "observeHolidays" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "helpdesk_business_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_canned_responses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "helpdesk_canned_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_closing_reasons" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_closing_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_ticket_followers" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "viaRole" TEXT,
    "addedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_ticket_followers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisition_backfills" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reason" "BackfillReason" NOT NULL,

    CONSTRAINT "requisition_backfills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_question_sets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "questions" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_question_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_description_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_description_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hiring_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requisitionInstructions" TEXT,
    "defaultApproverUserId" TEXT,
    "aiQuestionAttempts" INTEGER NOT NULL DEFAULT 2,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hiring_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_agenda_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT,
    "items" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_agenda_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_talking_points" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isDone" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_talking_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_private_notes" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_private_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_sections" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "course_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_modules" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "sectionId" TEXT,
    "type" "CourseModuleType" NOT NULL,
    "title" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "durationMinutes" INTEGER NOT NULL DEFAULT 0,
    "body" TEXT,
    "url" TEXT,
    "fileId" TEXT,
    "passPercent" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_questions" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "type" "QuestionType" NOT NULL DEFAULT 'SINGLE_CHOICE',
    "prompt" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correctOptionIds" JSONB NOT NULL,
    "explanation" TEXT,
    "difficulty" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_module_progress" (
    "id" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_module_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_attempts" (
    "id" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "correctCount" INTEGER NOT NULL,
    "totalCount" INTEGER NOT NULL,
    "scorePercent" DECIMAL(5,2) NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_stages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "winProbability" INTEGER NOT NULL DEFAULT 10,
    "kind" "OpportunityStageKind" NOT NULL DEFAULT 'OPEN',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "opportunity_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_sources" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "opportunity_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospects" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "city" TEXT,
    "state" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'IN',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "ownerId" TEXT,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "clientId" TEXT,
    "prospectId" TEXT,
    "sourceId" TEXT,
    "stageId" TEXT NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'OPEN',
    "winProbability" INTEGER NOT NULL DEFAULT 0,
    "ownerId" TEXT NOT NULL,
    "managerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "billingModel" "BillingModel" NOT NULL DEFAULT 'TIME_AND_MATERIAL',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "estimatedRevenue" DECIMAL(18,2) NOT NULL,
    "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "startDate" TIMESTAMP(3) NOT NULL,
    "closeDate" TIMESTAMP(3) NOT NULL,
    "expectedProjectStart" TIMESTAMP(3) NOT NULL,
    "expectedProjectEnd" TIMESTAMP(3),
    "businessUnitId" TEXT,
    "departmentId" TEXT,
    "locationId" TEXT,
    "closedAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "archivedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_comments" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_estimates" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EstimateType" NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "rateCardId" TEXT,
    "hours" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "billingAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunity_estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_lines" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "kind" "EstimateLineKind" NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "billingRoleId" TEXT,
    "employeeId" TEXT,
    "headcount" INTEGER NOT NULL DEFAULT 1,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "allocationPercent" DECIMAL(9,2) NOT NULL DEFAULT 100,
    "hours" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "billRate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "costRate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "estimate_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" "ProjectRequestSource" NOT NULL,
    "opportunityId" TEXT,
    "name" TEXT NOT NULL,
    "clientId" TEXT,
    "prospectId" TEXT,
    "billingModel" "BillingModel" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "estimatedRevenue" DECIMAL(18,2),
    "status" "ProjectRequestStatus" NOT NULL DEFAULT 'NEW',
    "payload" JSONB,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "projectId" TEXT,

    CONSTRAINT "project_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_roles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT,
    "opportunityId" TEXT,
    "estimateLineId" TEXT,
    "type" "ResourceRequestType" NOT NULL,
    "billingRoleId" TEXT NOT NULL,
    "employeeId" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "allocationPercent" DECIMAL(9,2) NOT NULL DEFAULT 100,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "businessUnitIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minExperienceYears" INTEGER NOT NULL DEFAULT 0,
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "ResourceRequestStatus" NOT NULL DEFAULT 'OPEN',
    "requestedById" TEXT NOT NULL,
    "notes" TEXT,
    "requisitionId" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "capacity" JSONB NOT NULL DEFAULT '[0,8,8,8,8,8,0]',
    "costType" "ResourceCostType",
    "costAmount" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "hourlyCost" DECIMAL(18,2),
    "targetUtilization" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_charges" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ChargeKind" NOT NULL,
    "template" "ChargeTemplate" NOT NULL DEFAULT 'NONE',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "ChargeStatus" NOT NULL DEFAULT 'UNBILLED',
    "invoiceId" TEXT,
    "sourceRefs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reason" TEXT NOT NULL,
    "status" "CreditNoteStatus" NOT NULL DEFAULT 'OPEN',
    "appliedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_entity_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV-',
    "invoiceSuffix" TEXT,
    "nextInvoiceNumber" INTEGER NOT NULL DEFAULT 1,
    "proformaPrefix" TEXT NOT NULL DEFAULT 'PINV-',
    "nextProformaNumber" INTEGER NOT NULL DEFAULT 1,
    "creditNotePrefix" TEXT NOT NULL DEFAULT 'CRN-',
    "nextCreditNoteNumber" INTEGER NOT NULL DEFAULT 1,
    "defaultPaymentTermDays" INTEGER NOT NULL DEFAULT 30,
    "bankDetails" TEXT,
    "footer" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_entity_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "psa_dashboard_layouts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "widgets" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "psa_dashboard_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "psa_insight_cache" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "psa_insight_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "psa_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "criticalRequestDays" INTEGER NOT NULL DEFAULT 10,
    "projectCreationNeedsApproval" BOOLEAN NOT NULL DEFAULT false,
    "defaultRevenueRecognition" "RevenueRecognition" NOT NULL DEFAULT 'INCOME_TO_DATE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "psa_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "ShiftRequestKind" NOT NULL,
    "status" "AttendanceRequestStatus" NOT NULL DEFAULT 'PENDING',
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "shiftId" TEXT,
    "reason" TEXT NOT NULL,
    "notifyEmployeeIds" JSONB,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "AttendanceRequestStatus" NOT NULL DEFAULT 'PENDING',
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "requestedMinutes" INTEGER NOT NULL,
    "loggedMinutes" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "notifyEmployeeIds" JSONB,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "overtimeEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overtime_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_off_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "days" DECIMAL(9,2) NOT NULL,
    "note" TEXT,
    "attachmentFileId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "ledgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comp_off_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_encashment_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "yearStart" TIMESTAMP(3) NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "days" DECIMAL(9,2) NOT NULL,
    "encashAll" BOOLEAN NOT NULL DEFAULT false,
    "amount" DECIMAL(18,2),
    "note" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "adhocTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_encashment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_comments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "authorEmployeeId" TEXT,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exit_reasons" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ExitReasonKind" NOT NULL DEFAULT 'VOLUNTARY',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exit_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attrition_risk_scores" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL,
    "band" "RiskBand" NOT NULL,
    "factors" JSONB NOT NULL,
    "coverage" INTEGER NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'risk-v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attrition_risk_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_insights" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "widget" TEXT,
    "kind" "InsightKind" NOT NULL,
    "filters" JSONB NOT NULL,
    "prompt" TEXT,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "answer" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "rating" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_comments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "widget" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "analytics_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storyboard_shares" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filters" JSONB,
    "insightId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storyboard_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_generations_tenantId_userId_feature_subjectId_createdAt_idx" ON "ai_generations"("tenantId", "userId", "feature", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "scheduled_reports_tenantId_reportKey_idx" ON "scheduled_reports"("tenantId", "reportKey");

-- CreateIndex
CREATE INDEX "scheduled_reports_isActive_nextRunAt_idx" ON "scheduled_reports"("isActive", "nextRunAt");

-- CreateIndex
CREATE INDEX "dashboard_widgets_tenantId_position_idx" ON "dashboard_widgets"("tenantId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_widgets_tenantId_type_key" ON "dashboard_widgets"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "wall_settings_tenantId_key" ON "wall_settings"("tenantId");

-- CreateIndex
CREATE INDEX "wall_posts_tenantId_deletedAt_createdAt_idx" ON "wall_posts"("tenantId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "wall_posts_tenantId_departmentId_createdAt_idx" ON "wall_posts"("tenantId", "departmentId", "createdAt");

-- CreateIndex
CREATE INDEX "wall_posts_authorId_idx" ON "wall_posts"("authorId");

-- CreateIndex
CREATE INDEX "wall_posts_wishForId_wishOccasion_wishYear_idx" ON "wall_posts"("wishForId", "wishOccasion", "wishYear");

-- CreateIndex
CREATE INDEX "wall_poll_options_postId_idx" ON "wall_poll_options"("postId");

-- CreateIndex
CREATE INDEX "wall_poll_votes_optionId_idx" ON "wall_poll_votes"("optionId");

-- CreateIndex
CREATE INDEX "wall_poll_votes_employeeId_idx" ON "wall_poll_votes"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "wall_poll_votes_postId_employeeId_key" ON "wall_poll_votes"("postId", "employeeId");

-- CreateIndex
CREATE INDEX "wall_likes_tenantId_idx" ON "wall_likes"("tenantId");

-- CreateIndex
CREATE INDEX "wall_likes_employeeId_idx" ON "wall_likes"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "wall_likes_postId_employeeId_key" ON "wall_likes"("postId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "wall_likes_announcementId_employeeId_key" ON "wall_likes"("announcementId", "employeeId");

-- CreateIndex
CREATE INDEX "wall_comments_postId_createdAt_idx" ON "wall_comments"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "wall_comments_announcementId_createdAt_idx" ON "wall_comments"("announcementId", "createdAt");

-- CreateIndex
CREATE INDEX "wall_comments_tenantId_idx" ON "wall_comments"("tenantId");

-- CreateIndex
CREATE INDEX "wall_comments_authorId_idx" ON "wall_comments"("authorId");

-- CreateIndex
CREATE INDEX "praise_badges_tenantId_idx" ON "praise_badges"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "praise_badges_tenantId_name_key" ON "praise_badges"("tenantId", "name");

-- CreateIndex
CREATE INDEX "profile_questions_tenantId_position_idx" ON "profile_questions"("tenantId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "profile_questions_tenantId_prompt_key" ON "profile_questions"("tenantId", "prompt");

-- CreateIndex
CREATE INDEX "profile_answers_employeeId_idx" ON "profile_answers"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "profile_answers_questionId_employeeId_key" ON "profile_answers"("questionId", "employeeId");

-- CreateIndex
CREATE INDEX "asset_request_approvals_tenantId_status_approverId_idx" ON "asset_request_approvals"("tenantId", "status", "approverId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_request_approvals_requestId_level_key" ON "asset_request_approvals"("requestId", "level");

-- CreateIndex
CREATE INDEX "asset_events_assetId_createdAt_idx" ON "asset_events"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "asset_events_tenantId_kind_createdAt_idx" ON "asset_events"("tenantId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "asset_imports_tenantId_createdAt_idx" ON "asset_imports"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "asset_settings_tenantId_key" ON "asset_settings"("tenantId");

-- CreateIndex
CREATE INDEX "helpdesk_category_agents_userId_idx" ON "helpdesk_category_agents"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_category_agents_categoryId_userId_key" ON "helpdesk_category_agents"("categoryId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_business_hours_tenantId_name_key" ON "helpdesk_business_hours"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_canned_responses_tenantId_title_key" ON "helpdesk_canned_responses"("tenantId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_closing_reasons_tenantId_name_key" ON "helpdesk_closing_reasons"("tenantId", "name");

-- CreateIndex
CREATE INDEX "helpdesk_ticket_followers_userId_idx" ON "helpdesk_ticket_followers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_ticket_followers_ticketId_userId_key" ON "helpdesk_ticket_followers"("ticketId", "userId");

-- CreateIndex
CREATE INDEX "requisition_backfills_tenantId_idx" ON "requisition_backfills"("tenantId");

-- CreateIndex
CREATE INDEX "requisition_backfills_employeeId_idx" ON "requisition_backfills"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "requisition_backfills_requisitionId_employeeId_key" ON "requisition_backfills"("requisitionId", "employeeId");

-- CreateIndex
CREATE INDEX "interview_question_sets_tenantId_idx" ON "interview_question_sets"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "interview_question_sets_jobId_section_attempt_key" ON "interview_question_sets"("jobId", "section", "attempt");

-- CreateIndex
CREATE INDEX "candidate_notes_applicationId_idx" ON "candidate_notes"("applicationId");

-- CreateIndex
CREATE INDEX "candidate_notes_tenantId_idx" ON "candidate_notes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "job_description_templates_tenantId_title_key" ON "job_description_templates"("tenantId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "hiring_settings_tenantId_key" ON "hiring_settings"("tenantId");

-- CreateIndex
CREATE INDEX "meeting_agenda_templates_tenantId_idx" ON "meeting_agenda_templates"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_agenda_templates_tenantId_name_key" ON "meeting_agenda_templates"("tenantId", "name");

-- CreateIndex
CREATE INDEX "meeting_talking_points_meetingId_idx" ON "meeting_talking_points"("meetingId");

-- CreateIndex
CREATE INDEX "meeting_talking_points_authorId_idx" ON "meeting_talking_points"("authorId");

-- CreateIndex
CREATE INDEX "meeting_private_notes_authorId_idx" ON "meeting_private_notes"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_private_notes_meetingId_authorId_key" ON "meeting_private_notes"("meetingId", "authorId");

-- CreateIndex
CREATE INDEX "course_sections_programId_idx" ON "course_sections"("programId");

-- CreateIndex
CREATE INDEX "course_modules_programId_displayOrder_idx" ON "course_modules"("programId", "displayOrder");

-- CreateIndex
CREATE INDEX "course_modules_sectionId_idx" ON "course_modules"("sectionId");

-- CreateIndex
CREATE INDEX "assessment_questions_moduleId_displayOrder_idx" ON "assessment_questions"("moduleId", "displayOrder");

-- CreateIndex
CREATE INDEX "course_module_progress_moduleId_idx" ON "course_module_progress"("moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "course_module_progress_enrolmentId_moduleId_key" ON "course_module_progress"("enrolmentId", "moduleId");

-- CreateIndex
CREATE INDEX "assessment_attempts_enrolmentId_moduleId_idx" ON "assessment_attempts"("enrolmentId", "moduleId");

-- CreateIndex
CREATE INDEX "assessment_attempts_moduleId_idx" ON "assessment_attempts"("moduleId");

-- CreateIndex
CREATE INDEX "opportunity_stages_tenantId_sequence_idx" ON "opportunity_stages"("tenantId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_stages_tenantId_name_key" ON "opportunity_stages"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_sources_tenantId_name_key" ON "opportunity_sources"("tenantId", "name");

-- CreateIndex
CREATE INDEX "prospects_clientId_idx" ON "prospects"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "prospects_tenantId_name_key" ON "prospects"("tenantId", "name");

-- CreateIndex
CREATE INDEX "opportunities_tenantId_status_idx" ON "opportunities"("tenantId", "status");

-- CreateIndex
CREATE INDEX "opportunities_stageId_idx" ON "opportunities"("stageId");

-- CreateIndex
CREATE INDEX "opportunities_clientId_idx" ON "opportunities"("clientId");

-- CreateIndex
CREATE INDEX "opportunities_ownerId_idx" ON "opportunities"("ownerId");

-- CreateIndex
CREATE INDEX "opportunities_prospectId_idx" ON "opportunities"("prospectId");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_tenantId_number_key" ON "opportunities"("tenantId", "number");

-- CreateIndex
CREATE INDEX "opportunity_comments_opportunityId_createdAt_idx" ON "opportunity_comments"("opportunityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_estimates_opportunityId_name_key" ON "opportunity_estimates"("opportunityId", "name");

-- CreateIndex
CREATE INDEX "estimate_lines_estimateId_idx" ON "estimate_lines"("estimateId");

-- CreateIndex
CREATE UNIQUE INDEX "project_requests_projectId_key" ON "project_requests"("projectId");

-- CreateIndex
CREATE INDEX "project_requests_tenantId_status_idx" ON "project_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "project_requests_opportunityId_idx" ON "project_requests"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_roles_tenantId_name_key" ON "billing_roles"("tenantId", "name");

-- CreateIndex
CREATE INDEX "resource_requests_tenantId_status_startDate_idx" ON "resource_requests"("tenantId", "status", "startDate");

-- CreateIndex
CREATE INDEX "resource_requests_projectId_idx" ON "resource_requests"("projectId");

-- CreateIndex
CREATE INDEX "resource_requests_opportunityId_idx" ON "resource_requests"("opportunityId");

-- CreateIndex
CREATE INDEX "resource_requests_billingRoleId_idx" ON "resource_requests"("billingRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "resource_profiles_employeeId_key" ON "resource_profiles"("employeeId");

-- CreateIndex
CREATE INDEX "resource_profiles_tenantId_idx" ON "resource_profiles"("tenantId");

-- CreateIndex
CREATE INDEX "project_charges_projectId_status_idx" ON "project_charges"("projectId", "status");

-- CreateIndex
CREATE INDEX "project_charges_invoiceId_idx" ON "project_charges"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "project_charges_tenantId_number_key" ON "project_charges"("tenantId", "number");

-- CreateIndex
CREATE INDEX "credit_notes_clientId_idx" ON "credit_notes"("clientId");

-- CreateIndex
CREATE INDEX "credit_notes_invoiceId_idx" ON "credit_notes"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_tenantId_number_key" ON "credit_notes"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "billing_entity_settings_legalEntityId_key" ON "billing_entity_settings"("legalEntityId");

-- CreateIndex
CREATE INDEX "billing_entity_settings_tenantId_idx" ON "billing_entity_settings"("tenantId");

-- CreateIndex
CREATE INDEX "psa_dashboard_layouts_tenantId_idx" ON "psa_dashboard_layouts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "psa_dashboard_layouts_userId_board_key" ON "psa_dashboard_layouts"("userId", "board");

-- CreateIndex
CREATE UNIQUE INDEX "psa_insight_cache_tenantId_board_key" ON "psa_insight_cache"("tenantId", "board");

-- CreateIndex
CREATE UNIQUE INDEX "psa_settings_tenantId_key" ON "psa_settings"("tenantId");

-- CreateIndex
CREATE INDEX "shift_requests_tenantId_status_idx" ON "shift_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "shift_requests_employeeId_fromDate_idx" ON "shift_requests"("employeeId", "fromDate");

-- CreateIndex
CREATE INDEX "overtime_requests_tenantId_status_idx" ON "overtime_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "overtime_requests_employeeId_fromDate_idx" ON "overtime_requests"("employeeId", "fromDate");

-- CreateIndex
CREATE INDEX "comp_off_requests_tenantId_status_idx" ON "comp_off_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "comp_off_requests_employeeId_fromDate_idx" ON "comp_off_requests"("employeeId", "fromDate");

-- CreateIndex
CREATE INDEX "leave_encashment_requests_tenantId_status_idx" ON "leave_encashment_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "leave_encashment_requests_employeeId_yearStart_idx" ON "leave_encashment_requests"("employeeId", "yearStart");

-- CreateIndex
CREATE INDEX "leave_encashment_requests_leaveTypeId_idx" ON "leave_encashment_requests"("leaveTypeId");

-- CreateIndex
CREATE INDEX "request_comments_tenantId_entityType_entityId_idx" ON "request_comments"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "exit_reasons_tenantId_idx" ON "exit_reasons"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "exit_reasons_tenantId_name_key" ON "exit_reasons"("tenantId", "name");

-- CreateIndex
CREATE INDEX "attrition_risk_scores_tenantId_asOf_idx" ON "attrition_risk_scores"("tenantId", "asOf");

-- CreateIndex
CREATE UNIQUE INDEX "attrition_risk_scores_employeeId_asOf_modelVersion_key" ON "attrition_risk_scores"("employeeId", "asOf", "modelVersion");

-- CreateIndex
CREATE INDEX "analytics_insights_tenantId_board_createdAt_idx" ON "analytics_insights"("tenantId", "board", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_insights_userId_createdAt_idx" ON "analytics_insights"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_insights_payloadHash_idx" ON "analytics_insights"("payloadHash");

-- CreateIndex
CREATE INDEX "analytics_comments_tenantId_board_widget_createdAt_idx" ON "analytics_comments"("tenantId", "board", "widget", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_comments_authorId_idx" ON "analytics_comments"("authorId");

-- CreateIndex
CREATE INDEX "storyboard_shares_userId_idx" ON "storyboard_shares"("userId");

-- CreateIndex
CREATE INDEX "storyboard_shares_ownerId_idx" ON "storyboard_shares"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "storyboard_shares_tenantId_board_ownerId_userId_key" ON "storyboard_shares"("tenantId", "board", "ownerId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_assignments_requestId_key" ON "asset_assignments"("requestId");

-- CreateIndex
CREATE INDEX "asset_assignments_ackStatus_idx" ON "asset_assignments"("ackStatus");

-- CreateIndex
CREATE INDEX "asset_requests_tenantId_status_createdAt_idx" ON "asset_requests"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "assets_tenantId_locationId_idx" ON "assets"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "assets_tenantId_warrantyExpiry_idx" ON "assets"("tenantId", "warrantyExpiry");

-- CreateIndex
CREATE INDEX "attendance_logs_attendanceRequestId_idx" ON "attendance_logs"("attendanceRequestId");

-- CreateIndex
CREATE INDEX "exit_records_reasonId_idx" ON "exit_records"("reasonId");

-- CreateIndex
CREATE INDEX "goals_tenantId_timeframe_idx" ON "goals"("tenantId", "timeframe");

-- CreateIndex
CREATE INDEX "helpdesk_categories_tenantId_parentId_idx" ON "helpdesk_categories"("tenantId", "parentId");

-- CreateIndex
CREATE INDEX "helpdesk_tickets_tenantId_categoryId_idx" ON "helpdesk_tickets"("tenantId", "categoryId");

-- CreateIndex
CREATE INDEX "helpdesk_tickets_tenantId_assigneeUserId_idx" ON "helpdesk_tickets"("tenantId", "assigneeUserId");

-- CreateIndex
CREATE UNIQUE INDEX "loan_categories_tenantId_code_key" ON "loan_categories"("tenantId", "code");

-- CreateIndex
CREATE INDEX "meetings_tenantId_meetingType_startsAt_idx" ON "meetings"("tenantId", "meetingType", "startsAt");

-- CreateIndex
CREATE INDEX "meetings_seriesId_idx" ON "meetings"("seriesId");

-- CreateIndex
CREATE INDEX "praises_wallPostId_idx" ON "praises"("wallPostId");

-- CreateIndex
CREATE INDEX "praises_badgeId_idx" ON "praises"("badgeId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_opportunityId_key" ON "projects"("opportunityId");

-- CreateIndex
CREATE INDEX "requisitions_tenantId_approverUserId_status_idx" ON "requisitions"("tenantId", "approverUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "requisitions_tenantId_code_key" ON "requisitions"("tenantId", "code");

-- CreateIndex
CREATE INDEX "resource_allocations_requestId_idx" ON "resource_allocations"("requestId");

-- CreateIndex
CREATE INDEX "training_programs_tenantId_format_courseState_idx" ON "training_programs"("tenantId", "format", "courseState");

-- Data fix (assets spec): asset ids that never had a foreign key may point at
-- rows that no longer exist. Null them so the new foreign keys can be added.
UPDATE "assets" SET "locationId" = NULL
WHERE "locationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "locations" l WHERE l."id" = "assets"."locationId");
UPDATE "asset_requests" SET "assetTypeId" = NULL
WHERE "assetTypeId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "asset_types" t WHERE t."id" = "asset_requests"."assetTypeId");

-- AddForeignKey
ALTER TABLE "exit_records" ADD CONSTRAINT "exit_records_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "exit_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "praises" ADD CONSTRAINT "praises_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "praise_badges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "praises" ADD CONSTRAINT "praises_wallPostId_fkey" FOREIGN KEY ("wallPostId") REFERENCES "wall_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "praises" ADD CONSTRAINT "praises_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "asset_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_requests" ADD CONSTRAINT "asset_requests_assetTypeId_fkey" FOREIGN KEY ("assetTypeId") REFERENCES "asset_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_requests" ADD CONSTRAINT "asset_requests_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "asset_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "meeting_agenda_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "rate_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_categories" ADD CONSTRAINT "helpdesk_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "helpdesk_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_categories" ADD CONSTRAINT "helpdesk_categories_businessHoursId_fkey" FOREIGN KEY ("businessHoursId") REFERENCES "helpdesk_business_hours"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_tickets" ADD CONSTRAINT "helpdesk_tickets_closingReasonId_fkey" FOREIGN KEY ("closingReasonId") REFERENCES "helpdesk_closing_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_settings" ADD CONSTRAINT "wall_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_posts" ADD CONSTRAINT "wall_posts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_posts" ADD CONSTRAINT "wall_posts_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_posts" ADD CONSTRAINT "wall_posts_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_posts" ADD CONSTRAINT "wall_posts_wishForId_fkey" FOREIGN KEY ("wishForId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_poll_options" ADD CONSTRAINT "wall_poll_options_postId_fkey" FOREIGN KEY ("postId") REFERENCES "wall_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_poll_votes" ADD CONSTRAINT "wall_poll_votes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "wall_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_poll_votes" ADD CONSTRAINT "wall_poll_votes_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "wall_poll_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_poll_votes" ADD CONSTRAINT "wall_poll_votes_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_likes" ADD CONSTRAINT "wall_likes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_likes" ADD CONSTRAINT "wall_likes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "wall_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_likes" ADD CONSTRAINT "wall_likes_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_likes" ADD CONSTRAINT "wall_likes_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_comments" ADD CONSTRAINT "wall_comments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_comments" ADD CONSTRAINT "wall_comments_postId_fkey" FOREIGN KEY ("postId") REFERENCES "wall_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_comments" ADD CONSTRAINT "wall_comments_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wall_comments" ADD CONSTRAINT "wall_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "praise_badges" ADD CONSTRAINT "praise_badges_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_questions" ADD CONSTRAINT "profile_questions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_answers" ADD CONSTRAINT "profile_answers_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "profile_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_answers" ADD CONSTRAINT "profile_answers_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_request_approvals" ADD CONSTRAINT "asset_request_approvals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_request_approvals" ADD CONSTRAINT "asset_request_approvals_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "asset_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_imports" ADD CONSTRAINT "asset_imports_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_settings" ADD CONSTRAINT "asset_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_category_agents" ADD CONSTRAINT "helpdesk_category_agents_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "helpdesk_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_business_hours" ADD CONSTRAINT "helpdesk_business_hours_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_canned_responses" ADD CONSTRAINT "helpdesk_canned_responses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_closing_reasons" ADD CONSTRAINT "helpdesk_closing_reasons_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket_followers" ADD CONSTRAINT "helpdesk_ticket_followers_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "helpdesk_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_backfills" ADD CONSTRAINT "requisition_backfills_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_backfills" ADD CONSTRAINT "requisition_backfills_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_backfills" ADD CONSTRAINT "requisition_backfills_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_question_sets" ADD CONSTRAINT "interview_question_sets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_question_sets" ADD CONSTRAINT "interview_question_sets_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_notes" ADD CONSTRAINT "candidate_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_notes" ADD CONSTRAINT "candidate_notes_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_description_templates" ADD CONSTRAINT "job_description_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hiring_settings" ADD CONSTRAINT "hiring_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_agenda_templates" ADD CONSTRAINT "meeting_agenda_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_talking_points" ADD CONSTRAINT "meeting_talking_points_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_talking_points" ADD CONSTRAINT "meeting_talking_points_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_private_notes" ADD CONSTRAINT "meeting_private_notes_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_private_notes" ADD CONSTRAINT "meeting_private_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_sections" ADD CONSTRAINT "course_sections_programId_fkey" FOREIGN KEY ("programId") REFERENCES "training_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_programId_fkey" FOREIGN KEY ("programId") REFERENCES "training_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "course_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_questions" ADD CONSTRAINT "assessment_questions_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "course_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_module_progress" ADD CONSTRAINT "course_module_progress_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "training_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_module_progress" ADD CONSTRAINT "course_module_progress_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "course_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "training_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "course_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_stages" ADD CONSTRAINT "opportunity_stages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_sources" ADD CONSTRAINT "opportunity_sources_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "prospects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "opportunity_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "opportunity_stages"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "employees"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_comments" ADD CONSTRAINT "opportunity_comments_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_estimates" ADD CONSTRAINT "opportunity_estimates_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_estimates" ADD CONSTRAINT "opportunity_estimates_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "rate_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "opportunity_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_billingRoleId_fkey" FOREIGN KEY ("billingRoleId") REFERENCES "billing_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "prospects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_roles" ADD CONSTRAINT "billing_roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_requests" ADD CONSTRAINT "resource_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_requests" ADD CONSTRAINT "resource_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_requests" ADD CONSTRAINT "resource_requests_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_requests" ADD CONSTRAINT "resource_requests_billingRoleId_fkey" FOREIGN KEY ("billingRoleId") REFERENCES "billing_roles"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_profiles" ADD CONSTRAINT "resource_profiles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_profiles" ADD CONSTRAINT "resource_profiles_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_charges" ADD CONSTRAINT "project_charges_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_charges" ADD CONSTRAINT "project_charges_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_charges" ADD CONSTRAINT "project_charges_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_entity_settings" ADD CONSTRAINT "billing_entity_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_dashboard_layouts" ADD CONSTRAINT "psa_dashboard_layouts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_insight_cache" ADD CONSTRAINT "psa_insight_cache_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_settings" ADD CONSTRAINT "psa_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_requests" ADD CONSTRAINT "shift_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_requests" ADD CONSTRAINT "shift_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_requests" ADD CONSTRAINT "shift_requests_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_off_requests" ADD CONSTRAINT "comp_off_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_off_requests" ADD CONSTRAINT "comp_off_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_encashment_requests" ADD CONSTRAINT "leave_encashment_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_encashment_requests" ADD CONSTRAINT "leave_encashment_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_encashment_requests" ADD CONSTRAINT "leave_encashment_requests_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_comments" ADD CONSTRAINT "request_comments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exit_reasons" ADD CONSTRAINT "exit_reasons_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attrition_risk_scores" ADD CONSTRAINT "attrition_risk_scores_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attrition_risk_scores" ADD CONSTRAINT "attrition_risk_scores_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_insights" ADD CONSTRAINT "analytics_insights_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_insights" ADD CONSTRAINT "analytics_insights_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_comments" ADD CONSTRAINT "analytics_comments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_comments" ADD CONSTRAINT "analytics_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_shares" ADD CONSTRAINT "storyboard_shares_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_shares" ADD CONSTRAINT "storyboard_shares_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_shares" ADD CONSTRAINT "storyboard_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Deferrable foreign keys. The psa spec asks for Restrict on these three; they
-- are NO ACTION and checked at commit instead, so deleting a stage, owner or
-- billing role that is still in use is refused, while deleting a tenant (which
-- removes both sides in one transaction, in no guaranteed order) succeeds.
-- ---------------------------------------------------------------------------
ALTER TABLE "opportunities" ALTER CONSTRAINT "opportunities_stageId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "opportunities" ALTER CONSTRAINT "opportunities_ownerId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "resource_requests" ALTER CONSTRAINT "resource_requests_billingRoleId_fkey" DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Backfills of new columns (existing columns are never rewritten).
-- ---------------------------------------------------------------------------

-- assets: ackStatus snapshots AssetType.requireAck; existing acknowledgements stand.
UPDATE "asset_assignments" a SET "ackStatus" = 'NOT_APPLICABLE'
FROM "assets" s JOIN "asset_types" t ON t."id" = s."assetTypeId"
WHERE s."id" = a."assetId" AND t."requireAck" = false;
UPDATE "asset_assignments" SET "ackStatus" = 'ACKNOWLEDGED' WHERE "acknowledgedAt" IS NOT NULL;

-- hire: newPositions = positions for NEW_HIRE requisitions.
UPDATE "requisitions" SET "newPositions" = "positions" WHERE "type" = 'NEW_HIRE';

-- hire: one RequisitionBackfill (reason OTHERS) per legacy replacingEmployeeId.
INSERT INTO "requisition_backfills" ("id", "tenantId", "requisitionId", "employeeId", "reason")
SELECT 'c' || substr(md5(random()::text || r."id"), 1, 24), r."tenantId", r."id", r."replacingEmployeeId", 'OTHERS'
FROM "requisitions" r
WHERE r."replacingEmployeeId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- hire: codes REQ-0001… per tenant, in creation order.
UPDATE "requisitions" r SET "code" = 'REQ-' || lpad(n.rn::text, 4, '0')
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "tenantId" ORDER BY "createdAt", "id") AS rn
  FROM "requisitions"
) n
WHERE n."id" = r."id" AND r."code" IS NULL;
