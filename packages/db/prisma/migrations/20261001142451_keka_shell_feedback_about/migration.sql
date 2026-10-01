-- CreateEnum
CREATE TYPE "FeedbackKind" AS ENUM ('FEEDBACK', 'INTERNAL_NOTE');

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "aboutMe" TEXT;

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromEmployeeId" TEXT NOT NULL,
    "aboutEmployeeId" TEXT NOT NULL,
    "kind" "FeedbackKind" NOT NULL DEFAULT 'FEEDBACK',
    "topic" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_tenantId_aboutEmployeeId_idx" ON "feedback"("tenantId", "aboutEmployeeId");

-- CreateIndex
CREATE INDEX "feedback_fromEmployeeId_idx" ON "feedback"("fromEmployeeId");

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_fromEmployeeId_fkey" FOREIGN KEY ("fromEmployeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_aboutEmployeeId_fkey" FOREIGN KEY ("aboutEmployeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
