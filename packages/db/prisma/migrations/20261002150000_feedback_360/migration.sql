-- AlterTable
ALTER TABLE "review_cycles" ADD COLUMN     "anonymousFeedback" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxPeers" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "review_responses" ADD COLUMN     "nominatedBy" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';

