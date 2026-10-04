import { applyExpensePolicyDecision, applyExpenseRateDecision, applyPreApprovalDecision } from "./expense-depth";
import { applyBookingDecision, applyTravelApprovalDecision, applyTravelPolicyDecision, applyTravelSettlementDecision, applyTripChangeDecision } from "./travel-depth";
import { applyLoanAdjustmentDecision, applyLoanProductDecision } from "./loan-depth";
import { applyBenefitEnrollmentDecision, applyBenefitExceptionDecision, applyBenefitPlanDecision, applyDependentDecision, applyLifeEventDecision } from "./benefits";
import { applyAllowanceChangeDecision, applyCompExceptionDecision, applyCompPlanDecision, applyPayRangeDecision } from "./comp-planning";
import type { MoneyWorkflowEntityType } from "./money-math";

/**
 * What a finished workflow request does to the money record behind it.
 * Called by the workflow engine for the request types in
 * MONEY_WORKFLOW_ENTITY_TYPES. A WITHDRAWN request puts the record back
 * where it was before submission.
 */
export async function applyMoneyEffect(
  req: { id: string; tenantId: string; entityType: string; entityId: string | null },
  outcome: "APPROVED" | "REJECTED" | "WITHDRAWN",
  actorUserId: string | null,
): Promise<void> {
  const { tenantId, entityId: id } = req;
  if (!id) return;
  const approved = outcome === "APPROVED";
  switch (req.entityType as MoneyWorkflowEntityType) {
    case "EXPENSE_POLICY": return applyExpensePolicyDecision(tenantId, id, approved, actorUserId);
    case "EXPENSE_PREAPPROVAL": return applyPreApprovalDecision(tenantId, id, outcome);
    case "EXPENSE_RATE": return applyExpenseRateDecision(tenantId, id, approved);
    case "TRAVEL_POLICY": return applyTravelPolicyDecision(tenantId, id, approved, actorUserId);
    case "TRAVEL_APPROVAL": return applyTravelApprovalDecision(tenantId, id, outcome);
    case "TRAVEL_BOOKING": return applyBookingDecision(tenantId, id, approved);
    case "TRIP_CHANGE": return applyTripChangeDecision(tenantId, id, outcome, actorUserId);
    case "TRAVEL_SETTLEMENT": return applyTravelSettlementDecision(tenantId, id, outcome, actorUserId);
    case "LOAN_PRODUCT": return applyLoanProductDecision(tenantId, id, outcome, actorUserId);
    case "LOAN_ADJUSTMENT": return applyLoanAdjustmentDecision(tenantId, id, outcome, actorUserId);
    case "BENEFIT_PLAN": return applyBenefitPlanDecision(tenantId, id, approved, actorUserId);
    case "BENEFIT_ENROLLMENT": return applyBenefitEnrollmentDecision(tenantId, id, outcome, actorUserId);
    case "BENEFIT_EXCEPTION": return applyBenefitExceptionDecision(tenantId, id, outcome);
    case "DEPENDENT_CHANGE": return applyDependentDecision(tenantId, id, outcome, actorUserId);
    case "LIFE_EVENT": return applyLifeEventDecision(tenantId, id, outcome);
    case "COMP_PLAN": return applyCompPlanDecision(tenantId, id, approved, actorUserId);
    case "COMP_EXCEPTION": return applyCompExceptionDecision(tenantId, id, outcome, actorUserId);
    case "PAY_RANGE": return applyPayRangeDecision(tenantId, id, outcome, actorUserId);
    case "ALLOWANCE_CHANGE": return applyAllowanceChangeDecision(tenantId, id, outcome, actorUserId);
    default: return;
  }
}
