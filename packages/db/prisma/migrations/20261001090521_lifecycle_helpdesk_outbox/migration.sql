-- CreateEnum
CREATE TYPE "JourneyTrigger" AS ENUM ('JOINING', 'CONFIRMATION', 'PROMOTION', 'TRANSFER', 'EXIT', 'MANUAL');

-- CreateEnum
CREATE TYPE "JourneyStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskOwner" AS ENUM ('HR', 'MANAGER', 'EMPLOYEE', 'IT', 'FINANCE', 'ADMIN');

-- CreateEnum
CREATE TYPE "JourneyTaskStatus" AS ENUM ('PENDING', 'DONE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "journey_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" "JourneyTrigger" NOT NULL,
    "departmentId" TEXT,
    "locationId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journey_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journey_task_templates" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "owner" "TaskOwner" NOT NULL DEFAULT 'HR',
    "offsetDays" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "autoCheck" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "journey_task_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journeys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "templateId" TEXT,
    "trigger" "JourneyTrigger" NOT NULL,
    "title" TEXT NOT NULL,
    "anchorDate" TIMESTAMP(3) NOT NULL,
    "status" "JourneyStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "journeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journey_tasks" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "owner" "TaskOwner" NOT NULL,
    "assigneeEmployeeId" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "autoCheck" TEXT,
    "status" "JourneyTaskStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "journey_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "slaHours" INTEGER NOT NULL DEFAULT 48,
    "defaultAssigneeUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_tickets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "employeeId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeUserId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "satisfaction" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "helpdesk_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_comments" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "authorLabel" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "kind" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "htmlBody" TEXT,
    "status" "OutboxStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_files" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "employeeId" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "journey_templates_tenantId_trigger_idx" ON "journey_templates"("tenantId", "trigger");

-- CreateIndex
CREATE UNIQUE INDEX "journey_templates_tenantId_name_key" ON "journey_templates"("tenantId", "name");

-- CreateIndex
CREATE INDEX "journey_task_templates_templateId_idx" ON "journey_task_templates"("templateId");

-- CreateIndex
CREATE INDEX "journeys_tenantId_status_idx" ON "journeys"("tenantId", "status");

-- CreateIndex
CREATE INDEX "journeys_employeeId_idx" ON "journeys"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "journeys_employeeId_trigger_anchorDate_key" ON "journeys"("employeeId", "trigger", "anchorDate");

-- CreateIndex
CREATE INDEX "journey_tasks_journeyId_idx" ON "journey_tasks"("journeyId");

-- CreateIndex
CREATE INDEX "journey_tasks_assigneeEmployeeId_status_idx" ON "journey_tasks"("assigneeEmployeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_categories_tenantId_name_key" ON "helpdesk_categories"("tenantId", "name");

-- CreateIndex
CREATE INDEX "helpdesk_tickets_tenantId_status_idx" ON "helpdesk_tickets"("tenantId", "status");

-- CreateIndex
CREATE INDEX "helpdesk_tickets_employeeId_idx" ON "helpdesk_tickets"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_tickets_tenantId_number_key" ON "helpdesk_tickets"("tenantId", "number");

-- CreateIndex
CREATE INDEX "helpdesk_comments_ticketId_idx" ON "helpdesk_comments"("ticketId");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "email_outbox_status_createdAt_idx" ON "email_outbox"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_storageKey_key" ON "stored_files"("storageKey");

-- CreateIndex
CREATE INDEX "stored_files_tenantId_relatedType_relatedId_idx" ON "stored_files"("tenantId", "relatedType", "relatedId");

-- CreateIndex
CREATE INDEX "stored_files_employeeId_idx" ON "stored_files"("employeeId");

-- AddForeignKey
ALTER TABLE "journey_task_templates" ADD CONSTRAINT "journey_task_templates_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "journey_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "journey_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_tasks" ADD CONSTRAINT "journey_tasks_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_tickets" ADD CONSTRAINT "helpdesk_tickets_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_tickets" ADD CONSTRAINT "helpdesk_tickets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "helpdesk_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_comments" ADD CONSTRAINT "helpdesk_comments_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "helpdesk_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
