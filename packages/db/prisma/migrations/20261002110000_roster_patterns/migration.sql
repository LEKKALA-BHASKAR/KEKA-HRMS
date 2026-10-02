-- CreateTable
CREATE TABLE "roster_patterns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roster_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roster_patterns_tenantId_idx" ON "roster_patterns"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "roster_patterns_tenantId_name_key" ON "roster_patterns"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "roster_patterns" ADD CONSTRAINT "roster_patterns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

