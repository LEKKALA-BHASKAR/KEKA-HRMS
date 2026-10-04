-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AssetEventKind" ADD VALUE 'MAINTENANCE';
ALTER TYPE "AssetEventKind" ADD VALUE 'RESERVED';
ALTER TYPE "AssetEventKind" ADD VALUE 'DISPOSED';
ALTER TYPE "AssetEventKind" ADD VALUE 'LOST_REPORTED';
ALTER TYPE "AssetEventKind" ADD VALUE 'RECONCILED';
ALTER TYPE "AssetEventKind" ADD VALUE 'CHECKLIST';

-- AlterEnum
ALTER TYPE "HelpdeskAssignMode" ADD VALUE 'LEAST_LOADED';

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "poolId" TEXT;

-- AlterTable
ALTER TABLE "document_templates" ADD COLUMN     "approvalStatus" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedReason" TEXT,
ADD COLUMN     "departmentIds" JSONB,
ADD COLUMN     "lastReviewedAt" TIMESTAMP(3),
ADD COLUMN     "nextReviewOn" TIMESTAMP(3),
ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "reviewRemindedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "workflowRequestId" TEXT;

-- AlterTable
ALTER TABLE "employee_documents" ADD COLUMN     "expiryNoticeStage" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "renewalRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "generated_documents" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "lastSentAt" TIMESTAMP(3),
ADD COLUMN     "letterNumber" TEXT,
ADD COLUMN     "sentCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "triggerEvent" TEXT,
ADD COLUMN     "validUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "helpdesk_tickets" ADD COLUMN     "approvalRequestId" TEXT,
ADD COLUMN     "approvalStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'WEB',
ADD COLUMN     "escalationLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastEscalatedAt" TIMESTAMP(3),
ADD COLUMN     "loggedByUserId" TEXT,
ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "satisfactionComment" TEXT,
ADD COLUMN     "severity" TEXT,
ADD COLUMN     "splitFromId" TEXT;

-- CreateTable
CREATE TABLE "kb_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_articles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT,
    "helpdeskCategoryId" TEXT,
    "policyDocumentId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "keywords" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "authorUserId" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "reviewDueOn" TIMESTAMP(3),
    "reviewRemindedAt" TIMESTAMP(3),
    "workflowRequestId" TEXT,
    "views" INTEGER NOT NULL DEFAULT 0,
    "helpfulYes" INTEGER NOT NULL DEFAULT 0,
    "helpfulNo" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_article_revisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "editedByUserId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_article_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_article_feedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_article_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_ticket_articles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "linkedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_ticket_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_sla_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT,
    "priority" "TicketPriority" NOT NULL,
    "firstResponseHours" INTEGER NOT NULL,
    "resolutionHours" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "helpdesk_sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_escalation_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT,
    "priority" "TicketPriority",
    "trigger" TEXT NOT NULL,
    "afterHours" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "escalateTo" TEXT NOT NULL DEFAULT 'CATEGORY_HEAD',
    "escalateUserId" TEXT,
    "reassign" BOOLEAN NOT NULL DEFAULT false,
    "raisePriority" "TicketPriority",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_escalation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_ticket_escalations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "ruleId" TEXT,
    "level" INTEGER NOT NULL,
    "escalatedToUserId" TEXT,
    "reason" TEXT NOT NULL,
    "byUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_ticket_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_triage_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "categoryId" TEXT,
    "setPriority" "TicketPriority",
    "setSeverity" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_triage_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_ticket_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assigneeUserId" TEXT,
    "dueOn" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "doneByUserId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_ticket_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_case_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "TicketPriority",
    "tasks" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_case_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "allowAnonymous" BOOLEAN NOT NULL DEFAULT true,
    "appealWindowDays" INTEGER NOT NULL DEFAULT 15,
    "showCauseDays" INTEGER NOT NULL DEFAULT 7,
    "warningValidityMonths" INTEGER NOT NULL DEFAULT 12,
    "retentionMonths" INTEGER NOT NULL DEFAULT 84,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "er_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_case_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "description" TEXT,
    "checklist" JSONB,
    "letterTemplateId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "er_case_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_cases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "incidentDate" TIMESTAMP(3),
    "incidentLocation" TEXT,
    "reporterEmployeeId" TEXT,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "trackingCodeHash" TEXT,
    "subjectEmployeeId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'WEB',
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "isConfidential" BOOLEAN NOT NULL DEFAULT true,
    "ownerUserId" TEXT,
    "templateId" TEXT,
    "policyDocumentId" TEXT,
    "resolution" TEXT,
    "outcome" TEXT,
    "resolutionStatus" TEXT NOT NULL DEFAULT 'NONE',
    "resolutionRequestId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "retainUntil" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "er_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_case_access" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VIEWER',
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "er_case_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_case_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'NOTE',
    "body" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "er_case_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_investigations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "investigatorUserId" TEXT NOT NULL,
    "scope" TEXT,
    "startedOn" TIMESTAMP(3) NOT NULL,
    "dueOn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "findings" TEXT,
    "conclusion" TEXT,
    "recommendation" TEXT,
    "submittedAt" TIMESTAMP(3),
    "workflowRequestId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "er_investigations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_investigation_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueOn" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "doneByUserId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "er_investigation_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_witnesses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "employeeId" TEXT,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "statement" TEXT,
    "interviewedOn" TIMESTAMP(3),
    "addedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "er_witnesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_evidence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fileId" TEXT,
    "sha256" TEXT,
    "collectedOn" TIMESTAMP(3),
    "addedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "er_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_hearings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "panelUserIds" JSONB,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "minutes" TEXT,
    "employeeStatement" TEXT,
    "attendees" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "er_hearings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_actions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "effectiveOn" TIMESTAMP(3) NOT NULL,
    "expiresOn" TIMESTAMP(3),
    "suspensionFrom" TIMESTAMP(3),
    "suspensionTo" TIMESTAMP(3),
    "suspensionPaid" BOOLEAN NOT NULL DEFAULT false,
    "responseDueOn" TIMESTAMP(3),
    "employeeResponse" TEXT,
    "respondedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "ladderOverride" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "letterTemplateId" TEXT,
    "letterId" TEXT,
    "hrActivityId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "er_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "er_appeals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actionId" TEXT,
    "filedByEmployeeId" TEXT NOT NULL,
    "grounds" TEXT NOT NULL,
    "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'FILED',
    "reviewerUserId" TEXT,
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "er_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentKind" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileUrl" TEXT,
    "fileSize" INTEGER,
    "mimeType" TEXT,
    "issuedOn" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "status" TEXT,
    "label" TEXT,
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_folder_access" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "workflowRequestId" TEXT,
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_folder_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_shares" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "allowDownload" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "sharedByUserId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_bulk_uploads" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentTypeId" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_bulk_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_envelopes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "fileId" TEXT,
    "letterId" TEXT,
    "contentHash" TEXT NOT NULL,
    "sequential" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "employeeId" TEXT,
    "reminderEveryDays" INTEGER DEFAULT 3,
    "expiresOn" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_recipients" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'SIGNER',
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "viewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "typedName" TEXT,
    "signatureFileId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "declineReason" TEXT,
    "delegatedFromId" TEXT,
    "remindedAt" TIMESTAMP(3),
    "remindCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "recipientId" TEXT,
    "kind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "ip" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "letter_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requireTemplateApproval" BOOLEAN NOT NULL DEFAULT false,
    "reviewEveryMonths" INTEGER NOT NULL DEFAULT 12,
    "maxBackdateDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "letter_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "letter_number_series" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "prefix" TEXT NOT NULL DEFAULT 'HR/{YYYY}/',
    "digits" INTEGER NOT NULL DEFAULT 4,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "yearlyReset" BOOLEAN NOT NULL DEFAULT true,
    "lastYear" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "letter_number_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "letter_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "generated" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "letter_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "letter_triggers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "letter_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_template_revisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "workflow" TEXT,
    "editedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_template_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_checklist_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT,
    "items" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_checklist_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "templateId" TEXT,
    "items" JSONB NOT NULL,
    "completedByUserId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_checklist_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_maintenance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "reportedByEmployeeId" TEXT,
    "scheduledOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "vendor" TEXT,
    "cost" DECIMAL(18,2),
    "completedOn" TIMESTAMP(3),
    "intervalMonths" INTEGER,
    "priorStatus" TEXT,
    "remindedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_maintenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_pools" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "locationId" TEXT,
    "maxDays" INTEGER NOT NULL DEFAULT 14,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_reservations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "checkedOutAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_stock_thresholds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetTypeId" TEXT NOT NULL,
    "minAvailable" INTEGER NOT NULL,
    "lastAlertAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_stock_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_disposals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "bookValue" DECIMAL(18,2),
    "expectedValue" DECIMAL(18,2),
    "realisedValue" DECIMAL(18,2),
    "buyer" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "workflowRequestId" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_disposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_reconciliations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "startedByUserId" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_reconciliation_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reconciliationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "expectedStatus" TEXT NOT NULL,
    "expectedHolder" TEXT,
    "expectedLocation" TEXT,
    "found" BOOLEAN,
    "foundCondition" TEXT,
    "foundLocation" TEXT,
    "note" TEXT,
    "checkedAt" TIMESTAMP(3),
    "checkedByUserId" TEXT,

    CONSTRAINT "asset_reconciliation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kb_categories_tenantId_name_key" ON "kb_categories"("tenantId", "name");

-- CreateIndex
CREATE INDEX "kb_articles_tenantId_status_idx" ON "kb_articles"("tenantId", "status");

-- CreateIndex
CREATE INDEX "kb_articles_tenantId_helpdeskCategoryId_idx" ON "kb_articles"("tenantId", "helpdeskCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "kb_article_revisions_articleId_version_key" ON "kb_article_revisions"("articleId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "kb_article_feedback_articleId_userId_key" ON "kb_article_feedback"("articleId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_ticket_articles_ticketId_articleId_key" ON "helpdesk_ticket_articles"("ticketId", "articleId");

-- CreateIndex
CREATE INDEX "helpdesk_sla_policies_tenantId_priority_idx" ON "helpdesk_sla_policies"("tenantId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_escalation_rules_tenantId_name_key" ON "helpdesk_escalation_rules"("tenantId", "name");

-- CreateIndex
CREATE INDEX "helpdesk_ticket_escalations_tenantId_createdAt_idx" ON "helpdesk_ticket_escalations"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "helpdesk_ticket_escalations_ticketId_idx" ON "helpdesk_ticket_escalations"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_triage_rules_tenantId_name_key" ON "helpdesk_triage_rules"("tenantId", "name");

-- CreateIndex
CREATE INDEX "helpdesk_ticket_tasks_ticketId_idx" ON "helpdesk_ticket_tasks"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_case_templates_tenantId_name_key" ON "helpdesk_case_templates"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "er_settings_tenantId_key" ON "er_settings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "er_case_templates_tenantId_name_key" ON "er_case_templates"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "er_cases_trackingCodeHash_key" ON "er_cases"("trackingCodeHash");

-- CreateIndex
CREATE INDEX "er_cases_tenantId_kind_status_idx" ON "er_cases"("tenantId", "kind", "status");

-- CreateIndex
CREATE INDEX "er_cases_tenantId_subjectEmployeeId_idx" ON "er_cases"("tenantId", "subjectEmployeeId");

-- CreateIndex
CREATE INDEX "er_cases_tenantId_reporterEmployeeId_idx" ON "er_cases"("tenantId", "reporterEmployeeId");

-- CreateIndex
CREATE UNIQUE INDEX "er_cases_tenantId_number_key" ON "er_cases"("tenantId", "number");

-- CreateIndex
CREATE INDEX "er_case_access_tenantId_userId_idx" ON "er_case_access"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "er_case_access_caseId_userId_key" ON "er_case_access"("caseId", "userId");

-- CreateIndex
CREATE INDEX "er_case_notes_caseId_createdAt_idx" ON "er_case_notes"("caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "er_investigations_caseId_key" ON "er_investigations"("caseId");

-- CreateIndex
CREATE INDEX "er_investigations_tenantId_status_idx" ON "er_investigations"("tenantId", "status");

-- CreateIndex
CREATE INDEX "er_investigation_tasks_investigationId_idx" ON "er_investigation_tasks"("investigationId");

-- CreateIndex
CREATE INDEX "er_witnesses_caseId_idx" ON "er_witnesses"("caseId");

-- CreateIndex
CREATE INDEX "er_evidence_caseId_idx" ON "er_evidence"("caseId");

-- CreateIndex
CREATE INDEX "er_hearings_caseId_idx" ON "er_hearings"("caseId");

-- CreateIndex
CREATE INDEX "er_hearings_tenantId_scheduledAt_idx" ON "er_hearings"("tenantId", "scheduledAt");

-- CreateIndex
CREATE INDEX "er_actions_tenantId_employeeId_status_idx" ON "er_actions"("tenantId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "er_actions_caseId_idx" ON "er_actions"("caseId");

-- CreateIndex
CREATE INDEX "er_appeals_tenantId_status_idx" ON "er_appeals"("tenantId", "status");

-- CreateIndex
CREATE INDEX "er_appeals_caseId_idx" ON "er_appeals"("caseId");

-- CreateIndex
CREATE INDEX "document_versions_tenantId_documentKind_documentId_idx" ON "document_versions"("tenantId", "documentKind", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_documentKind_documentId_version_key" ON "document_versions"("documentKind", "documentId", "version");

-- CreateIndex
CREATE INDEX "document_folder_access_tenantId_userId_idx" ON "document_folder_access"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "document_folder_access_folderId_userId_key" ON "document_folder_access"("folderId", "userId");

-- CreateIndex
CREATE INDEX "document_shares_tenantId_sharedWithUserId_idx" ON "document_shares"("tenantId", "sharedWithUserId");

-- CreateIndex
CREATE INDEX "document_shares_documentId_idx" ON "document_shares"("documentId");

-- CreateIndex
CREATE INDEX "document_bulk_uploads_tenantId_createdAt_idx" ON "document_bulk_uploads"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "signature_envelopes_tenantId_status_idx" ON "signature_envelopes"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "signature_envelopes_tenantId_number_key" ON "signature_envelopes"("tenantId", "number");

-- CreateIndex
CREATE INDEX "signature_recipients_tenantId_userId_status_idx" ON "signature_recipients"("tenantId", "userId", "status");

-- CreateIndex
CREATE INDEX "signature_recipients_envelopeId_idx" ON "signature_recipients"("envelopeId");

-- CreateIndex
CREATE INDEX "signature_events_envelopeId_createdAt_idx" ON "signature_events"("envelopeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "letter_settings_tenantId_key" ON "letter_settings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "letter_number_series_tenantId_name_key" ON "letter_number_series"("tenantId", "name");

-- CreateIndex
CREATE INDEX "letter_batches_tenantId_createdAt_idx" ON "letter_batches"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "letter_triggers_tenantId_event_templateId_key" ON "letter_triggers"("tenantId", "event", "templateId");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_revisions_templateId_version_key" ON "document_template_revisions"("templateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "asset_checklist_templates_tenantId_name_key" ON "asset_checklist_templates"("tenantId", "name");

-- CreateIndex
CREATE INDEX "asset_checklist_runs_tenantId_assetId_idx" ON "asset_checklist_runs"("tenantId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_checklist_runs_assignmentId_kind_key" ON "asset_checklist_runs"("assignmentId", "kind");

-- CreateIndex
CREATE INDEX "asset_maintenance_tenantId_status_scheduledOn_idx" ON "asset_maintenance"("tenantId", "status", "scheduledOn");

-- CreateIndex
CREATE INDEX "asset_maintenance_assetId_idx" ON "asset_maintenance"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_pools_tenantId_name_key" ON "asset_pools"("tenantId", "name");

-- CreateIndex
CREATE INDEX "asset_reservations_tenantId_assetId_status_idx" ON "asset_reservations"("tenantId", "assetId", "status");

-- CreateIndex
CREATE INDEX "asset_reservations_tenantId_employeeId_idx" ON "asset_reservations"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_stock_thresholds_tenantId_assetTypeId_key" ON "asset_stock_thresholds"("tenantId", "assetTypeId");

-- CreateIndex
CREATE INDEX "asset_disposals_tenantId_status_idx" ON "asset_disposals"("tenantId", "status");

-- CreateIndex
CREATE INDEX "asset_disposals_assetId_idx" ON "asset_disposals"("assetId");

-- CreateIndex
CREATE INDEX "asset_reconciliations_tenantId_status_idx" ON "asset_reconciliations"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "asset_reconciliation_lines_reconciliationId_assetId_key" ON "asset_reconciliation_lines"("reconciliationId", "assetId");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "asset_pools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_categories" ADD CONSTRAINT "kb_categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "kb_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_article_revisions" ADD CONSTRAINT "kb_article_revisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_article_revisions" ADD CONSTRAINT "kb_article_revisions_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "kb_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_article_feedback" ADD CONSTRAINT "kb_article_feedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_article_feedback" ADD CONSTRAINT "kb_article_feedback_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "kb_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket_articles" ADD CONSTRAINT "helpdesk_ticket_articles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket_articles" ADD CONSTRAINT "helpdesk_ticket_articles_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "helpdesk_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket_articles" ADD CONSTRAINT "helpdesk_ticket_articles_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "kb_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_sla_policies" ADD CONSTRAINT "helpdesk_sla_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_escalation_rules" ADD CONSTRAINT "helpdesk_escalation_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket_escalations" ADD CONSTRAINT "helpdesk_ticket_escalations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket_escalations" ADD CONSTRAINT "helpdesk_ticket_escalations_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "helpdesk_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket_escalations" ADD CONSTRAINT "helpdesk_ticket_escalations_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "helpdesk_escalation_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_triage_rules" ADD CONSTRAINT "helpdesk_triage_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket_tasks" ADD CONSTRAINT "helpdesk_ticket_tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_ticket_tasks" ADD CONSTRAINT "helpdesk_ticket_tasks_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "helpdesk_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_case_templates" ADD CONSTRAINT "helpdesk_case_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_settings" ADD CONSTRAINT "er_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_case_templates" ADD CONSTRAINT "er_case_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_cases" ADD CONSTRAINT "er_cases_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_case_access" ADD CONSTRAINT "er_case_access_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_case_access" ADD CONSTRAINT "er_case_access_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "er_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_case_notes" ADD CONSTRAINT "er_case_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_case_notes" ADD CONSTRAINT "er_case_notes_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "er_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_investigations" ADD CONSTRAINT "er_investigations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_investigations" ADD CONSTRAINT "er_investigations_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "er_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_investigation_tasks" ADD CONSTRAINT "er_investigation_tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_investigation_tasks" ADD CONSTRAINT "er_investigation_tasks_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "er_investigations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_witnesses" ADD CONSTRAINT "er_witnesses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_witnesses" ADD CONSTRAINT "er_witnesses_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "er_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_evidence" ADD CONSTRAINT "er_evidence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_evidence" ADD CONSTRAINT "er_evidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "er_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_hearings" ADD CONSTRAINT "er_hearings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_hearings" ADD CONSTRAINT "er_hearings_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "er_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_actions" ADD CONSTRAINT "er_actions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_actions" ADD CONSTRAINT "er_actions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "er_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_appeals" ADD CONSTRAINT "er_appeals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_appeals" ADD CONSTRAINT "er_appeals_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "er_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "er_appeals" ADD CONSTRAINT "er_appeals_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "er_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_folder_access" ADD CONSTRAINT "document_folder_access_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_bulk_uploads" ADD CONSTRAINT "document_bulk_uploads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_envelopes" ADD CONSTRAINT "signature_envelopes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_recipients" ADD CONSTRAINT "signature_recipients_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_recipients" ADD CONSTRAINT "signature_recipients_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "signature_envelopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "signature_envelopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "letter_settings" ADD CONSTRAINT "letter_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "letter_number_series" ADD CONSTRAINT "letter_number_series_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "letter_batches" ADD CONSTRAINT "letter_batches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "letter_triggers" ADD CONSTRAINT "letter_triggers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_template_revisions" ADD CONSTRAINT "document_template_revisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_checklist_templates" ADD CONSTRAINT "asset_checklist_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_checklist_runs" ADD CONSTRAINT "asset_checklist_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_maintenance" ADD CONSTRAINT "asset_maintenance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_pools" ADD CONSTRAINT "asset_pools_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_reservations" ADD CONSTRAINT "asset_reservations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_stock_thresholds" ADD CONSTRAINT "asset_stock_thresholds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_reconciliations" ADD CONSTRAINT "asset_reconciliations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_reconciliation_lines" ADD CONSTRAINT "asset_reconciliation_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_reconciliation_lines" ADD CONSTRAINT "asset_reconciliation_lines_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "asset_reconciliations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
