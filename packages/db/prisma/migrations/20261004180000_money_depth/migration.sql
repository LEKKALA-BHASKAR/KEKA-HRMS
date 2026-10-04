-- AlterTable
ALTER TABLE "dependents" ADD COLUMN     "proofUrl" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedBy" TEXT;

-- AlterTable
ALTER TABLE "loan_categories" ADD COLUMN     "emergencyMaxMonthsSalary" DECIMAL(6,2),
ADD COLUMN     "isEmergency" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "loan_policies" ADD COLUMN     "requireChangeApproval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "loan_policy_rules" ADD COLUMN     "processingFeeFlat" DECIMAL(18,2),
ADD COLUMN     "processingFeePct" DECIMAL(6,3);

-- AlterTable
ALTER TABLE "loans" ADD COLUMN     "hasTranches" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "processingFee" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "loan_installments" ADD COLUMN     "overdueAlertedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "expense_categories" ADD COLUMN     "isTaxable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "expense_policies" ADD COLUMN     "bandId" TEXT,
ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "payrollCutoffDay" INTEGER,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "supersedesId" TEXT,
ADD COLUMN     "templateKey" TEXT,
ADD COLUMN     "workflowRequestId" TEXT;

-- AlterTable
ALTER TABLE "expense_claims" ADD COLUMN     "preApprovalId" TEXT,
ADD COLUMN     "rejectCode" TEXT,
ADD COLUMN     "tripId" TEXT;

-- AlterTable
ALTER TABLE "expense_claim_lines" ADD COLUMN     "distanceKm" DECIMAL(10,1),
ADD COLUMN     "duplicateOfLineId" TEXT,
ADD COLUMN     "reasonCode" TEXT,
ADD COLUMN     "receiptCheck" TEXT,
ADD COLUMN     "receiptUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "vehicleType" TEXT;

-- AlterTable
ALTER TABLE "travel_requests" ADD COLUMN     "destinationCountry" TEXT,
ADD COLUMN     "insurancePolicyNo" TEXT,
ADD COLUMN     "insuranceProvider" TEXT,
ADD COLUMN     "insuranceValidTo" TIMESTAMP(3),
ADD COLUMN     "policyId" TEXT,
ADD COLUMN     "purposeId" TEXT,
ADD COLUMN     "riskLevel" TEXT,
ADD COLUMN     "violations" JSONB,
ADD COLUMN     "workflowRequestId" TEXT;

-- CreateTable
CREATE TABLE "expense_pre_approvals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "categoryId" TEXT,
    "estimatedAmount" DECIMAL(18,2) NOT NULL,
    "expectedDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "usedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_pre_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_rates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "workflowRequestId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_audit_samples" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "ratePct" DECIMAL(6,2) NOT NULL,
    "seed" INTEGER NOT NULL,
    "population" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_audit_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_audit_sample_items" (
    "id" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'PENDING',
    "finding" TEXT,
    "recoverAmount" DECIMAL(18,2),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "expense_audit_sample_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "bandIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "domesticFlightClass" TEXT NOT NULL DEFAULT 'ECONOMY',
    "internationalFlightClass" TEXT NOT NULL DEFAULT 'ECONOMY',
    "hotelCapPerNight" DECIMAL(18,2),
    "groundDailyCap" DECIMAL(18,2),
    "minAdvanceDays" INTEGER NOT NULL DEFAULT 0,
    "secondApprovalAbove" DECIMAL(18,2),
    "internationalNeedsSecondApproval" BOOLEAN NOT NULL DEFAULT true,
    "requireInsuranceInternational" BOOLEAN NOT NULL DEFAULT true,
    "passportValidityMonths" INTEGER NOT NULL DEFAULT 6,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "supersedesId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traveler_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "seatPreference" TEXT,
    "mealPreference" TEXT,
    "frequentFlyer" TEXT,
    "hotelPreference" TEXT,
    "passportNumber" TEXT,
    "passportExpiry" TIMESTAMP(3),
    "passportCountry" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "traveler_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_purposes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isBillable" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "trip_purposes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destination_risks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "advisory" TEXT,
    "blockTravel" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "destination_risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_bookings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "travelClass" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "cost" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "inPolicy" BOOLEAN NOT NULL DEFAULT true,
    "violation" TEXT,
    "itineraryUrl" TEXT,
    "amendedFromId" TEXT,
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "travel_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_checklist_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT,
    "fileUrl" TEXT,

    CONSTRAINT "trip_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "changes" JSONB,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_settlements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "perDiemDays" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "perDiemRate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "perDiemAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "claimsTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "bookingsTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "advanceAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "workflowRequestId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "adhocId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_tranches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "plannedOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "paidAt" TIMESTAMP(3),
    "paidBy" TEXT,

    CONSTRAINT "loan_tranches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_adjustments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(18,2),
    "details" JSONB,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "result" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_product_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_product_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT,
    "description" TEXT,
    "coverageAmount" DECIMAL(18,2),
    "monthlyPremium" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tierFactors" JSONB,
    "employerRule" TEXT NOT NULL DEFAULT 'PERCENT_OF_PREMIUM',
    "employerValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employerCap" DECIMAL(18,2),
    "eligibility" JSONB,
    "waitingPeriodDays" INTEGER NOT NULL DEFAULT 0,
    "allowedRelations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxDependents" INTEGER NOT NULL DEFAULT 0,
    "childMaxAge" INTEGER,
    "requiresDependentProof" BOOLEAN NOT NULL DEFAULT true,
    "deductionName" TEXT,
    "planYearStart" TIMESTAMP(3),
    "planYearEnd" TIMESTAMP(3),
    "renewalDate" TIMESTAMP(3),
    "previousPlanId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_enrollment_windows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OPEN',
    "opensOn" TIMESTAMP(3) NOT NULL,
    "closesOn" TIMESTAMP(3) NOT NULL,
    "planIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "employeeId" TEXT,
    "announcedAt" TIMESTAMP(3),
    "lastReminderAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_enrollment_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_enrollments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "windowId" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'EMPLOYEE',
    "dependentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contributionPct" DECIMAL(6,2),
    "employeeMonthly" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employerMonthly" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "coverageStart" TIMESTAMP(3),
    "coverageEnd" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "workflowRequestId" TEXT,
    "deductedThrough" INTEGER,
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dependent_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "dependentId" TEXT,
    "action" TEXT NOT NULL DEFAULT 'ADD',
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "proofUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dependent_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_life_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "proofUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "windowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_life_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_eligibility_exceptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ruleGaps" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_eligibility_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_deductions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'REGULAR',
    "adhocId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_carrier_files" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "result" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_carrier_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_plan_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "meritMatrix" JSONB NOT NULL,
    "defaultPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "guardrails" JSONB,
    "eligibility" JSONB,
    "budgetPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "prorate" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comp_plan_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateId" TEXT,
    "reviewCycleId" TEXT,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "meritMatrix" JSONB NOT NULL,
    "defaultPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "guardrails" JSONB,
    "eligibility" JSONB,
    "budgetPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "prorate" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflowRequestId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comp_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_plan_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "ownerEmployeeId" TEXT,
    "currentCtc" DECIMAL(18,2) NOT NULL,
    "rating" DECIMAL(9,2),
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "ineligibleReason" TEXT,
    "meritPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "promotionPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "newPayGradeId" TEXT,
    "marketPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "prorationFactor" DECIMAL(6,4) NOT NULL DEFAULT 1,
    "totalPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "newCtc" DECIMAL(18,2) NOT NULL,
    "compaBefore" DECIMAL(6,3),
    "compaAfter" DECIMAL(6,3),
    "note" TEXT,
    "exceptionStatus" TEXT NOT NULL DEFAULT 'NONE',
    "exceptionWorkflowId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "salaryRevisionId" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comp_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_budget_pools" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "ownerEmployeeId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comp_budget_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_pool_transfers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "fromPoolId" TEXT NOT NULL,
    "toPoolId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "byUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comp_pool_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_calibration_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "departmentId" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comp_calibration_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_decision_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "itemId" TEXT,
    "sessionId" TEXT,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comp_decision_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_statements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comp_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_pay_differentials" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "pct" DECIMAL(6,2) NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_pay_differentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_range_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payGradeId" TEXT NOT NULL,
    "minAnnual" DECIMAL(18,2) NOT NULL,
    "midAnnual" DECIMAL(18,2) NOT NULL,
    "maxAnnual" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_range_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_equity_cohorts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT,
    "bandId" TEXT,
    "payGradeId" TEXT,
    "designationId" TEXT,
    "locationId" TEXT,
    "thresholdPct" DECIMAL(6,2) NOT NULL DEFAULT 5,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_equity_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allowance_change_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "currentMonthly" DECIMAL(18,2),
    "newMonthly" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflowRequestId" TEXT,
    "overrideId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allowance_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_pre_approvals_tenantId_status_idx" ON "expense_pre_approvals"("tenantId", "status");

-- CreateIndex
CREATE INDEX "expense_pre_approvals_employeeId_idx" ON "expense_pre_approvals"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_pre_approvals_tenantId_number_key" ON "expense_pre_approvals"("tenantId", "number");

-- CreateIndex
CREATE INDEX "expense_rates_tenantId_kind_key_effectiveFrom_idx" ON "expense_rates"("tenantId", "kind", "key", "effectiveFrom");

-- CreateIndex
CREATE INDEX "expense_audit_samples_tenantId_createdAt_idx" ON "expense_audit_samples"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "expense_audit_sample_items_sampleId_claimId_key" ON "expense_audit_sample_items"("sampleId", "claimId");

-- CreateIndex
CREATE INDEX "travel_policies_tenantId_status_idx" ON "travel_policies"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "travel_policies_tenantId_name_key" ON "travel_policies"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "traveler_profiles_employeeId_key" ON "traveler_profiles"("employeeId");

-- CreateIndex
CREATE INDEX "traveler_profiles_tenantId_idx" ON "traveler_profiles"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_purposes_tenantId_code_key" ON "trip_purposes"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "destination_risks_tenantId_destination_key" ON "destination_risks"("tenantId", "destination");

-- CreateIndex
CREATE INDEX "travel_bookings_tenantId_tripId_idx" ON "travel_bookings"("tenantId", "tripId");

-- CreateIndex
CREATE INDEX "trip_checklist_items_tripId_idx" ON "trip_checklist_items"("tripId");

-- CreateIndex
CREATE INDEX "trip_changes_tenantId_tripId_idx" ON "trip_changes"("tenantId", "tripId");

-- CreateIndex
CREATE UNIQUE INDEX "travel_settlements_tripId_key" ON "travel_settlements"("tripId");

-- CreateIndex
CREATE INDEX "travel_settlements_tenantId_status_idx" ON "travel_settlements"("tenantId", "status");

-- CreateIndex
CREATE INDEX "loan_tranches_tenantId_idx" ON "loan_tranches"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "loan_tranches_loanId_sequence_key" ON "loan_tranches"("loanId", "sequence");

-- CreateIndex
CREATE INDEX "loan_adjustments_tenantId_loanId_idx" ON "loan_adjustments"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "loan_adjustments_tenantId_status_idx" ON "loan_adjustments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "loan_product_changes_tenantId_status_idx" ON "loan_product_changes"("tenantId", "status");

-- CreateIndex
CREATE INDEX "benefit_plans_tenantId_status_idx" ON "benefit_plans"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_plans_tenantId_code_key" ON "benefit_plans"("tenantId", "code");

-- CreateIndex
CREATE INDEX "benefit_enrollment_windows_tenantId_closesOn_idx" ON "benefit_enrollment_windows"("tenantId", "closesOn");

-- CreateIndex
CREATE INDEX "benefit_enrollments_tenantId_status_idx" ON "benefit_enrollments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "benefit_enrollments_employeeId_idx" ON "benefit_enrollments"("employeeId");

-- CreateIndex
CREATE INDEX "benefit_enrollments_planId_idx" ON "benefit_enrollments"("planId");

-- CreateIndex
CREATE INDEX "dependent_requests_tenantId_status_idx" ON "dependent_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "benefit_life_events_tenantId_status_idx" ON "benefit_life_events"("tenantId", "status");

-- CreateIndex
CREATE INDEX "benefit_eligibility_exceptions_tenantId_status_idx" ON "benefit_eligibility_exceptions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "benefit_deductions_tenantId_year_month_idx" ON "benefit_deductions"("tenantId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_deductions_enrollmentId_year_month_key" ON "benefit_deductions"("enrollmentId", "year", "month");

-- CreateIndex
CREATE INDEX "benefit_carrier_files_tenantId_planId_idx" ON "benefit_carrier_files"("tenantId", "planId");

-- CreateIndex
CREATE UNIQUE INDEX "comp_plan_templates_tenantId_name_key" ON "comp_plan_templates"("tenantId", "name");

-- CreateIndex
CREATE INDEX "comp_plans_tenantId_status_idx" ON "comp_plans"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "comp_plans_tenantId_name_key" ON "comp_plans"("tenantId", "name");

-- CreateIndex
CREATE INDEX "comp_plan_items_tenantId_idx" ON "comp_plan_items"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "comp_plan_items_planId_employeeId_key" ON "comp_plan_items"("planId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "comp_budget_pools_planId_ownerEmployeeId_key" ON "comp_budget_pools"("planId", "ownerEmployeeId");

-- CreateIndex
CREATE INDEX "comp_pool_transfers_planId_idx" ON "comp_pool_transfers"("planId");

-- CreateIndex
CREATE INDEX "comp_calibration_sessions_planId_idx" ON "comp_calibration_sessions"("planId");

-- CreateIndex
CREATE INDEX "comp_decision_logs_planId_createdAt_idx" ON "comp_decision_logs"("planId", "createdAt");

-- CreateIndex
CREATE INDEX "comp_statements_tenantId_employeeId_idx" ON "comp_statements"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "comp_statements_planId_employeeId_key" ON "comp_statements"("planId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "location_pay_differentials_tenantId_locationId_key" ON "location_pay_differentials"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "pay_range_changes_tenantId_status_idx" ON "pay_range_changes"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pay_equity_cohorts_tenantId_name_key" ON "pay_equity_cohorts"("tenantId", "name");

-- CreateIndex
CREATE INDEX "allowance_change_requests_tenantId_status_idx" ON "allowance_change_requests"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "expense_pre_approvals" ADD CONSTRAINT "expense_pre_approvals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_pre_approvals" ADD CONSTRAINT "expense_pre_approvals_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_rates" ADD CONSTRAINT "expense_rates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_audit_samples" ADD CONSTRAINT "expense_audit_samples_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_audit_sample_items" ADD CONSTRAINT "expense_audit_sample_items_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "expense_audit_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_policies" ADD CONSTRAINT "travel_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traveler_profiles" ADD CONSTRAINT "traveler_profiles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traveler_profiles" ADD CONSTRAINT "traveler_profiles_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_purposes" ADD CONSTRAINT "trip_purposes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_risks" ADD CONSTRAINT "destination_risks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_bookings" ADD CONSTRAINT "travel_bookings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_checklist_items" ADD CONSTRAINT "trip_checklist_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_changes" ADD CONSTRAINT "trip_changes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_settlements" ADD CONSTRAINT "travel_settlements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_settlements" ADD CONSTRAINT "travel_settlements_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_tranches" ADD CONSTRAINT "loan_tranches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_adjustments" ADD CONSTRAINT "loan_adjustments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_product_changes" ADD CONSTRAINT "loan_product_changes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_plans" ADD CONSTRAINT "benefit_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollment_windows" ADD CONSTRAINT "benefit_enrollment_windows_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollments" ADD CONSTRAINT "benefit_enrollments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollments" ADD CONSTRAINT "benefit_enrollments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollments" ADD CONSTRAINT "benefit_enrollments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "benefit_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependent_requests" ADD CONSTRAINT "dependent_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependent_requests" ADD CONSTRAINT "dependent_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_life_events" ADD CONSTRAINT "benefit_life_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_life_events" ADD CONSTRAINT "benefit_life_events_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_eligibility_exceptions" ADD CONSTRAINT "benefit_eligibility_exceptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_eligibility_exceptions" ADD CONSTRAINT "benefit_eligibility_exceptions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_deductions" ADD CONSTRAINT "benefit_deductions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_carrier_files" ADD CONSTRAINT "benefit_carrier_files_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_plan_templates" ADD CONSTRAINT "comp_plan_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_plans" ADD CONSTRAINT "comp_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_plan_items" ADD CONSTRAINT "comp_plan_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_plan_items" ADD CONSTRAINT "comp_plan_items_planId_fkey" FOREIGN KEY ("planId") REFERENCES "comp_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_plan_items" ADD CONSTRAINT "comp_plan_items_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_budget_pools" ADD CONSTRAINT "comp_budget_pools_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_pool_transfers" ADD CONSTRAINT "comp_pool_transfers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_calibration_sessions" ADD CONSTRAINT "comp_calibration_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_decision_logs" ADD CONSTRAINT "comp_decision_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_statements" ADD CONSTRAINT "comp_statements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_statements" ADD CONSTRAINT "comp_statements_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_pay_differentials" ADD CONSTRAINT "location_pay_differentials_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_range_changes" ADD CONSTRAINT "pay_range_changes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_equity_cohorts" ADD CONSTRAINT "pay_equity_cohorts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance_change_requests" ADD CONSTRAINT "allowance_change_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance_change_requests" ADD CONSTRAINT "allowance_change_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
