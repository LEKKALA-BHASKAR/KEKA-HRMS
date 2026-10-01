-- CreateTable
CREATE TABLE "employee_perks" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "perkId" TEXT NOT NULL,
    "monthlyValue" DECIMAL(18,2),
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_perks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_perks_employeeId_idx" ON "employee_perks"("employeeId");

-- CreateIndex
CREATE INDEX "employee_perks_perkId_idx" ON "employee_perks"("perkId");

-- AddForeignKey
ALTER TABLE "employee_perks" ADD CONSTRAINT "employee_perks_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_perks" ADD CONSTRAINT "employee_perks_perkId_fkey" FOREIGN KEY ("perkId") REFERENCES "perks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

