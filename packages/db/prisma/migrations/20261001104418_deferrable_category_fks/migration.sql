-- Checked at commit rather than per row: deleting a tenant removes a category
-- and the lines that use it in one transaction, but the cascade reaches the
-- lines (two levels down) after the category (one level down). Deleting a
-- category that is still in use is still refused.
ALTER TABLE "expense_claim_lines" ALTER CONSTRAINT "expense_claim_lines_categoryId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "helpdesk_tickets" ALTER CONSTRAINT "helpdesk_tickets_categoryId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ledger_lines" ALTER CONSTRAINT "ledger_lines_accountId_fkey" DEFERRABLE INITIALLY DEFERRED;
