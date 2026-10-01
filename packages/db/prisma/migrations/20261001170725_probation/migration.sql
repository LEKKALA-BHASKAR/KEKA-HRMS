-- CreateEnum
CREATE TYPE "ProbationCompletion" AS ENUM ('EVALUATION', 'AUTO_CONFIRM');

-- CreateEnum
CREATE TYPE "ProbationStatus" AS ENUM ('ACTIVE', 'IN_REVIEW', 'CONFIRMED', 'NOT_CONFIRMED');

-- CreateEnum
CREATE TYPE "ProbationEvaluatorRole" AS ENUM ('MANAGER', 'SELF');

-- CreateEnum
CREATE TYPE "ProbationEvaluationStatus" AS ENUM ('PENDING', 'SUBMITTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ProbationRecommendation" AS ENUM ('CONFIRM', 'EXTEND', 'NOT_CONFIRM');

-- CreateTable
CREATE TABLE "probation_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "durationDays" INTEGER NOT NULL,
    "maxExtensions" INTEGER NOT NULL DEFAULT 1,
    "extensionDays" INTEGER NOT NULL DEFAULT 30,
    "completion" "ProbationCompletion" NOT NULL DEFAULT 'EVALUATION',
    "reviewLeadDays" INTEGER NOT NULL DEFAULT 15,
    "selfReview" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "probation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_probations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "originalEndDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "extensions" INTEGER NOT NULL DEFAULT 0,
    "status" "ProbationStatus" NOT NULL DEFAULT 'ACTIVE',
    "round" INTEGER NOT NULL DEFAULT 1,
    "reviewOpenedAt" TIMESTAMP(3),
    "decision" "ProbationRecommendation",
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "confirmedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_probations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "probation_evaluations" (
    "id" TEXT NOT NULL,
    "probationId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "role" "ProbationEvaluatorRole" NOT NULL,
    "evaluatorId" TEXT NOT NULL,
    "status" "ProbationEvaluationStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" DATE NOT NULL,
    "rating" INTEGER,
    "recommendation" "ProbationRecommendation",
    "strengths" TEXT,
    "improvements" TEXT,
    "comments" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "probation_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "probation_policies_tenantId_name_key" ON "probation_policies"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "employee_probations_employeeId_key" ON "employee_probations"("employeeId");

-- CreateIndex
CREATE INDEX "employee_probations_tenantId_status_idx" ON "employee_probations"("tenantId", "status");

-- CreateIndex
CREATE INDEX "employee_probations_tenantId_endDate_idx" ON "employee_probations"("tenantId", "endDate");

-- CreateIndex
CREATE INDEX "probation_evaluations_evaluatorId_status_idx" ON "probation_evaluations"("evaluatorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "probation_evaluations_probationId_round_role_key" ON "probation_evaluations"("probationId", "round", "role");

-- AddForeignKey
ALTER TABLE "probation_policies" ADD CONSTRAINT "probation_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_probations" ADD CONSTRAINT "employee_probations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_probations" ADD CONSTRAINT "employee_probations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_probations" ADD CONSTRAINT "employee_probations_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "probation_policies"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "probation_evaluations" ADD CONSTRAINT "probation_evaluations_probationId_fkey" FOREIGN KEY ("probationId") REFERENCES "employee_probations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "probation_evaluations" ADD CONSTRAINT "probation_evaluations_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
