export { wageTypeOf } from "@keka/services";

/** How a unit-paid employee's remuneration reads in step 1. */
export const WAGE_LINE_LABEL: Record<"DAILY" | "HOURLY" | "PIECE_RATE", string> = {
  DAILY: "Daily wage (days)",
  HOURLY: "Hourly (hours)",
  PIECE_RATE: "Piece rate (units)",
};
