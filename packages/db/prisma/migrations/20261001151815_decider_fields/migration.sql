-- AlterTable
ALTER TABLE "expense_claims" ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedBy" TEXT;

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" TEXT,
ADD COLUMN     "requestedBy" TEXT;

-- AlterTable
ALTER TABLE "timesheets" ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedBy" TEXT;
