import { runHelpdeskEscalations } from "./helpdesk-ops";
import { runDocumentExpiry } from "./document-ops";
import { runSignatureReminders } from "./esign";
import { runTemplateReviewReminders } from "./letter-ops";
import { runMaintenanceReminders, runLowStockAlerts } from "./asset-ops";

/**
 * The nightly sweep for cases and documents: helpdesk escalations,
 * document expiry notices, e-signature reminders and expiry, template and
 * article review reminders, maintenance due and low stock. Each step is
 * idempotent (it stamps what it has sent), so reruns send nothing new.
 */
export async function runCasesDocsJob(tenantId: string, now = new Date()): Promise<Record<string, number>> {
  const esc = await runHelpdeskEscalations(tenantId, now);
  const docs = await runDocumentExpiry(tenantId, now);
  const sig = await runSignatureReminders(tenantId, now);
  const reviews = await runTemplateReviewReminders(tenantId, now);
  const maintenance = await runMaintenanceReminders(tenantId, now);
  const lowStock = await runLowStockAlerts(tenantId, now);
  return {
    ticketsEscalated: esc.escalated, expiryNotices: docs.notices, documentsExpired: docs.expired,
    signatureReminders: sig.reminded, envelopesExpired: sig.expired, reviewReminders: reviews,
    maintenanceDue: maintenance, lowStockTypes: lowStock,
  };
}
