-- AlterTable
ALTER TABLE "adhoc_transactions" ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceType" TEXT;

-- CreateIndex
CREATE INDEX "adhoc_transactions_sourceType_sourceId_idx" ON "adhoc_transactions"("sourceType", "sourceId");
