import type { ProbationStage } from "@keka/services";

export const STAGE: Record<ProbationStage, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  ON_TRACK: { label: "On track", tone: "neutral" },
  REVIEW_SOON: { label: "Review due", tone: "warning" },
  IN_REVIEW: { label: "In review", tone: "info" },
  OVERDUE: { label: "Overdue", tone: "danger" },
  CONFIRMED: { label: "Confirmed", tone: "success" },
  NOT_CONFIRMED: { label: "Not confirmed", tone: "neutral" },
};

export const REC: Record<string, string> = { CONFIRM: "Confirm", EXTEND: "Extend", NOT_CONFIRM: "Do not confirm" };
