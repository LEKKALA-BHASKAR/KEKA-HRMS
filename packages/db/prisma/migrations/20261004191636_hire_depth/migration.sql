-- AlterTable
ALTER TABLE "hiring_stages" ADD COLUMN     "entryMinScore" DECIMAL(9,2),
ADD COLUMN     "entryRequiresApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "entryRequiresResume" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "talent_pool_members" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "talent_pools" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "memberExpiryDays" INTEGER,
ADD COLUMN     "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rules" JSONB;

-- CreateTable
CREATE TABLE "hire_depth_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "screenSlaHours" INTEGER NOT NULL DEFAULT 72,
    "feedbackSlaHours" INTEGER NOT NULL DEFAULT 24,
    "offerResponseSlaHours" INTEGER NOT NULL DEFAULT 120,
    "requisitionApprovalSlaHours" INTEGER NOT NULL DEFAULT 48,
    "requisitionMaxAgeDays" INTEGER NOT NULL DEFAULT 60,
    "requirePostingApproval" BOOLEAN NOT NULL DEFAULT false,
    "intakeQuestions" JSONB,
    "offerChecklist" JSONB,
    "biasTerms" JSONB,
    "noShowLimit" INTEGER NOT NULL DEFAULT 2,
    "consentValidityDays" INTEGER NOT NULL DEFAULT 365,
    "reactivationAfterDays" INTEGER NOT NULL DEFAULT 90,
    "alertsLastRunAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hire_depth_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruiter_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "queue" TEXT NOT NULL DEFAULT 'OTHER',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assigneeUserId" TEXT,
    "createdBy" TEXT,
    "dueAt" TIMESTAMP(3),
    "requiresSignOff" BOOLEAN NOT NULL DEFAULT false,
    "applicationId" TEXT,
    "candidateId" TEXT,
    "campaignId" TEXT,
    "sourceKey" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruiter_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hire_alerts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "notified" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hire_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisition_intakes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "submittedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requisition_intakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sourcing_channels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseSource" "CandidateSource" NOT NULL,
    "description" TEXT,
    "monthlyCost" DECIMAL(18,2),
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sourcing_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sourcing_campaigns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "jobId" TEXT,
    "channelId" TEXT,
    "budget" DECIMAL(18,2),
    "startsOn" TIMESTAMP(3),
    "endsOn" TIMESTAMP(3),
    "targetApplicants" INTEGER,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "ownerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sourcing_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sourcing_projects" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "jobId" TEXT,
    "ownerUserId" TEXT,
    "memberUserIds" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sourcing_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sourcing_project_candidates" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'IDENTIFIED',
    "note" TEXT,
    "addedBy" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sourcing_project_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_sourcing_searches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "filters" JSONB,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_sourcing_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_sourcing_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "channelId" TEXT,
    "campaignId" TEXT,
    "agencyId" TEXT,
    "utmSource" TEXT,
    "utmCampaign" TEXT,
    "engagementStatus" TEXT NOT NULL DEFAULT 'NEW',
    "isPassive" BOOLEAN NOT NULL DEFAULT false,
    "isHighPotential" BOOLEAN NOT NULL DEFAULT false,
    "tags" JSONB,
    "consentStatus" TEXT NOT NULL DEFAULT 'NONE',
    "consentSource" TEXT,
    "consentAt" TIMESTAMP(3),
    "consentExpiresAt" TIMESTAMP(3),
    "lastContactedAt" TIMESTAMP(3),
    "timeZone" TEXT,
    "linkedProfile" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_sourcing_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_tag_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_tag_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_attribution_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "matchField" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "source" "CandidateSource" NOT NULL,
    "channelId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_attribution_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_agencies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT,
    "feePercent" DECIMAL(5,2),
    "ownerUserId" TEXT,
    "entryStage" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recruitment_agencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_cadences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_cadences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cadence_enrollments" (
    "id" TEXT NOT NULL,
    "cadenceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "enrolledBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "cadence_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_communications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "applicationId" TEXT,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'OUTBOUND',
    "subject" TEXT,
    "body" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byUserId" TEXT,

    CONSTRAINT "candidate_communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "uploadedBy" TEXT,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_merge_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "survivorId" TEXT NOT NULL,
    "mergedCandidateId" TEXT NOT NULL,
    "mergedName" TEXT NOT NULL,
    "mergedEmail" TEXT NOT NULL,
    "moved" JSONB NOT NULL,
    "requestedBy" TEXT,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_merge_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disposition_reasons" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'REJECT',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disposition_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_dispositions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "reasonId" TEXT,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "note" TEXT,
    "byWhom" TEXT NOT NULL DEFAULT 'RECRUITER',
    "byUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_dispositions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "referrerEmployeeId" TEXT NOT NULL,
    "relationship" TEXT,
    "recommendation" TEXT,
    "bonusAmount" DECIMAL(18,2),
    "bonusStatus" TEXT NOT NULL DEFAULT 'NONE',
    "bonusRequestedAt" TIMESTAMP(3),
    "bonusDecidedAt" TIMESTAMP(3),
    "bonusPaidAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_contents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "slug" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "locationId" TEXT,
    "audience" TEXT,
    "personName" TEXT,
    "personTitle" TEXT,
    "contactEmail" TEXT,
    "imageFileId" TEXT,
    "imageAlt" TEXT,
    "campaignCode" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "career_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_content_versions" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "career_content_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_site_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "analyticsTagId" TEXT,
    "locales" JSONB,
    "highContrast" BOOLEAN NOT NULL DEFAULT false,
    "largeText" BOOLEAN NOT NULL DEFAULT false,
    "reduceMotion" BOOLEAN NOT NULL DEFAULT false,
    "requireAltText" BOOLEAN NOT NULL DEFAULT true,
    "groupByLocation" BOOLEAN NOT NULL DEFAULT false,
    "showRecruiterContacts" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "career_site_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_site_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "career_site_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_posting_metas" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "translations" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_posting_metas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_alert_subscriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "keywords" TEXT,
    "departmentId" TEXT,
    "locationId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_alert_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_alert_sents" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_alert_sents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_site_visits" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "jobId" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "campaignCode" TEXT,
    "referrerHost" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "career_site_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applicant_portal_links" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applicant_portal_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applicant_change_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applicant_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rounds" JSONB NOT NULL,
    "panelRules" JSONB,
    "skillWeights" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "fromAt" TIMESTAMP(3),
    "toAt" TIMESTAMP(3),
    "employeeId" TEXT,
    "byUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_consents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "recordedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviewer_capacities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "maxPerWeek" INTEGER NOT NULL DEFAULT 5,
    "maxPerDay" INTEGER NOT NULL DEFAULT 2,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interviewer_capacities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_guides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "roleKeyword" TEXT,
    "departmentId" TEXT,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_guides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_bank_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "competency" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL DEFAULT 'MEDIUM',
    "guidance" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_bank_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_versions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "annualCtc" DECIMAL(18,2) NOT NULL,
    "joiningBonus" DECIMAL(18,2),
    "proposedJoiningDate" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "breakup" JSONB,
    "event" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL,
    "contentHash" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_negotiations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "requestedCtc" DECIMAL(18,2),
    "requestedJoiningDate" TIMESTAMP(3),
    "competitorName" TEXT,
    "competitorCtc" DECIMAL(18,2),
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "createdBy" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_negotiations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_clauses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'GENERAL',
    "body" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "minCtc" DECIMAL(18,2),
    "departmentId" TEXT,
    "employmentType" TEXT,
    "amount" DECIMAL(18,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_clauses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_extras" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "clauseIds" JSONB,
    "clausesHtml" TEXT,
    "compConfirmedAt" TIMESTAMP(3),
    "compConfirmedNote" TEXT,
    "withdrawReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offer_extras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_checklist_checks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "checkedBy" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_checklist_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hire_depth_settings_tenantId_key" ON "hire_depth_settings"("tenantId");

-- CreateIndex
CREATE INDEX "recruiter_tasks_tenantId_status_assigneeUserId_idx" ON "recruiter_tasks"("tenantId", "status", "assigneeUserId");

-- CreateIndex
CREATE INDEX "recruiter_tasks_tenantId_queue_idx" ON "recruiter_tasks"("tenantId", "queue");

-- CreateIndex
CREATE UNIQUE INDEX "recruiter_tasks_tenantId_sourceKey_key" ON "recruiter_tasks"("tenantId", "sourceKey");

-- CreateIndex
CREATE INDEX "hire_alerts_tenantId_kind_resolvedAt_idx" ON "hire_alerts"("tenantId", "kind", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "hire_alerts_tenantId_key_key" ON "hire_alerts"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "requisition_intakes_requisitionId_key" ON "requisition_intakes"("requisitionId");

-- CreateIndex
CREATE UNIQUE INDEX "sourcing_channels_tenantId_name_key" ON "sourcing_channels"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sourcing_campaigns_tenantId_code_key" ON "sourcing_campaigns"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sourcing_campaigns_tenantId_name_key" ON "sourcing_campaigns"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sourcing_projects_tenantId_name_key" ON "sourcing_projects"("tenantId", "name");

-- CreateIndex
CREATE INDEX "sourcing_project_candidates_candidateId_idx" ON "sourcing_project_candidates"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "sourcing_project_candidates_projectId_candidateId_key" ON "sourcing_project_candidates"("projectId", "candidateId");

-- CreateIndex
CREATE INDEX "saved_sourcing_searches_tenantId_ownerUserId_idx" ON "saved_sourcing_searches"("tenantId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_sourcing_profiles_candidateId_key" ON "candidate_sourcing_profiles"("candidateId");

-- CreateIndex
CREATE INDEX "candidate_sourcing_profiles_tenantId_engagementStatus_idx" ON "candidate_sourcing_profiles"("tenantId", "engagementStatus");

-- CreateIndex
CREATE INDEX "prospect_tag_rules_tenantId_isActive_idx" ON "prospect_tag_rules"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "source_attribution_rules_tenantId_isActive_idx" ON "source_attribution_rules"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_agencies_tenantId_name_key" ON "recruitment_agencies"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_cadences_tenantId_name_key" ON "outreach_cadences"("tenantId", "name");

-- CreateIndex
CREATE INDEX "cadence_enrollments_candidateId_idx" ON "cadence_enrollments"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "cadence_enrollments_cadenceId_candidateId_key" ON "cadence_enrollments"("cadenceId", "candidateId");

-- CreateIndex
CREATE INDEX "candidate_communications_tenantId_candidateId_idx" ON "candidate_communications"("tenantId", "candidateId");

-- CreateIndex
CREATE INDEX "candidate_documents_tenantId_candidateId_idx" ON "candidate_documents"("tenantId", "candidateId");

-- CreateIndex
CREATE INDEX "candidate_merge_logs_tenantId_survivorId_idx" ON "candidate_merge_logs"("tenantId", "survivorId");

-- CreateIndex
CREATE UNIQUE INDEX "disposition_reasons_tenantId_kind_label_key" ON "disposition_reasons"("tenantId", "kind", "label");

-- CreateIndex
CREATE UNIQUE INDEX "application_dispositions_applicationId_key" ON "application_dispositions"("applicationId");

-- CreateIndex
CREATE INDEX "application_dispositions_tenantId_kind_idx" ON "application_dispositions"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "referral_records_candidateId_key" ON "referral_records"("candidateId");

-- CreateIndex
CREATE INDEX "referral_records_tenantId_bonusStatus_idx" ON "referral_records"("tenantId", "bonusStatus");

-- CreateIndex
CREATE INDEX "career_contents_tenantId_kind_status_idx" ON "career_contents"("tenantId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "career_contents_tenantId_slug_key" ON "career_contents"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "career_content_versions_contentId_version_key" ON "career_content_versions"("contentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "career_site_configs_tenantId_key" ON "career_site_configs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "career_site_snapshots_tenantId_version_key" ON "career_site_snapshots"("tenantId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "job_posting_metas_jobId_key" ON "job_posting_metas"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "job_alert_subscriptions_tokenHash_key" ON "job_alert_subscriptions"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "job_alert_subscriptions_tenantId_email_key" ON "job_alert_subscriptions"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "job_alert_sents_subscriptionId_jobId_key" ON "job_alert_sents"("subscriptionId", "jobId");

-- CreateIndex
CREATE INDEX "career_site_visits_tenantId_createdAt_idx" ON "career_site_visits"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "applicant_portal_links_tokenHash_key" ON "applicant_portal_links"("tokenHash");

-- CreateIndex
CREATE INDEX "applicant_portal_links_applicationId_idx" ON "applicant_portal_links"("applicationId");

-- CreateIndex
CREATE INDEX "applicant_change_requests_tenantId_applicationId_idx" ON "applicant_change_requests"("tenantId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "interview_plans_jobId_key" ON "interview_plans"("jobId");

-- CreateIndex
CREATE INDEX "interview_events_tenantId_interviewId_idx" ON "interview_events"("tenantId", "interviewId");

-- CreateIndex
CREATE INDEX "interview_events_tenantId_kind_idx" ON "interview_events"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "interview_consents_interviewId_key" ON "interview_consents"("interviewId");

-- CreateIndex
CREATE UNIQUE INDEX "interviewer_capacities_tenantId_employeeId_key" ON "interviewer_capacities"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "interview_guides_tenantId_title_key" ON "interview_guides"("tenantId", "title");

-- CreateIndex
CREATE INDEX "question_bank_items_tenantId_competency_idx" ON "question_bank_items"("tenantId", "competency");

-- CreateIndex
CREATE INDEX "offer_versions_tenantId_idx" ON "offer_versions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_versions_applicationId_version_key" ON "offer_versions"("applicationId", "version");

-- CreateIndex
CREATE INDEX "offer_negotiations_tenantId_applicationId_idx" ON "offer_negotiations"("tenantId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_clauses_tenantId_title_locale_key" ON "offer_clauses"("tenantId", "title", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "offer_extras_applicationId_key" ON "offer_extras"("applicationId");

-- CreateIndex
CREATE INDEX "offer_checklist_checks_tenantId_idx" ON "offer_checklist_checks"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_checklist_checks_applicationId_item_key" ON "offer_checklist_checks"("applicationId", "item");

-- AddForeignKey
ALTER TABLE "hire_depth_settings" ADD CONSTRAINT "hire_depth_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruiter_tasks" ADD CONSTRAINT "recruiter_tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hire_alerts" ADD CONSTRAINT "hire_alerts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_intakes" ADD CONSTRAINT "requisition_intakes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourcing_channels" ADD CONSTRAINT "sourcing_channels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourcing_campaigns" ADD CONSTRAINT "sourcing_campaigns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourcing_campaigns" ADD CONSTRAINT "sourcing_campaigns_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sourcing_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourcing_projects" ADD CONSTRAINT "sourcing_projects_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourcing_project_candidates" ADD CONSTRAINT "sourcing_project_candidates_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "sourcing_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourcing_project_candidates" ADD CONSTRAINT "sourcing_project_candidates_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_sourcing_searches" ADD CONSTRAINT "saved_sourcing_searches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_sourcing_searches" ADD CONSTRAINT "saved_sourcing_searches_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "sourcing_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_sourcing_profiles" ADD CONSTRAINT "candidate_sourcing_profiles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_sourcing_profiles" ADD CONSTRAINT "candidate_sourcing_profiles_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_tag_rules" ADD CONSTRAINT "prospect_tag_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_attribution_rules" ADD CONSTRAINT "source_attribution_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_agencies" ADD CONSTRAINT "recruitment_agencies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_cadences" ADD CONSTRAINT "outreach_cadences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadence_enrollments" ADD CONSTRAINT "cadence_enrollments_cadenceId_fkey" FOREIGN KEY ("cadenceId") REFERENCES "outreach_cadences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadence_enrollments" ADD CONSTRAINT "cadence_enrollments_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_communications" ADD CONSTRAINT "candidate_communications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_communications" ADD CONSTRAINT "candidate_communications_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_merge_logs" ADD CONSTRAINT "candidate_merge_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disposition_reasons" ADD CONSTRAINT "disposition_reasons_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_dispositions" ADD CONSTRAINT "application_dispositions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_records" ADD CONSTRAINT "referral_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_records" ADD CONSTRAINT "referral_records_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_contents" ADD CONSTRAINT "career_contents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_content_versions" ADD CONSTRAINT "career_content_versions_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "career_contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_site_configs" ADD CONSTRAINT "career_site_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_site_snapshots" ADD CONSTRAINT "career_site_snapshots_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_posting_metas" ADD CONSTRAINT "job_posting_metas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_alert_subscriptions" ADD CONSTRAINT "job_alert_subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_alert_sents" ADD CONSTRAINT "job_alert_sents_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "job_alert_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_site_visits" ADD CONSTRAINT "career_site_visits_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applicant_portal_links" ADD CONSTRAINT "applicant_portal_links_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applicant_change_requests" ADD CONSTRAINT "applicant_change_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_plans" ADD CONSTRAINT "interview_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_events" ADD CONSTRAINT "interview_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_consents" ADD CONSTRAINT "interview_consents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviewer_capacities" ADD CONSTRAINT "interviewer_capacities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_guides" ADD CONSTRAINT "interview_guides_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_bank_items" ADD CONSTRAINT "question_bank_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_negotiations" ADD CONSTRAINT "offer_negotiations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_clauses" ADD CONSTRAINT "offer_clauses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_extras" ADD CONSTRAINT "offer_extras_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_checklist_checks" ADD CONSTRAINT "offer_checklist_checks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
