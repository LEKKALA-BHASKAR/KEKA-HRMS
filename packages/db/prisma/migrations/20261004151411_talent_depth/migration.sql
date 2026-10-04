-- AlterEnum
ALTER TYPE "CustomFieldEntity" ADD VALUE 'CANDIDATE';

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "education" TEXT;

-- AlterTable
ALTER TABLE "feedback" ADD COLUMN     "isAnonymous" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "goals" ADD COLUMN     "teamGoalId" TEXT,
ADD COLUMN     "templateId" TEXT;

-- CreateTable
CREATE TABLE "goal_timeframes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOM',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_timeframes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "metricType" TEXT NOT NULL DEFAULT 'PERCENTAGE',
    "metricName" TEXT,
    "startValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "targetValue" DECIMAL(18,2) NOT NULL DEFAULT 100,
    "tags" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goal_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_form_sections" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "review_form_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_form_questions" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'RATING',
    "prompt" TEXT NOT NULL,
    "competency" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "appliesTo" JSONB,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "review_form_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_cycle_stages" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "selfStartsAt" TIMESTAMP(3),
    "selfEndsAt" TIMESTAMP(3),
    "managerStartsAt" TIMESTAMP(3),
    "managerEndsAt" TIMESTAMP(3),
    "calibrationStartsAt" TIMESTAMP(3),
    "calibrationEndsAt" TIMESTAMP(3),
    "publishOn" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_cycle_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_cycle_participants" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "managerId" TEXT,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_cycle_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "askedId" TEXT NOT NULL,
    "aboutEmployeeId" TEXT NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "feedbackId" TEXT,
    "dueDate" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "allowAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "whoCanGive" TEXT NOT NULL DEFAULT 'EVERYONE',
    "allowRequests" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedback_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_recommendations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "recommendedById" TEXT NOT NULL,
    "incrementPercent" DECIMAL(9,2) NOT NULL,
    "recommendPromotion" BOOLEAN NOT NULL DEFAULT false,
    "proposedJobTitle" TEXT,
    "justification" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "minTenureMonths" INTEGER NOT NULL DEFAULT 12,
    "minMonthsSinceLastPromotion" INTEGER NOT NULL DEFAULT 12,
    "minRating" DECIMAL(9,2) NOT NULL DEFAULT 4,
    "excludeOnPip" BOOLEAN NOT NULL DEFAULT true,
    "maxIncrementPercent" DECIMAL(9,2) NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotion_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "growth_plan_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "items" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "growth_plan_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "growth_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "templateId" TEXT,
    "title" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "growth_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "growth_plan_items" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MILESTONE',
    "dueDate" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "growth_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_pools" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talent_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_pool_members" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "note" TEXT,
    "addedBy" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talent_pool_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_applications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_score_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "skillsWeight" INTEGER NOT NULL DEFAULT 50,
    "experienceWeight" INTEGER NOT NULL DEFAULT 30,
    "educationWeight" INTEGER NOT NULL DEFAULT 20,
    "skillKeywords" JSONB,
    "educationKeywords" JSONB,
    "idealExperienceYears" DECIMAL(9,1) NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_score_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kit" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scorecard_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_slot_offers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'VIDEO',
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "meetingUrl" TEXT,
    "panelIds" JSONB NOT NULL,
    "slots" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "chosenSlot" TIMESTAMP(3),
    "interviewId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_slot_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hire_approval_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT,
    "minAmount" DECIMAL(18,2),
    "approverUserIds" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hire_approval_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hire_approval_steps" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "ruleId" TEXT,
    "sequence" INTEGER NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hire_approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_eeo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "gender" TEXT,
    "ethnicity" TEXT,
    "veteranStatus" TEXT,
    "disabilityStatus" TEXT,
    "declined" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_eeo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_site_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "headline" TEXT,
    "about" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#1266a8',
    "accentColor" TEXT NOT NULL DEFAULT '#0f8a55',
    "logoFileId" TEXT,
    "bannerFileId" TEXT,
    "embedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "collectEeo" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "career_site_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goal_timeframes_tenantId_isActive_idx" ON "goal_timeframes"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "goal_timeframes_tenantId_name_key" ON "goal_timeframes"("tenantId", "name");

-- CreateIndex
CREATE INDEX "goal_templates_tenantId_isActive_idx" ON "goal_templates"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "goal_templates_tenantId_title_key" ON "goal_templates"("tenantId", "title");

-- CreateIndex
CREATE INDEX "review_form_sections_cycleId_displayOrder_idx" ON "review_form_sections"("cycleId", "displayOrder");

-- CreateIndex
CREATE INDEX "review_form_questions_sectionId_displayOrder_idx" ON "review_form_questions"("sectionId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "review_cycle_stages_cycleId_key" ON "review_cycle_stages"("cycleId");

-- CreateIndex
CREATE INDEX "review_cycle_participants_employeeId_idx" ON "review_cycle_participants"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "review_cycle_participants_cycleId_employeeId_key" ON "review_cycle_participants"("cycleId", "employeeId");

-- CreateIndex
CREATE INDEX "feedback_requests_tenantId_status_idx" ON "feedback_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "feedback_requests_askedId_status_idx" ON "feedback_requests"("askedId", "status");

-- CreateIndex
CREATE INDEX "feedback_requests_requesterId_idx" ON "feedback_requests"("requesterId");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_settings_tenantId_key" ON "feedback_settings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "salary_recommendations_reviewId_key" ON "salary_recommendations"("reviewId");

-- CreateIndex
CREATE INDEX "salary_recommendations_tenantId_status_idx" ON "salary_recommendations"("tenantId", "status");

-- CreateIndex
CREATE INDEX "salary_recommendations_cycleId_idx" ON "salary_recommendations"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_policies_tenantId_key" ON "promotion_policies"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "growth_plan_templates_tenantId_name_key" ON "growth_plan_templates"("tenantId", "name");

-- CreateIndex
CREATE INDEX "growth_plans_tenantId_status_idx" ON "growth_plans"("tenantId", "status");

-- CreateIndex
CREATE INDEX "growth_plans_employeeId_idx" ON "growth_plans"("employeeId");

-- CreateIndex
CREATE INDEX "growth_plan_items_planId_idx" ON "growth_plan_items"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "talent_pools_tenantId_name_key" ON "talent_pools"("tenantId", "name");

-- CreateIndex
CREATE INDEX "talent_pool_members_candidateId_idx" ON "talent_pool_members"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "talent_pool_members_poolId_candidateId_key" ON "talent_pool_members"("poolId", "candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "internal_applications_applicationId_key" ON "internal_applications"("applicationId");

-- CreateIndex
CREATE INDEX "internal_applications_tenantId_idx" ON "internal_applications"("tenantId");

-- CreateIndex
CREATE INDEX "internal_applications_employeeId_idx" ON "internal_applications"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_score_configs_tenantId_key" ON "candidate_score_configs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "scorecard_templates_tenantId_name_key" ON "scorecard_templates"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "interview_slot_offers_tokenHash_key" ON "interview_slot_offers"("tokenHash");

-- CreateIndex
CREATE INDEX "interview_slot_offers_tenantId_status_idx" ON "interview_slot_offers"("tenantId", "status");

-- CreateIndex
CREATE INDEX "interview_slot_offers_applicationId_idx" ON "interview_slot_offers"("applicationId");

-- CreateIndex
CREATE INDEX "hire_approval_rules_tenantId_kind_isActive_idx" ON "hire_approval_rules"("tenantId", "kind", "isActive");

-- CreateIndex
CREATE INDEX "hire_approval_steps_tenantId_kind_entityId_idx" ON "hire_approval_steps"("tenantId", "kind", "entityId");

-- CreateIndex
CREATE INDEX "hire_approval_steps_tenantId_approverUserId_status_idx" ON "hire_approval_steps"("tenantId", "approverUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_eeo_candidateId_key" ON "candidate_eeo"("candidateId");

-- CreateIndex
CREATE INDEX "candidate_eeo_tenantId_idx" ON "candidate_eeo"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "career_site_settings_tenantId_key" ON "career_site_settings"("tenantId");

-- AddForeignKey
ALTER TABLE "goal_timeframes" ADD CONSTRAINT "goal_timeframes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_templates" ADD CONSTRAINT "goal_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_form_sections" ADD CONSTRAINT "review_form_sections_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_form_questions" ADD CONSTRAINT "review_form_questions_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "review_form_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_cycle_stages" ADD CONSTRAINT "review_cycle_stages_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_cycle_participants" ADD CONSTRAINT "review_cycle_participants_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_cycle_participants" ADD CONSTRAINT "review_cycle_participants_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_askedId_fkey" FOREIGN KEY ("askedId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_settings" ADD CONSTRAINT "feedback_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_recommendations" ADD CONSTRAINT "salary_recommendations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_recommendations" ADD CONSTRAINT "salary_recommendations_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_recommendations" ADD CONSTRAINT "salary_recommendations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_policies" ADD CONSTRAINT "promotion_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "growth_plan_templates" ADD CONSTRAINT "growth_plan_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "growth_plans" ADD CONSTRAINT "growth_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "growth_plans" ADD CONSTRAINT "growth_plans_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "growth_plan_items" ADD CONSTRAINT "growth_plan_items_planId_fkey" FOREIGN KEY ("planId") REFERENCES "growth_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_pools" ADD CONSTRAINT "talent_pools_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_pool_members" ADD CONSTRAINT "talent_pool_members_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "talent_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_pool_members" ADD CONSTRAINT "talent_pool_members_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_applications" ADD CONSTRAINT "internal_applications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_applications" ADD CONSTRAINT "internal_applications_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_applications" ADD CONSTRAINT "internal_applications_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_score_configs" ADD CONSTRAINT "candidate_score_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_templates" ADD CONSTRAINT "scorecard_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "interview_slot_offers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "interview_slot_offers_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hire_approval_rules" ADD CONSTRAINT "hire_approval_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hire_approval_steps" ADD CONSTRAINT "hire_approval_steps_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_eeo" ADD CONSTRAINT "candidate_eeo_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_eeo" ADD CONSTRAINT "candidate_eeo_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_site_settings" ADD CONSTRAINT "career_site_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
