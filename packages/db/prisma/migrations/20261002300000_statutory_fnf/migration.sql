-- AlterTable
ALTER TABLE "fnf_settlements" ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedBy" TEXT;

-- AlterTable
ALTER TABLE "email_outbox" ADD COLUMN     "attachmentFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

