-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FOUNDATION', 'STRENGTH', 'GROWTH');

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('PASSWORD', 'MOBILE_OTP', 'MICROSOFT', 'GOOGLE');

-- CreateEnum
CREATE TYPE "TwoFactorMethod" AS ENUM ('NONE', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "AuditModule" AS ENUM ('EMPLOYEE', 'PAYROLL', 'LEAVE', 'ATTENDANCE', 'ROLE', 'AUTH', 'FINANCE');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'LOCK', 'UNLOCK', 'EXPORT', 'LOGIN', 'LOGOUT');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'DROPDOWN', 'CHECKBOX', 'MULTILINE', 'EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "CustomFieldEntity" AS ENUM ('EMPLOYEE', 'DOCUMENT', 'PROJECT', 'CLIENT');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('PREBOARDING', 'ONBOARDING', 'PROBATION', 'CONFIRMED', 'NOTICE_PERIOD', 'EXITED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('CURRENT', 'PERMANENT', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "IdentityDocType" AS ENUM ('PAN', 'AADHAAR', 'VOTER_ID', 'DRIVING_LICENCE', 'PASSPORT', 'UAN', 'ESIC_NUMBER');

-- CreateEnum
CREATE TYPE "JobChangeReason" AS ENUM ('NEW_HIRE', 'PROMOTION', 'TRANSFER', 'DEPARTMENT_CHANGE', 'LOCATION_CHANGE', 'MANAGER_CHANGE', 'CONFIRMATION', 'DEMOTION', 'WORKER_TYPE_CHANGE');

-- CreateEnum
CREATE TYPE "PayFrequency" AS ENUM ('MONTHLY', 'SEMI_MONTHLY', 'WEEKLY', 'BI_WEEKLY');

-- CreateEnum
CREATE TYPE "ComponentType" AS ENUM ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT', 'PERK');

-- CreateEnum
CREATE TYPE "CalculationType" AS ENUM ('FIXED', 'PERCENTAGE', 'FORMULA', 'BALANCE');

-- CreateEnum
CREATE TYPE "TaxTreatment" AS ENUM ('FULLY_TAXABLE', 'PARTIALLY_EXEMPT', 'FULLY_EXEMPT');

-- CreateEnum
CREATE TYPE "StructureType" AS ENUM ('RANGE_BASED', 'CUSTOM', 'DAILY_WAGE');

-- CreateEnum
CREATE TYPE "TdsMethod" AS ENUM ('AVERAGE', 'FLAT', 'NONE');

-- CreateEnum
CREATE TYPE "RevisionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'APPLIED');

-- CreateEnum
CREATE TYPE "RemunerationType" AS ENUM ('MONTHLY', 'HOURLY', 'DAILY', 'PIECE_RATE');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'PENDING_APPROVAL', 'LOCKED', 'FINALIZED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "PayrollRunType" AS ENUM ('REGULAR', 'OFF_CYCLE');

-- CreateEnum
CREATE TYPE "PayAction" AS ENUM ('PROCESS_AS_SALARY', 'HOLD_SALARY_PROCESSING', 'VOID_SALARY_PROCESSING', 'HOLD_PAYOUT', 'VOID_PAYOUT', 'ALREADY_PAID');

-- CreateEnum
CREATE TYPE "PayslipStatus" AS ENUM ('NOT_GENERATED', 'GENERATED', 'RELEASED', 'HELD');

-- CreateEnum
CREATE TYPE "PayslipLayout" AS ENUM ('THREE_SECTION', 'TWO_SECTION');

-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('LOCK_PAYROLL', 'COMPENSATION_CHANGE');

-- CreateEnum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PtFrequency" AS ENUM ('MONTHLY', 'HALF_YEARLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "LwfFrequency" AS ENUM ('MONTHLY', 'HALF_YEARLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "TaxRegime" AS ENUM ('OLD', 'NEW');

-- CreateEnum
CREATE TYPE "DeclarationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PARTIALLY_APPROVED', 'APPROVED', 'REJECTED', 'LOCKED');

-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('NOT_SUBMITTED', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "HraDeclarationMode" AS ENUM ('ANNUAL', 'MONTH_ON_MONTH');

-- CreateEnum
CREATE TYPE "FilingType" AS ENUM ('FORM_16', 'FORM_12BB', 'FORM_24Q', 'FORM_26Q', 'PF_ECR', 'ESI_ECR', 'PT_RETURN', 'LWF_RETURN');

-- CreateEnum
CREATE TYPE "FilingStatus" AS ENUM ('DRAFT', 'GENERATED', 'FILED', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "ArrearSource" AS ENUM ('BACKDATED_REVISION', 'SALARY_HOLD_RELEASE', 'LOP_REVERSAL', 'ARREAR_LOP_RECOVERY');

-- CreateEnum
CREATE TYPE "AdhocType" AS ENUM ('PAYMENT', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "AdhocTaxTreatment" AS ENUM ('TAXABLE', 'NON_TAXABLE', 'SPREAD');

-- CreateEnum
CREATE TYPE "BonusPayAction" AS ENUM ('PAY', 'ON_HOLD', 'VOID', 'PAY_OUTSIDE_PAYROLL', 'PARTIALLY_PAY');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID');

-- CreateEnum
CREATE TYPE "PerkValuationMethod" AS ENUM ('FIXED_FOR_ALL', 'FORMULA', 'PER_EMPLOYEE');

-- CreateEnum
CREATE TYPE "InterestType" AS ENUM ('FLAT', 'REDUCING', 'NONE');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'DISBURSED', 'ACTIVE', 'CLOSED', 'FORECLOSED');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('SCHEDULED', 'SKIPPED', 'DEDUCTED', 'WAIVED');

-- CreateEnum
CREATE TYPE "ExitType" AS ENUM ('RESIGNATION', 'TERMINATION', 'RETIREMENT', 'ABSCONDING', 'END_OF_CONTRACT', 'DEATH');

-- CreateEnum
CREATE TYPE "ExitStatus" AS ENUM ('INITIATED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'IN_CLEARANCE', 'SETTLED', 'COMPLETED', 'CANCELLED', 'RETAINED');

-- CreateEnum
CREATE TYPE "SettlementMode" AS ENUM ('ONE_TIME', 'PERIODIC_PARTIAL');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'IN_REVIEW', 'APPROVED', 'FINALIZED', 'PAID', 'VOIDED', 'ALREADY_PAID');

-- CreateEnum
CREATE TYPE "JournalVoucherStatus" AS ENUM ('DRAFT', 'GENERATED', 'EXPORTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LeaveCategory" AS ENUM ('REGULAR', 'INCIDENT', 'COMP_OFF', 'UNPAID', 'FLOATER');

-- CreateEnum
CREATE TYPE "AccrualFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL', 'UPFRONT');

-- CreateEnum
CREATE TYPE "LeaveUnit" AS ENUM ('DAYS', 'HOURS');

-- CreateEnum
CREATE TYPE "YearEndAction" AS ENUM ('RESET', 'PAY_ALL', 'CARRY_FORWARD_ALL', 'PAY_THEN_CARRY_FORWARD', 'CARRY_FORWARD_THEN_PAY');

-- CreateEnum
CREATE TYPE "LeaveYearBasis" AS ENUM ('CALENDAR_JAN', 'FINANCIAL_APR', 'JOINING_DATE');

-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DayPortion" AS ENUM ('FULL_DAY', 'FIRST_HALF', 'SECOND_HALF', 'QUARTER');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY', 'ON_DUTY', 'WORK_FROM_HOME', 'NO_ATTENDANCE');

-- CreateEnum
CREATE TYPE "CaptureSource" AS ENUM ('WEB', 'MOBILE', 'BIOMETRIC', 'KIOSK', 'API', 'MANUAL');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" "PlanTier" NOT NULL DEFAULT 'FOUNDATION',
    "hasHire" BOOLEAN NOT NULL DEFAULT false,
    "hasPsa" BOOLEAN NOT NULL DEFAULT false,
    "hasLearn" BOOLEAN NOT NULL DEFAULT false,
    "countryCode" TEXT NOT NULL DEFAULT 'IN',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "fyStartMonth" INTEGER NOT NULL DEFAULT 4,
    "logoUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_visibility_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "restrictByLegalEntity" BOOLEAN NOT NULL DEFAULT false,
    "restrictByBusinessUnit" BOOLEAN NOT NULL DEFAULT false,
    "managerReporteeOverride" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_visibility_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "phone" TEXT,
    "loginDisabled" BOOLEAN NOT NULL DEFAULT false,
    "isDeactivated" BOOLEAN NOT NULL DEFAULT false,
    "twoFactor" "TwoFactorMethod" NOT NULL DEFAULT 'NONE',
    "lastLoginAt" TIMESTAMP(3),
    "emailVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role_assignments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT,

    CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_scopes" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "departmentId" TEXT,
    "locationId" TEXT,

    CONSTRAINT "role_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "module" "AuditModule" NOT NULL,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "summary" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_entities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'IN',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "cin" TEXT,
    "dateOfIncorporation" TIMESTAMP(3),
    "businessType" TEXT,
    "sector" TEXT,
    "natureOfBusiness" TEXT,
    "logoUrl" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authorised_signatories" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "email" TEXT,
    "fathersName" TEXT,
    "address" TEXT,
    "pan" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorised_signatories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_bank_accounts" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "corporateId" TEXT,
    "userId" TEXT,
    "aliasId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_units" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "headId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessUnitId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "headId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "stateCode" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'IN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bands" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_grades" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minAnnual" DECIMAL(18,2),
    "maxAnnual" DECIMAL(18,2),
    "midAnnual" DECIMAL(18,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_grades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isContingent" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_titles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bandId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_number_series" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "prefix" TEXT NOT NULL DEFAULT '',
    "digits" INTEGER NOT NULL DEFAULT 4,
    "suffix" TEXT NOT NULL DEFAULT '',
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_number_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entity" "CustomFieldEntity" NOT NULL DEFAULT 'EMPLOYEE',
    "section" TEXT,
    "label" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL DEFAULT 'TEXT',
    "options" JSONB,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_values" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "value" TEXT,

    CONSTRAINT "custom_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "attendanceNumber" TEXT,
    "userId" TEXT,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT NOT NULL,
    "displayName" TEXT,
    "workEmail" TEXT,
    "personalEmail" TEXT,
    "mobile" TEXT,
    "alternatePhone" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "gender" "Gender",
    "maritalStatus" "MaritalStatus",
    "bloodGroup" "BloodGroup",
    "nationality" TEXT DEFAULT 'Indian',
    "photoUrl" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ONBOARDING',
    "dateOfJoining" TIMESTAMP(3) NOT NULL,
    "confirmationDate" TIMESTAMP(3),
    "legalEntityId" TEXT,
    "businessUnitId" TEXT,
    "departmentId" TEXT,
    "locationId" TEXT,
    "costCenterId" TEXT,
    "bandId" TEXT,
    "payGradeId" TEXT,
    "workerTypeId" TEXT,
    "reportingManagerId" TEXT,
    "jobTitleName" TEXT,
    "payGroupId" TEXT,
    "exitInitiatedAt" TIMESTAMP(3),
    "lastWorkingDay" TIMESTAMP(3),
    "isRehireEligible" BOOLEAN,
    "profileCompletion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_addresses" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "AddressType" NOT NULL DEFAULT 'CURRENT',
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "stateCode" TEXT,
    "postalCode" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'IN',

    CONSTRAINT "employee_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_experiences" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "jobTitle" TEXT,
    "fromDate" TIMESTAMP(3),
    "toDate" TIMESTAMP(3),
    "description" TEXT,
    "isCurrentFY" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "employee_experiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_educations" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "degree" TEXT,
    "specialization" TEXT,
    "fromYear" INTEGER,
    "toYear" INTEGER,
    "grade" TEXT,

    CONSTRAINT "employee_educations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_identities" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "IdentityDocType" NOT NULL,
    "number" TEXT NOT NULL,
    "nameOnDoc" TEXT,
    "issuedDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "fileUrl" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "employee_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_contacts" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dependents" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "isNominee" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "dependents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_job_records" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "reason" "JobChangeReason" NOT NULL DEFAULT 'NEW_HIRE',
    "jobTitleId" TEXT,
    "departmentId" TEXT,
    "businessUnitId" TEXT,
    "locationId" TEXT,
    "legalEntityId" TEXT,
    "bandId" TEXT,
    "payGradeId" TEXT,
    "workerTypeId" TEXT,
    "reportingManagerId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "employee_job_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_bank_accounts" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "branch" TEXT,
    "accountHolder" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_groups" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "frequency" "PayFrequency" NOT NULL DEFAULT 'MONTHLY',
    "payPeriodStartDay" INTEGER NOT NULL DEFAULT 1,
    "payPeriodEndDay" INTEGER NOT NULL DEFAULT 0,
    "attendanceCutoffDay" INTEGER,
    "payDay" INTEGER NOT NULL DEFAULT 1,
    "pfEnabled" BOOLEAN NOT NULL DEFAULT true,
    "esiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "ptEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lwfEnabled" BOOLEAN NOT NULL DEFAULT true,
    "tdsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "declarationOpenDay" INTEGER NOT NULL DEFAULT 1,
    "declarationCloseDay" INTEGER NOT NULL DEFAULT 22,
    "declarationFyCutoff" TIMESTAMP(3),
    "newJoinerWindowDays" INTEGER NOT NULL DEFAULT 30,
    "proofSubmissionDue" TIMESTAMP(3),
    "proofMandatory" BOOLEAN NOT NULL DEFAULT true,
    "allowLateDeclaration" BOOLEAN NOT NULL DEFAULT false,
    "allowRegimeChoice" BOOLEAN NOT NULL DEFAULT true,
    "regimeChangeCutoff" TIMESTAMP(3),
    "approvalWorkflowEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pay_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_components" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT,
    "type" "ComponentType" NOT NULL,
    "calculationType" "CalculationType" NOT NULL DEFAULT 'FORMULA',
    "taxTreatment" "TaxTreatment" NOT NULL DEFAULT 'FULLY_TAXABLE',
    "isRecurring" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isPartOfFbp" BOOLEAN NOT NULL DEFAULT false,
    "isOutsideCtc" BOOLEAN NOT NULL DEFAULT false,
    "isLopApplicable" BOOLEAN NOT NULL DEFAULT true,
    "isArrearApplicable" BOOLEAN NOT NULL DEFAULT true,
    "affectsPfWage" BOOLEAN NOT NULL DEFAULT false,
    "affectsEsiGross" BOOLEAN NOT NULL DEFAULT true,
    "showOnPayslip" BOOLEAN NOT NULL DEFAULT true,
    "annualExemptLimit" DECIMAL(18,2),
    "taxSection" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_group_components" (
    "id" TEXT NOT NULL,
    "payGroupId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,

    CONSTRAINT "pay_group_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structures" (
    "id" TEXT NOT NULL,
    "payGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "StructureType" NOT NULL DEFAULT 'CUSTOM',
    "minAnnualCtc" DECIMAL(18,2),
    "maxAnnualCtc" DECIMAL(18,2),
    "pfEnabled" BOOLEAN NOT NULL DEFAULT true,
    "esiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "tdsMethod" "TdsMethod" NOT NULL DEFAULT 'AVERAGE',
    "isPartOfFbp" BOOLEAN NOT NULL DEFAULT false,
    "roundComponents" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structure_components" (
    "id" TEXT NOT NULL,
    "structureId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "calculationType" "CalculationType" NOT NULL DEFAULT 'FORMULA',
    "formula" TEXT,
    "fixedAmount" DECIMAL(18,2),
    "percentage" DECIMAL(9,4),
    "percentageOf" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "minAmount" DECIMAL(18,2),
    "maxAmount" DECIMAL(18,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "salary_structure_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_revisions" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "structureId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "annualCtc" DECIMAL(18,2) NOT NULL,
    "previousCtc" DECIMAL(18,2),
    "remunerationType" "RemunerationType" NOT NULL DEFAULT 'MONTHLY',
    "rate" DECIMAL(18,4),
    "reason" TEXT,
    "status" "RevisionStatus" NOT NULL DEFAULT 'APPLIED',
    "arrearsProcessed" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "salary_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payGroupId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "payDate" TIMESTAMP(3),
    "type" "PayrollRunType" NOT NULL DEFAULT 'REGULAR',
    "baseRunId" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "stepState" JSONB,
    "employeeCount" INTEGER NOT NULL DEFAULT 0,
    "totalGross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalNetPay" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalEmployerCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "finalizedBy" TEXT,
    "rolledBackAt" TIMESTAMP(3),
    "rollbackReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_run_employees" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "payAction" "PayAction" NOT NULL DEFAULT 'PROCESS_AS_SALARY',
    "comment" TEXT,
    "totalDays" INTEGER NOT NULL DEFAULT 30,
    "payableDays" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "lopDays" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "lopAdjustment" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "lopReversalDays" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "payableUnits" DECIMAL(12,2),
    "grossEarnings" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employerCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "pfWage" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "pfEmployee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "pfEmployer" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "epsEmployer" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vpf" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "esiGross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "esiEmployee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "esiEmployer" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "professionalTax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lwfEmployee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lwfEmployer" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tds" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "ptOverride" DECIMAL(18,2),
    "esiOverride" DECIMAL(18,2),
    "tdsOverride" DECIMAL(18,2),
    "lwfOverride" DECIMAL(18,2),
    "overrideNote" TEXT,
    "annualCtc" DECIMAL(18,2),
    "structureId" TEXT,
    "errors" JSONB,
    "calculatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_run_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_lines" (
    "id" TEXT NOT NULL,
    "runEmployeeId" TEXT NOT NULL,
    "componentId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ComponentType" NOT NULL,
    "fullAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "ytdAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "isOverridden" BOOLEAN NOT NULL DEFAULT false,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "showOnPayslip" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "payslip_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PayslipStatus" NOT NULL DEFAULT 'NOT_GENERATED',
    "isProvisional" BOOLEAN NOT NULL DEFAULT false,
    "isSegregated" BOOLEAN NOT NULL DEFAULT false,
    "netPay" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "pdfUrl" TEXT,
    "isPasswordProtected" BOOLEAN NOT NULL DEFAULT true,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "heldAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_settings" (
    "id" TEXT NOT NULL,
    "payGroupId" TEXT NOT NULL,
    "layout" "PayslipLayout" NOT NULL DEFAULT 'THREE_SECTION',
    "showCompanyLogo" BOOLEAN NOT NULL DEFAULT true,
    "appendTaxSummary" BOOLEAN NOT NULL DEFAULT false,
    "showYtdTotals" BOOLEAN NOT NULL DEFAULT true,
    "showActualGross" BOOLEAN NOT NULL DEFAULT false,
    "excludeNaFields" BOOLEAN NOT NULL DEFAULT true,
    "showLoanDetails" BOOLEAN NOT NULL DEFAULT true,
    "showLeaveSummary" BOOLEAN NOT NULL DEFAULT true,
    "showArrearBreakup" BOOLEAN NOT NULL DEFAULT true,
    "showEmployerContributions" BOOLEAN NOT NULL DEFAULT true,
    "showOvertimeHours" BOOLEAN NOT NULL DEFAULT false,
    "showOutsideCtcComponents" BOOLEAN NOT NULL DEFAULT false,
    "passwordProtect" BOOLEAN NOT NULL DEFAULT true,
    "fieldOrder" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payslip_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_register_configs" (
    "id" TEXT NOT NULL,
    "payGroupId" TEXT NOT NULL,
    "columns" JSONB,
    "showOutsideCtc" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pay_register_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_approval_rules" (
    "id" TEXT NOT NULL,
    "payGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "action" "ApprovalAction" NOT NULL,
    "approverRoleIds" JSONB NOT NULL,
    "criteria" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_approval_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_approval_requests" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "action" "ApprovalAction" NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "currentLevel" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "comments" JSONB,

    CONSTRAINT "payroll_approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_group_filing_details" (
    "id" TEXT NOT NULL,
    "payGroupId" TEXT NOT NULL,
    "pan" TEXT,
    "tan" TEXT,
    "tanCircle" TEXT,
    "citTds" TEXT,
    "form16SignatoryName" TEXT,
    "form16SignatoryDesignation" TEXT,
    "form16SignatoryPan" TEXT,
    "responsiblePersonName" TEXT,
    "responsiblePersonDesignation" TEXT,
    "responsiblePersonPan" TEXT,
    "pfRegistrationNumber" TEXT,
    "pfRegistrationDate" TIMESTAMP(3),
    "pfSignatoryName" TEXT,
    "pfWageCeiling" DECIMAL(18,2) NOT NULL DEFAULT 15000,
    "pfCapAtCeiling" BOOLEAN NOT NULL DEFAULT true,
    "pfEmployeeRate" DECIMAL(9,4) NOT NULL DEFAULT 12,
    "pfEmployerRate" DECIMAL(9,4) NOT NULL DEFAULT 12,
    "epsRate" DECIMAL(9,4) NOT NULL DEFAULT 8.33,
    "epsWageCeiling" DECIMAL(18,2) NOT NULL DEFAULT 15000,
    "edliRate" DECIMAL(9,4) NOT NULL DEFAULT 0.5,
    "pfAdminRate" DECIMAL(9,4) NOT NULL DEFAULT 0.5,
    "pfEmployerInsideCtc" BOOLEAN NOT NULL DEFAULT true,
    "pfProrationAffectsSpecialAllowance" BOOLEAN NOT NULL DEFAULT false,
    "esiRegistrationNumber" TEXT,
    "esiRegistrationDate" TIMESTAMP(3),
    "esiSignatoryName" TEXT,
    "esiWageLimit" DECIMAL(18,2) NOT NULL DEFAULT 21000,
    "esiEmployeeRate" DECIMAL(9,4) NOT NULL DEFAULT 0.75,
    "esiEmployerRate" DECIMAL(9,4) NOT NULL DEFAULT 3.25,
    "esiEmployerInsideCtc" BOOLEAN NOT NULL DEFAULT false,
    "esiHideEmployerOnPayslip" BOOLEAN NOT NULL DEFAULT false,
    "esiIncludeArrears" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pay_group_filing_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pt_state_registrations" (
    "id" TEXT NOT NULL,
    "payGroupId" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "stateName" TEXT NOT NULL,
    "locationName" TEXT,
    "establishmentId" TEXT,
    "registrationDate" TIMESTAMP(3),
    "signatoryName" TEXT,
    "frequency" "PtFrequency" NOT NULL DEFAULT 'MONTHLY',
    "localBodyType" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pt_state_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pt_state_registration_locations" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,

    CONSTRAINT "pt_state_registration_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pt_slabs" (
    "id" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "localBodyType" TEXT,
    "gender" "Gender",
    "frequency" "PtFrequency" NOT NULL DEFAULT 'MONTHLY',
    "fromAmount" DECIMAL(18,2) NOT NULL,
    "toAmount" DECIMAL(18,2),
    "amount" DECIMAL(18,2) NOT NULL,
    "specialMonth" INTEGER,
    "specialAmount" DECIMAL(18,2),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "pt_slabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lwf_state_registrations" (
    "id" TEXT NOT NULL,
    "payGroupId" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "stateName" TEXT NOT NULL,
    "establishmentId" TEXT,
    "registrationDate" TIMESTAMP(3),
    "signatoryName" TEXT,
    "employerInsideCtc" BOOLEAN NOT NULL DEFAULT false,
    "hideEmployerOnPayslip" BOOLEAN NOT NULL DEFAULT false,
    "prorateNewJoiners" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lwf_state_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lwf_state_registration_locations" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,

    CONSTRAINT "lwf_state_registration_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lwf_rules" (
    "id" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "frequency" "LwfFrequency" NOT NULL DEFAULT 'ANNUAL',
    "deductionMonths" JSONB NOT NULL,
    "employeeAmount" DECIMAL(18,2) NOT NULL,
    "employerAmount" DECIMAL(18,2) NOT NULL,
    "wageLimit" DECIMAL(18,2),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "lwf_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "income_tax_slabs" (
    "id" TEXT NOT NULL,
    "regime" "TaxRegime" NOT NULL,
    "fyStartYear" INTEGER NOT NULL,
    "minAge" INTEGER NOT NULL DEFAULT 0,
    "maxAge" INTEGER NOT NULL DEFAULT 200,
    "fromAmount" DECIMAL(18,2) NOT NULL,
    "toAmount" DECIMAL(18,2),
    "ratePercent" DECIMAL(9,4) NOT NULL,

    CONSTRAINT "income_tax_slabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "income_tax_configs" (
    "id" TEXT NOT NULL,
    "regime" "TaxRegime" NOT NULL,
    "fyStartYear" INTEGER NOT NULL,
    "standardDeduction" DECIMAL(18,2) NOT NULL,
    "rebateLimit" DECIMAL(18,2) NOT NULL,
    "rebateMaxAmount" DECIMAL(18,2) NOT NULL,
    "cessPercent" DECIMAL(9,4) NOT NULL DEFAULT 4,
    "surchargeBands" JSONB,
    "marginalReliefEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "income_tax_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_statutory_profiles" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "pfEnabled" BOOLEAN NOT NULL DEFAULT true,
    "uan" TEXT,
    "pfAccountNumber" TEXT,
    "pfCapAtCeiling" BOOLEAN,
    "vpfAmount" DECIMAL(18,2),
    "vpfPercent" DECIMAL(9,4),
    "epsApplicable" BOOLEAN NOT NULL DEFAULT true,
    "pfJoinDate" TIMESTAMP(3),
    "esiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "esicNumber" TEXT,
    "esiCycleEndDate" TIMESTAMP(3),
    "ptEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lwfEnabled" BOOLEAN NOT NULL DEFAULT true,
    "taxRegime" "TaxRegime" NOT NULL DEFAULT 'NEW',
    "regimeLockedAt" TIMESTAMP(3),
    "flatTdsAmount" DECIMAL(18,2),
    "tdsDisabled" BOOLEAN NOT NULL DEFAULT false,
    "previousEmployerIncome" DECIMAL(18,2),
    "previousEmployerTds" DECIMAL(18,2),
    "previousEmployerPf" DECIMAL(18,2),
    "previousEmployerPt" DECIMAL(18,2),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_statutory_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investment_declarations" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fyStartYear" INTEGER NOT NULL,
    "regime" "TaxRegime" NOT NULL DEFAULT 'NEW',
    "status" "DeclarationStatus" NOT NULL DEFAULT 'DRAFT',
    "declaredTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "approvedTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investment_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "declaration_items" (
    "id" TEXT NOT NULL,
    "declarationId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "declaredAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "approvedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "proofStatus" "ProofStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "proofFileUrl" TEXT,
    "proofRemark" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "declaration_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hra_declarations" (
    "id" TEXT NOT NULL,
    "declarationId" TEXT NOT NULL,
    "mode" "HraDeclarationMode" NOT NULL DEFAULT 'ANNUAL',
    "isMetro" BOOLEAN NOT NULL DEFAULT false,
    "annualRent" DECIMAL(18,2),
    "monthlyRent" JSONB,
    "landlordName" TEXT,
    "landlordPan" TEXT,
    "rentAddress" TEXT,

    CONSTRAINT "hra_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statutory_filings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "payGroupId" TEXT,
    "type" "FilingType" NOT NULL,
    "fyStartYear" INTEGER NOT NULL,
    "quarter" INTEGER,
    "month" INTEGER,
    "status" "FilingStatus" NOT NULL DEFAULT 'DRAFT',
    "fileUrl" TEXT,
    "tokenNumber" TEXT,
    "receiptNumber" TEXT,
    "filedAt" TIMESTAMP(3),
    "generatedAt" TIMESTAMP(3),
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statutory_filings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_challans" (
    "id" TEXT NOT NULL,
    "filingId" TEXT,
    "tenantId" TEXT NOT NULL,
    "minorHeadCode" TEXT,
    "challanNumber" TEXT NOT NULL,
    "bsrCode" TEXT NOT NULL,
    "deductionDate" TIMESTAMP(3) NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "bankName" TEXT,
    "tdsAmount" DECIMAL(18,2) NOT NULL,
    "surcharge" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cess" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "interest" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "fee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_challans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arrears" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "source" "ArrearSource" NOT NULL,
    "forYear" INTEGER NOT NULL,
    "forMonth" INTEGER NOT NULL,
    "paidInRunId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "breakdown" JSONB,
    "note" TEXT,
    "isProcessed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arrears_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adhoc_transactions" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "AdhocType" NOT NULL,
    "name" TEXT NOT NULL,
    "componentCode" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "taxTreatment" "AdhocTaxTreatment" NOT NULL DEFAULT 'TAXABLE',
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "runId" TEXT,
    "comment" TEXT,
    "isPaidOutside" BOOLEAN NOT NULL DEFAULT false,
    "isProcessed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "adhoc_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bonus_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isPartOfCtc" BOOLEAN NOT NULL DEFAULT false,
    "isTaxable" BOOLEAN NOT NULL DEFAULT true,
    "affectsEsi" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bonus_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_bonuses" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "bonusTypeId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paidAmount" DECIMAL(18,2),
    "payoutYear" INTEGER NOT NULL,
    "payoutMonth" INTEGER NOT NULL,
    "payAction" "BonusPayAction" NOT NULL DEFAULT 'PAY',
    "runId" TEXT,
    "isProcessed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_bonuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "component_claims" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "fyStartYear" INTEGER NOT NULL,
    "claimedAmount" DECIMAL(18,2) NOT NULL,
    "payableAmount" DECIMAL(18,2),
    "status" "ClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
    "payoutYear" INTEGER,
    "payoutMonth" INTEGER,
    "runId" TEXT,
    "attachmentUrl" TEXT,
    "billDate" TIMESTAMP(3),
    "billNumber" TEXT,
    "comment" TEXT,
    "reviewerNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "component_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "perks" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "isTaxable" BOOLEAN NOT NULL DEFAULT true,
    "taxBorneByEmployer" BOOLEAN NOT NULL DEFAULT false,
    "section192_1aExclusion" BOOLEAN NOT NULL DEFAULT false,
    "valuationMethod" "PerkValuationMethod" NOT NULL DEFAULT 'FIXED_FOR_ALL',
    "fixedAmount" DECIMAL(18,2),
    "formula" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "perks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "isConcessional" BOOLEAN NOT NULL DEFAULT false,
    "sbiBenchmarkRate" DECIMAL(9,4),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "requireProbationComplete" BOOLEAN NOT NULL DEFAULT true,
    "minDaysFromJoining" INTEGER,
    "minAnnualSalary" DECIMAL(18,2),
    "maxAnnualSalary" DECIMAL(18,2),
    "blockOnNoticePeriod" BOOLEAN NOT NULL DEFAULT true,
    "approverRoleIds" JSONB,
    "autoApproveAfterDays" INTEGER,
    "autoApproveAction" TEXT DEFAULT 'APPROVE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_policy_rules" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "interestType" "InterestType" NOT NULL DEFAULT 'NONE',
    "interestRate" DECIMAL(9,4),
    "maxInstallments" INTEGER NOT NULL DEFAULT 12,
    "commencementMonths" INTEGER NOT NULL DEFAULT 1,
    "maxAmount" DECIMAL(18,2),
    "maxPercentOfSalary" DECIMAL(9,4),
    "requiresDocuments" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "loan_policy_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "policyId" TEXT,
    "principal" DECIMAL(18,2) NOT NULL,
    "interestType" "InterestType" NOT NULL DEFAULT 'NONE',
    "interestRate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "installments" INTEGER NOT NULL,
    "emiAmount" DECIMAL(18,2) NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "disbursedAt" TIMESTAMP(3),
    "disbursedOutside" BOOLEAN NOT NULL DEFAULT false,
    "startYear" INTEGER,
    "startMonth" INTEGER,
    "outstanding" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalRepaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "purpose" TEXT,
    "documentUrl" TEXT,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_installments" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "principalPart" DECIMAL(18,2) NOT NULL,
    "interestPart" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "balanceAfter" DECIMAL(18,2) NOT NULL,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "runId" TEXT,
    "deductedAt" TIMESTAMP(3),

    CONSTRAINT "loan_installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exit_records" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "ExitType" NOT NULL DEFAULT 'RESIGNATION',
    "reason" TEXT,
    "status" "ExitStatus" NOT NULL DEFAULT 'INITIATED',
    "noticeDate" TIMESTAMP(3) NOT NULL,
    "lastWorkingDay" TIMESTAMP(3) NOT NULL,
    "noticeBuyoutDays" DECIMAL(9,2),
    "hadDiscussion" BOOLEAN NOT NULL DEFAULT false,
    "discussionNote" TEXT,
    "isRehireEligible" BOOLEAN,
    "attachmentUrl" TEXT,
    "initiatedBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exit_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fnf_settlements" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "mode" "SettlementMode" NOT NULL DEFAULT 'ONE_TIME',
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "settlementYear" INTEGER,
    "settlementMonth" INTEGER,
    "leaveEncashment" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lopReversal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "salaryArrears" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "pendingSalary" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "bonusPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "gratuity" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "noticeBuyoutPay" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reimbursements" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "overtimeAndShift" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "noticeShortfallRecovery" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "loanRecovery" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "assetDamageRecovery" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "advanceRecovery" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherDeductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "pfDeduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "esiDeduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "ptDeduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lwfDeduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tdsDeduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalRecovery" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netSettlement" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "gratuityEligible" BOOLEAN NOT NULL DEFAULT false,
    "gratuityActCovered" BOOLEAN NOT NULL DEFAULT true,
    "breakdown" JSONB,
    "statementUrl" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "finalizedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fnf_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_period_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "resignationDays" INTEGER NOT NULL DEFAULT 60,
    "terminationDays" INTEGER NOT NULL DEFAULT 30,
    "probationDays" INTEGER NOT NULL DEFAULT 15,
    "allowBuyout" BOOLEAN NOT NULL DEFAULT true,
    "buyoutBasis" TEXT NOT NULL DEFAULT 'GROSS',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_period_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_vouchers" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" "JournalVoucherStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "totalDebit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalCredit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "isBalanced" BOOLEAN NOT NULL DEFAULT false,
    "target" TEXT,
    "exportedAt" TIMESTAMP(3),
    "fileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "narration" TEXT,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "componentCode" TEXT,
    "costCenterId" TEXT,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_mappings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "componentCode" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'DEBIT',
    "target" TEXT NOT NULL DEFAULT 'XLSX',

    CONSTRAINT "account_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" "LeaveCategory" NOT NULL DEFAULT 'REGULAR',
    "unit" "LeaveUnit" NOT NULL DEFAULT 'DAYS',
    "color" TEXT,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "accrualFrequency" "AccrualFrequency" NOT NULL DEFAULT 'MONTHLY',
    "accrualDay" INTEGER NOT NULL DEFAULT 1,
    "annualQuota" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "unevenAccrual" JSONB,
    "isUnlimited" BOOLEAN NOT NULL DEFAULT false,
    "prorateOnJoining" BOOLEAN NOT NULL DEFAULT true,
    "noAwardIfJoinAfterDay" INTEGER,
    "accrueDuringProbation" BOOLEAN NOT NULL DEFAULT true,
    "probationWaitDays" INTEGER,
    "maxDaysDuringProbation" DECIMAL(9,2),
    "prorateOnExit" BOOLEAN NOT NULL DEFAULT true,
    "accrueDuringNotice" BOOLEAN NOT NULL DEFAULT true,
    "noticeExtensionMultiplier" DECIMAL(9,2),
    "expiryDaysAfterCredit" INTEGER,
    "maxAccumulation" DECIMAL(9,2),
    "allowNegativeBalance" BOOLEAN NOT NULL DEFAULT false,
    "maxNegativeDays" DECIMAL(9,2),
    "allowHalfDay" BOOLEAN NOT NULL DEFAULT true,
    "allowQuarterDay" BOOLEAN NOT NULL DEFAULT false,
    "allowBackdated" BOOLEAN NOT NULL DEFAULT true,
    "priorNoticeDays" INTEGER,
    "requireComment" BOOLEAN NOT NULL DEFAULT false,
    "attachmentAboveDays" DECIMAL(9,2),
    "isHiddenFromEmployee" BOOLEAN NOT NULL DEFAULT false,
    "maxConsecutiveDays" DECIMAL(9,2),
    "maxDaysPerMonth" DECIMAL(9,2),
    "minGapBetweenLeavesDays" INTEGER,
    "sandwichConfig" JSONB,
    "yearEndAction" "YearEndAction" NOT NULL DEFAULT 'CARRY_FORWARD_ALL',
    "carryForwardMax" DECIMAL(9,2),
    "carryForwardExpiryDays" INTEGER,
    "encashmentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "encashmentFormula" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "yearBasis" "LeaveYearBasis" NOT NULL DEFAULT 'FINANCIAL_APR',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_plan_types" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "quotaOverride" DECIMAL(9,2),

    CONSTRAINT "leave_plan_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_plan_assignments" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "leave_plan_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balances" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "yearStart" TIMESTAMP(3) NOT NULL,
    "opening" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "accrued" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "used" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "encashed" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "lapsed" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "carriedForward" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "available" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "fromPortion" "DayPortion" NOT NULL DEFAULT 'FULL_DAY',
    "toPortion" "DayPortion" NOT NULL DEFAULT 'FULL_DAY',
    "totalDays" DECIMAL(9,2) NOT NULL,
    "sandwichDays" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "attachmentUrl" TEXT,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_request_days" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "portion" "DayPortion" NOT NULL DEFAULT 'FULL_DAY',
    "dayValue" DECIMAL(9,2) NOT NULL,
    "isSandwich" BOOLEAN NOT NULL DEFAULT false,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "leave_request_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_calendars" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "locationIds" JSONB,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holiday_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isFlexible" BOOLEAN NOT NULL DEFAULT false,
    "requiredHours" DECIMAL(9,2),
    "breakMinutes" INTEGER NOT NULL DEFAULT 60,
    "maxSlotMinutes" INTEGER,
    "daySchedule" JSONB,
    "crossesMidnight" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_assignments" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "weeklyOffCode" TEXT,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_off_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_off_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'NO_ATTENDANCE',
    "shiftId" TEXT,
    "firstIn" TIMESTAMP(3),
    "lastOut" TIMESTAMP(3),
    "grossHours" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "effectiveHours" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "overtimeHours" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "payableValue" DECIMAL(9,2) NOT NULL DEFAULT 1,
    "lopValue" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "penaltyReason" TEXT,
    "isRegularised" BOOLEAN NOT NULL DEFAULT false,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_logs" (
    "id" TEXT NOT NULL,
    "recordId" TEXT,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "direction" INTEGER NOT NULL,
    "source" "CaptureSource" NOT NULL DEFAULT 'WEB',
    "deviceId" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "ipAddress" TEXT,
    "selfieUrl" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lop_adjustments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "days" DECIMAL(9,2) NOT NULL,
    "reversalForYear" INTEGER,
    "reversalForMonth" INTEGER,
    "note" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "lop_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "hours" DECIMAL(9,2) NOT NULL,
    "rate" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "payAction" TEXT NOT NULL DEFAULT 'PAY',
    "runId" TEXT,
    "isProcessed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overtime_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_allowance_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "shiftCode" TEXT,
    "days" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,2) NOT NULL,
    "payAction" TEXT NOT NULL DEFAULT 'PAY',
    "runId" TEXT,
    "isProcessed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_allowance_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_subdomain_key" ON "tenants"("subdomain");

-- CreateIndex
CREATE INDEX "tenants_subdomain_idx" ON "tenants"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_visibility_settings_tenantId_key" ON "tenant_visibility_settings"("tenantId");

-- CreateIndex
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "otp_challenges_tenantId_identifier_idx" ON "otp_challenges"("tenantId", "identifier");

-- CreateIndex
CREATE INDEX "roles_tenantId_idx" ON "roles"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenantId_name_key" ON "roles"("tenantId", "name");

-- CreateIndex
CREATE INDEX "role_permissions_roleId_idx" ON "role_permissions"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_roleId_permission_key" ON "role_permissions"("roleId", "permission");

-- CreateIndex
CREATE INDEX "user_role_assignments_userId_idx" ON "user_role_assignments"("userId");

-- CreateIndex
CREATE INDEX "user_role_assignments_roleId_idx" ON "user_role_assignments"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_assignments_userId_roleId_key" ON "user_role_assignments"("userId", "roleId");

-- CreateIndex
CREATE INDEX "role_scopes_assignmentId_idx" ON "role_scopes"("assignmentId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_module_createdAt_idx" ON "audit_logs"("tenantId", "module", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_entityType_entityId_idx" ON "audit_logs"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "legal_entities_tenantId_idx" ON "legal_entities"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "legal_entities_tenantId_name_key" ON "legal_entities"("tenantId", "name");

-- CreateIndex
CREATE INDEX "authorised_signatories_legalEntityId_idx" ON "authorised_signatories"("legalEntityId");

-- CreateIndex
CREATE INDEX "entity_bank_accounts_legalEntityId_idx" ON "entity_bank_accounts"("legalEntityId");

-- CreateIndex
CREATE INDEX "business_units_tenantId_idx" ON "business_units"("tenantId");

-- CreateIndex
CREATE INDEX "business_units_legalEntityId_idx" ON "business_units"("legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "business_units_tenantId_name_key" ON "business_units"("tenantId", "name");

-- CreateIndex
CREATE INDEX "departments_tenantId_idx" ON "departments"("tenantId");

-- CreateIndex
CREATE INDEX "departments_businessUnitId_idx" ON "departments"("businessUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenantId_name_key" ON "departments"("tenantId", "name");

-- CreateIndex
CREATE INDEX "locations_tenantId_idx" ON "locations"("tenantId");

-- CreateIndex
CREATE INDEX "locations_tenantId_stateCode_idx" ON "locations"("tenantId", "stateCode");

-- CreateIndex
CREATE UNIQUE INDEX "locations_tenantId_name_key" ON "locations"("tenantId", "name");

-- CreateIndex
CREATE INDEX "cost_centers_tenantId_idx" ON "cost_centers"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_tenantId_name_key" ON "cost_centers"("tenantId", "name");

-- CreateIndex
CREATE INDEX "bands_tenantId_idx" ON "bands"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "bands_tenantId_name_key" ON "bands"("tenantId", "name");

-- CreateIndex
CREATE INDEX "pay_grades_tenantId_idx" ON "pay_grades"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "pay_grades_tenantId_name_key" ON "pay_grades"("tenantId", "name");

-- CreateIndex
CREATE INDEX "worker_types_tenantId_idx" ON "worker_types"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "worker_types_tenantId_name_key" ON "worker_types"("tenantId", "name");

-- CreateIndex
CREATE INDEX "job_titles_tenantId_idx" ON "job_titles"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "job_titles_tenantId_name_key" ON "job_titles"("tenantId", "name");

-- CreateIndex
CREATE INDEX "employee_number_series_tenantId_idx" ON "employee_number_series"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_number_series_tenantId_name_key" ON "employee_number_series"("tenantId", "name");

-- CreateIndex
CREATE INDEX "custom_field_definitions_tenantId_entity_idx" ON "custom_field_definitions"("tenantId", "entity");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_tenantId_entity_fieldKey_key" ON "custom_field_definitions"("tenantId", "entity", "fieldKey");

-- CreateIndex
CREATE INDEX "custom_field_values_ownerId_idx" ON "custom_field_values"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_values_definitionId_ownerId_key" ON "custom_field_values"("definitionId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "employees_userId_key" ON "employees"("userId");

-- CreateIndex
CREATE INDEX "employees_tenantId_status_idx" ON "employees"("tenantId", "status");

-- CreateIndex
CREATE INDEX "employees_tenantId_departmentId_idx" ON "employees"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "employees_tenantId_locationId_idx" ON "employees"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "employees_tenantId_payGroupId_idx" ON "employees"("tenantId", "payGroupId");

-- CreateIndex
CREATE INDEX "employees_reportingManagerId_idx" ON "employees"("reportingManagerId");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenantId_employeeNumber_key" ON "employees"("tenantId", "employeeNumber");

-- CreateIndex
CREATE INDEX "employee_addresses_employeeId_idx" ON "employee_addresses"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_addresses_employeeId_type_key" ON "employee_addresses"("employeeId", "type");

-- CreateIndex
CREATE INDEX "employee_experiences_employeeId_idx" ON "employee_experiences"("employeeId");

-- CreateIndex
CREATE INDEX "employee_educations_employeeId_idx" ON "employee_educations"("employeeId");

-- CreateIndex
CREATE INDEX "employee_identities_employeeId_idx" ON "employee_identities"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_identities_employeeId_type_key" ON "employee_identities"("employeeId", "type");

-- CreateIndex
CREATE INDEX "emergency_contacts_employeeId_idx" ON "emergency_contacts"("employeeId");

-- CreateIndex
CREATE INDEX "dependents_employeeId_idx" ON "dependents"("employeeId");

-- CreateIndex
CREATE INDEX "employee_job_records_employeeId_effectiveFrom_idx" ON "employee_job_records"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "employee_bank_accounts_employeeId_idx" ON "employee_bank_accounts"("employeeId");

-- CreateIndex
CREATE INDEX "pay_groups_tenantId_idx" ON "pay_groups"("tenantId");

-- CreateIndex
CREATE INDEX "pay_groups_legalEntityId_idx" ON "pay_groups"("legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "pay_groups_tenantId_name_key" ON "pay_groups"("tenantId", "name");

-- CreateIndex
CREATE INDEX "salary_components_tenantId_type_idx" ON "salary_components"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "salary_components_tenantId_code_key" ON "salary_components"("tenantId", "code");

-- CreateIndex
CREATE INDEX "pay_group_components_payGroupId_idx" ON "pay_group_components"("payGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "pay_group_components_payGroupId_componentId_key" ON "pay_group_components"("payGroupId", "componentId");

-- CreateIndex
CREATE INDEX "salary_structures_payGroupId_idx" ON "salary_structures"("payGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structures_payGroupId_name_key" ON "salary_structures"("payGroupId", "name");

-- CreateIndex
CREATE INDEX "salary_structure_components_structureId_idx" ON "salary_structure_components"("structureId");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structure_components_structureId_componentId_key" ON "salary_structure_components"("structureId", "componentId");

-- CreateIndex
CREATE INDEX "salary_revisions_employeeId_effectiveFrom_idx" ON "salary_revisions"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "payroll_runs_tenantId_year_month_idx" ON "payroll_runs"("tenantId", "year", "month");

-- CreateIndex
CREATE INDEX "payroll_runs_payGroupId_status_idx" ON "payroll_runs"("payGroupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_payGroupId_year_month_type_sequence_key" ON "payroll_runs"("payGroupId", "year", "month", "type", "sequence");

-- CreateIndex
CREATE INDEX "payroll_run_employees_runId_idx" ON "payroll_run_employees"("runId");

-- CreateIndex
CREATE INDEX "payroll_run_employees_employeeId_idx" ON "payroll_run_employees"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_run_employees_runId_employeeId_key" ON "payroll_run_employees"("runId", "employeeId");

-- CreateIndex
CREATE INDEX "payslip_lines_runEmployeeId_idx" ON "payslip_lines"("runEmployeeId");

-- CreateIndex
CREATE INDEX "payslips_employeeId_year_month_idx" ON "payslips"("employeeId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_runId_employeeId_isSegregated_key" ON "payslips"("runId", "employeeId", "isSegregated");

-- CreateIndex
CREATE UNIQUE INDEX "payslip_settings_payGroupId_key" ON "payslip_settings"("payGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "pay_register_configs_payGroupId_key" ON "pay_register_configs"("payGroupId");

-- CreateIndex
CREATE INDEX "payroll_approval_rules_payGroupId_idx" ON "payroll_approval_rules"("payGroupId");

-- CreateIndex
CREATE INDEX "payroll_approval_requests_runId_idx" ON "payroll_approval_requests"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "pay_group_filing_details_payGroupId_key" ON "pay_group_filing_details"("payGroupId");

-- CreateIndex
CREATE INDEX "pt_state_registrations_payGroupId_idx" ON "pt_state_registrations"("payGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "pt_state_registrations_payGroupId_stateCode_localBodyType_key" ON "pt_state_registrations"("payGroupId", "stateCode", "localBodyType");

-- CreateIndex
CREATE UNIQUE INDEX "pt_state_registration_locations_registrationId_locationId_key" ON "pt_state_registration_locations"("registrationId", "locationId");

-- CreateIndex
CREATE INDEX "pt_slabs_stateCode_effectiveFrom_idx" ON "pt_slabs"("stateCode", "effectiveFrom");

-- CreateIndex
CREATE INDEX "lwf_state_registrations_payGroupId_idx" ON "lwf_state_registrations"("payGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "lwf_state_registrations_payGroupId_stateCode_key" ON "lwf_state_registrations"("payGroupId", "stateCode");

-- CreateIndex
CREATE UNIQUE INDEX "lwf_state_registration_locations_registrationId_locationId_key" ON "lwf_state_registration_locations"("registrationId", "locationId");

-- CreateIndex
CREATE INDEX "lwf_rules_stateCode_effectiveFrom_idx" ON "lwf_rules"("stateCode", "effectiveFrom");

-- CreateIndex
CREATE INDEX "income_tax_slabs_regime_fyStartYear_idx" ON "income_tax_slabs"("regime", "fyStartYear");

-- CreateIndex
CREATE UNIQUE INDEX "income_tax_configs_regime_fyStartYear_key" ON "income_tax_configs"("regime", "fyStartYear");

-- CreateIndex
CREATE UNIQUE INDEX "employee_statutory_profiles_employeeId_key" ON "employee_statutory_profiles"("employeeId");

-- CreateIndex
CREATE INDEX "investment_declarations_employeeId_idx" ON "investment_declarations"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "investment_declarations_employeeId_fyStartYear_key" ON "investment_declarations"("employeeId", "fyStartYear");

-- CreateIndex
CREATE INDEX "declaration_items_declarationId_idx" ON "declaration_items"("declarationId");

-- CreateIndex
CREATE UNIQUE INDEX "hra_declarations_declarationId_key" ON "hra_declarations"("declarationId");

-- CreateIndex
CREATE INDEX "statutory_filings_tenantId_type_fyStartYear_idx" ON "statutory_filings"("tenantId", "type", "fyStartYear");

-- CreateIndex
CREATE INDEX "tds_challans_tenantId_idx" ON "tds_challans"("tenantId");

-- CreateIndex
CREATE INDEX "arrears_employeeId_isProcessed_idx" ON "arrears"("employeeId", "isProcessed");

-- CreateIndex
CREATE INDEX "arrears_paidInRunId_idx" ON "arrears"("paidInRunId");

-- CreateIndex
CREATE INDEX "adhoc_transactions_employeeId_year_month_idx" ON "adhoc_transactions"("employeeId", "year", "month");

-- CreateIndex
CREATE INDEX "adhoc_transactions_runId_idx" ON "adhoc_transactions"("runId");

-- CreateIndex
CREATE INDEX "bonus_types_tenantId_idx" ON "bonus_types"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "bonus_types_tenantId_name_key" ON "bonus_types"("tenantId", "name");

-- CreateIndex
CREATE INDEX "employee_bonuses_employeeId_payoutYear_payoutMonth_idx" ON "employee_bonuses"("employeeId", "payoutYear", "payoutMonth");

-- CreateIndex
CREATE INDEX "component_claims_employeeId_fyStartYear_idx" ON "component_claims"("employeeId", "fyStartYear");

-- CreateIndex
CREATE INDEX "component_claims_status_idx" ON "component_claims"("status");

-- CreateIndex
CREATE UNIQUE INDEX "perks_componentId_key" ON "perks"("componentId");

-- CreateIndex
CREATE INDEX "loan_categories_tenantId_idx" ON "loan_categories"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "loan_categories_tenantId_name_key" ON "loan_categories"("tenantId", "name");

-- CreateIndex
CREATE INDEX "loan_policies_tenantId_idx" ON "loan_policies"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "loan_policies_tenantId_name_key" ON "loan_policies"("tenantId", "name");

-- CreateIndex
CREATE INDEX "loan_policy_rules_policyId_idx" ON "loan_policy_rules"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "loan_policy_rules_policyId_categoryId_key" ON "loan_policy_rules"("policyId", "categoryId");

-- CreateIndex
CREATE INDEX "loans_employeeId_status_idx" ON "loans"("employeeId", "status");

-- CreateIndex
CREATE INDEX "loan_installments_loanId_year_month_idx" ON "loan_installments"("loanId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "loan_installments_loanId_sequence_key" ON "loan_installments"("loanId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "exit_records_employeeId_key" ON "exit_records"("employeeId");

-- CreateIndex
CREATE INDEX "exit_records_status_idx" ON "exit_records"("status");

-- CreateIndex
CREATE UNIQUE INDEX "fnf_settlements_employeeId_key" ON "fnf_settlements"("employeeId");

-- CreateIndex
CREATE INDEX "notice_period_policies_tenantId_idx" ON "notice_period_policies"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "notice_period_policies_tenantId_name_key" ON "notice_period_policies"("tenantId", "name");

-- CreateIndex
CREATE INDEX "journal_vouchers_runId_idx" ON "journal_vouchers"("runId");

-- CreateIndex
CREATE INDEX "journal_entries_voucherId_idx" ON "journal_entries"("voucherId");

-- CreateIndex
CREATE INDEX "account_mappings_tenantId_idx" ON "account_mappings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "account_mappings_tenantId_target_componentCode_key" ON "account_mappings"("tenantId", "target", "componentCode");

-- CreateIndex
CREATE INDEX "leave_types_tenantId_idx" ON "leave_types"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_tenantId_code_key" ON "leave_types"("tenantId", "code");

-- CreateIndex
CREATE INDEX "leave_plans_tenantId_idx" ON "leave_plans"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_plans_tenantId_name_key" ON "leave_plans"("tenantId", "name");

-- CreateIndex
CREATE INDEX "leave_plan_types_planId_idx" ON "leave_plan_types"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_plan_types_planId_leaveTypeId_key" ON "leave_plan_types"("planId", "leaveTypeId");

-- CreateIndex
CREATE INDEX "leave_plan_assignments_employeeId_idx" ON "leave_plan_assignments"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_plan_assignments_planId_employeeId_effectiveFrom_key" ON "leave_plan_assignments"("planId", "employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "leave_balances_employeeId_idx" ON "leave_balances"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_employeeId_leaveTypeId_yearStart_key" ON "leave_balances"("employeeId", "leaveTypeId", "yearStart");

-- CreateIndex
CREATE INDEX "leave_requests_tenantId_employeeId_fromDate_idx" ON "leave_requests"("tenantId", "employeeId", "fromDate");

-- CreateIndex
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

-- CreateIndex
CREATE INDEX "leave_request_days_date_idx" ON "leave_request_days"("date");

-- CreateIndex
CREATE UNIQUE INDEX "leave_request_days_requestId_date_key" ON "leave_request_days"("requestId", "date");

-- CreateIndex
CREATE INDEX "holiday_calendars_tenantId_idx" ON "holiday_calendars"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_calendars_tenantId_name_year_key" ON "holiday_calendars"("tenantId", "name", "year");

-- CreateIndex
CREATE INDEX "holidays_calendarId_date_idx" ON "holidays"("calendarId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_calendarId_date_name_key" ON "holidays"("calendarId", "date", "name");

-- CreateIndex
CREATE INDEX "shifts_tenantId_idx" ON "shifts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_tenantId_code_key" ON "shifts"("tenantId", "code");

-- CreateIndex
CREATE INDEX "shift_assignments_shiftId_date_idx" ON "shift_assignments"("shiftId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "shift_assignments_employeeId_date_key" ON "shift_assignments"("employeeId", "date");

-- CreateIndex
CREATE INDEX "weekly_off_policies_tenantId_idx" ON "weekly_off_policies"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_off_policies_tenantId_name_version_key" ON "weekly_off_policies"("tenantId", "name", "version");

-- CreateIndex
CREATE INDEX "attendance_records_tenantId_date_idx" ON "attendance_records"("tenantId", "date");

-- CreateIndex
CREATE INDEX "attendance_records_employeeId_date_idx" ON "attendance_records"("employeeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_employeeId_date_key" ON "attendance_records"("employeeId", "date");

-- CreateIndex
CREATE INDEX "attendance_logs_tenantId_employeeId_timestamp_idx" ON "attendance_logs"("tenantId", "employeeId", "timestamp");

-- CreateIndex
CREATE INDEX "attendance_logs_recordId_idx" ON "attendance_logs"("recordId");

-- CreateIndex
CREATE INDEX "lop_adjustments_tenantId_employeeId_year_month_idx" ON "lop_adjustments"("tenantId", "employeeId", "year", "month");

-- CreateIndex
CREATE INDEX "overtime_entries_tenantId_employeeId_year_month_idx" ON "overtime_entries"("tenantId", "employeeId", "year", "month");

-- CreateIndex
CREATE INDEX "shift_allowance_entries_tenantId_employeeId_year_month_idx" ON "shift_allowance_entries"("tenantId", "employeeId", "year", "month");

-- AddForeignKey
ALTER TABLE "tenant_visibility_settings" ADD CONSTRAINT "tenant_visibility_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_scopes" ADD CONSTRAINT "role_scopes_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "user_role_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorised_signatories" ADD CONSTRAINT "authorised_signatories_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_bank_accounts" ADD CONSTRAINT "entity_bank_accounts_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_headId_fkey" FOREIGN KEY ("headId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_headId_fkey" FOREIGN KEY ("headId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bands" ADD CONSTRAINT "bands_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_grades" ADD CONSTRAINT "pay_grades_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_types" ADD CONSTRAINT "worker_types_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_titles" ADD CONSTRAINT "job_titles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_number_series" ADD CONSTRAINT "employee_number_series_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "business_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "cost_centers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_bandId_fkey" FOREIGN KEY ("bandId") REFERENCES "bands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_payGradeId_fkey" FOREIGN KEY ("payGradeId") REFERENCES "pay_grades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_workerTypeId_fkey" FOREIGN KEY ("workerTypeId") REFERENCES "worker_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_reportingManagerId_fkey" FOREIGN KEY ("reportingManagerId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_addresses" ADD CONSTRAINT "employee_addresses_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_experiences" ADD CONSTRAINT "employee_experiences_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_educations" ADD CONSTRAINT "employee_educations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_identities" ADD CONSTRAINT "employee_identities_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependents" ADD CONSTRAINT "dependents_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_job_records" ADD CONSTRAINT "employee_job_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_job_records" ADD CONSTRAINT "employee_job_records_jobTitleId_fkey" FOREIGN KEY ("jobTitleId") REFERENCES "job_titles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bank_accounts" ADD CONSTRAINT "employee_bank_accounts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_groups" ADD CONSTRAINT "pay_groups_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_groups" ADD CONSTRAINT "pay_groups_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_components" ADD CONSTRAINT "salary_components_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_group_components" ADD CONSTRAINT "pay_group_components_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_group_components" ADD CONSTRAINT "pay_group_components_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "salary_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structure_components" ADD CONSTRAINT "salary_structure_components_structureId_fkey" FOREIGN KEY ("structureId") REFERENCES "salary_structures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structure_components" ADD CONSTRAINT "salary_structure_components_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "salary_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_revisions" ADD CONSTRAINT "salary_revisions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_revisions" ADD CONSTRAINT "salary_revisions_structureId_fkey" FOREIGN KEY ("structureId") REFERENCES "salary_structures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_baseRunId_fkey" FOREIGN KEY ("baseRunId") REFERENCES "payroll_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_employees" ADD CONSTRAINT "payroll_run_employees_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_employees" ADD CONSTRAINT "payroll_run_employees_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_runEmployeeId_fkey" FOREIGN KEY ("runEmployeeId") REFERENCES "payroll_run_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "salary_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_settings" ADD CONSTRAINT "payslip_settings_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_register_configs" ADD CONSTRAINT "pay_register_configs_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_approval_rules" ADD CONSTRAINT "payroll_approval_rules_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_approval_requests" ADD CONSTRAINT "payroll_approval_requests_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_group_filing_details" ADD CONSTRAINT "pay_group_filing_details_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pt_state_registrations" ADD CONSTRAINT "pt_state_registrations_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pt_state_registration_locations" ADD CONSTRAINT "pt_state_registration_locations_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "pt_state_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pt_state_registration_locations" ADD CONSTRAINT "pt_state_registration_locations_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lwf_state_registrations" ADD CONSTRAINT "lwf_state_registrations_payGroupId_fkey" FOREIGN KEY ("payGroupId") REFERENCES "pay_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lwf_state_registration_locations" ADD CONSTRAINT "lwf_state_registration_locations_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "lwf_state_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lwf_state_registration_locations" ADD CONSTRAINT "lwf_state_registration_locations_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_statutory_profiles" ADD CONSTRAINT "employee_statutory_profiles_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_declarations" ADD CONSTRAINT "investment_declarations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "declaration_items" ADD CONSTRAINT "declaration_items_declarationId_fkey" FOREIGN KEY ("declarationId") REFERENCES "investment_declarations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hra_declarations" ADD CONSTRAINT "hra_declarations_declarationId_fkey" FOREIGN KEY ("declarationId") REFERENCES "investment_declarations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_challans" ADD CONSTRAINT "tds_challans_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "statutory_filings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arrears" ADD CONSTRAINT "arrears_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adhoc_transactions" ADD CONSTRAINT "adhoc_transactions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bonuses" ADD CONSTRAINT "employee_bonuses_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bonuses" ADD CONSTRAINT "employee_bonuses_bonusTypeId_fkey" FOREIGN KEY ("bonusTypeId") REFERENCES "bonus_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_claims" ADD CONSTRAINT "component_claims_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_claims" ADD CONSTRAINT "component_claims_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "salary_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perks" ADD CONSTRAINT "perks_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "salary_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_policy_rules" ADD CONSTRAINT "loan_policy_rules_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "loan_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_policy_rules" ADD CONSTRAINT "loan_policy_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "loan_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "loan_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "loan_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_installments" ADD CONSTRAINT "loan_installments_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exit_records" ADD CONSTRAINT "exit_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fnf_settlements" ADD CONSTRAINT "fnf_settlements_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_vouchers" ADD CONSTRAINT "journal_vouchers_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "journal_vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_plan_types" ADD CONSTRAINT "leave_plan_types_planId_fkey" FOREIGN KEY ("planId") REFERENCES "leave_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_plan_types" ADD CONSTRAINT "leave_plan_types_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_plan_assignments" ADD CONSTRAINT "leave_plan_assignments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "leave_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "holiday_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "attendance_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
