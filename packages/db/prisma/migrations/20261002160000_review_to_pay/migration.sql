-- AlterTable
ALTER TABLE "review_cycles" ADD COLUMN     "meritMatrix" JSONB;

-- CreateTable
CREATE TABLE "compensation_proposals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "bandName" TEXT,
    "currentCtc" DECIMAL(18,2) NOT NULL,
    "recommendedPercent" DECIMAL(9,2) NOT NULL,
    "proposedPercent" DECIMAL(9,2) NOT NULL,
    "proposedCtc" DECIMAL(18,2) NOT NULL,
    "bonusAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "proposedBy" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedBy" TEXT,
    "salaryRevisionId" TEXT,
    "bonusId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compensation_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compensation_proposals_reviewId_key" ON "compensation_proposals"("reviewId");

-- CreateIndex
CREATE INDEX "compensation_proposals_cycleId_status_idx" ON "compensation_proposals"("cycleId", "status");

-- CreateIndex
CREATE INDEX "compensation_proposals_tenantId_idx" ON "compensation_proposals"("tenantId");

-- AddForeignKey
ALTER TABLE "compensation_proposals" ADD CONSTRAINT "compensation_proposals_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_proposals" ADD CONSTRAINT "compensation_proposals_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

