-- CreateTable
CREATE TABLE "fbp_declarations" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fyStartYear" INTEGER NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT true,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fbp_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fbp_declaration_lines" (
    "id" TEXT NOT NULL,
    "declarationId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "annualAmount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "fbp_declaration_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fbp_declarations_employeeId_fyStartYear_key" ON "fbp_declarations"("employeeId", "fyStartYear");

-- CreateIndex
CREATE UNIQUE INDEX "fbp_declaration_lines_declarationId_componentId_key" ON "fbp_declaration_lines"("declarationId", "componentId");

-- AddForeignKey
ALTER TABLE "fbp_declarations" ADD CONSTRAINT "fbp_declarations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fbp_declaration_lines" ADD CONSTRAINT "fbp_declaration_lines_declarationId_fkey" FOREIGN KEY ("declarationId") REFERENCES "fbp_declarations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fbp_declaration_lines" ADD CONSTRAINT "fbp_declaration_lines_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "salary_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

