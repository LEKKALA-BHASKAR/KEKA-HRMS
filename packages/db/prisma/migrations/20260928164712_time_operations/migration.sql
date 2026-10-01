-- CreateEnum
CREATE TYPE "AttendanceRequestType" AS ENUM ('ADJUSTMENT', 'REGULARISATION', 'PARTIAL_DAY', 'WORK_FROM_HOME', 'ON_DUTY');

-- CreateEnum
CREATE TYPE "AttendanceRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeaveLedgerKind" AS ENUM ('OPENING', 'ACCRUAL', 'USED', 'REVERSAL', 'ADJUSTMENT', 'CARRY_FORWARD', 'LAPSE', 'ENCASHMENT', 'COMP_OFF_CREDIT');

-- CreateTable
CREATE TABLE "attendance_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "allowWebClockIn" BOOLEAN NOT NULL DEFAULT true,
    "allowMobileClockIn" BOOLEAN NOT NULL DEFAULT true,
    "ipAllowList" JSONB,
    "requireClockInComment" BOOLEAN NOT NULL DEFAULT false,
    "fullDayThresholdPct" INTEGER NOT NULL DEFAULT 90,
    "halfDayThresholdPct" INTEGER NOT NULL DEFAULT 50,
    "graceMinutes" INTEGER NOT NULL DEFAULT 15,
    "lateExemptPerMonth" INTEGER NOT NULL DEFAULT 3,
    "latePenaltyDays" DECIMAL(4,2) NOT NULL DEFAULT 0.5,
    "missingPunchExemptPerMonth" INTEGER NOT NULL DEFAULT 2,
    "missingPunchPenaltyDays" DECIMAL(4,2) NOT NULL DEFAULT 0.5,
    "noAttendanceIsLop" BOOLEAN NOT NULL DEFAULT true,
    "overtimeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "overtimeMinMinutes" INTEGER NOT NULL DEFAULT 30,
    "regularisationWindowDays" INTEGER NOT NULL DEFAULT 30,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_time_policies" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendancePolicyId" TEXT,
    "shiftId" TEXT,
    "weeklyOffPolicyId" TEXT,
    "holidayCalendarId" TEXT,
    "trackAttendance" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_time_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "AttendanceRequestType" NOT NULL,
    "status" "AttendanceRequestStatus" NOT NULL DEFAULT 'PENDING',
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "proposedIn" TIMESTAMP(3),
    "proposedOut" TIMESTAMP(3),
    "partialMinutes" INTEGER,
    "reason" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_ledger_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "yearStart" TIMESTAMP(3) NOT NULL,
    "kind" "LeaveLedgerKind" NOT NULL,
    "days" DECIMAL(9,2) NOT NULL,
    "periodKey" TEXT,
    "requestId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_policies_tenantId_idx" ON "attendance_policies"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_policies_tenantId_name_key" ON "attendance_policies"("tenantId", "name");

-- CreateIndex
CREATE INDEX "employee_time_policies_employeeId_effectiveFrom_idx" ON "employee_time_policies"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "attendance_requests_tenantId_status_idx" ON "attendance_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "attendance_requests_employeeId_fromDate_idx" ON "attendance_requests"("employeeId", "fromDate");

-- CreateIndex
CREATE INDEX "leave_ledger_entries_employeeId_leaveTypeId_yearStart_idx" ON "leave_ledger_entries"("employeeId", "leaveTypeId", "yearStart");

-- CreateIndex
CREATE INDEX "leave_ledger_entries_requestId_idx" ON "leave_ledger_entries"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_ledger_entries_employeeId_leaveTypeId_kind_periodKey_key" ON "leave_ledger_entries"("employeeId", "leaveTypeId", "kind", "periodKey");

-- AddForeignKey
ALTER TABLE "employee_time_policies" ADD CONSTRAINT "employee_time_policies_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_time_policies" ADD CONSTRAINT "employee_time_policies_attendancePolicyId_fkey" FOREIGN KEY ("attendancePolicyId") REFERENCES "attendance_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_requests" ADD CONSTRAINT "attendance_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_ledger_entries" ADD CONSTRAINT "leave_ledger_entries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
