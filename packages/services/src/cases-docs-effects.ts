import { applyCaseDecision, applyKbDecision } from "./helpdesk-ops";
import { applyFindingsDecision, applyActionDecision, applyResolutionDecision } from "./er-cases";
import { applyFolderAccessDecision } from "./document-ops";
import { applyTemplateDecision } from "./letter-ops";
import { applyDisposalDecision } from "./asset-ops";

/**
 * Approvals for helpdesk cases, the knowledge base, employee relations,
 * confidential document folders, letter templates and asset disposal run on
 * the generic workflow engine. This module names who approves each by
 * default (an admin can replace it with a workflow definition) and applies
 * the outcome to the record. It never imports the engine itself.
 */
export const CASES_DOCS_ROUTES = {
  HELPDESK_CASE: { name: "Helpdesk administrator", permission: "helpdesk.settings.manage" },
  KB_ARTICLE: { name: "Helpdesk administrator", permission: "helpdesk.settings.manage" },
  ER_FINDINGS: { name: "Employee relations approver", permission: "lifecycle.er_case.approve" },
  ER_ACTION: { name: "Employee relations approver", permission: "lifecycle.er_case.approve" },
  ER_RESOLUTION: { name: "Employee relations approver", permission: "lifecycle.er_case.approve" },
  DOCUMENT_FOLDER_ACCESS: { name: "Document administrator", permission: "document.employee.manage" },
  LETTER_TEMPLATE: { name: "Template administrator", permission: "document.template.manage" },
  ASSET_DISPOSAL: { name: "Asset manager", permission: "asset.item.manage" },
} as const;

export async function applyCasesDocsEffect(req: { tenantId: string; entityType: string; entityId: string | null }, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const t = req.tenantId, id = req.entityId;
  if (!id) return;
  switch (req.entityType) {
    case "HELPDESK_CASE": return applyCaseDecision(t, id, outcome, actorUserId);
    case "KB_ARTICLE": return applyKbDecision(t, id, outcome, actorUserId);
    case "ER_FINDINGS": return applyFindingsDecision(t, id, outcome, actorUserId);
    case "ER_ACTION": return applyActionDecision(t, id, outcome, actorUserId);
    case "ER_RESOLUTION": return applyResolutionDecision(t, id, outcome, actorUserId);
    case "DOCUMENT_FOLDER_ACCESS": return applyFolderAccessDecision(t, id, outcome, actorUserId);
    case "LETTER_TEMPLATE": return applyTemplateDecision(t, id, outcome, actorUserId);
    case "ASSET_DISPOSAL": {
      const { prisma } = await import("@keka/db");
      if (!(await prisma.assetDisposal.findFirst({ where: { id, tenantId: t }, select: { id: true } }))) return;
      return applyDisposalDecision(id, outcome, actorUserId);
    }
    default: return;
  }
}
