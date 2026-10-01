/** Badge tones for letter statuses. */
export const LETTER_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  PENDING_APPROVAL: "warning", PENDING_ACKNOWLEDGEMENT: "info", PENDING_SIGNATURE: "info", ISSUED: "success",
  ACKNOWLEDGED: "success", SIGNED: "success", REJECTED: "danger", VOID: "neutral",
};
