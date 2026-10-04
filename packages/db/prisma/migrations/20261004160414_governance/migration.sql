-- AlterTable
ALTER TABLE "user_role_assignments" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "grantNote" TEXT;

-- AlterTable
ALTER TABLE "webhook_endpoints" ADD COLUMN     "approvalStatus" TEXT NOT NULL DEFAULT 'APPROVED';

-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "entityType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "matchDepartmentId" TEXT,
    "matchLocationId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "validations" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "approverType" TEXT NOT NULL,
    "approverRoleId" TEXT,
    "approverUserId" TEXT,
    "approverPermission" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'ANY',
    "conditionField" TEXT,
    "conditionOp" TEXT,
    "conditionValue" TEXT,
    "slaHours" INTEGER,
    "escalateTo" TEXT,
    "escalateUserId" TEXT,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "definitionId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "category" TEXT,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "amount" DECIMAL(18,2),
    "data" JSONB,
    "requesterUserId" TEXT NOT NULL,
    "subjectEmployeeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "route" JSONB,
    "lastError" TEXT,
    "decidedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "stepName" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ANY',
    "approverUserId" TEXT NOT NULL,
    "delegatedFromUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "dueAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approver_delegations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "delegatorUserId" TEXT NOT NULL,
    "delegateUserId" TEXT NOT NULL,
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3) NOT NULL,
    "entityTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approver_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL DEFAULT 0,
    "departmentId" TEXT,
    "locationId" TEXT,
    "entityType" TEXT,
    "actions" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "watermark" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actionsRun" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigneeUserId" TEXT NOT NULL,
    "dueOn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "sourceType" TEXT,
    "sourceId" TEXT,
    "subjectEmployeeId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ipAllowlistEnforced" BOOLEAN NOT NULL DEFAULT false,
    "roleChangeApproval" BOOLEAN NOT NULL DEFAULT false,
    "policyChangeApproval" BOOLEAN NOT NULL DEFAULT false,
    "webhookApproval" BOOLEAN NOT NULL DEFAULT false,
    "inactiveDays" INTEGER NOT NULL DEFAULT 90,
    "failedLoginAlert" INTEGER NOT NULL DEFAULT 5,
    "reminderHours" INTEGER NOT NULL DEFAULT 24,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "governance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_allow_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "label" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_allow_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "durationDays" INTEGER,
    "privileged" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "assignmentId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_review_campaigns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reviewerMode" TEXT NOT NULL DEFAULT 'USER',
    "reviewerUserId" TEXT,
    "roleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dueOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "closeAction" TEXT NOT NULL DEFAULT 'KEEP',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "access_review_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_review_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,

    CONSTRAINT "access_review_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "workflowRequestId" TEXT,
    "error" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_alerts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "summary" TEXT NOT NULL,
    "userId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "acknowledgedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'PURGE',
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retention_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "cutoff" TIMESTAMP(3) NOT NULL,
    "matched" INTEGER NOT NULL,
    "heldBack" INTEGER NOT NULL DEFAULT 0,
    "affected" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "sample" JSONB,
    "workflowRequestId" TEXT,
    "runBy" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_holds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "employeeId" TEXT,
    "dataType" TEXT,
    "matterRef" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,

    CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_purposes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_purposes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purposeId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "ipAddress" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'STATUTORY',
    "regulation" TEXT,
    "authority" TEXT,
    "frequency" TEXT NOT NULL DEFAULT 'ONE_TIME',
    "dueOn" TIMESTAMP(3) NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "reviewerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "evidenceFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "exceptionReason" TEXT,
    "workflowRequestId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "previousId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_campaigns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dueOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastRemindedAt" TIMESTAMP(3),
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "policy_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_findings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "source" TEXT NOT NULL DEFAULT 'INTERNAL_AUDIT',
    "complianceItemId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "correctiveAction" TEXT,
    "dueOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "escalatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closureNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_seals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "sealedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_seals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_definitions_tenantId_entityType_isCurrent_idx" ON "workflow_definitions"("tenantId", "entityType", "isCurrent");

-- CreateIndex
CREATE INDEX "workflow_definitions_tenantId_family_idx" ON "workflow_definitions"("tenantId", "family");

-- CreateIndex
CREATE INDEX "workflow_steps_definitionId_order_idx" ON "workflow_steps"("definitionId", "order");

-- CreateIndex
CREATE INDEX "workflow_requests_tenantId_status_idx" ON "workflow_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "workflow_requests_tenantId_entityType_entityId_idx" ON "workflow_requests"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "workflow_requests_requesterUserId_idx" ON "workflow_requests"("requesterUserId");

-- CreateIndex
CREATE INDEX "workflow_tasks_tenantId_approverUserId_status_idx" ON "workflow_tasks"("tenantId", "approverUserId", "status");

-- CreateIndex
CREATE INDEX "workflow_tasks_requestId_stepOrder_idx" ON "workflow_tasks"("requestId", "stepOrder");

-- CreateIndex
CREATE INDEX "workflow_tasks_status_dueAt_idx" ON "workflow_tasks"("status", "dueAt");

-- CreateIndex
CREATE INDEX "workflow_events_requestId_createdAt_idx" ON "workflow_events"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "approver_delegations_tenantId_delegatorUserId_idx" ON "approver_delegations"("tenantId", "delegatorUserId");

-- CreateIndex
CREATE INDEX "automation_rules_tenantId_status_idx" ON "automation_rules"("tenantId", "status");

-- CreateIndex
CREATE INDEX "automation_runs_tenantId_createdAt_idx" ON "automation_runs"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_ruleId_dedupeKey_key" ON "automation_runs"("ruleId", "dedupeKey");

-- CreateIndex
CREATE INDEX "work_tasks_tenantId_assigneeUserId_status_idx" ON "work_tasks"("tenantId", "assigneeUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "governance_settings_tenantId_key" ON "governance_settings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ip_allow_rules_tenantId_cidr_key" ON "ip_allow_rules"("tenantId", "cidr");

-- CreateIndex
CREATE INDEX "access_requests_tenantId_status_idx" ON "access_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "access_requests_requesterUserId_idx" ON "access_requests"("requesterUserId");

-- CreateIndex
CREATE INDEX "access_review_campaigns_tenantId_status_idx" ON "access_review_campaigns"("tenantId", "status");

-- CreateIndex
CREATE INDEX "access_review_items_campaignId_decision_idx" ON "access_review_items"("campaignId", "decision");

-- CreateIndex
CREATE INDEX "access_review_items_tenantId_reviewerUserId_decision_idx" ON "access_review_items"("tenantId", "reviewerUserId", "decision");

-- CreateIndex
CREATE INDEX "change_requests_tenantId_status_idx" ON "change_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "security_alerts_tenantId_status_idx" ON "security_alerts"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "security_alerts_tenantId_dedupeKey_key" ON "security_alerts"("tenantId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "retention_rules_tenantId_dataType_key" ON "retention_rules"("tenantId", "dataType");

-- CreateIndex
CREATE INDEX "retention_runs_ruleId_createdAt_idx" ON "retention_runs"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "legal_holds_tenantId_releasedAt_idx" ON "legal_holds"("tenantId", "releasedAt");

-- CreateIndex
CREATE INDEX "consent_purposes_tenantId_status_idx" ON "consent_purposes"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "consent_purposes_tenantId_key_version_key" ON "consent_purposes"("tenantId", "key", "version");

-- CreateIndex
CREATE INDEX "consent_records_tenantId_employeeId_idx" ON "consent_records"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "consent_records_purposeId_employeeId_key" ON "consent_records"("purposeId", "employeeId");

-- CreateIndex
CREATE INDEX "compliance_items_tenantId_status_dueOn_idx" ON "compliance_items"("tenantId", "status", "dueOn");

-- CreateIndex
CREATE INDEX "policy_campaigns_tenantId_status_idx" ON "policy_campaigns"("tenantId", "status");

-- CreateIndex
CREATE INDEX "audit_findings_tenantId_status_idx" ON "audit_findings"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "audit_seals_auditLogId_key" ON "audit_seals"("auditLogId");

-- CreateIndex
CREATE UNIQUE INDEX "audit_seals_tenantId_seq_key" ON "audit_seals"("tenantId", "seq");

-- AddForeignKey
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_requests" ADD CONSTRAINT "workflow_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_requests" ADD CONSTRAINT "workflow_requests_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "workflow_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_tasks" ADD CONSTRAINT "workflow_tasks_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "workflow_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "workflow_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approver_delegations" ADD CONSTRAINT "approver_delegations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_tasks" ADD CONSTRAINT "work_tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "governance_settings" ADD CONSTRAINT "governance_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ip_allow_rules" ADD CONSTRAINT "ip_allow_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_review_campaigns" ADD CONSTRAINT "access_review_campaigns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "access_review_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_rules" ADD CONSTRAINT "retention_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_runs" ADD CONSTRAINT "retention_runs_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "retention_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_purposes" ADD CONSTRAINT "consent_purposes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_purposeId_fkey" FOREIGN KEY ("purposeId") REFERENCES "consent_purposes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_items" ADD CONSTRAINT "compliance_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_campaigns" ADD CONSTRAINT "policy_campaigns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_seals" ADD CONSTRAINT "audit_seals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grant the new governance permissions to the existing system roles (new
-- tenants get them from @keka/rbac SYSTEM_ROLES when they are created).
INSERT INTO "role_permissions" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", p.perm
FROM "roles" r
JOIN (VALUES
  ('GLOBAL_ADMIN', 'admin.workflow.manage'), ('GLOBAL_ADMIN', 'admin.security.govern'),
  ('GLOBAL_ADMIN', 'admin.compliance.view'), ('GLOBAL_ADMIN', 'admin.compliance.manage'),
  ('HR_MANAGER', 'admin.workflow.manage'), ('HR_MANAGER', 'admin.compliance.view'), ('HR_MANAGER', 'admin.compliance.manage'),
  ('HR_EXECUTIVE', 'admin.compliance.view'),
  ('PAYROLL_ADMIN', 'admin.compliance.view')
) AS p(rolekey, perm) ON p.rolekey = r."key"
WHERE r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
