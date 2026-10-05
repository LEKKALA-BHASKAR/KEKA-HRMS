-- AlterTable
ALTER TABLE "business_units" ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "plCode" TEXT;

-- AlterTable
ALTER TABLE "cost_centers" ADD COLUMN     "legalEntityId" TEXT,
ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "employee_number_series" ADD COLUMN     "legalEntityId" TEXT;

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "parentId" TEXT;

-- CreateTable
CREATE TABLE "config_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'PRODUCTION',
    "kind" TEXT NOT NULL DEFAULT 'CHECKPOINT',
    "payload" JSONB NOT NULL,
    "summary" JSONB,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),
    "restoredBy" TEXT,

    CONSTRAINT "config_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branding_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "portalTitle" TEXT NOT NULL,
    "primaryColor" TEXT NOT NULL DEFAULT '#1266a8',
    "accentColor" TEXT NOT NULL DEFAULT '#0f8a5f',
    "logoText" TEXT,
    "welcomeMessage" TEXT,
    "legalEntityId" TEXT,
    "businessUnitId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branding_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "country_availability" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "countryName" TEXT NOT NULL,
    "modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currency" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "country_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_dictionaries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_dictionaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_dictionary_entries" (
    "id" TEXT NOT NULL,
    "dictionaryId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "master_dictionary_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_status_catalog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "baseStatus" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#6b7280',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_status_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_status_tags" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "setBy" TEXT,

    CONSTRAINT "employee_status_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_functions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "parentId" TEXT,
    "description" TEXT,
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_functions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_unit_metadata_fields" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitType" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL DEFAULT 'TEXT',
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "inheritable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_unit_metadata_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_unit_metadata_values" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitType" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_unit_metadata_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "headcount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reorg_scenarios" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "moves" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "appliedBy" TEXT,

    CONSTRAINT "reorg_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_packs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_pack_assignments" (
    "id" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "unitType" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_pack_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_tax_registrations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "stateCode" TEXT,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_tax_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_holiday_calendars" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "holidayCalendarId" TEXT NOT NULL,

    CONSTRAINT "entity_holiday_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_payroll_calendars" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "inputCutoff" TIMESTAMP(3) NOT NULL,
    "payDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "note" TEXT,

    CONSTRAINT "entity_payroll_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intercompany_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "homeEntityId" TEXT NOT NULL,
    "hostEntityId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "allocationPct" INTEGER NOT NULL DEFAULT 100,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intercompany_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_unit_jurisdictions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessUnitId" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "taxType" TEXT NOT NULL,
    "registrationNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_unit_jurisdictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "fileId" TEXT,
    "reference" TEXT,
    "validUntil" TIMESTAMP(3),
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_compliance_deadlines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'STATUTORY',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "recurrence" TEXT NOT NULL DEFAULT 'NONE',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "ownerUserId" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_compliance_deadlines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_transitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceEntityId" TEXT,
    "targetEntityId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "mapping" JSONB NOT NULL DEFAULT '[]',
    "deactivateSource" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "stepsDone" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "entity_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_transfer_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromEntityId" TEXT,
    "toEntityId" TEXT,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "minNoticeDays" INTEGER NOT NULL DEFAULT 0,
    "carryForwardLeave" BOOLEAN NOT NULL DEFAULT true,
    "restartProbation" BOOLEAN NOT NULL DEFAULT false,
    "newEmployeeNumber" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_transfer_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_profile_extras" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "salutation" TEXT,
    "pronouns" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workAddressLine1" TEXT,
    "workAddressLine2" TEXT,
    "workCity" TEXT,
    "workState" TEXT,
    "workPostalCode" TEXT,
    "workAddressNote" TEXT,
    "hideMobile" BOOLEAN NOT NULL DEFAULT false,
    "hideBirthday" BOOLEAN NOT NULL DEFAULT false,
    "hidePersonalEmail" BOOLEAN NOT NULL DEFAULT false,
    "hideFromDirectory" BOOLEAN NOT NULL DEFAULT false,
    "personalEmailVerifiedAt" TIMESTAMP(3),
    "verifiedEmail" TEXT,
    "emailCodeHash" TEXT,
    "emailCodeExpires" TIMESTAMP(3),
    "emailCodeAttempts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_profile_extras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nationality_history" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "nationality" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "note" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nationality_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_identifiers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_completeness_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "workerTypeId" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_completeness_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nominee_allocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "dependentId" TEXT NOT NULL,
    "benefit" TEXT NOT NULL,
    "sharePct" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nominee_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "preferredChannel" TEXT NOT NULL DEFAULT 'BOTH',
    "emailMuted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inAppMuted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "digestFrequency" TEXT NOT NULL DEFAULT 'NONE',
    "digestSections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fontScale" INTEGER NOT NULL DEFAULT 100,
    "highContrast" BOOLEAN NOT NULL DEFAULT false,
    "reducedMotion" BOOLEAN NOT NULL DEFAULT false,
    "underlineLinks" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "dashboardHidden" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "response" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_card_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "cardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "id_card_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_sla_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "targetHours" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_ops_alerts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "message" TEXT NOT NULL,
    "link" TEXT,
    "employeeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "hr_ops_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_qc_samples" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "actorId" TEXT,
    "result" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "sampledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_qc_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "config_snapshots_tenantId_createdAt_idx" ON "config_snapshots"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "branding_profiles_tenantId_name_key" ON "branding_profiles"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "country_availability_tenantId_countryCode_key" ON "country_availability"("tenantId", "countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "master_dictionaries_tenantId_key_key" ON "master_dictionaries"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "master_dictionary_entries_dictionaryId_code_key" ON "master_dictionary_entries"("dictionaryId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "employee_status_catalog_tenantId_code_key" ON "employee_status_catalog"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "employee_status_tags_employeeId_key" ON "employee_status_tags"("employeeId");

-- CreateIndex
CREATE INDEX "employee_status_tags_tenantId_catalogId_idx" ON "employee_status_tags"("tenantId", "catalogId");

-- CreateIndex
CREATE UNIQUE INDEX "business_functions_tenantId_name_key" ON "business_functions"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "org_unit_metadata_fields_tenantId_unitType_key_key" ON "org_unit_metadata_fields"("tenantId", "unitType", "key");

-- CreateIndex
CREATE UNIQUE INDEX "org_unit_metadata_values_tenantId_unitType_unitId_key_key" ON "org_unit_metadata_values"("tenantId", "unitType", "unitId", "key");

-- CreateIndex
CREATE INDEX "org_snapshots_tenantId_asOf_idx" ON "org_snapshots"("tenantId", "asOf");

-- CreateIndex
CREATE INDEX "reorg_scenarios_tenantId_status_idx" ON "reorg_scenarios"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "policy_packs_tenantId_name_key" ON "policy_packs"("tenantId", "name");

-- CreateIndex
CREATE INDEX "policy_pack_assignments_unitType_unitId_idx" ON "policy_pack_assignments"("unitType", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "policy_pack_assignments_packId_unitType_unitId_key" ON "policy_pack_assignments"("packId", "unitType", "unitId");

-- CreateIndex
CREATE INDEX "entity_tax_registrations_tenantId_legalEntityId_idx" ON "entity_tax_registrations"("tenantId", "legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "entity_tax_registrations_tenantId_type_number_key" ON "entity_tax_registrations"("tenantId", "type", "number");

-- CreateIndex
CREATE INDEX "entity_holiday_calendars_tenantId_idx" ON "entity_holiday_calendars"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "entity_holiday_calendars_legalEntityId_holidayCalendarId_key" ON "entity_holiday_calendars"("legalEntityId", "holidayCalendarId");

-- CreateIndex
CREATE INDEX "entity_payroll_calendars_tenantId_idx" ON "entity_payroll_calendars"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "entity_payroll_calendars_legalEntityId_year_month_key" ON "entity_payroll_calendars"("legalEntityId", "year", "month");

-- CreateIndex
CREATE INDEX "intercompany_assignments_tenantId_status_idx" ON "intercompany_assignments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "intercompany_assignments_employeeId_idx" ON "intercompany_assignments"("employeeId");

-- CreateIndex
CREATE INDEX "business_unit_jurisdictions_tenantId_idx" ON "business_unit_jurisdictions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "business_unit_jurisdictions_businessUnitId_stateCode_taxTyp_key" ON "business_unit_jurisdictions"("businessUnitId", "stateCode", "taxType");

-- CreateIndex
CREATE INDEX "entity_documents_tenantId_legalEntityId_idx" ON "entity_documents"("tenantId", "legalEntityId");

-- CreateIndex
CREATE INDEX "entity_compliance_deadlines_tenantId_status_dueDate_idx" ON "entity_compliance_deadlines"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "entity_transitions_tenantId_status_idx" ON "entity_transitions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "entity_transfer_rules_tenantId_idx" ON "entity_transfer_rules"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profile_extras_employeeId_key" ON "employee_profile_extras"("employeeId");

-- CreateIndex
CREATE INDEX "employee_profile_extras_tenantId_idx" ON "employee_profile_extras"("tenantId");

-- CreateIndex
CREATE INDEX "nationality_history_tenantId_employeeId_idx" ON "nationality_history"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "employee_identifiers_employeeId_idx" ON "employee_identifiers"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_identifiers_tenantId_system_value_key" ON "employee_identifiers"("tenantId", "system", "value");

-- CreateIndex
CREATE INDEX "field_completeness_rules_tenantId_idx" ON "field_completeness_rules"("tenantId");

-- CreateIndex
CREATE INDEX "nominee_allocations_tenantId_employeeId_idx" ON "nominee_allocations"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "nominee_allocations_dependentId_benefit_key" ON "nominee_allocations"("dependentId", "benefit");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- CreateIndex
CREATE INDEX "user_preferences_tenantId_idx" ON "user_preferences"("tenantId");

-- CreateIndex
CREATE INDEX "privacy_requests_tenantId_status_idx" ON "privacy_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "privacy_requests_employeeId_idx" ON "privacy_requests"("employeeId");

-- CreateIndex
CREATE INDEX "id_card_requests_tenantId_status_idx" ON "id_card_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "id_card_requests_employeeId_idx" ON "id_card_requests"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_sla_policies_tenantId_transactionType_key" ON "hr_sla_policies"("tenantId", "transactionType");

-- CreateIndex
CREATE INDEX "hr_ops_alerts_tenantId_status_idx" ON "hr_ops_alerts"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hr_ops_alerts_tenantId_fingerprint_key" ON "hr_ops_alerts"("tenantId", "fingerprint");

-- CreateIndex
CREATE INDEX "hr_qc_samples_tenantId_result_idx" ON "hr_qc_samples"("tenantId", "result");

-- CreateIndex
CREATE UNIQUE INDEX "hr_qc_samples_tenantId_sourceType_sourceId_key" ON "hr_qc_samples"("tenantId", "sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "config_snapshots" ADD CONSTRAINT "config_snapshots_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branding_profiles" ADD CONSTRAINT "branding_profiles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "country_availability" ADD CONSTRAINT "country_availability_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_dictionaries" ADD CONSTRAINT "master_dictionaries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_dictionary_entries" ADD CONSTRAINT "master_dictionary_entries_dictionaryId_fkey" FOREIGN KEY ("dictionaryId") REFERENCES "master_dictionaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_status_catalog" ADD CONSTRAINT "employee_status_catalog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_status_tags" ADD CONSTRAINT "employee_status_tags_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_functions" ADD CONSTRAINT "business_functions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_unit_metadata_fields" ADD CONSTRAINT "org_unit_metadata_fields_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_unit_metadata_values" ADD CONSTRAINT "org_unit_metadata_values_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_snapshots" ADD CONSTRAINT "org_snapshots_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorg_scenarios" ADD CONSTRAINT "reorg_scenarios_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_packs" ADD CONSTRAINT "policy_packs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_pack_assignments" ADD CONSTRAINT "policy_pack_assignments_packId_fkey" FOREIGN KEY ("packId") REFERENCES "policy_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_tax_registrations" ADD CONSTRAINT "entity_tax_registrations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_holiday_calendars" ADD CONSTRAINT "entity_holiday_calendars_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_payroll_calendars" ADD CONSTRAINT "entity_payroll_calendars_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intercompany_assignments" ADD CONSTRAINT "intercompany_assignments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_unit_jurisdictions" ADD CONSTRAINT "business_unit_jurisdictions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_documents" ADD CONSTRAINT "entity_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_compliance_deadlines" ADD CONSTRAINT "entity_compliance_deadlines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_transitions" ADD CONSTRAINT "entity_transitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_transfer_rules" ADD CONSTRAINT "entity_transfer_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profile_extras" ADD CONSTRAINT "employee_profile_extras_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nationality_history" ADD CONSTRAINT "nationality_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_identifiers" ADD CONSTRAINT "employee_identifiers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_completeness_rules" ADD CONSTRAINT "field_completeness_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nominee_allocations" ADD CONSTRAINT "nominee_allocations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_card_requests" ADD CONSTRAINT "id_card_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_sla_policies" ADD CONSTRAINT "hr_sla_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_ops_alerts" ADD CONSTRAINT "hr_ops_alerts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_qc_samples" ADD CONSTRAINT "hr_qc_samples_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
