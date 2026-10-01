-- AlterEnum
ALTER TYPE "InstallmentStatus" ADD VALUE 'PREPAID';

-- AlterTable
ALTER TABLE "loans" ADD COLUMN     "decisionNote" TEXT;
