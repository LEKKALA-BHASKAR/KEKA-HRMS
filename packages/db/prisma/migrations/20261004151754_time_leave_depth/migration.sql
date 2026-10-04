-- CreateEnum
CREATE TYPE "WorkLogStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "attendance_policies" ADD COLUMN     "awolAfterDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "awolEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hoursBasis" TEXT NOT NULL DEFAULT 'EFFECTIVE',
ADD COLUMN     "newJoinerGraceDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "odMonthlyLimit" INTEGER,
ADD COLUMN     "overtimeCompOffHoursPerDay" DECIMAL(5,2) NOT NULL DEFAULT 8,
ADD COLUMN     "overtimeToCompOff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "regularisationCutoffDay" INTEGER,
ADD COLUMN     "regularisationMonthlyLimit" INTEGER,
ADD COLUMN     "remoteAllowedOnHolidays" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "remoteAllowedOnWeeklyOffs" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "remoteAttachmentRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "remoteNoticeDays" INTEGER,
ADD COLUMN     "wfhMonthlyLimit" INTEGER;

-- AlterTable
ALTER TABLE "leave_encashment_requests" ADD COLUMN     "requestedBy" TEXT;

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "advanceDays" DECIMAL(9,2) NOT NULL DEFAULT 0,
ADD COLUMN     "hours" DECIMAL(5,2),
ADD COLUMN     "startTime" TEXT;

-- AlterTable
ALTER TABLE "leave_types" ADD COLUMN     "advanceLeaveMaxDays" DECIMAL(9,2),
ADD COLUMN     "allowAdvanceLeave" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "compOffFullDayMinHours" DECIMAL(5,2),
ADD COLUMN     "compOffHalfDayMinHours" DECIMAL(5,2),
ADD COLUMN     "encashmentMinBalance" DECIMAL(9,2),
ADD COLUMN     "encashmentMonths" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "hourIncrementMinutes" INTEGER,
ADD COLUMN     "hoursPerDay" DECIMAL(5,2),
ADD COLUMN     "maxHoursPerDay" DECIMAL(5,2),
ADD COLUMN     "minHoursPerRequest" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "attendance_kiosks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locationId" TEXT,
    "token" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_kiosks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kiosk_pins" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kiosk_pins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_log_weeks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "status" "WorkLogStatus" NOT NULL DEFAULT 'DRAFT',
    "totalHours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_log_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_log_days" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "work_log_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_kiosks_token_key" ON "attendance_kiosks"("token");

-- CreateIndex
CREATE INDEX "attendance_kiosks_tenantId_idx" ON "attendance_kiosks"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_kiosks_tenantId_name_key" ON "attendance_kiosks"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "kiosk_pins_employeeId_key" ON "kiosk_pins"("employeeId");

-- CreateIndex
CREATE INDEX "kiosk_pins_tenantId_idx" ON "kiosk_pins"("tenantId");

-- CreateIndex
CREATE INDEX "work_log_weeks_tenantId_status_idx" ON "work_log_weeks"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "work_log_weeks_employeeId_weekStart_key" ON "work_log_weeks"("employeeId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "work_log_days_weekId_date_key" ON "work_log_days"("weekId", "date");

-- AddForeignKey
ALTER TABLE "attendance_kiosks" ADD CONSTRAINT "attendance_kiosks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kiosk_pins" ADD CONSTRAINT "kiosk_pins_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kiosk_pins" ADD CONSTRAINT "kiosk_pins_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_log_weeks" ADD CONSTRAINT "work_log_weeks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_log_weeks" ADD CONSTRAINT "work_log_weeks_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_log_days" ADD CONSTRAINT "work_log_days_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "work_log_weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
