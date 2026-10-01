-- CreateEnum
CREATE TYPE "TwoFactorPolicy" AS ENUM ('OFF', 'ADMINS', 'EVERYONE');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "passwordHistory" JSONB,
ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "tenant_security_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "minPasswordLength" INTEGER NOT NULL DEFAULT 8,
    "requireMixedCase" BOOLEAN NOT NULL DEFAULT true,
    "requireNumber" BOOLEAN NOT NULL DEFAULT true,
    "requireSymbol" BOOLEAN NOT NULL DEFAULT true,
    "passwordExpiryDays" INTEGER,
    "passwordHistoryCount" INTEGER NOT NULL DEFAULT 3,
    "maxFailedAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockoutMinutes" INTEGER NOT NULL DEFAULT 15,
    "sessionHours" INTEGER NOT NULL DEFAULT 8,
    "twoFactorPolicy" "TwoFactorPolicy" NOT NULL DEFAULT 'OFF',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_security_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "success" BOOLEAN NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_security_settings_tenantId_key" ON "tenant_security_settings"("tenantId");

-- CreateIndex
CREATE INDEX "login_events_email_createdAt_idx" ON "login_events"("email", "createdAt");

-- CreateIndex
CREATE INDEX "login_events_ipAddress_createdAt_idx" ON "login_events"("ipAddress", "createdAt");

-- CreateIndex
CREATE INDEX "login_events_tenantId_createdAt_idx" ON "login_events"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "tenant_security_settings" ADD CONSTRAINT "tenant_security_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
