-- CreateEnum
CREATE TYPE "GrowthStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "CourseStatus" ADD VALUE 'IN_REVIEW';

-- AlterTable
ALTER TABLE "career_aspirations" ADD COLUMN     "endorsedAt" TIMESTAMP(3),
ADD COLUMN     "endorsedBy" TEXT,
ADD COLUMN     "managerNote" TEXT,
ADD COLUMN     "openToRelocate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "targetDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "career_paths" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedBy" TEXT,
ADD COLUMN     "decisionNote" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "submittedBy" TEXT;

-- AlterTable
ALTER TABLE "course_lessons" ADD COLUMN     "maxAttempts" INTEGER;

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "certificateValidityMonths" INTEGER,
ADD COLUMN     "credits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "prerequisiteCourseId" TEXT,
ADD COLUMN     "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "submittedBy" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "improvement_plans" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "employeeResponse" TEXT,
ADD COLUMN     "proposedAt" TIMESTAMP(3),
ADD COLUMN     "proposedBy" TEXT,
ADD COLUMN     "proposedNote" TEXT,
ADD COLUMN     "proposedOutcome" TEXT;

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "internalClosesAt" TIMESTAMP(3),
ADD COLUMN     "internalMinTenureMonths" INTEGER;

-- AlterTable
ALTER TABLE "skills" ADD COLUMN     "isCritical" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "proposedBy" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "validityMonths" INTEGER;

-- CreateTable
CREATE TABLE "learning_paths" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "jobTitle" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "dueInDays" INTEGER,
    "status" "GrowthStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_paths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_path_courses" (
    "id" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "learning_path_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_path_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "assignedBy" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "learning_path_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "lessonId" TEXT,
    "employeeId" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "courseId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'CLASSROOM',
    "venue" TEXT,
    "meetingUrl" TEXT,
    "instructorName" TEXT,
    "instructorId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_registrations" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "attendance" TEXT,
    "note" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "session_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_certificates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "learning_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_reviews" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "departmentId" TEXT,
    "meetingAt" TIMESTAMP(3),
    "agenda" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "talent_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_review_entries" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "performance" INTEGER,
    "potential" INTEGER,
    "box" INTEGER,
    "flightRisk" TEXT,
    "retentionAction" TEXT,
    "notes" TEXT,
    "ratedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "talent_review_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_box_labels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "box" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "talent_box_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readiness_levels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "minMonths" INTEGER NOT NULL DEFAULT 0,
    "maxMonths" INTEGER,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "readiness_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "succession_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "positionTitle" TEXT NOT NULL,
    "departmentId" TEXT,
    "incumbentId" TEXT,
    "criticality" TEXT NOT NULL DEFAULT 'HIGH',
    "riskOfLoss" TEXT NOT NULL DEFAULT 'MEDIUM',
    "vacancyImpact" TEXT,
    "notes" TEXT,
    "status" "GrowthStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "succession_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "successors" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "readinessId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 1,
    "isEmergency" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'NOMINATED',
    "notes" TEXT,
    "pendingReadinessId" TEXT,
    "pendingReason" TEXT,
    "pendingBy" TEXT,
    "nominatedBy" TEXT,
    "nominatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "developmentPlanId" TEXT,

    CONSTRAINT "successors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobility_applications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "coverNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "managerId" TEXT,
    "managerNote" TEXT,
    "managerDecidedAt" TIMESTAMP(3),
    "hrDecidedBy" TEXT,
    "hrDecidedAt" TIMESTAMP(3),
    "hrNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobility_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobility_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TRANSFER',
    "toDepartmentId" TEXT,
    "toLocationId" TEXT,
    "toJobTitleId" TEXT,
    "preferredDate" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_MANAGER',
    "managerId" TEXT,
    "managerNote" TEXT,
    "managerDecidedAt" TIMESTAMP(3),
    "hrDecidedBy" TEXT,
    "hrDecidedAt" TIMESTAMP(3),
    "hrNote" TEXT,
    "jobChangeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobility_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "development_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "careerStepId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "managerId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "development_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "development_actions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "planId" TEXT,
    "pipId" TEXT,
    "coachingPlanId" TEXT,
    "skillId" TEXT,
    "courseId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'OTHER',
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "evidence" TEXT,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifierNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "development_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coaching_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "focusArea" TEXT NOT NULL,
    "goals" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "employeeResponse" TEXT,
    "respondedAt" TIMESTAMP(3),
    "effectivenessScore" INTEGER,
    "closingNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coaching_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coaching_session_logs" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "heldOn" TIMESTAMP(3) NOT NULL,
    "notes" TEXT NOT NULL,
    "progress" TEXT NOT NULL DEFAULT 'STEADY',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coaching_session_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pip_milestones" (
    "id" TEXT NOT NULL,
    "pipId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pip_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pip_check_ins" (
    "id" TEXT NOT NULL,
    "pipId" TEXT NOT NULL,
    "heldOn" TIMESTAMP(3) NOT NULL,
    "progress" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "employeeComment" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pip_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency_frameworks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "jobTitle" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "previousId" TEXT,
    "status" "GrowthStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competency_frameworks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency_items" (
    "id" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "requiredLevel" INTEGER NOT NULL DEFAULT 1,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "isCritical" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "competency_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proficiency_scales" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "levels" TEXT[],
    "descriptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "GrowthStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proficiency_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_assessment_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "evidence" TEXT,
    "assessedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_assessment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'ADHOC',
    "questions" TEXT[],
    "status" "GrowthStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedback_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learning_paths_tenantId_status_idx" ON "learning_paths"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "learning_paths_tenantId_name_key" ON "learning_paths"("tenantId", "name");

-- CreateIndex
CREATE INDEX "learning_path_courses_courseId_idx" ON "learning_path_courses"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "learning_path_courses_pathId_courseId_key" ON "learning_path_courses"("pathId", "courseId");

-- CreateIndex
CREATE INDEX "learning_path_assignments_tenantId_status_idx" ON "learning_path_assignments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "learning_path_assignments_employeeId_idx" ON "learning_path_assignments"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "learning_path_assignments_pathId_employeeId_key" ON "learning_path_assignments"("pathId", "employeeId");

-- CreateIndex
CREATE INDEX "learning_requests_tenantId_status_idx" ON "learning_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "learning_requests_employeeId_status_idx" ON "learning_requests"("employeeId", "status");

-- CreateIndex
CREATE INDEX "training_sessions_tenantId_startsAt_idx" ON "training_sessions"("tenantId", "startsAt");

-- CreateIndex
CREATE INDEX "session_registrations_employeeId_idx" ON "session_registrations"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "session_registrations_sessionId_employeeId_key" ON "session_registrations"("sessionId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "learning_certificates_enrolmentId_key" ON "learning_certificates"("enrolmentId");

-- CreateIndex
CREATE INDEX "learning_certificates_employeeId_idx" ON "learning_certificates"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "learning_certificates_tenantId_number_key" ON "learning_certificates"("tenantId", "number");

-- CreateIndex
CREATE INDEX "talent_reviews_tenantId_status_idx" ON "talent_reviews"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "talent_reviews_tenantId_name_key" ON "talent_reviews"("tenantId", "name");

-- CreateIndex
CREATE INDEX "talent_review_entries_employeeId_idx" ON "talent_review_entries"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "talent_review_entries_reviewId_employeeId_key" ON "talent_review_entries"("reviewId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "talent_box_labels_tenantId_box_key" ON "talent_box_labels"("tenantId", "box");

-- CreateIndex
CREATE UNIQUE INDEX "readiness_levels_tenantId_code_key" ON "readiness_levels"("tenantId", "code");

-- CreateIndex
CREATE INDEX "succession_plans_tenantId_status_idx" ON "succession_plans"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "succession_plans_tenantId_positionTitle_key" ON "succession_plans"("tenantId", "positionTitle");

-- CreateIndex
CREATE INDEX "successors_employeeId_idx" ON "successors"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "successors_planId_employeeId_key" ON "successors"("planId", "employeeId");

-- CreateIndex
CREATE INDEX "mobility_applications_tenantId_status_idx" ON "mobility_applications"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mobility_applications_jobId_employeeId_key" ON "mobility_applications"("jobId", "employeeId");

-- CreateIndex
CREATE INDEX "mobility_requests_tenantId_status_idx" ON "mobility_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "mobility_requests_employeeId_idx" ON "mobility_requests"("employeeId");

-- CreateIndex
CREATE INDEX "development_plans_tenantId_status_idx" ON "development_plans"("tenantId", "status");

-- CreateIndex
CREATE INDEX "development_plans_employeeId_idx" ON "development_plans"("employeeId");

-- CreateIndex
CREATE INDEX "development_actions_tenantId_status_idx" ON "development_actions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "development_actions_employeeId_idx" ON "development_actions"("employeeId");

-- CreateIndex
CREATE INDEX "coaching_plans_tenantId_status_idx" ON "coaching_plans"("tenantId", "status");

-- CreateIndex
CREATE INDEX "coaching_plans_employeeId_idx" ON "coaching_plans"("employeeId");

-- CreateIndex
CREATE INDEX "coaching_plans_coachId_idx" ON "coaching_plans"("coachId");

-- CreateIndex
CREATE INDEX "coaching_session_logs_planId_idx" ON "coaching_session_logs"("planId");

-- CreateIndex
CREATE INDEX "pip_milestones_pipId_idx" ON "pip_milestones"("pipId");

-- CreateIndex
CREATE INDEX "pip_check_ins_pipId_idx" ON "pip_check_ins"("pipId");

-- CreateIndex
CREATE INDEX "competency_frameworks_tenantId_status_idx" ON "competency_frameworks"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "competency_frameworks_tenantId_name_version_key" ON "competency_frameworks"("tenantId", "name", "version");

-- CreateIndex
CREATE INDEX "competency_items_skillId_idx" ON "competency_items"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "competency_items_frameworkId_skillId_key" ON "competency_items"("frameworkId", "skillId");

-- CreateIndex
CREATE UNIQUE INDEX "proficiency_scales_tenantId_name_key" ON "proficiency_scales"("tenantId", "name");

-- CreateIndex
CREATE INDEX "skill_assessment_logs_tenantId_createdAt_idx" ON "skill_assessment_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "skill_assessment_logs_employeeId_skillId_idx" ON "skill_assessment_logs"("employeeId", "skillId");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_templates_tenantId_name_key" ON "feedback_templates"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "learning_paths" ADD CONSTRAINT "learning_paths_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_path_courses" ADD CONSTRAINT "learning_path_courses_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "learning_paths"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_path_courses" ADD CONSTRAINT "learning_path_courses_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_path_assignments" ADD CONSTRAINT "learning_path_assignments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_path_assignments" ADD CONSTRAINT "learning_path_assignments_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "learning_paths"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_path_assignments" ADD CONSTRAINT "learning_path_assignments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_requests" ADD CONSTRAINT "learning_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_requests" ADD CONSTRAINT "learning_requests_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_requests" ADD CONSTRAINT "learning_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_registrations" ADD CONSTRAINT "session_registrations_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "training_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_registrations" ADD CONSTRAINT "session_registrations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_certificates" ADD CONSTRAINT "learning_certificates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_certificates" ADD CONSTRAINT "learning_certificates_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_certificates" ADD CONSTRAINT "learning_certificates_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_reviews" ADD CONSTRAINT "talent_reviews_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_review_entries" ADD CONSTRAINT "talent_review_entries_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "talent_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_review_entries" ADD CONSTRAINT "talent_review_entries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_box_labels" ADD CONSTRAINT "talent_box_labels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readiness_levels" ADD CONSTRAINT "readiness_levels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "succession_plans" ADD CONSTRAINT "succession_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "succession_plans" ADD CONSTRAINT "succession_plans_incumbentId_fkey" FOREIGN KEY ("incumbentId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "successors" ADD CONSTRAINT "successors_planId_fkey" FOREIGN KEY ("planId") REFERENCES "succession_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "successors" ADD CONSTRAINT "successors_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "successors" ADD CONSTRAINT "successors_readinessId_fkey" FOREIGN KEY ("readinessId") REFERENCES "readiness_levels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobility_applications" ADD CONSTRAINT "mobility_applications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobility_applications" ADD CONSTRAINT "mobility_applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobility_applications" ADD CONSTRAINT "mobility_applications_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobility_requests" ADD CONSTRAINT "mobility_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobility_requests" ADD CONSTRAINT "mobility_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "development_actions" ADD CONSTRAINT "development_actions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "development_actions" ADD CONSTRAINT "development_actions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "development_actions" ADD CONSTRAINT "development_actions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "development_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "development_actions" ADD CONSTRAINT "development_actions_pipId_fkey" FOREIGN KEY ("pipId") REFERENCES "improvement_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "development_actions" ADD CONSTRAINT "development_actions_coachingPlanId_fkey" FOREIGN KEY ("coachingPlanId") REFERENCES "coaching_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coaching_plans" ADD CONSTRAINT "coaching_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coaching_plans" ADD CONSTRAINT "coaching_plans_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coaching_plans" ADD CONSTRAINT "coaching_plans_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coaching_session_logs" ADD CONSTRAINT "coaching_session_logs_planId_fkey" FOREIGN KEY ("planId") REFERENCES "coaching_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pip_milestones" ADD CONSTRAINT "pip_milestones_pipId_fkey" FOREIGN KEY ("pipId") REFERENCES "improvement_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pip_check_ins" ADD CONSTRAINT "pip_check_ins_pipId_fkey" FOREIGN KEY ("pipId") REFERENCES "improvement_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_frameworks" ADD CONSTRAINT "competency_frameworks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_items" ADD CONSTRAINT "competency_items_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "competency_frameworks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_items" ADD CONSTRAINT "competency_items_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proficiency_scales" ADD CONSTRAINT "proficiency_scales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_assessment_logs" ADD CONSTRAINT "skill_assessment_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_assessment_logs" ADD CONSTRAINT "skill_assessment_logs_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_assessment_logs" ADD CONSTRAINT "skill_assessment_logs_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_templates" ADD CONSTRAINT "feedback_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- New permissions on the system roles that hold them (fresh tenants get them from the seed).
INSERT INTO "role_permissions" ("id", "roleId", "permission")
SELECT 'c' || substr(md5(random()::text || r."id" || p.perm), 1, 24), r."id", p.perm
FROM "roles" r
CROSS JOIN (VALUES ('performance.succession.manage'), ('performance.mobility.manage')) AS p(perm)
WHERE r."isSystem" = true AND r."key" IN ('GLOBAL_ADMIN', 'HR_MANAGER', 'PERFORMANCE_ADMIN')
ON CONFLICT DO NOTHING;
