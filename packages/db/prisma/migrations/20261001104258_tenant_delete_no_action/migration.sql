-- DropForeignKey
ALTER TABLE "expense_claim_lines" DROP CONSTRAINT "expense_claim_lines_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "helpdesk_tickets" DROP CONSTRAINT "helpdesk_tickets_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "ledger_lines" DROP CONSTRAINT "ledger_lines_accountId_fkey";

-- AddForeignKey
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "expense_categories"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helpdesk_tickets" ADD CONSTRAINT "helpdesk_tickets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "helpdesk_categories"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
