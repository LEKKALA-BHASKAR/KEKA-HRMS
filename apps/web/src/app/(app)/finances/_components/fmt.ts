/**
 * Formatting safe to use in client components (no server-only imports):
 * Indian digit grouping and the app's "01 Oct 2026" dates.
 */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const two = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** "INR 2,55,556" — whole rupees, as Keka's cards show them. */
export const inr0 = (v: number) => `INR ${whole.format(Math.round(v))}`;
/** "INR 1,25,000.00" — paise shown, as in tables. */
export const inr2 = (v: number) => `INR ${two.format(v)}`;
export const fmtDate = (d: Date | string) => {
  const x = typeof d === "string" ? new Date(d) : d;
  return `${String(x.getUTCDate()).padStart(2, "0")} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};
/** "Dec 2025". */
export const monthShort = (y: number, m: number) => `${MON[m - 1]} ${y}`;
