-- AlterTable
ALTER TABLE "generated_documents" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "decisionNote" TEXT,
ADD COLUMN     "issuedByUserId" TEXT,
ADD COLUMN     "signatureFileId" TEXT,
ADD COLUMN     "signedIp" TEXT,
ADD COLUMN     "signedUserAgent" TEXT,
ADD COLUMN     "signerName" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "workflow" TEXT;

-- CreateIndex
CREATE INDEX "generated_documents_status_idx" ON "generated_documents"("status");

