-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "noticePeriodPolicyId" TEXT;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_noticePeriodPolicyId_fkey" FOREIGN KEY ("noticePeriodPolicyId") REFERENCES "notice_period_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

