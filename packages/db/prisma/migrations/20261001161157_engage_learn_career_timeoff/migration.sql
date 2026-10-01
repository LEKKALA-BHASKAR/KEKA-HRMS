-- CreateEnum
CREATE TYPE "SurveyKind" AS ENUM ('PULSE', 'ENGAGEMENT', 'ENPS', 'POLL');

-- CreateEnum
CREATE TYPE "SurveyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "SurveyQuestionType" AS ENUM ('RATING', 'NPS', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'TEXT');

-- CreateEnum
CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CourseLevel" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED');

-- CreateEnum
CREATE TYPE "LessonKind" AS ENUM ('ARTICLE', 'VIDEO', 'DOCUMENT', 'QUIZ');

-- CreateEnum
CREATE TYPE "CourseEnrolmentStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TimeOffRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "surveys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" "SurveyKind" NOT NULL,
    "status" "SurveyStatus" NOT NULL DEFAULT 'DRAFT',
    "isAnonymous" BOOLEAN NOT NULL DEFAULT true,
    "minGroupSize" INTEGER NOT NULL DEFAULT 3,
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "launchedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_questions" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "type" "SurveyQuestionType" NOT NULL,
    "driver" TEXT,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "survey_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_participants" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_responses" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "employeeId" TEXT,
    "departmentId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_answers" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "score" INTEGER,
    "choices" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "text" TEXT,

    CONSTRAINT "survey_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "category" TEXT NOT NULL,
    "level" "CourseLevel" NOT NULL DEFAULT 'BEGINNER',
    "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "dueInDays" INTEGER,
    "passPercent" INTEGER NOT NULL DEFAULT 70,
    "skillId" TEXT,
    "skillLevel" INTEGER NOT NULL DEFAULT 1,
    "coverColour" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_lessons" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "LessonKind" NOT NULL,
    "body" TEXT,
    "url" TEXT,
    "durationMinutes" INTEGER NOT NULL DEFAULT 5,

    CONSTRAINT "course_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_questions" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" TEXT[],
    "correctIndex" INTEGER NOT NULL,

    CONSTRAINT "quiz_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_enrolments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "CourseEnrolmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "source" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "assignedBy" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER,

    CONSTRAINT "course_enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_progress" (
    "id" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "score" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "lesson_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_paths" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "departmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "career_paths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_path_steps" (
    "id" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "minYears" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "career_path_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_step_skills" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "career_step_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_aspirations" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "career_aspirations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_off_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workedOn" DATE NOT NULL,
    "days" DECIMAL(4,1) NOT NULL,
    "reason" TEXT NOT NULL,
    "dayType" TEXT NOT NULL,
    "status" "TimeOffRequestStatus" NOT NULL DEFAULT 'PENDING',
    "expiresOn" DATE,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comp_off_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_encashment_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "days" DECIMAL(9,2) NOT NULL,
    "perDayRate" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "basis" TEXT NOT NULL,
    "reason" TEXT,
    "status" "TimeOffRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "adhocId" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_encashment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "surveys_tenantId_status_idx" ON "surveys"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "survey_questions_surveyId_sequence_key" ON "survey_questions"("surveyId", "sequence");

-- CreateIndex
CREATE INDEX "survey_participants_employeeId_idx" ON "survey_participants"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "survey_participants_surveyId_employeeId_key" ON "survey_participants"("surveyId", "employeeId");

-- CreateIndex
CREATE INDEX "survey_responses_surveyId_idx" ON "survey_responses"("surveyId");

-- CreateIndex
CREATE INDEX "survey_answers_questionId_idx" ON "survey_answers"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "survey_answers_responseId_questionId_key" ON "survey_answers"("responseId", "questionId");

-- CreateIndex
CREATE INDEX "courses_tenantId_status_idx" ON "courses"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenantId_title_key" ON "courses"("tenantId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "course_lessons_courseId_sequence_key" ON "course_lessons"("courseId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_questions_lessonId_sequence_key" ON "quiz_questions"("lessonId", "sequence");

-- CreateIndex
CREATE INDEX "course_enrolments_employeeId_status_idx" ON "course_enrolments"("employeeId", "status");

-- CreateIndex
CREATE INDEX "course_enrolments_tenantId_status_idx" ON "course_enrolments"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "course_enrolments_courseId_employeeId_key" ON "course_enrolments"("courseId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_progress_enrolmentId_lessonId_key" ON "lesson_progress"("enrolmentId", "lessonId");

-- CreateIndex
CREATE UNIQUE INDEX "career_paths_tenantId_name_key" ON "career_paths"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "career_path_steps_pathId_sequence_key" ON "career_path_steps"("pathId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "career_step_skills_stepId_skillId_key" ON "career_step_skills"("stepId", "skillId");

-- CreateIndex
CREATE UNIQUE INDEX "career_aspirations_employeeId_key" ON "career_aspirations"("employeeId");

-- CreateIndex
CREATE INDEX "comp_off_requests_tenantId_status_idx" ON "comp_off_requests"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "comp_off_requests_employeeId_workedOn_key" ON "comp_off_requests"("employeeId", "workedOn");

-- CreateIndex
CREATE INDEX "leave_encashment_requests_tenantId_status_idx" ON "leave_encashment_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "leave_encashment_requests_employeeId_idx" ON "leave_encashment_requests"("employeeId");

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "survey_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "survey_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_lessons" ADD CONSTRAINT "course_lessons_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "course_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrolments" ADD CONSTRAINT "course_enrolments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrolments" ADD CONSTRAINT "course_enrolments_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_enrolments" ADD CONSTRAINT "course_enrolments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "course_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "course_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_paths" ADD CONSTRAINT "career_paths_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_path_steps" ADD CONSTRAINT "career_path_steps_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "career_paths"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_step_skills" ADD CONSTRAINT "career_step_skills_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "career_path_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_step_skills" ADD CONSTRAINT "career_step_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_aspirations" ADD CONSTRAINT "career_aspirations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_aspirations" ADD CONSTRAINT "career_aspirations_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "career_path_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_off_requests" ADD CONSTRAINT "comp_off_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comp_off_requests" ADD CONSTRAINT "comp_off_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_encashment_requests" ADD CONSTRAINT "leave_encashment_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_encashment_requests" ADD CONSTRAINT "leave_encashment_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
