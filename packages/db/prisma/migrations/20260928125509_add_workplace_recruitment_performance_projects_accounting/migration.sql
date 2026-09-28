-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AwardCadence" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL', 'SPOT');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'IN_REPAIR', 'RETIRED', 'LOST', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AssetCondition" AS ENUM ('NEW', 'GOOD', 'FAIR', 'DAMAGED', 'UNUSABLE');

-- CreateEnum
CREATE TYPE "AssetRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentScope" AS ENUM ('EMPLOYEE', 'ORGANISATION');

-- CreateEnum
CREATE TYPE "EmployeeDocumentStatus" AS ENUM ('PENDING_ON_EMPLOYEE', 'PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'NOT_APPLICABLE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'TERMINATED', 'RENEWED');

-- CreateEnum
CREATE TYPE "HrActivityType" AS ENUM ('PROMOTION', 'TRANSFER', 'WARNING', 'COMPLAINT', 'WORK_TRIP', 'TERMINATION', 'RESIGNATION', 'APPRECIATION', 'SALARY_REVISION');

-- CreateEnum
CREATE TYPE "TrainingStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EnrolmentStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RequisitionType" AS ENUM ('NEW_HIRE', 'BACKFILL');

-- CreateEnum
CREATE TYPE "RequisitionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'OPEN', 'ON_HOLD', 'CLOSED', 'FILLED');

-- CreateEnum
CREATE TYPE "CandidateSource" AS ENUM ('CAREER_PORTAL', 'REFERRAL', 'INTERNAL', 'JOB_BOARD', 'AGENCY', 'DIRECT_SOURCING', 'WALK_IN');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'REJECTED', 'WITHDRAWN', 'OFFER_EXTENDED', 'OFFER_ACCEPTED', 'OFFER_DECLINED', 'HIRED');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXTENDED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GoalMetricType" AS ENUM ('PERCENTAGE', 'COMPLETION', 'NUMBER_INCREASE', 'NUMBER_DECREASE', 'CURRENCY');

-- CreateEnum
CREATE TYPE "GoalLevel" AS ENUM ('COMPANY', 'DEPARTMENT', 'TEAM', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('DRAFT', 'ON_TRACK', 'NEEDS_ATTENTION', 'AT_RISK', 'COMPLETED', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewTiming" AS ENUM ('SYNCHRONOUS', 'DATE_OF_JOINING', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ReviewCycleStatus" AS ENUM ('DRAFT', 'LAUNCHED', 'IN_PROGRESS', 'CALIBRATION', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('NOT_STARTED', 'SELF_PENDING', 'MANAGER_PENDING', 'PENDING_CALIBRATION', 'CALIBRATED', 'SHARED', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "BillingModel" AS ENUM ('TIME_AND_MATERIAL', 'MILESTONE', 'RETAINER', 'NON_BILLABLE');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "ProjectHealth" AS ENUM ('GREEN', 'AMBER', 'RED');

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'DELAYED', 'INVOICED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TimesheetStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'LOCKED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "AccountClass" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "LedgerEntryStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "LedgerSource" AS ENUM ('MANUAL', 'PAYROLL', 'EXPENSE', 'INVOICE', 'PAYMENT', 'OPENING_BALANCE', 'LOAN');

-- CreateEnum
CREATE TYPE "ClaimStage" AS ENUM ('DRAFT', 'SUBMITTED', 'PARTIALLY_APPROVED', 'APPROVED', 'REJECTED', 'PAYMENT_PENDING', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdvanceStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'DISBURSED', 'PARTIALLY_SETTLED', 'SETTLED', 'RECOVERED');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'BOOKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "bannerUrl" TEXT,
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "audience" JSONB,
    "publishAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "requireAck" BOOLEAN NOT NULL DEFAULT false,
    "notifyByEmail" BOOLEAN NOT NULL DEFAULT false,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_reads" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "announcement_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "award_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "cadence" "AwardCadence" NOT NULL DEFAULT 'MONTHLY',
    "cashAmount" DECIMAL(18,2),
    "points" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "award_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_awards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "awardTypeId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "period" TEXT,
    "awardedOn" TIMESTAMP(3) NOT NULL,
    "citation" TEXT,
    "cashAmount" DECIMAL(18,2),
    "paidInRunId" TEXT,
    "certificateUrl" TEXT,
    "nominatedBy" TEXT,
    "approvedBy" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_awards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "praises" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromEmployeeId" TEXT NOT NULL,
    "toEmployeeId" TEXT NOT NULL,
    "badge" TEXT,
    "message" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "praises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "usefulLifeMonths" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_types" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "requireAck" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_id_series" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT 'AST',
    "digits" INTEGER NOT NULL DEFAULT 5,
    "suffix" TEXT NOT NULL DEFAULT '',
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_id_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetTypeId" TEXT NOT NULL,
    "assetTag" TEXT NOT NULL,
    "serialNumber" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'AVAILABLE',
    "condition" "AssetCondition" NOT NULL DEFAULT 'NEW',
    "purchaseDate" TIMESTAMP(3),
    "purchaseCost" DECIMAL(18,2),
    "vendor" TEXT,
    "invoiceNumber" TEXT,
    "warrantyExpiry" TIMESTAMP(3),
    "currentValue" DECIMAL(18,2),
    "locationId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_assignments" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assignedOn" TIMESTAMP(3) NOT NULL,
    "assignedBy" TEXT,
    "conditionOut" "AssetCondition" NOT NULL DEFAULT 'GOOD',
    "acknowledgedAt" TIMESTAMP(3),
    "returnedOn" TIMESTAMP(3),
    "conditionIn" "AssetCondition",
    "damageCharge" DECIMAL(18,2),
    "damageNote" TEXT,
    "chargeRecovered" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assetId" TEXT,
    "assetTypeId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "AssetRequestStatus" NOT NULL DEFAULT 'PENDING',
    "neededBy" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_folders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "DocumentScope" NOT NULL DEFAULT 'EMPLOYEE',
    "isConfidential" BOOLEAN NOT NULL DEFAULT false,
    "viewRoles" JSONB,
    "editRoles" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_types" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "requireVerification" BOOLEAN NOT NULL DEFAULT true,
    "trackExpiry" BOOLEAN NOT NULL DEFAULT false,
    "allowNotApplicable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "folderId" TEXT,
    "documentTypeId" TEXT,
    "name" TEXT NOT NULL,
    "fileUrl" TEXT,
    "fileSize" INTEGER,
    "mimeType" TEXT,
    "status" "EmployeeDocumentStatus" NOT NULL DEFAULT 'PENDING_ON_EMPLOYEE',
    "issuedOn" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "folderId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fileUrl" TEXT,
    "version" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "requireAck" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_document_acks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_document_acks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'CUSTOM',
    "body" TEXT NOT NULL,
    "placeholders" JSONB,
    "legalEntityIds" JSONB,
    "workflow" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_documents" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "renderedBody" TEXT NOT NULL,
    "fileUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issuedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),

    CONSTRAINT "generated_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_contracts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "contractNumber" TEXT,
    "contractType" TEXT NOT NULL DEFAULT 'FIXED_TERM',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" "ContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "contractValue" DECIMAL(18,2),
    "noticeDays" INTEGER,
    "fileUrl" TEXT,
    "terms" TEXT,
    "renewedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_activities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "HrActivityType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "tripFrom" TIMESTAMP(3),
    "tripTo" TIMESTAMP(3),
    "destination" TEXT,
    "severity" TEXT,
    "attachmentUrl" TEXT,
    "jobRecordId" TEXT,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'INTERNAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_programs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "trainingTypeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "trainer" TEXT,
    "costPerHead" DECIMAL(18,2),
    "venue" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "durationHours" DECIMAL(9,2),
    "maxSeats" INTEGER,
    "status" "TrainingStatus" NOT NULL DEFAULT 'PLANNED',
    "skills" JSONB,
    "materialUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_enrolments" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "EnrolmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "score" DECIMAL(9,2),
    "completedAt" TIMESTAMP(3),
    "certificateUrl" TEXT,
    "feedback" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT,

    CONSTRAINT "training_enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_rooms" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locationId" TEXT,
    "capacity" INTEGER,
    "facilities" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roomId" TEXT,
    "title" TEXT NOT NULL,
    "meetingType" TEXT NOT NULL DEFAULT 'OTHER',
    "agenda" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "meetingUrl" TEXT,
    "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "minutes" TEXT,
    "organiserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_attendees" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendance" TEXT NOT NULL DEFAULT 'REQUIRED',
    "response" TEXT NOT NULL DEFAULT 'PENDING',
    "attended" BOOLEAN,

    CONSTRAINT "meeting_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_action_items" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ownerId" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_action_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "RequisitionType" NOT NULL DEFAULT 'NEW_HIRE',
    "status" "RequisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "departmentId" TEXT,
    "locationId" TEXT,
    "businessUnitId" TEXT,
    "legalEntityId" TEXT,
    "jobTitleId" TEXT,
    "bandId" TEXT,
    "workerTypeId" TEXT,
    "positions" INTEGER NOT NULL DEFAULT 1,
    "positionPlan" JSONB,
    "minAnnualCtc" DECIMAL(18,2),
    "maxAnnualCtc" DECIMAL(18,2),
    "justification" TEXT,
    "replacingEmployeeId" TEXT,
    "raisedBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "targetStartDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hiring_flows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hiring_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hiring_stages" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stageKind" TEXT NOT NULL DEFAULT 'INTERVIEW',
    "requireScorecard" BOOLEAN NOT NULL DEFAULT false,
    "staleAfterDays" INTEGER,

    CONSTRAINT "hiring_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requisitionId" TEXT,
    "flowId" TEXT,
    "title" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "responsibilities" TEXT,
    "requirements" TEXT,
    "employmentType" TEXT NOT NULL DEFAULT 'FULL_TIME',
    "workMode" TEXT NOT NULL DEFAULT 'ONSITE',
    "departmentId" TEXT,
    "locationId" TEXT,
    "businessUnitId" TEXT,
    "legalEntityId" TEXT,
    "openings" INTEGER NOT NULL DEFAULT 1,
    "minAnnualCtc" DECIMAL(18,2),
    "maxAnnualCtc" DECIMAL(18,2),
    "hideSalary" BOOLEAN NOT NULL DEFAULT true,
    "minExperienceYears" DECIMAL(9,1),
    "skills" JSONB,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "allowInternal" BOOLEAN NOT NULL DEFAULT false,
    "allowReferral" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "feedbackVisibility" TEXT NOT NULL DEFAULT 'RESTRICTED',
    "hiringManagerId" TEXT,
    "recruiterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "currentEmployer" TEXT,
    "currentTitle" TEXT,
    "totalExperienceYears" DECIMAL(9,1),
    "currentAnnualCtc" DECIMAL(18,2),
    "expectedAnnualCtc" DECIMAL(18,2),
    "noticePeriodDays" INTEGER,
    "resumeUrl" TEXT,
    "portfolioUrl" TEXT,
    "linkedinUrl" TEXT,
    "skills" JSONB,
    "city" TEXT,
    "source" "CandidateSource" NOT NULL DEFAULT 'CAREER_PORTAL',
    "referredById" TEXT,
    "convertedEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentStageId" TEXT,
    "ownerId" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "averageScore" DECIMAL(9,2),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_stage_history" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMP(3),
    "movedBy" TEXT,
    "note" TEXT,

    CONSTRAINT "application_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'VIDEO',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "meetingUrl" TEXT,
    "roomId" TEXT,
    "status" "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_panelists" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "isLead" BOOLEAN NOT NULL DEFAULT false,
    "response" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "interview_panelists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecards" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "panelistId" TEXT NOT NULL,
    "ratings" JSONB,
    "overallScore" DECIMAL(9,2),
    "recommendation" TEXT,
    "strengths" TEXT,
    "concerns" TEXT,
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "annualCtc" DECIMAL(18,2) NOT NULL,
    "salaryStructureId" TEXT,
    "joiningBonus" DECIMAL(18,2),
    "proposedJoiningDate" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "jobTitleId" TEXT,
    "bandId" TEXT,
    "payGradeId" TEXT,
    "reportingManagerId" TEXT,
    "letterUrl" TEXT,
    "templateId" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "extendedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bgv_checks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT,
    "employeeId" TEXT,
    "vendor" TEXT,
    "checkTypes" JSONB,
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "reportUrl" TEXT,
    "findings" TEXT,

    CONSTRAINT "bgv_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indicator_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "weight" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indicator_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_indicators" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "appliesToJobTitleIds" JSONB,
    "appliesToBandIds" JSONB,
    "weight" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_indicators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultDurationDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "goalTypeId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "level" "GoalLevel" NOT NULL DEFAULT 'INDIVIDUAL',
    "employeeId" TEXT,
    "departmentId" TEXT,
    "metricType" "GoalMetricType" NOT NULL DEFAULT 'PERCENTAGE',
    "metricName" TEXT,
    "startValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "targetValue" DECIMAL(18,2) NOT NULL DEFAULT 100,
    "currentValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "progressPercent" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'DRAFT',
    "statusOverride" "GoalStatus",
    "parentGoalId" TEXT,
    "rollupMethod" TEXT NOT NULL DEFAULT 'AVERAGE',
    "weight" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "countsInReview" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_check_ins" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "progressPercent" DECIMAL(9,2) NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "recordedBy" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_cycles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timing" "ReviewTiming" NOT NULL DEFAULT 'SYNCHRONOUS',
    "status" "ReviewCycleStatus" NOT NULL DEFAULT 'DRAFT',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "reviewOpensAt" TIMESTAMP(3),
    "reviewClosesAt" TIMESTAMP(3),
    "reviewerTypes" JSONB,
    "ratingScale" JSONB,
    "ratePotential" BOOLEAN NOT NULL DEFAULT false,
    "visibility" TEXT NOT NULL DEFAULT 'RESTRICTED',
    "eligibility" JSONB,
    "launchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_reviews" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "rawRating" DECIMAL(9,2),
    "finalRating" DECIMAL(9,2),
    "potentialRating" DECIMAL(9,2),
    "bandId" TEXT,
    "calibrationReason" TEXT,
    "calibratedBy" TEXT,
    "calibratedAt" TIMESTAMP(3),
    "managerSummary" TEXT,
    "employeeComments" TEXT,
    "sharedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_responses" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "reviewerType" TEXT NOT NULL,
    "weight" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "overallRating" DECIMAL(9,2),
    "answers" JSONB,
    "strengths" TEXT,
    "improvements" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indicator_ratings" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "indicatorId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "rating" DECIMAL(9,2) NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indicator_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_bands" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minRating" DECIMAL(9,2) NOT NULL,
    "maxRating" DECIMAL(9,2) NOT NULL,
    "targetPercent" DECIMAL(9,2),
    "color" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "performance_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "improvement_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "objectives" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "outcome" TEXT,
    "outcomeNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "managerId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "improvement_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "levels" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_skills" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "rating" DECIMAL(9,2),
    "source" TEXT NOT NULL DEFAULT 'SELF',
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "addressLine1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'IN',
    "gstin" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "accountManagerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "billingModel" "BillingModel" NOT NULL DEFAULT 'TIME_AND_MATERIAL',
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNING',
    "health" "ProjectHealth" NOT NULL DEFAULT 'GREEN',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "estimatedHours" DECIMAL(12,2),
    "budget" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "retainerFee" DECIMAL(18,2),
    "retainerFrequency" TEXT,
    "retainerFrom" TIMESTAMP(3),
    "projectManagerId" TEXT,
    "requireTimesheetApproval" BOOLEAN NOT NULL DEFAULT true,
    "approverIds" JSONB,
    "costCenterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_phases" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),

    CONSTRAINT "project_phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestones" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "completedOn" TIMESTAMP(3),
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(18,2),
    "weight" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "phaseId" TEXT,
    "milestoneId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "assigneeId" TEXT,
    "reporterId" TEXT,
    "estimatedHours" DECIMAL(12,2),
    "loggedHours" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "isBillable" BOOLEAN NOT NULL DEFAULT true,
    "parentTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comments" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_rates" (
    "id" TEXT NOT NULL,
    "rateCardId" TEXT NOT NULL,
    "billingRole" TEXT NOT NULL,
    "rateCategory" TEXT NOT NULL DEFAULT 'STANDARD',
    "billRate" DECIMAL(18,2) NOT NULL,
    "suggestedCost" DECIMAL(18,2),
    "effectiveFrom" TIMESTAMP(3),

    CONSTRAINT "billing_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_allocations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "billingRole" TEXT,
    "allocationPercent" DECIMAL(9,2) NOT NULL DEFAULT 100,
    "billRate" DECIMAL(18,2),
    "costRate" DECIMAL(18,2),
    "isBillable" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "shadowOfEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "TimesheetStatus" NOT NULL DEFAULT 'DRAFT',
    "totalHours" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "billableHours" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "timesheetId" TEXT,
    "employeeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(9,2) NOT NULL,
    "description" TEXT,
    "isBillable" BOOLEAN NOT NULL DEFAULT true,
    "billRate" DECIMAL(18,2),
    "costRate" DECIMAL(18,2),
    "invoiceId" TEXT,
    "isInvoiced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "projectId" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "issueDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amountDue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "terms" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "lineType" TEXT NOT NULL DEFAULT 'HOURS',
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unitRate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxPercent" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "milestoneId" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paidOn" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
    "reference" TEXT,
    "notes" TEXT,
    "isCreditNote" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountClass" "AccountClass" NOT NULL,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "parentId" TEXT,
    "normalSide" TEXT NOT NULL DEFAULT 'DEBIT',
    "description" TEXT,
    "isBankAccount" BOOLEAN NOT NULL DEFAULT false,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "ifsc" TEXT,
    "openingBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "openingDate" TIMESTAMP(3),
    "currentBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "entryNumber" TEXT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "narration" TEXT,
    "status" "LedgerEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "LedgerSource" NOT NULL DEFAULT 'MANUAL',
    "sourceRefType" TEXT,
    "sourceRefId" TEXT,
    "totalDebit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalCredit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "isBalanced" BOOLEAN NOT NULL DEFAULT false,
    "postedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_lines" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "narration" TEXT,
    "costCenterId" TEXT,
    "departmentId" TEXT,
    "employeeId" TEXT,
    "projectId" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ledger_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_periods" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "code" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,

    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "accountId" TEXT,
    "maxAmount" DECIMAL(18,2),
    "receiptRequiredAbove" DECIMAL(18,2),
    "approverRoleIds" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseCurrency" TEXT NOT NULL DEFAULT 'INR',
    "allowFutureDated" BOOLEAN NOT NULL DEFAULT false,
    "advanceReceiptDays" INTEGER,
    "approverRoleIds" JSONB,
    "escalationAboveAmount" DECIMAL(18,2),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_policy_categories" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "maxAmount" DECIMAL(18,2),

    CONSTRAINT "expense_policy_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "policyId" TEXT,
    "claimNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "stage" "ClaimStage" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "claimedTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "approvedTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "advanceId" TEXT,
    "payViaPayroll" BOOLEAN NOT NULL DEFAULT true,
    "paidInRunId" TEXT,
    "projectId" TEXT,
    "costCenterId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_claim_lines" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "exchangeRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "baseAmount" DECIMAL(18,2) NOT NULL,
    "approvedAmount" DECIMAL(18,2),
    "receiptUrl" TEXT,
    "merchant" TEXT,
    "reviewNote" TEXT,
    "isApproved" BOOLEAN,

    CONSTRAINT "expense_claim_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_advances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "AdvanceStatus" NOT NULL DEFAULT 'REQUESTED',
    "neededBy" TIMESTAMP(3),
    "settledAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "outstanding" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "disbursedAt" TIMESTAMP(3),
    "recoveredInRunId" TEXT,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'REQUESTED',
    "fromCity" TEXT NOT NULL,
    "toCity" TEXT NOT NULL,
    "departDate" TIMESTAMP(3) NOT NULL,
    "returnDate" TIMESTAMP(3),
    "travelType" TEXT NOT NULL DEFAULT 'DOMESTIC',
    "modes" JSONB,
    "needsAccommodation" BOOLEAN NOT NULL DEFAULT false,
    "needsVisa" BOOLEAN NOT NULL DEFAULT false,
    "estimatedCost" DECIMAL(18,2),
    "actualCost" DECIMAL(18,2),
    "advanceId" TEXT,
    "projectId" TEXT,
    "clientId" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "bookingRef" TEXT,
    "bookedBy" TEXT,
    "bookedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_tenantId_status_publishAt_idx" ON "announcements"("tenantId", "status", "publishAt");

-- CreateIndex
CREATE INDEX "announcement_reads_employeeId_idx" ON "announcement_reads"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_reads_announcementId_employeeId_key" ON "announcement_reads"("announcementId", "employeeId");

-- CreateIndex
CREATE INDEX "award_types_tenantId_idx" ON "award_types"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "award_types_tenantId_name_key" ON "award_types"("tenantId", "name");

-- CreateIndex
CREATE INDEX "employee_awards_tenantId_awardedOn_idx" ON "employee_awards"("tenantId", "awardedOn");

-- CreateIndex
CREATE INDEX "employee_awards_employeeId_idx" ON "employee_awards"("employeeId");

-- CreateIndex
CREATE INDEX "praises_tenantId_createdAt_idx" ON "praises"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "praises_toEmployeeId_idx" ON "praises"("toEmployeeId");

-- CreateIndex
CREATE INDEX "asset_categories_tenantId_idx" ON "asset_categories"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_categories_tenantId_name_key" ON "asset_categories"("tenantId", "name");

-- CreateIndex
CREATE INDEX "asset_types_categoryId_idx" ON "asset_types"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_types_categoryId_name_key" ON "asset_types"("categoryId", "name");

-- CreateIndex
CREATE INDEX "asset_id_series_tenantId_idx" ON "asset_id_series"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_id_series_tenantId_name_key" ON "asset_id_series"("tenantId", "name");

-- CreateIndex
CREATE INDEX "assets_tenantId_status_idx" ON "assets"("tenantId", "status");

-- CreateIndex
CREATE INDEX "assets_assetTypeId_idx" ON "assets"("assetTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tenantId_assetTag_key" ON "assets"("tenantId", "assetTag");

-- CreateIndex
CREATE INDEX "asset_assignments_assetId_idx" ON "asset_assignments"("assetId");

-- CreateIndex
CREATE INDEX "asset_assignments_employeeId_returnedOn_idx" ON "asset_assignments"("employeeId", "returnedOn");

-- CreateIndex
CREATE INDEX "asset_requests_tenantId_status_idx" ON "asset_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "asset_requests_employeeId_idx" ON "asset_requests"("employeeId");

-- CreateIndex
CREATE INDEX "document_folders_tenantId_idx" ON "document_folders"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "document_folders_tenantId_name_key" ON "document_folders"("tenantId", "name");

-- CreateIndex
CREATE INDEX "document_types_folderId_idx" ON "document_types"("folderId");

-- CreateIndex
CREATE UNIQUE INDEX "document_types_folderId_name_key" ON "document_types"("folderId", "name");

-- CreateIndex
CREATE INDEX "employee_documents_tenantId_status_idx" ON "employee_documents"("tenantId", "status");

-- CreateIndex
CREATE INDEX "employee_documents_employeeId_idx" ON "employee_documents"("employeeId");

-- CreateIndex
CREATE INDEX "employee_documents_expiresOn_idx" ON "employee_documents"("expiresOn");

-- CreateIndex
CREATE INDEX "org_documents_tenantId_idx" ON "org_documents"("tenantId");

-- CreateIndex
CREATE INDEX "org_document_acks_employeeId_idx" ON "org_document_acks"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "org_document_acks_documentId_employeeId_key" ON "org_document_acks"("documentId", "employeeId");

-- CreateIndex
CREATE INDEX "document_templates_tenantId_category_idx" ON "document_templates"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_tenantId_name_key" ON "document_templates"("tenantId", "name");

-- CreateIndex
CREATE INDEX "generated_documents_employeeId_idx" ON "generated_documents"("employeeId");

-- CreateIndex
CREATE INDEX "generated_documents_templateId_idx" ON "generated_documents"("templateId");

-- CreateIndex
CREATE INDEX "employee_contracts_tenantId_status_idx" ON "employee_contracts"("tenantId", "status");

-- CreateIndex
CREATE INDEX "employee_contracts_employeeId_idx" ON "employee_contracts"("employeeId");

-- CreateIndex
CREATE INDEX "employee_contracts_endDate_idx" ON "employee_contracts"("endDate");

-- CreateIndex
CREATE INDEX "hr_activities_tenantId_type_occurredOn_idx" ON "hr_activities"("tenantId", "type", "occurredOn");

-- CreateIndex
CREATE INDEX "hr_activities_employeeId_occurredOn_idx" ON "hr_activities"("employeeId", "occurredOn");

-- CreateIndex
CREATE INDEX "training_types_tenantId_idx" ON "training_types"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "training_types_tenantId_name_key" ON "training_types"("tenantId", "name");

-- CreateIndex
CREATE INDEX "training_programs_tenantId_status_idx" ON "training_programs"("tenantId", "status");

-- CreateIndex
CREATE INDEX "training_enrolments_employeeId_status_idx" ON "training_enrolments"("employeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "training_enrolments_programId_employeeId_key" ON "training_enrolments"("programId", "employeeId");

-- CreateIndex
CREATE INDEX "meeting_rooms_tenantId_idx" ON "meeting_rooms"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_rooms_tenantId_name_key" ON "meeting_rooms"("tenantId", "name");

-- CreateIndex
CREATE INDEX "meetings_tenantId_startsAt_idx" ON "meetings"("tenantId", "startsAt");

-- CreateIndex
CREATE INDEX "meetings_roomId_startsAt_idx" ON "meetings"("roomId", "startsAt");

-- CreateIndex
CREATE INDEX "meeting_attendees_employeeId_idx" ON "meeting_attendees"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_attendees_meetingId_employeeId_key" ON "meeting_attendees"("meetingId", "employeeId");

-- CreateIndex
CREATE INDEX "meeting_action_items_meetingId_idx" ON "meeting_action_items"("meetingId");

-- CreateIndex
CREATE INDEX "meeting_action_items_ownerId_status_idx" ON "meeting_action_items"("ownerId", "status");

-- CreateIndex
CREATE INDEX "requisitions_tenantId_status_idx" ON "requisitions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hiring_flows_tenantId_idx" ON "hiring_flows"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "hiring_flows_tenantId_name_key" ON "hiring_flows"("tenantId", "name");

-- CreateIndex
CREATE INDEX "hiring_stages_flowId_idx" ON "hiring_stages"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "hiring_stages_flowId_sequence_key" ON "hiring_stages"("flowId", "sequence");

-- CreateIndex
CREATE INDEX "jobs_tenantId_status_idx" ON "jobs"("tenantId", "status");

-- CreateIndex
CREATE INDEX "jobs_isPublished_publishedAt_idx" ON "jobs"("isPublished", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_tenantId_code_key" ON "jobs"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_convertedEmployeeId_key" ON "candidates"("convertedEmployeeId");

-- CreateIndex
CREATE INDEX "candidates_tenantId_idx" ON "candidates"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_tenantId_email_key" ON "candidates"("tenantId", "email");

-- CreateIndex
CREATE INDEX "applications_tenantId_status_idx" ON "applications"("tenantId", "status");

-- CreateIndex
CREATE INDEX "applications_jobId_currentStageId_idx" ON "applications"("jobId", "currentStageId");

-- CreateIndex
CREATE UNIQUE INDEX "applications_jobId_candidateId_key" ON "applications"("jobId", "candidateId");

-- CreateIndex
CREATE INDEX "application_stage_history_applicationId_idx" ON "application_stage_history"("applicationId");

-- CreateIndex
CREATE INDEX "application_stage_history_stageId_idx" ON "application_stage_history"("stageId");

-- CreateIndex
CREATE INDEX "interviews_applicationId_idx" ON "interviews"("applicationId");

-- CreateIndex
CREATE INDEX "interviews_scheduledAt_idx" ON "interviews"("scheduledAt");

-- CreateIndex
CREATE INDEX "interview_panelists_employeeId_idx" ON "interview_panelists"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "interview_panelists_interviewId_employeeId_key" ON "interview_panelists"("interviewId", "employeeId");

-- CreateIndex
CREATE INDEX "scorecards_interviewId_idx" ON "scorecards"("interviewId");

-- CreateIndex
CREATE UNIQUE INDEX "scorecards_interviewId_panelistId_key" ON "scorecards"("interviewId", "panelistId");

-- CreateIndex
CREATE UNIQUE INDEX "offers_applicationId_key" ON "offers"("applicationId");

-- CreateIndex
CREATE INDEX "offers_status_idx" ON "offers"("status");

-- CreateIndex
CREATE INDEX "bgv_checks_tenantId_status_idx" ON "bgv_checks"("tenantId", "status");

-- CreateIndex
CREATE INDEX "bgv_checks_employeeId_idx" ON "bgv_checks"("employeeId");

-- CreateIndex
CREATE INDEX "indicator_categories_tenantId_idx" ON "indicator_categories"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "indicator_categories_tenantId_name_key" ON "indicator_categories"("tenantId", "name");

-- CreateIndex
CREATE INDEX "performance_indicators_categoryId_idx" ON "performance_indicators"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "performance_indicators_categoryId_name_key" ON "performance_indicators"("categoryId", "name");

-- CreateIndex
CREATE INDEX "goal_types_tenantId_idx" ON "goal_types"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "goal_types_tenantId_name_key" ON "goal_types"("tenantId", "name");

-- CreateIndex
CREATE INDEX "goals_tenantId_status_idx" ON "goals"("tenantId", "status");

-- CreateIndex
CREATE INDEX "goals_employeeId_dueDate_idx" ON "goals"("employeeId", "dueDate");

-- CreateIndex
CREATE INDEX "goals_parentGoalId_idx" ON "goals"("parentGoalId");

-- CreateIndex
CREATE INDEX "goal_check_ins_goalId_recordedAt_idx" ON "goal_check_ins"("goalId", "recordedAt");

-- CreateIndex
CREATE INDEX "review_cycles_tenantId_status_idx" ON "review_cycles"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_cycles_tenantId_name_key" ON "review_cycles"("tenantId", "name");

-- CreateIndex
CREATE INDEX "employee_reviews_cycleId_status_idx" ON "employee_reviews"("cycleId", "status");

-- CreateIndex
CREATE INDEX "employee_reviews_employeeId_idx" ON "employee_reviews"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_reviews_cycleId_employeeId_key" ON "employee_reviews"("cycleId", "employeeId");

-- CreateIndex
CREATE INDEX "review_responses_reviewerId_submittedAt_idx" ON "review_responses"("reviewerId", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "review_responses_reviewId_reviewerId_reviewerType_key" ON "review_responses"("reviewId", "reviewerId", "reviewerType");

-- CreateIndex
CREATE INDEX "indicator_ratings_reviewId_idx" ON "indicator_ratings"("reviewId");

-- CreateIndex
CREATE INDEX "indicator_ratings_indicatorId_idx" ON "indicator_ratings"("indicatorId");

-- CreateIndex
CREATE INDEX "performance_bands_cycleId_idx" ON "performance_bands"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "performance_bands_cycleId_name_key" ON "performance_bands"("cycleId", "name");

-- CreateIndex
CREATE INDEX "improvement_plans_tenantId_status_idx" ON "improvement_plans"("tenantId", "status");

-- CreateIndex
CREATE INDEX "improvement_plans_employeeId_idx" ON "improvement_plans"("employeeId");

-- CreateIndex
CREATE INDEX "skills_tenantId_idx" ON "skills"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "skills_tenantId_name_key" ON "skills"("tenantId", "name");

-- CreateIndex
CREATE INDEX "employee_skills_skillId_idx" ON "employee_skills"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_skills_employeeId_skillId_key" ON "employee_skills"("employeeId", "skillId");

-- CreateIndex
CREATE INDEX "clients_tenantId_idx" ON "clients"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tenantId_name_key" ON "clients"("tenantId", "name");

-- CreateIndex
CREATE INDEX "projects_tenantId_status_idx" ON "projects"("tenantId", "status");

-- CreateIndex
CREATE INDEX "projects_clientId_idx" ON "projects"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_tenantId_name_key" ON "projects"("tenantId", "name");

-- CreateIndex
CREATE INDEX "project_phases_projectId_idx" ON "project_phases"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_phases_projectId_name_key" ON "project_phases"("projectId", "name");

-- CreateIndex
CREATE INDEX "milestones_projectId_status_idx" ON "milestones"("projectId", "status");

-- CreateIndex
CREATE INDEX "tasks_tenantId_status_idx" ON "tasks"("tenantId", "status");

-- CreateIndex
CREATE INDEX "tasks_projectId_status_idx" ON "tasks"("projectId", "status");

-- CreateIndex
CREATE INDEX "tasks_assigneeId_status_idx" ON "tasks"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "task_comments_taskId_createdAt_idx" ON "task_comments"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "rate_cards_tenantId_idx" ON "rate_cards"("tenantId");

-- CreateIndex
CREATE INDEX "rate_cards_clientId_idx" ON "rate_cards"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "rate_cards_tenantId_name_key" ON "rate_cards"("tenantId", "name");

-- CreateIndex
CREATE INDEX "billing_rates_rateCardId_idx" ON "billing_rates"("rateCardId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_rates_rateCardId_billingRole_rateCategory_key" ON "billing_rates"("rateCardId", "billingRole", "rateCategory");

-- CreateIndex
CREATE INDEX "resource_allocations_employeeId_startDate_idx" ON "resource_allocations"("employeeId", "startDate");

-- CreateIndex
CREATE INDEX "resource_allocations_projectId_idx" ON "resource_allocations"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "resource_allocations_projectId_employeeId_startDate_key" ON "resource_allocations"("projectId", "employeeId", "startDate");

-- CreateIndex
CREATE INDEX "timesheets_tenantId_status_idx" ON "timesheets"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "timesheets_employeeId_periodStart_key" ON "timesheets"("employeeId", "periodStart");

-- CreateIndex
CREATE INDEX "time_entries_tenantId_date_idx" ON "time_entries"("tenantId", "date");

-- CreateIndex
CREATE INDEX "time_entries_employeeId_date_idx" ON "time_entries"("employeeId", "date");

-- CreateIndex
CREATE INDEX "time_entries_projectId_date_idx" ON "time_entries"("projectId", "date");

-- CreateIndex
CREATE INDEX "time_entries_timesheetId_idx" ON "time_entries"("timesheetId");

-- CreateIndex
CREATE INDEX "invoices_tenantId_status_idx" ON "invoices"("tenantId", "status");

-- CreateIndex
CREATE INDEX "invoices_clientId_idx" ON "invoices"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_invoiceNumber_key" ON "invoices"("tenantId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "invoice_lines_invoiceId_idx" ON "invoice_lines"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_payments_invoiceId_idx" ON "invoice_payments"("invoiceId");

-- CreateIndex
CREATE INDEX "accounts_tenantId_accountClass_idx" ON "accounts"("tenantId", "accountClass");

-- CreateIndex
CREATE INDEX "accounts_parentId_idx" ON "accounts"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenantId_code_key" ON "accounts"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_reversedById_key" ON "ledger_entries"("reversedById");

-- CreateIndex
CREATE INDEX "ledger_entries_tenantId_entryDate_idx" ON "ledger_entries"("tenantId", "entryDate");

-- CreateIndex
CREATE INDEX "ledger_entries_tenantId_status_idx" ON "ledger_entries"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ledger_entries_sourceRefType_sourceRefId_idx" ON "ledger_entries"("sourceRefType", "sourceRefId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_tenantId_entryNumber_key" ON "ledger_entries"("tenantId", "entryNumber");

-- CreateIndex
CREATE INDEX "ledger_lines_entryId_idx" ON "ledger_lines"("entryId");

-- CreateIndex
CREATE INDEX "ledger_lines_accountId_idx" ON "ledger_lines"("accountId");

-- CreateIndex
CREATE INDEX "ledger_lines_employeeId_idx" ON "ledger_lines"("employeeId");

-- CreateIndex
CREATE INDEX "accounting_periods_tenantId_startDate_idx" ON "accounting_periods"("tenantId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_periods_tenantId_code_legalEntityId_key" ON "accounting_periods"("tenantId", "code", "legalEntityId");

-- CreateIndex
CREATE INDEX "expense_categories_tenantId_idx" ON "expense_categories"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_tenantId_name_key" ON "expense_categories"("tenantId", "name");

-- CreateIndex
CREATE INDEX "expense_policies_tenantId_idx" ON "expense_policies"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_policies_tenantId_name_key" ON "expense_policies"("tenantId", "name");

-- CreateIndex
CREATE INDEX "expense_policy_categories_policyId_idx" ON "expense_policy_categories"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_policy_categories_policyId_categoryId_key" ON "expense_policy_categories"("policyId", "categoryId");

-- CreateIndex
CREATE INDEX "expense_claims_tenantId_stage_idx" ON "expense_claims"("tenantId", "stage");

-- CreateIndex
CREATE INDEX "expense_claims_employeeId_idx" ON "expense_claims"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claims_tenantId_claimNumber_key" ON "expense_claims"("tenantId", "claimNumber");

-- CreateIndex
CREATE INDEX "expense_claim_lines_claimId_idx" ON "expense_claim_lines"("claimId");

-- CreateIndex
CREATE INDEX "expense_claim_lines_categoryId_idx" ON "expense_claim_lines"("categoryId");

-- CreateIndex
CREATE INDEX "cash_advances_tenantId_status_idx" ON "cash_advances"("tenantId", "status");

-- CreateIndex
CREATE INDEX "cash_advances_employeeId_idx" ON "cash_advances"("employeeId");

-- CreateIndex
CREATE INDEX "travel_requests_tenantId_status_idx" ON "travel_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "travel_requests_employeeId_idx" ON "travel_requests"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "travel_requests_tenantId_requestNumber_key" ON "travel_requests"("tenantId", "requestNumber");

-- AddForeignKey
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_awards" ADD CONSTRAINT "employee_awards_awardTypeId_fkey" FOREIGN KEY ("awardTypeId") REFERENCES "award_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_awards" ADD CONSTRAINT "employee_awards_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "praises" ADD CONSTRAINT "praises_fromEmployeeId_fkey" FOREIGN KEY ("fromEmployeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "praises" ADD CONSTRAINT "praises_toEmployeeId_fkey" FOREIGN KEY ("toEmployeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "asset_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_assetTypeId_fkey" FOREIGN KEY ("assetTypeId") REFERENCES "asset_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_requests" ADD CONSTRAINT "asset_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_requests" ADD CONSTRAINT "asset_requests_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "document_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "document_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_documentTypeId_fkey" FOREIGN KEY ("documentTypeId") REFERENCES "document_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_documents" ADD CONSTRAINT "org_documents_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "document_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_document_acks" ADD CONSTRAINT "org_document_acks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "org_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_document_acks" ADD CONSTRAINT "org_document_acks_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "document_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_renewedFromId_fkey" FOREIGN KEY ("renewedFromId") REFERENCES "employee_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_activities" ADD CONSTRAINT "hr_activities_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_trainingTypeId_fkey" FOREIGN KEY ("trainingTypeId") REFERENCES "training_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_enrolments" ADD CONSTRAINT "training_enrolments_programId_fkey" FOREIGN KEY ("programId") REFERENCES "training_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_enrolments" ADD CONSTRAINT "training_enrolments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "meeting_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_replacingEmployeeId_fkey" FOREIGN KEY ("replacingEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hiring_stages" ADD CONSTRAINT "hiring_stages_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "hiring_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "requisitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "hiring_flows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_stage_history" ADD CONSTRAINT "application_stage_history_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_stage_history" ADD CONSTRAINT "application_stage_history_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "hiring_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_panelists" ADD CONSTRAINT "interview_panelists_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_panelists" ADD CONSTRAINT "interview_panelists_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bgv_checks" ADD CONSTRAINT "bgv_checks_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_indicators" ADD CONSTRAINT "performance_indicators_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "indicator_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_goalTypeId_fkey" FOREIGN KEY ("goalTypeId") REFERENCES "goal_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_parentGoalId_fkey" FOREIGN KEY ("parentGoalId") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_check_ins" ADD CONSTRAINT "goal_check_ins_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_reviews" ADD CONSTRAINT "employee_reviews_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_reviews" ADD CONSTRAINT "employee_reviews_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_reviews" ADD CONSTRAINT "employee_reviews_bandId_fkey" FOREIGN KEY ("bandId") REFERENCES "performance_bands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "employee_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indicator_ratings" ADD CONSTRAINT "indicator_ratings_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "employee_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indicator_ratings" ADD CONSTRAINT "indicator_ratings_indicatorId_fkey" FOREIGN KEY ("indicatorId") REFERENCES "performance_indicators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_bands" ADD CONSTRAINT "performance_bands_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "improvement_plans" ADD CONSTRAINT "improvement_plans_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_projectManagerId_fkey" FOREIGN KEY ("projectManagerId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "project_phases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_rates" ADD CONSTRAINT "billing_rates_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "rate_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "timesheets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ledger_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_policy_categories" ADD CONSTRAINT "expense_policy_categories_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "expense_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_policy_categories" ADD CONSTRAINT "expense_policy_categories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "expense_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "expense_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "expense_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_advances" ADD CONSTRAINT "cash_advances_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
