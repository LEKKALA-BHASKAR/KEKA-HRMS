import type { PrismaClient, Prisma, TicketPriority, TicketStatus } from "@prisma/client";
import { addBusinessMinutes, parseSchedule, type BusinessSchedule } from "../../../services/src/helpdesk-time";

/**
 * Helpdesk seed (Keka parity): business hours, categories with
 * subcategories, heads and agents, canned responses, closing reasons, and a
 * couple of months of tickets in every state — with their threads, system
 * lines, followers, SLA flags and ratings — so the dashboard, lists and
 * reports have shape.
 *
 * Idempotent: it first maps any legacy values (WAITING_ON_EMPLOYEE → ON_HOLD,
 * RESOLVED → CLOSED, URGENT → HIGH), then clears the tenant's helpdesk rows
 * and rebuilds them. Times are relative to now, so "today" is always today.
 *
 *   npx tsx packages/db/prisma/seed/helpdesk.ts   (runs for the acme tenant)
 */

const H = 3_600_000;
const D = 24 * H;
const MIN = 60_000;

type Who = "agent" | "agent2" | "emp" | "note";
interface T {
  emp: string; cat: string; subject: string; description: string; priority: TicketPriority;
  status: "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "CLOSED";
  /** Hours before now it was raised. */
  ago: number;
  thread?: Array<[afterHours: number, who: Who, body: string]>;
  /** For ON_HOLD: hours after raising it was held. For CLOSED: hours after raising it closed. */
  at?: number;
  reason?: string;
  rating?: number;
  followers?: Array<"manager" | string>;
}

const OFFICE = [1, 2, 3, 4, 5].map((day) => ({ day, from: "09:30", to: "18:30" }));
const IT_DESK = [1, 2, 3, 4, 5, 6].map((day) => ({ day, from: "08:00", to: "20:00" }));

const CANNED: Array<[string, string, number]> = [
  ["Closing Words", "Hi,\n\nHope we were able to resolve your query as quickly as possible. Do reach out in case of any queries.\n\nThanks", 1],
  ["Next Steps", "Hi,\n\nAs a next step we will be assigning the ticket to the category head for their inputs on the same.\n\nThanks", 2],
  ["Delayed", "Hi,\n\nThere is a delay in resolution of the ticket as it requires an in-depth check. We will get back to you on the same as soon as possible.\n\nThanks", 3],
  ["Ticket Acknowledgement", "Thank you for raising the ticket. Your query will be resolved shortly.", 5],
  ["Need More Information on the same", "Thank you for raising the ticket. We will need more details on the same ticket; we will get in touch with you in some time. Kindly hold on.\n\nRegards", 8],
];

const REASONS: Array<[string, string]> = [
  ["Resolved", "The employee's query was answered or the issue fixed."],
  ["Duplicate ticket", "Already being handled on another ticket."],
  ["Out of scope", "Can't be handled currently."],
  ["No response from employee", "Closed after the employee did not reply to a follow-up."],
  ["Raised in error", "The employee raised the ticket by mistake."],
];

type Cat = {
  name: string; description: string; head: string | null; hours: "default" | "office" | "it";
  fr: number; sla: number; onHold?: boolean; mode?: "HEAD" | "ROUND_ROBIN" | "UNASSIGNED"; agents?: string[];
  priority?: TicketPriority | null; audienceDepts?: string[]; active?: boolean;
  subs?: Array<[name: string, description: string]>;
};

const CATEGORIES: Cat[] = [
  { name: "Payroll & salary", description: "Payslips, deductions, tax and arrears.", head: "lakshmi.narayanan", hours: "office", fr: 8, sla: 48, onHold: true, agents: ["lakshmi.narayanan", "ramesh.iyer"], priority: "MEDIUM",
    subs: [["Payslip queries", "Questions about a line on your payslip or a salary credit."], ["Tax & TDS", "Declarations, proofs, Form 16 and monthly TDS."]] },
  { name: "Leave & attendance", description: "Dedicated to employees' attendance & leave related queries.", head: "deepak.chauhan", hours: "office", fr: 4, sla: 24, onHold: true, agents: ["deepak.chauhan", "priya.sharma"], priority: "MEDIUM",
    subs: [["Leave balance", "Balances, accruals, comp-offs and carry-forward."], ["Attendance regularisation", "Missing punches, regularisation and LOP corrections."]] },
  { name: "IT & access", description: "Helps employees on their general issues for laptops, desktops, logins & related assets.", head: "ritu.saxena", hours: "it", fr: 4, sla: 24, onHold: true, mode: "ROUND_ROBIN", agents: ["ritu.saxena", "vikram.menon"], priority: "HIGH",
    subs: [["Hardware support", "Laptops, monitors, keyboards and other devices."], ["Software & access", "Licences, VPN, accounts and system access."]] },
  { name: "Benefits & reimbursements", description: "Insurance, claims and allowances.", head: "priya.sharma", hours: "office", fr: 8, sla: 72, onHold: true, agents: ["priya.sharma"], priority: "MEDIUM",
    subs: [["Insurance", "Group medical and term insurance, dependants and claims."], ["Reimbursements", "Claims, advances and allowances."]] },
  { name: "Documents & letters", description: "Employment, address and experience letters, and document verification.", head: "deepak.chauhan", hours: "office", fr: 8, sla: 72, agents: ["deepak.chauhan"], priority: "LOW",
    subs: [["Letters", "Address proof, employment, experience and relieving letters."], ["Document verification", "Identity and education documents awaiting verification."]] },
  { name: "Facilities & admin", description: "Seating, access cards, stationery and meeting rooms.", head: "imran.sheikh", hours: "office", fr: 8, sla: 48, priority: "LOW",
    subs: [["Stationery requests", "The following category is supposed to be used if there is any stationery request or office essentials."], ["Conference room booking", "For blocking a conference room."]] },
  { name: "Sales incentives", description: "Incentive plans, payouts and disputes for the sales and customer success teams.", head: "lakshmi.narayanan", hours: "office", fr: 8, sla: 72, priority: "MEDIUM", audienceDepts: ["Sales", "Customer Success"] },
  { name: "Policies", description: "Questions about company policy.", head: "priya.sharma", hours: "office", fr: 8, sla: 72, priority: "LOW" },
  { name: "POSH concerns", description: "Kindly raise the following ticket for all the POSH concerns. Only the internal committee sees these.", head: "priya.sharma", hours: "default", fr: 4, sla: 72, priority: "HIGH" },
  { name: "Suggestion box", description: "If you have any suggestion for the organisation, kindly raise the following ticket.", head: null, hours: "default", fr: 24, sla: 120, mode: "UNASSIGNED", priority: null },
  { name: "Relocation support", description: "Moving between offices: travel, stay and shifting allowance.", head: "priya.sharma", hours: "office", fr: 8, sla: 72, active: false },
];

const TICKETS: T[] = [
  { emp: "ACM0009", cat: "Tax & TDS", subject: "Why is my September TDS higher than August?", description: "My TDS went up by about ₹1,200 this month though my salary is the same. Can someone explain?", priority: "MEDIUM", status: "IN_PROGRESS", ago: 30,
    thread: [[3, "agent", "Your annual projection was re-run after the arrears from the July revision; the extra tax is spread over the remaining months. I'll send the working shortly."], [3.5, "note", "Arrears of ₹18,400 paid in September — confirm with the payroll register before sending the working."]] },
  { emp: "ACM0012", cat: "Attendance regularisation", subject: "Regularisation for 14 September not reflecting", description: "I raised a regularisation for the holiday mix-up but my attendance still shows LOP.", priority: "HIGH", status: "ON_HOLD", ago: 74, at: 6,
    thread: [[5.5, "agent", "14 September is a holiday on the default calendar — could you confirm which date you meant?"]], followers: ["manager"] },
  { emp: "ACM0014", cat: "Software & access", subject: "VPN access for the new staging cluster", description: "Need a VPN profile for staging-2 to debug the release scheduled for Friday.", priority: "HIGH", status: "OPEN", ago: 3 },
  { emp: "ACM0016", cat: "Letters", subject: "Address proof letter for a bank account", description: "Please issue an address proof letter on letterhead for opening a salary account with HDFC Bank.", priority: "LOW", status: "CLOSED", ago: 9 * 24, at: 40, reason: "Resolved", rating: 4,
    thread: [[4, "agent", "Letter issued and uploaded to your documents."], [20, "emp", "Received, thank you!"]] },
  { emp: "ACM0018", cat: "Insurance", subject: "Add spouse to the medical insurance", description: "Got married last month; how do I add my spouse to the group policy? I have the marriage certificate ready.", priority: "MEDIUM", status: "OPEN", ago: 52 },
  { emp: "ACM0013", cat: "Policies", subject: "Is work from another city allowed for two weeks?", description: "Planning to work from Jaipur for two weeks in November.", priority: "LOW", status: "CLOSED", ago: 15 * 24, at: 26, reason: "Resolved", rating: 5,
    thread: [[2, "agent", "Yes, up to 30 days a year with manager approval — raise a work-from-home request for the dates."], [3, "emp", "Thanks."]] },
  { emp: "ACM0021", cat: "Tax & TDS", subject: "Form 16 for FY 2025-26", description: "Where can I download last year's Form 16?", priority: "MEDIUM", status: "CLOSED", ago: 20 * 24, at: 6, reason: "Resolved", rating: 4,
    thread: [[1, "agent", "It is under My Finances → Manage Tax → Form 16. Part A is from TRACES; Part B is generated by us."]] },
  { emp: "ACM0025", cat: "Hardware support", subject: "Laptop keyboard keys sticking", description: "A few keys on my laptop keyboard are unresponsive — E, R and the space bar need a hard press.", priority: "HIGH", status: "IN_PROGRESS", ago: 46,
    thread: [[1.5, "agent", "Replacement keyboard ordered; you can pick up a loaner from the IT desk today."], [2, "note", "Dell ProSupport case 4471209 raised — part ETA Monday."], [5, "emp", "Picked up the loaner, thanks Ritu."]] },
  { emp: "ACM0009", cat: "Hardware support", subject: "Requesting to replace the laptop charger", description: "The charger's cable is frayed near the connector. Requesting a replacement.", priority: "MEDIUM", status: "CLOSED", ago: 41 * 24, at: 20, reason: "Resolved", rating: 5,
    thread: [[2, "agent", "Please drop the old charger at the IT desk and collect a new one."]] },
  { emp: "ACM0007", cat: "Reimbursements", subject: "Reimbursement for team offsite cab fares", description: "Cab fares for the Coorg offsite (₹6,840 for five people) were paid on my card. How do I claim them for the team?", priority: "MEDIUM", status: "IN_PROGRESS", ago: 4 * 24,
    thread: [[6, "agent", "File one expense claim under Travel with all receipts; mention the team members in the description and Finance will approve it as a team expense."], [7, "emp", "Will do — Meera has two of the receipts."]], followers: ["ACM0009", "manager"] },
  { emp: "ACM0010", cat: "Leave balance", subject: "Earned leave balance not updated after September accrual", description: "My earned leave still shows 9.5 days; the 1.25 days for September has not been credited.", priority: "MEDIUM", status: "OPEN", ago: 2 },
  { emp: "ACM0011", cat: "Document verification", subject: "Degree certificate still pending verification", description: "I uploaded my B.Tech degree certificate two weeks ago but it still shows pending verification.", priority: "LOW", status: "IN_PROGRESS", ago: 6 * 24,
    thread: [[7, "agent", "The university's verification portal is slow this month; we have sent the request and will update you."]] },
  { emp: "ACM0015", cat: "Sales incentives", subject: "Q2 incentive payout missing from September salary", description: "My Q2 incentive (₹42,500 as per the approved sheet) was not in the September payslip.", priority: "HIGH", status: "IN_PROGRESS", ago: 3 * 24,
    thread: [[4, "agent", "The Q2 sheet reached payroll after the cut-off; it will be paid as an adhoc payment in October."], [5, "emp", "Can it be paid off-cycle? I have an EMI due."]], followers: ["manager"] },
  { emp: "ACM0017", cat: "Conference room booking", subject: "Block the 4th floor board room for a client workshop", description: "Need the board room on 18 September, 10 am to 4 pm, with the video conferencing kit.", priority: "LOW", status: "CLOSED", ago: 12 * 24, at: 3, reason: "Resolved", rating: 5,
    thread: [[1, "agent", "Blocked for you — the VC kit will be set up by 9:30."]] },
  { emp: "ACM0023", cat: "Software & access", subject: "Jira licence for two new contractors", description: "Two contractors join the delivery team on Monday and need Jira and Confluence access.", priority: "MEDIUM", status: "CLOSED", ago: 25 * 24, at: 5, reason: "Duplicate ticket",
    thread: [[2, "agent", "This is already being handled on the onboarding request for the same contractors — closing this one."]] },
  { emp: "ACM0024", cat: "Attendance regularisation", subject: "Missed punch on 29 September", description: "I forgot to punch out on 29 September; I left at 7:10 pm.", priority: "MEDIUM", status: "CLOSED", ago: 40, at: 18, reason: "Resolved", rating: 4,
    thread: [[2, "agent", "Regularised — the day now shows present with 9h 40m."]] },
  { emp: "ACM0026", cat: "Policies", subject: "Intern stipend and leave eligibility", description: "Am I eligible for casual leave during my internship, and is the stipend paid on the last working day?", priority: "NA", status: "OPEN", ago: 20 },
  { emp: "ACM0027", cat: "Letters", subject: "Relieving letter draft for review", description: "Could I see a draft of my relieving letter before my last day? The visa process needs exact wording.", priority: "MEDIUM", status: "IN_PROGRESS", ago: 5 * 24,
    thread: [[30, "agent", "Sharing the draft by tomorrow; it follows the standard template with your designation and tenure."]] },
  { emp: "ACM0028", cat: "Payslip queries", subject: "F&F settlement break-up", description: "Please share the break-up of my full and final settlement, especially leave encashment.", priority: "MEDIUM", status: "ON_HOLD", ago: 7 * 24, at: 10,
    thread: [[4, "agent", "The settlement will be drafted after your clearance is complete. Putting this on hold until the asset handover is done."]] },
  { emp: "ACM0029", cat: "Hardware support", subject: "Second monitor request", description: "Requesting a second 27\" monitor for my desk.", priority: "LOW", status: "CLOSED", ago: 35 * 24, at: 30, reason: "Out of scope", rating: 3,
    thread: [[6, "agent", "Second monitors are only issued for design and data roles this quarter. Closing for now; we'll revisit in Q4."]] },
  { emp: "ACM0030", cat: "Suggestion box", subject: "Standing desks on the 3rd floor", description: "Could we pilot a few standing desks on the 3rd floor? Several of us would use them.", priority: "NA", status: "OPEN", ago: 10 * 24 },
  { emp: "ACM0008", cat: "Insurance", subject: "Hospital cashless claim pre-authorisation", description: "My father is being admitted to Manipal Hospital on Friday; how do I get cashless pre-authorisation?", priority: "HIGH", status: "CLOSED", ago: 50 * 24, at: 8, reason: "Resolved", rating: 5,
    thread: [[1, "agent", "Share the hospital's pre-auth form with the TPA desk at the hospital; I've also emailed the TPA your policy number."], [6, "emp", "Pre-auth approved. Thank you!"]] },
  { emp: "ACM0006", cat: "Software & access", subject: "GitHub Copilot seat", description: "Requesting a Copilot seat for the platform team's code review pilot.", priority: "MEDIUM", status: "CLOSED", ago: 52, at: 50, reason: "Resolved", rating: 4,
    thread: [[3, "agent2", "Seat assigned — sign in again in the IDE to pick it up."]] },
  { emp: "ACM0005", cat: "Leave balance", subject: "Comp-off for weekend release not credited", description: "I worked on Saturday 26 September for the release; the comp-off has not been credited.", priority: "MEDIUM", status: "IN_PROGRESS", ago: 26,
    thread: [[2, "agent", "Raise a comp-off request for 26 September from Attendance; once your manager approves it, the day will be credited."]] },
  { emp: "ACM0011", cat: "Stationery requests", subject: "Whiteboard markers and notebooks for the QA bay", description: "Need a box of whiteboard markers and ten notebooks for the QA bay.", priority: "LOW", status: "CLOSED", ago: 18 * 24, at: 26, reason: "Resolved", rating: 4,
    thread: [[5, "agent", "Delivered to the QA bay this afternoon."]] },
  { emp: "ACM0014", cat: "Tax & TDS", subject: "HRA exemption not considered", description: "My HRA exemption is not reflected in the tax projection though I submitted rent receipts.", priority: "MEDIUM", status: "CLOSED", ago: 56 * 24, at: 30, reason: "Resolved", rating: 3,
    thread: [[12, "agent", "The receipts were for the wrong financial year; please re-upload the FY 2026-27 receipts and we'll recompute."], [20, "emp", "Uploaded the right ones now."]] },
  { emp: "ACM0010", cat: "Hardware support", subject: "Headset microphone not working", description: "The USB headset's microphone stopped working; colleagues can't hear me on calls.", priority: "LOW", status: "CLOSED", ago: 70 * 24, at: 48, reason: "No response from employee",
    thread: [[3, "agent", "Could you try it on another laptop and tell us if the issue follows the headset?"]] },
  { emp: "ACM0013", cat: "Payslip queries", subject: "Professional tax deducted twice", description: "I see ₹200 PT deducted twice in the August payslip.", priority: "MEDIUM", status: "CLOSED", ago: 33 * 24, at: 4, reason: "Raised in error", rating: 4,
    thread: [[1, "agent", "The second line is the September arrear PT for July, which was missed — it's correct. Closing this."], [2, "emp", "Ah, got it. My mistake."]] },
  { emp: "ACM0018", cat: "Reimbursements", subject: "Internet allowance for September", description: "My internet reimbursement claim from 5 September is still pending approval.", priority: "LOW", status: "IN_PROGRESS", ago: 8 * 24,
    thread: [[30, "agent", "Your manager has approved it; it's queued with Finance for the October payout."]] },
  { emp: "ACM0016", cat: "Insurance", subject: "Parental insurance top-up options", description: "Is there a voluntary top-up to cover my parents beyond the base policy?", priority: "LOW", status: "CLOSED", ago: 64 * 24, at: 70, reason: "Resolved", rating: 4,
    thread: [[20, "agent", "Yes — a voluntary parental top-up of ₹3 lakh is available at ₹9,800 a year, deducted from salary. I've shared the enrolment form."]] },
];

const utcDate = (d: Date) => d.toISOString().slice(0, 10);

export async function seedHelpdesk(prisma: PrismaClient, ctx: { tenantId: string; now?: Date }): Promise<{ categories: number; tickets: number; open: number; closed: number }> {
  const { tenantId } = ctx;
  const now = ctx.now ?? new Date();

  // 1. Legacy values → Keka's (any row a previous build wrote), then clear.
  await prisma.$executeRaw`UPDATE helpdesk_tickets SET status = 'CLOSED', "closedAt" = COALESCE("closedAt", "resolvedAt", "updatedAt") WHERE "tenantId" = ${tenantId} AND status = 'RESOLVED'`;
  await prisma.helpdeskTicket.updateMany({ where: { tenantId, status: "WAITING_ON_EMPLOYEE" }, data: { status: "ON_HOLD" } });
  await prisma.helpdeskTicket.updateMany({ where: { tenantId, priority: "URGENT" }, data: { priority: "HIGH" } });

  const ticketIds = (await prisma.helpdeskTicket.findMany({ where: { tenantId }, select: { id: true } })).map((t) => t.id);
  await prisma.storedFile.deleteMany({ where: { tenantId, relatedType: { in: ["HelpdeskTicket", "HelpdeskComment"] } } });
  await prisma.notification.deleteMany({ where: { tenantId, kind: "HELPDESK" } });
  await prisma.scheduledReport.deleteMany({ where: { tenantId, reportKey: { startsWith: "helpdesk:" } } });
  await prisma.helpdeskTicket.deleteMany({ where: { id: { in: ticketIds } } });
  await prisma.helpdeskCategory.deleteMany({ where: { tenantId, parentId: { not: null } } });
  await prisma.helpdeskCategory.deleteMany({ where: { tenantId } });
  await prisma.helpdeskBusinessHours.deleteMany({ where: { tenantId } });
  await prisma.helpdeskCannedResponse.deleteMany({ where: { tenantId } });
  await prisma.helpdeskClosingReason.deleteMany({ where: { tenantId } });

  // People.
  const users = await prisma.user.findMany({ where: { tenantId }, select: { id: true, email: true, employee: { select: { displayName: true, firstName: true, lastName: true } } } });
  const user = (handle: string) => {
    const u = users.find((x) => x.email === `${handle}@acme.test`);
    if (!u) throw new Error(`no user ${handle}`);
    return u.id;
  };
  const userName = new Map(users.map((u) => [u.id, u.employee ? u.employee.displayName ?? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
  const emps = await prisma.employee.findMany({
    where: { tenantId },
    select: { id: true, employeeNumber: true, userId: true, displayName: true, firstName: true, lastName: true, reportingManager: { select: { userId: true } } },
  });
  const emp = (n: string) => {
    const e = emps.find((x) => x.employeeNumber === n);
    if (!e) throw new Error(`no employee ${n}`);
    return e;
  };
  const priya = user("priya.sharma");

  // 2. Business hours.
  const defaultHours = await prisma.helpdeskBusinessHours.create({
    data: { tenantId, name: "Default 24x7", description: "The default business hours are set to 24/7 with no holidays defined.", timezone: "Asia/Kolkata", schedule: [], isDefault: true },
  });
  const office = await prisma.helpdeskBusinessHours.create({
    data: { tenantId, name: "India office hours", description: "Bengaluru and Pune offices, Monday to Friday, closed on the organisation's holidays.", timezone: "Asia/Kolkata", schedule: OFFICE, observeHolidays: true },
  });
  const itDesk = await prisma.helpdeskBusinessHours.create({
    data: { tenantId, name: "IT service desk", description: "Extended hours for the IT desk, Monday to Saturday.", timezone: "Asia/Kolkata", schedule: IT_DESK, observeHolidays: true },
  });
  const hoursId = { default: defaultHours.id, office: office.id, it: itDesk.id };
  const holidays = [...new Set((await prisma.holiday.findMany({ where: { isOptional: false, calendar: { tenantId, isDefault: true } }, select: { date: true } })).map((h) => utcDate(h.date)))];
  const schedules: Record<string, { s: BusinessSchedule; h: string[] }> = {
    default: { s: { timezone: "Asia/Kolkata", days: [] }, h: [] },
    office: { s: parseSchedule(OFFICE), h: holidays },
    it: { s: parseSchedule(IT_DESK), h: holidays },
  };

  // 3. Closing reasons and canned responses.
  const reasons = new Map<string, string>();
  for (const [name, description] of REASONS) reasons.set(name, (await prisma.helpdeskClosingReason.create({ data: { tenantId, name, description } })).id);
  for (const [title, body, daysAgo] of CANNED) {
    const at = new Date(now.getTime() - daysAgo * D);
    await prisma.helpdeskCannedResponse.create({ data: { tenantId, title, body, updatedByUserId: priya, createdAt: at, updatedAt: at } });
  }

  // 4. Categories.
  const depts = await prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } });
  type Leaf = { id: string; parent: Cat; headUserId: string | null; mode: string; agents: string[]; rr: number };
  const leaves = new Map<string, Leaf>();
  let categories = 0;
  for (const [i, c] of CATEGORIES.entries()) {
    const head = c.head ? user(c.head) : null;
    const common = {
      tenantId, firstResponseHours: c.fr, slaHours: c.sla, businessHoursId: hoursId[c.hours], enableOnHold: !!c.onHold,
      assignMode: c.mode ?? "HEAD", defaultPriority: c.priority === undefined ? "MEDIUM" as const : c.priority, isActive: c.active ?? true,
      audience: c.audienceDepts ? { departmentIds: depts.filter((d) => c.audienceDepts!.includes(d.name)).map((d) => d.id) } : undefined,
    } satisfies Partial<Prisma.HelpdeskCategoryUncheckedCreateInput>;
    const parent = await prisma.helpdeskCategory.create({
      data: { ...common, name: c.name, description: c.description, defaultAssigneeUserId: head, sortOrder: i, agents: { create: (c.agents ?? []).map((h) => ({ userId: user(h) })) } },
    });
    categories++;
    const agents = (c.agents ?? []).map(user).sort();
    if (!c.subs?.length) leaves.set(c.name, { id: parent.id, parent: c, headUserId: head, mode: common.assignMode, agents, rr: 0 });
    for (const [j, [name, description]] of (c.subs ?? []).entries()) {
      const sub = await prisma.helpdeskCategory.create({ data: { ...common, name, description, parentId: parent.id, defaultAssigneeUserId: head, sortOrder: j } });
      categories++;
      leaves.set(name, { id: sub.id, parent: c, headUserId: head, mode: common.assignMode, agents, rr: 0 });
    }
  }

  // 5. Tickets, oldest first so numbers follow time.
  const sorted = [...TICKETS].sort((a, b) => b.ago - a.ago);
  let number = 1000, open = 0, closed = 0;
  for (const t of sorted) {
    const leaf = leaves.get(t.cat);
    if (!leaf) throw new Error(`no category ${t.cat}`);
    const e = emp(t.emp);
    const raiser = e.displayName ?? `${e.firstName} ${e.lastName}`;
    const created = new Date(now.getTime() - t.ago * H);
    const { s, h } = schedules[leaf.parent.hours];
    const firstResponseDueAt = addBusinessMinutes(created, leaf.parent.fr * 60, s, h);
    const dueAt = addBusinessMinutes(created, leaf.parent.sla * 60, s, h);

    const assignee = leaf.mode === "UNASSIGNED" ? null
      : leaf.mode === "ROUND_ROBIN" && leaf.agents.length ? leaf.agents[leaf.rr++ % leaf.agents.length]
      : leaf.headUserId;
    const agentId = assignee ?? leaf.headUserId ?? priya;
    const agent2 = leaf.agents.find((a) => a !== agentId) ?? agentId;
    const comments: Prisma.HelpdeskCommentCreateManyInput[] = [];
    let firstResponseAt: Date | null = null, lastResponder: string | null = null, lastAt: Date | null = null;
    let status: TicketStatus = "OPEN";
    const at = (hours: number) => new Date(created.getTime() + hours * H);
    const line = (when: Date, by: string, body: string) => comments.push({ ticketId: "", authorUserId: by, authorLabel: userName.get(by) ?? "Helpdesk", body, isSystem: true, createdAt: when });

    for (const [after, who, body] of t.thread ?? []) {
      const when = at(after);
      if (when > now) continue;
      if (who === "emp") {
        comments.push({ ticketId: "", authorUserId: e.userId!, authorLabel: raiser, body, createdAt: when });
        lastResponder = e.userId; lastAt = when;
        continue;
      }
      const by = who === "agent2" ? agent2 : agentId;
      if (who === "note") {
        comments.push({ ticketId: "", authorUserId: by, authorLabel: userName.get(by) ?? "", body, isInternal: true, createdAt: when });
        continue;
      }
      comments.push({ ticketId: "", authorUserId: by, authorLabel: userName.get(by) ?? "", body, createdAt: when });
      if (!firstResponseAt) {
        firstResponseAt = when;
        line(new Date(when.getTime() + 1000), by, `First response was added to the ticket by ${userName.get(by)}`);
      }
      if (status === "OPEN") {
        status = "IN_PROGRESS";
        line(new Date(when.getTime() + 2000), by, `Ticket status changed to In Progress by ${userName.get(by)}`);
      }
      lastResponder = by; lastAt = when;
    }

    let onHoldSince: Date | null = null, closedAt: Date | null = null;
    if (t.status === "ON_HOLD") {
      onHoldSince = at(t.at ?? 1);
      status = "ON_HOLD";
      line(onHoldSince, agentId, `Ticket status changed to On Hold by ${userName.get(agentId)}`);
    } else if (t.status === "CLOSED") {
      closedAt = at(t.at ?? 1);
      status = "CLOSED";
      line(closedAt, agentId, `Ticket status changed to Closed by ${userName.get(agentId)}${t.reason ? ` · ${t.reason}` : ""}`);
    } else if (t.status === "IN_PROGRESS" && status === "OPEN") {
      status = "IN_PROGRESS";
      line(at(0.5), agentId, `Ticket status changed to In Progress by ${userName.get(agentId)}`);
    }

    const end = closedAt ?? now;
    const missedFirstResponse = status !== "ON_HOLD" && (firstResponseAt ? firstResponseAt > firstResponseDueAt : end > firstResponseDueAt);
    const missedResolution = status !== "ON_HOLD" && end > dueAt;

    number++;
    const ticket = await prisma.helpdeskTicket.create({
      data: {
        tenantId, number, employeeId: e.id, categoryId: leaf.id, subject: t.subject, description: t.description,
        priority: t.priority, status, assigneeUserId: assignee, firstResponseDueAt, dueAt, firstResponseAt,
        onHoldSince, closedAt, resolvedAt: closedAt, closedByUserId: closedAt ? agentId : null,
        closingReasonId: t.reason ? reasons.get(t.reason) ?? null : null, satisfaction: t.rating ?? null,
        missedFirstResponse, missedResolution, lastResponderUserId: lastResponder, lastRespondedAt: lastAt,
        createdAt: created, updatedAt: [lastAt, onHoldSince, closedAt, created].filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0],
      },
    });
    if (comments.length) await prisma.helpdeskComment.createMany({ data: comments.map((c) => ({ ...c, ticketId: ticket.id })) });

    for (const f of t.followers ?? []) {
      const uid = f === "manager" ? e.reportingManager?.userId ?? null : emp(f).userId;
      if (!uid || uid === e.userId) continue;
      await prisma.helpdeskTicketFollower.create({ data: { ticketId: ticket.id, userId: uid, viaRole: f === "manager" ? "REPORTING_MANAGER" : null, addedByUserId: agentId, createdAt: at(1) } });
      await prisma.helpdeskComment.create({ data: { ticketId: ticket.id, authorUserId: agentId, authorLabel: userName.get(agentId) ?? "", body: `${userName.get(uid)} was added as a follower by ${userName.get(agentId)}`, isSystem: true, createdAt: at(1) } });
    }
    if (status === "CLOSED") closed++; else open++;
  }

  // Notifications for the people who work the queue.
  const recent = await prisma.helpdeskTicket.findMany({ where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, assigneeUserId: { not: null } }, orderBy: { createdAt: "desc" }, take: 6, include: { employee: { select: { displayName: true } } } });
  if (recent.length) {
    await prisma.notification.createMany({
      data: recent.map((r) => ({ tenantId, userId: r.assigneeUserId!, kind: "HELPDESK", title: `#${r.number}: ${r.subject}`, body: `${r.employee.displayName ?? ""}`, link: `/helpdesk/tickets/${r.id}`, createdAt: r.createdAt })),
    });
  }

  return { categories, tickets: sorted.length, open, closed };
}

// Run on its own: `npx tsx packages/db/prisma/seed/helpdesk.ts [subdomain]`.
if (process.argv[1]?.endsWith("seed/helpdesk.ts")) {
  (async () => {
    const path = await import("node:path");
    const { config } = await import("dotenv");
    config({ path: path.resolve(__dirname, "../../../../.env") });
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: process.argv[2] ?? "acme" } });
      const r = await seedHelpdesk(prisma, { tenantId: tenant.id });
      console.log(`Helpdesk: ${r.categories} categories, ${r.tickets} tickets (${r.open} open, ${r.closed} closed)`);
    } finally {
      await prisma.$disconnect();
    }
  })().catch((e) => { console.error(e); process.exitCode = 1; });
}
