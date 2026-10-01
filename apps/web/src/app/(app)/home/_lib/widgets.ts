/**
 * The Quick Access widget catalogue. Array order is the default layout an
 * organisation starts with; `standard: false` widgets are only available
 * through Add Widget. Titles and descriptions are Keka's own wording where
 * Keka has the widget. Safe to import from client and server code.
 */

export type WidgetType =
  | "QUICK_LINKS" | "ON_LEAVE_TODAY" | "LEAVE_BALANCES" | "TIME_TODAY" | "WORKING_REMOTELY" | "HOLIDAYS"
  | "INBOX" | "FEEDBACK_RECEIVED" | "PROJECT_TIME_TODAY" | "NEEDS_ATTENTION" | "TEAM_TODAY";

export interface WidgetMeta { type: WidgetType; title: string; description: string; color: WidgetColor; standard: boolean }

export const WIDGETS: WidgetMeta[] = [
  { type: "QUICK_LINKS", title: "Quick Links", color: "violet", standard: true,
    description: "This widget shows the external links configured for easy access to those pages so that there is no hassle to type url everytime." },
  { type: "ON_LEAVE_TODAY", title: "On Leave Today", color: "sand", standard: true,
    description: "This widget shows the employees who are on leave today." },
  { type: "LEAVE_BALANCES", title: "Leave Balances", color: "plain", standard: true,
    description: "This widget shows your leave balances with links to request leave." },
  { type: "TIME_TODAY", title: "Time Today", color: "teal", standard: true,
    description: "This widget shows the current time and lets employees clock in and out from the browser." },
  { type: "WORKING_REMOTELY", title: "Working Remotely", color: "magenta", standard: true,
    description: "This widget shows the employees working from home or on duty today." },
  { type: "HOLIDAYS", title: "Holidays", color: "plain", standard: true,
    description: "This widget shows the upcoming holidays on the employee's holiday calendar." },
  { type: "INBOX", title: "Inbox", color: "plain", standard: true,
    description: "This widget shows the tasks pending on employee." },
  { type: "FEEDBACK_RECEIVED", title: "Feedbacks Received", color: "plain", standard: false,
    description: "This widget displays the feedbacks received count and provides ability to request feedback from others." },
  { type: "PROJECT_TIME_TODAY", title: "Project Time - Today", color: "plain", standard: false,
    description: "This widget gives a link to add time entry to the project assigned and once entry is added it shows client, project, task and time details for the day." },
  { type: "NEEDS_ATTENTION", title: "Needs Attention", color: "plain", standard: true,
    description: "This widget shows payroll, compliance and people items that need action. Only administrators with items see it." },
  { type: "TEAM_TODAY", title: "Your Team Today", color: "plain", standard: true,
    description: "This widget shows requests, absences and leave in a manager's team. Only managers see it." },
];

export const WIDGET_BY_TYPE = new Map(WIDGETS.map((w) => [w.type, w]));

export type WidgetColor = "plain" | "violet" | "sand" | "teal" | "magenta" | "coral" | "amber";

/**
 * Keka's card hues, darkened where white text would fail WCAG AA. `ink` is
 * the text colour that sits on the card.
 */
export const WIDGET_COLORS: Record<WidgetColor, { label: string; bg: string; ink: string }> = {
  plain:   { label: "White",   bg: "#ffffff", ink: "#10131a" },
  violet:  { label: "Violet",  bg: "#7a66ae", ink: "#ffffff" },
  sand:    { label: "Sand",    bg: "#7d6d4b", ink: "#ffffff" },
  teal:    { label: "Teal",    bg: "#1f7a8c", ink: "#ffffff" },
  magenta: { label: "Magenta", bg: "#a2549a", ink: "#ffffff" },
  coral:   { label: "Coral",   bg: "#d23a58", ink: "#ffffff" },
  amber:   { label: "Amber",   bg: "#fbbf2b", ink: "#1f2937" },
};

export const isWidgetColor = (c: unknown): c is WidgetColor => typeof c === "string" && c in WIDGET_COLORS;
export const isWidgetType = (t: unknown): t is WidgetType => typeof t === "string" && WIDGET_BY_TYPE.has(t as WidgetType);

export interface QuickLink { label: string; url: string }
export const QUICK_LINKS_MAX = 8;

/** Read the stored links out of a widget's config, tolerating anything malformed. */
export function linksOf(config: unknown): QuickLink[] {
  const raw = (config && typeof config === "object" && Array.isArray((config as { links?: unknown }).links))
    ? (config as { links: unknown[] }).links : [];
  return raw
    .filter((l): l is QuickLink => !!l && typeof (l as QuickLink).label === "string" && typeof (l as QuickLink).url === "string")
    .slice(0, QUICK_LINKS_MAX);
}
