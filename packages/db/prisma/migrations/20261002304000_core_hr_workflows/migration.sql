-- CreateEnum
CREATE TYPE "JobChangeStatus" AS ENUM ('PENDING_APPROVAL', 'SCHEDULED', 'APPLIED', 'REJECTED', 'WITHDRAWN');

-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'JOB_CHANGE';

-- AlterEnum
ALTER TYPE "SurveyKind" ADD VALUE 'EXIT';

-- AlterTable
ALTER TABLE "exit_records" ADD COLUMN     "exitSurveyId" TEXT;

-- AlterTable
ALTER TABLE "survey_responses" ADD COLUMN     "exitRecordId" TEXT;

-- AlterTable
ALTER TABLE "scheduled_reports" ADD COLUMN     "lastStatus" TEXT;

-- CreateTable
CREATE TABLE "job_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "reason" "JobChangeReason" NOT NULL,
    "jobTitleId" TEXT,
    "departmentId" TEXT,
    "businessUnitId" TEXT,
    "locationId" TEXT,
    "legalEntityId" TEXT,
    "bandId" TEXT,
    "payGradeId" TEXT,
    "workerTypeId" TEXT,
    "reportingManagerId" TEXT,
    "note" TEXT,
    "logActivity" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" "JobChangeStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approvalRequestId" TEXT,
    "jobRecordId" TEXT,
    "requestedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_changes_tenantId_status_idx" ON "job_changes"("tenantId", "status");

-- CreateIndex
CREATE INDEX "job_changes_employeeId_status_idx" ON "job_changes"("employeeId", "status");

-- CreateIndex
CREATE INDEX "job_changes_status_effectiveFrom_idx" ON "job_changes"("status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_tenantId_event_key" ON "notification_settings"("tenantId", "event");

-- CreateIndex
CREATE INDEX "survey_responses_exitRecordId_idx" ON "survey_responses"("exitRecordId");

