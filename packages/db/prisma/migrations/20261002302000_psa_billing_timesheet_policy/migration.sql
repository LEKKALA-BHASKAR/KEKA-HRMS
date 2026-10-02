-- CreateEnum
CREATE TYPE "TimesheetApprover" AS ENUM ('EITHER', 'LINE_MANAGER', 'PROJECT_MANAGER');

-- CreateEnum
CREATE TYPE "TimesheetRounding" AS ENUM ('REJECT', 'NEAREST', 'UP');

-- CreateEnum
CREATE TYPE "TimesheetApprovalChain" AS ENUM ('EITHER', 'LINE_MANAGER', 'PROJECT_MANAGER', 'LINE_THEN_PROJECT');

-- CreateEnum
CREATE TYPE "TimesheetReminderKind" AS ENUM ('REMINDER', 'ESCALATION');

-- AlterTable
ALTER TABLE "timesheets" ADD COLUMN     "approvalStep" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "autoApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "awaiting" "TimesheetApprover" NOT NULL DEFAULT 'EITHER',
ADD COLUMN     "firstApprovedBy" TEXT;

-- AlterTable
ALTER TABLE "psa_settings" ADD COLUMN     "tsApprovalChain" "TimesheetApprovalChain" NOT NULL DEFAULT 'EITHER',
ADD COLUMN     "tsAutoApprove" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tsAutoApproveMaxHours" DECIMAL(6,2),
ADD COLUMN     "tsEscalateAfterDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "tsEscalationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tsFlagWeeklyHoursAbove" DECIMAL(6,2) NOT NULL DEFAULT 50,
ADD COLUMN     "tsIncrementMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "tsMaxHoursPerDay" DECIMAL(5,2) NOT NULL DEFAULT 24,
ADD COLUMN     "tsMaxHoursPerWeek" DECIMAL(6,2),
ADD COLUMN     "tsMinHoursPerDay" DECIMAL(5,2),
ADD COLUMN     "tsMinHoursPerWeek" DECIMAL(6,2),
ADD COLUMN     "tsReminderAfterDays" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "tsRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tsRounding" "TimesheetRounding" NOT NULL DEFAULT 'REJECT';

-- CreateTable
CREATE TABLE "timesheet_reminders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "kind" "TimesheetReminderKind" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timesheet_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "timesheet_reminders_tenantId_periodStart_idx" ON "timesheet_reminders"("tenantId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_reminders_employeeId_periodStart_kind_key" ON "timesheet_reminders"("employeeId", "periodStart", "kind");

-- AddForeignKey
ALTER TABLE "timesheet_reminders" ADD CONSTRAINT "timesheet_reminders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

