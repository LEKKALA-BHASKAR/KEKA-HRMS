-- AlterTable
ALTER TABLE "engage_settings" ADD COLUMN     "surveyRetentionDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "survey_answers" ADD COLUMN     "textHiddenAt" TIMESTAMP(3),
ADD COLUMN     "textHiddenReason" TEXT;
