-- CreateEnum
CREATE TYPE "SalaryHoldStatus" AS ENUM ('HELD', 'RELEASED');

-- CreateEnum
CREATE TYPE "PaymentBatchStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PaymentItemStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- AlterTable
ALTER TABLE "employee_bank_accounts" ADD COLUMN     "verifiedBy" TEXT;

-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN     "attendanceFrom" TIMESTAMP(3),
ADD COLUMN     "attendanceTo" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payroll_run_employees" ADD COLUMN     "attendanceLopDays" DECIMAL(9,2),
ADD COLUMN     "carriedLopDays" DECIMAL(9,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tds_challans" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "month" INTEGER,
ADD COLUMN     "payGroupId" TEXT,
ADD COLUMN     "year" INTEGER;

-- AlterTable
ALTER TABLE "lop_adjustments" ADD COLUMN     "amount" DECIMAL(18,2);

-- CreateTable
CREATE TABLE "salary_holds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT,
    "status" "SalaryHoldStatus" NOT NULL DEFAULT 'HELD',
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heldBy" TEXT,
    "releaseRunId" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "releaseNote" TEXT,

    CONSTRAINT "salary_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "PaymentBatchStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "payment_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_batch_items" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "salaryHoldId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "ifsc" TEXT,
    "accountVerified" BOOLEAN NOT NULL DEFAULT false,
    "status" "PaymentItemStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "failureReason" TEXT,
    "markedAt" TIMESTAMP(3),
    "markedBy" TEXT,

    CONSTRAINT "payment_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "salary_holds_tenantId_status_idx" ON "salary_holds"("tenantId", "status");

-- CreateIndex
CREATE INDEX "salary_holds_releaseRunId_idx" ON "salary_holds"("releaseRunId");

-- CreateIndex
CREATE UNIQUE INDEX "salary_holds_runId_employeeId_key" ON "salary_holds"("runId", "employeeId");

-- CreateIndex
CREATE INDEX "payment_batches_tenantId_idx" ON "payment_batches"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_batches_runId_number_key" ON "payment_batches"("runId", "number");

-- CreateIndex
CREATE INDEX "payment_batch_items_batchId_idx" ON "payment_batch_items"("batchId");

-- CreateIndex
CREATE INDEX "payment_batch_items_employeeId_idx" ON "payment_batch_items"("employeeId");

-- CreateIndex
CREATE INDEX "tds_challans_tenantId_year_month_idx" ON "tds_challans"("tenantId", "year", "month");

-- AddForeignKey
ALTER TABLE "salary_holds" ADD CONSTRAINT "salary_holds_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_holds" ADD CONSTRAINT "salary_holds_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_holds" ADD CONSTRAINT "salary_holds_releaseRunId_fkey" FOREIGN KEY ("releaseRunId") REFERENCES "payroll_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "payment_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_salaryHoldId_fkey" FOREIGN KEY ("salaryHoldId") REFERENCES "salary_holds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

