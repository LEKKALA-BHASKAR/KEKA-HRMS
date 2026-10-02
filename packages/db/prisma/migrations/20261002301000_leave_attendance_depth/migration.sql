-- AlterTable
ALTER TABLE "leave_types" ADD COLUMN     "approvalChain" JSONB;

-- AlterTable
ALTER TABLE "leave_plans" ADD COLUMN     "approvalChain" JSONB;

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "approvalLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "approvalSteps" JSONB,
ADD COLUMN     "levelSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "holiday_calendars" ADD COLUMN     "optionalHolidayQuota" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "allowanceCode" TEXT,
ADD COLUMN     "allowancePerDay" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "editReason" TEXT,
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "editedBy" TEXT,
ADD COLUMN     "manualStatus" "AttendanceStatus";

-- AlterTable
ALTER TABLE "lop_adjustments" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "shift_allowance_entries" ADD COLUMN     "allowanceCode" TEXT,
ADD COLUMN     "isGenerated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "attendance_policies" ADD COLUMN     "autoCreditCompOff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "overtimeMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 1,
ADD COLUMN     "overtimeOffDayMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 1,
ADD COLUMN     "overtimeRoundingMinutes" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "optional_holiday_selections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "holidayId" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "optional_holiday_selections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "optional_holiday_selections_tenantId_employeeId_idx" ON "optional_holiday_selections"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "optional_holiday_selections_employeeId_holidayId_key" ON "optional_holiday_selections"("employeeId", "holidayId");

-- AddForeignKey
ALTER TABLE "optional_holiday_selections" ADD CONSTRAINT "optional_holiday_selections_holidayId_fkey" FOREIGN KEY ("holidayId") REFERENCES "holidays"("id") ON DELETE CASCADE ON UPDATE CASCADE;

