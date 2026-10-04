import { prisma, Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { startWorkflow } from "./workflow-engine";
import { moneyAudit } from "./money-audit";
import {
  checkTripPolicy, checkBookingPolicy, needsSecondTravelApproval, destinationRisk, passportIssue, perDiemDays, travelSettlementNet,
  type TravelPolicyRules, type Violation,
} from "./money-math";
import { expenseRateOn } from "./expense-depth";

/**
 * Travel depth: travel policies (approved before use), purposes, destination
 * risk, traveller profiles, the policy check and second-level approval of a
 * trip, bookings with out-of-policy approval and amendments, trip changes and
 * cancellations through approval, the pre-travel checklist and the
 * settlement that pays per diem and closes the advance.
 */

type R = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
//  Policies, purposes, risks, profiles
// ---------------------------------------------------------------------------

export interface TravelPolicyInput {
  tenantId: string; id?: string | null; name: string; description?: string | null; bandIds: string[];
  domesticFlightClass: string; internationalFlightClass: string; hotelCapPerNight?: number | null; groundDailyCap?: number | null;
  minAdvanceDays: number; secondApprovalAbove?: number | null; internationalNeedsSecondApproval: boolean; requireInsuranceInternational: boolean; passportValidityMonths: number;
  actorUserId: string;
}

export async function saveTravelPolicy(input: TravelPolicyInput): Promise<R & { id?: string }> {
  const { tenantId, id, actorUserId, ...rest } = input;
  const data = { ...rest, name: rest.name.trim(), hotelCapPerNight: rest.hotelCapPerNight ?? null, groundDailyCap: rest.groundDailyCap ?? null, secondApprovalAbove: rest.secondApprovalAbove ?? null };
  if (await prisma.travelPolicy.findFirst({ where: { tenantId, name: data.name, ...(id ? { id: { not: id } } : {}) } })) return { ok: false, message: "Another travel policy has that name." };
  if (id) {
    const p = await prisma.travelPolicy.findFirst({ where: { id, tenantId } });
    if (!p) return { ok: false, message: "Policy not found." };
    if (p.status !== "DRAFT") return { ok: false, message: "Only a draft can be edited. Revise an active policy to change it." };
    await prisma.travelPolicy.update({ where: { id }, data });
    return { ok: true, id, message: `Saved ${data.name}.` };
  }
  const p = await prisma.travelPolicy.create({ data: { ...data, tenantId, createdBy: actorUserId } });
  return { ok: true, id: p.id, message: `Saved ${data.name} as a draft. Submit it for approval to put it in force.` };
}

export async function reviseTravelPolicy(tenantId: string, id: string): Promise<R & { id?: string }> {
  const p = await prisma.travelPolicy.findFirst({ where: { id, tenantId } });
  if (!p || p.status !== "ACTIVE") return { ok: false, message: "Only an active policy is revised." };
  const open = await prisma.travelPolicy.findFirst({ where: { tenantId, supersedesId: id, status: { in: ["DRAFT", "PENDING_APPROVAL"] } } });
  if (open) return { ok: false, id: open.id, message: `A revision (${open.name}) is already open.` };
  let name = `${p.name} (revision)`;
  for (let i = 2; await prisma.travelPolicy.findFirst({ where: { tenantId, name } }); i++) name = `${p.name} (revision ${i})`;
  const { id: _id, createdAt: _c, updatedAt: _u, workflowRequestId: _w, status: _s, ...copy } = p;
  const rev = await prisma.travelPolicy.create({ data: { ...copy, name, status: "DRAFT", supersedesId: id } });
  return { ok: true, id: rev.id, message: `Opened ${name}.` };
}

export async function submitTravelPolicy(tenantId: string, id: string, requesterUserId: string, employeeId: string | null): Promise<R> {
  const p = await prisma.travelPolicy.findFirst({ where: { id, tenantId } });
  if (!p) return { ok: false, message: "Policy not found." };
  if (p.status !== "DRAFT") return { ok: false, message: `This policy is ${p.status.toLowerCase().replace(/_/g, " ")}.` };
  await prisma.travelPolicy.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
  const wf = await startWorkflow({ tenantId, entityType: "TRAVEL_POLICY", entityId: id, title: `${p.supersedesId ? "Revise" : "Publish"} travel policy "${p.name}"`, details: p.description, requesterUserId, subjectEmployeeId: employeeId });
  if (!wf.ok) { await prisma.travelPolicy.update({ where: { id }, data: { status: "DRAFT" } }); return wf; }
  await prisma.travelPolicy.update({ where: { id }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, message: wf.message };
}

export async function applyTravelPolicyDecision(tenantId: string, id: string, approved: boolean, actorUserId: string | null): Promise<void> {
  const p = await prisma.travelPolicy.findFirst({ where: { id, tenantId, status: "PENDING_APPROVAL" } });
  if (!p) return;
  if (!approved) { await prisma.travelPolicy.update({ where: { id }, data: { status: "DRAFT" } }); return; }
  if (p.supersedesId) await prisma.travelPolicy.updateMany({ where: { id: p.supersedesId, tenantId }, data: { status: "RETIRED" } });
  await prisma.travelPolicy.update({ where: { id }, data: { status: "ACTIVE" } });
  await moneyAudit(tenantId, actorUserId, { module: "FINANCE", action: "APPROVE", entityType: "TravelPolicy", entityId: id, summary: `Travel policy ${p.name} approved and in force` });
}

export async function retireTravelPolicy(tenantId: string, id: string): Promise<R> {
  const u = await prisma.travelPolicy.updateMany({ where: { id, tenantId, status: "ACTIVE" }, data: { status: "RETIRED" } });
  return u.count ? { ok: true, message: "Retired." } : { ok: false, message: "Only an active policy can be retired." };
}

/** The active policy for a traveller: one naming their band, else one naming no band. */
export async function travelPolicyFor(employeeId: string) {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { tenantId: true, bandId: true } });
  const live = await prisma.travelPolicy.findMany({ where: { tenantId: emp.tenantId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  return live.find((p) => emp.bandId && p.bandIds.includes(emp.bandId)) ?? live.find((p) => p.bandIds.length === 0) ?? null;
}

export function policyRules(p: Awaited<ReturnType<typeof travelPolicyFor>>): TravelPolicyRules | null {
  if (!p) return null;
  return {
    domesticFlightClass: p.domesticFlightClass, internationalFlightClass: p.internationalFlightClass, hotelCapPerNight: num(p.hotelCapPerNight), groundDailyCap: num(p.groundDailyCap),
    minAdvanceDays: p.minAdvanceDays, secondApprovalAbove: num(p.secondApprovalAbove), internationalNeedsSecondApproval: p.internationalNeedsSecondApproval,
    requireInsuranceInternational: p.requireInsuranceInternational, passportValidityMonths: p.passportValidityMonths,
  };
}

export async function saveTripPurpose(tenantId: string, input: { id?: string | null; code: string; name: string; isBillable: boolean; isActive: boolean }): Promise<R> {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) return { ok: false, message: "Code: 2–20 letters, digits, - or _." };
  if (await prisma.tripPurpose.findFirst({ where: { tenantId, code, ...(input.id ? { id: { not: input.id } } : {}) } })) return { ok: false, message: "That code is in use." };
  const data = { code, name: input.name.trim(), isBillable: input.isBillable, isActive: input.isActive };
  if (input.id) {
    const u = await prisma.tripPurpose.updateMany({ where: { id: input.id, tenantId }, data });
    if (!u.count) return { ok: false, message: "Purpose not found." };
  } else await prisma.tripPurpose.create({ data: { ...data, tenantId } });
  return { ok: true, message: `Saved ${data.name}.` };
}

export async function saveDestinationRisk(tenantId: string, input: { destination: string; level: string; advisory?: string | null; blockTravel: boolean; actorUserId: string }): Promise<R> {
  if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(input.level)) return { ok: false, message: "Pick a risk level." };
  const destination = input.destination.trim();
  if (!destination) return { ok: false, message: "Name the destination." };
  await prisma.destinationRisk.upsert({
    where: { tenantId_destination: { tenantId, destination } },
    create: { tenantId, destination, level: input.level, advisory: input.advisory ?? null, blockTravel: input.blockTravel, updatedBy: input.actorUserId },
    update: { level: input.level, advisory: input.advisory ?? null, blockTravel: input.blockTravel, updatedBy: input.actorUserId },
  });
  return { ok: true, message: `${destination}: ${input.level.toLowerCase()} risk${input.blockTravel ? ", travel blocked" : ""}.` };
}

export async function saveTravelerProfile(employeeId: string, input: { seatPreference?: string | null; mealPreference?: string | null; frequentFlyer?: string | null; hotelPreference?: string | null; passportNumber?: string | null; passportExpiry?: Date | null; passportCountry?: string | null; notes?: string | null }): Promise<R> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { tenantId: true } });
  await prisma.travelerProfile.upsert({ where: { employeeId }, create: { tenantId: emp.tenantId, employeeId, ...input }, update: input });
  return { ok: true, message: "Travel preferences saved." };
}

/** Passport expiry: the identity record, else the traveller profile. */
async function passportExpiryOf(employeeId: string): Promise<Date | null> {
  const id = await prisma.employeeIdentity.findFirst({ where: { employeeId, type: "PASSPORT" }, select: { expiryDate: true } });
  if (id?.expiryDate) return id.expiryDate;
  return (await prisma.travelerProfile.findUnique({ where: { employeeId }, select: { passportExpiry: true } }))?.passportExpiry ?? null;
}

// ---------------------------------------------------------------------------
//  Trip assessment and approval
// ---------------------------------------------------------------------------

/**
 * Check a trip against policy, destination risk and passport validity; store
 * what was found and make sure the pre-travel checklist exists. Returns the
 * violations and whether travel is blocked outright.
 */
export async function assessTrip(tripId: string): Promise<{ violations: Violation[]; blocked: string | null; secondApproval: boolean }> {
  const t = await prisma.travelRequest.findUniqueOrThrow({ where: { id: tripId } });
  const policy = await travelPolicyFor(t.employeeId);
  const rules = policyRules(policy);
  const violations = checkTripPolicy({ travelType: t.travelType, departDate: t.departDate, returnDate: t.returnDate, estimatedCost: num(t.estimatedCost), requestedOn: t.createdAt }, rules);
  const risks = await prisma.destinationRisk.findMany({ where: { tenantId: t.tenantId } });
  const risk = destinationRisk(risks, t.toCity, t.destinationCountry);
  let blocked: string | null = null;
  if (risk) {
    if (risk.blockTravel) blocked = `Travel to ${risk.destination} is blocked: ${risk.advisory ?? `${risk.level.toLowerCase()} risk`}.`;
    else if (["HIGH", "CRITICAL"].includes(risk.level)) violations.push({ code: "DESTINATION_RISK", severity: "approval", message: `${risk.destination} is ${risk.level.toLowerCase()} risk${risk.advisory ? `: ${risk.advisory}` : ""}.` });
    else violations.push({ code: "DESTINATION_RISK", severity: "warning", message: `${risk.destination}: ${risk.level.toLowerCase()} risk advisory.` });
  }
  if (t.travelType === "INTERNATIONAL") {
    const issue = passportIssue(await passportExpiryOf(t.employeeId), t.returnDate ?? t.departDate, rules?.passportValidityMonths ?? 6);
    if (issue) violations.push({ code: "PASSPORT", severity: "warning", message: issue });
    const have = await prisma.tripChecklistItem.findMany({ where: { tripId }, select: { kind: true } });
    const need: Array<[string, string]> = [["PASSPORT", "Passport valid for the trip"], ["VISA", `Visa for ${t.destinationCountry ?? t.toCity}`]];
    if (rules?.requireInsuranceInternational !== false) need.push(["INSURANCE", "Travel insurance covering the trip dates"]);
    for (const [kind, label] of need) if (!have.some((h) => h.kind === kind)) await prisma.tripChecklistItem.create({ data: { tenantId: t.tenantId, tripId, kind, label } });
  }
  await prisma.travelRequest.update({ where: { id: tripId }, data: { policyId: policy?.id ?? null, violations: violations as unknown as Prisma.InputJsonValue, riskLevel: risk?.level ?? null } });
  const configured = await prisma.workflowDefinition.count({ where: { tenantId: t.tenantId, entityType: "TRAVEL_APPROVAL", isCurrent: true, isActive: true } });
  return { violations, blocked, secondApproval: needsSecondTravelApproval(violations) || configured > 0 };
}

/**
 * After the manager approves: if the matrix asks for more (policy breach,
 * international, high-risk destination, or a configured TRAVEL_APPROVAL
 * workflow), route to the travel approval workflow; otherwise approve.
 */
export async function routeTripAfterManager(tripId: string, managerUserId: string): Promise<R> {
  const t = await prisma.travelRequest.findUniqueOrThrow({ where: { id: tripId }, include: { employee: { select: { userId: true, displayName: true } } } });
  const a = await assessTrip(tripId);
  if (a.blocked) {
    await prisma.travelRequest.update({ where: { id: tripId }, data: { status: "REJECTED", rejectReason: a.blocked } });
    return { ok: true, message: a.blocked };
  }
  if (!a.secondApproval) {
    await prisma.travelRequest.update({ where: { id: tripId }, data: { status: "APPROVED", approvedBy: managerUserId, approvedAt: new Date() } });
    return { ok: true, message: "Approved; the travel desk will book it." };
  }
  await prisma.travelRequest.update({ where: { id: tripId }, data: { approvedBy: managerUserId, approvedAt: new Date() } });
  const wf = await startWorkflow({
    tenantId: t.tenantId, entityType: "TRAVEL_APPROVAL", entityId: tripId, title: `${t.requestNumber}: ${t.employee.displayName}, ${t.fromCity} → ${t.toCity}`,
    details: a.violations.map((v) => v.message).join(" "), amount: num(t.estimatedCost), category: t.travelType,
    requesterUserId: t.employee.userId ?? managerUserId, subjectEmployeeId: t.employeeId,
  });
  if (!wf.ok) return wf;
  const after = await prisma.travelRequest.findUniqueOrThrow({ where: { id: tripId }, select: { status: true } });
  if (after.status === "REQUESTED") await prisma.travelRequest.update({ where: { id: tripId }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, message: after.status === "APPROVED" ? "Approved." : "Manager approval recorded; the travel approval matrix needs a second approval." };
}

export async function applyTravelApprovalDecision(tenantId: string, tripId: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN"): Promise<void> {
  const t = await prisma.travelRequest.findFirst({ where: { id: tripId, tenantId, status: "REQUESTED" }, include: { employee: { select: { userId: true } } } });
  if (!t) return;
  if (outcome === "APPROVED") await prisma.travelRequest.update({ where: { id: tripId }, data: { status: "APPROVED" } });
  else await prisma.travelRequest.update({ where: { id: tripId }, data: { status: outcome === "REJECTED" ? "REJECTED" : "CANCELLED", rejectReason: outcome === "REJECTED" ? "Declined at the second travel approval" : "Withdrawn" } });
  if (outcome === "APPROVED") await notify({ tenantId, userIds: await usersWithPermission(tenantId, "expense.travel.manage"), kind: "TRAVEL", title: `${t.requestNumber} approved — ready to book`, link: `/expenses/travel/${t.id}` });
}

/** Edit a trip the manager has not acted on yet. */
export async function editTrip(tripId: string, employeeId: string, input: { purpose: string; fromCity: string; toCity: string; departDate: Date; returnDate?: Date | null; travelType: "DOMESTIC" | "INTERNATIONAL"; needsAccommodation: boolean; estimatedCost?: number | null; purposeId?: string | null; destinationCountry?: string | null }): Promise<R> {
  const t = await prisma.travelRequest.findFirst({ where: { id: tripId, employeeId } });
  if (!t) return { ok: false, message: "Trip not found." };
  if (t.status !== "REQUESTED" || t.approvedAt) return { ok: false, message: "Once approved, request a change instead." };
  if (input.returnDate && input.returnDate < input.departDate) return { ok: false, message: "The return is before the departure." };
  await prisma.travelRequest.update({ where: { id: tripId }, data: { ...input, purposeId: input.purposeId || null, destinationCountry: input.destinationCountry || null, needsVisa: input.travelType === "INTERNATIONAL" } });
  const a = await assessTrip(tripId);
  return { ok: true, message: `Trip updated.${a.violations.length ? ` ${a.violations.map((v) => v.message).join(" ")}` : ""}` };
}

// ---------------------------------------------------------------------------
//  Changes and cancellations
// ---------------------------------------------------------------------------

export async function requestTripChange(input: { tripId: string; employeeId: string; requesterUserId: string; kind: "CHANGE" | "CANCEL"; reason: string; changes?: { departDate?: Date | null; returnDate?: Date | null; toCity?: string | null; estimatedCost?: number | null } }): Promise<R & { id?: string }> {
  const t = await prisma.travelRequest.findFirst({ where: { id: input.tripId, employeeId: input.employeeId } });
  if (!t) return { ok: false, message: "Trip not found." };
  if (!["APPROVED", "BOOKED", "IN_PROGRESS"].includes(t.status)) return { ok: false, message: t.status === "REQUESTED" ? "Edit or cancel the request directly — it is not approved yet." : `A ${t.status.toLowerCase()} trip cannot be changed.` };
  if (!input.reason.trim()) return { ok: false, message: "Say why." };
  if (await prisma.tripChange.findFirst({ where: { tripId: t.id, status: "PENDING" } })) return { ok: false, message: "A change to this trip is already waiting for approval." };
  const ch = input.changes ?? {};
  const changes: Record<string, unknown> = {};
  if (ch.departDate) changes.departDate = ch.departDate.toISOString();
  if (ch.returnDate) changes.returnDate = ch.returnDate.toISOString();
  if (ch.toCity?.trim()) changes.toCity = ch.toCity.trim();
  if (ch.estimatedCost !== null && ch.estimatedCost !== undefined) changes.estimatedCost = ch.estimatedCost;
  if (input.kind === "CHANGE" && Object.keys(changes).length === 0) return { ok: false, message: "Say what changes." };
  const dep = changes.departDate ? new Date(String(changes.departDate)) : t.departDate;
  const ret = changes.returnDate ? new Date(String(changes.returnDate)) : t.returnDate;
  if (ret && ret < dep) return { ok: false, message: "The return is before the departure." };
  const row = await prisma.tripChange.create({ data: { tenantId: t.tenantId, tripId: t.id, kind: input.kind, changes: changes as Prisma.InputJsonValue, reason: input.reason.trim(), requestedBy: input.requesterUserId } });
  const wf = await startWorkflow({ tenantId: t.tenantId, entityType: "TRIP_CHANGE", entityId: row.id, title: `${input.kind === "CANCEL" ? "Cancel" : "Change"} ${t.requestNumber} (${t.fromCity} → ${t.toCity})`, details: input.reason, category: input.kind, amount: num(changes.estimatedCost ?? t.estimatedCost), requesterUserId: input.requesterUserId, subjectEmployeeId: t.employeeId });
  if (!wf.ok) { await prisma.tripChange.delete({ where: { id: row.id } }); return wf; }
  await prisma.tripChange.updateMany({ where: { id: row.id, status: "PENDING" }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, id: row.id, message: wf.message };
}

export async function applyTripChangeDecision(tenantId: string, changeId: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const c = await prisma.tripChange.findFirst({ where: { id: changeId, tenantId, status: "PENDING" } });
  if (!c) return;
  if (outcome !== "APPROVED") { await prisma.tripChange.update({ where: { id: c.id }, data: { status: outcome, decidedAt: new Date() } }); return; }
  const t = await prisma.travelRequest.findUniqueOrThrow({ where: { id: c.tripId } });
  if (c.kind === "CANCEL") {
    await prisma.$transaction([
      prisma.travelRequest.update({ where: { id: t.id }, data: { status: "CANCELLED" } }),
      prisma.travelBooking.updateMany({ where: { tripId: t.id, status: { in: ["CONFIRMED", "PENDING_APPROVAL"] } }, data: { status: "CANCELLED" } }),
    ]);
  } else {
    const ch = (c.changes ?? {}) as Record<string, unknown>;
    await prisma.travelRequest.update({
      where: { id: t.id },
      data: {
        ...(ch.departDate ? { departDate: new Date(String(ch.departDate)) } : {}), ...(ch.returnDate ? { returnDate: new Date(String(ch.returnDate)) } : {}),
        ...(ch.toCity ? { toCity: String(ch.toCity) } : {}), ...(ch.estimatedCost !== undefined ? { estimatedCost: Number(ch.estimatedCost) } : {}),
        // Bookings made for the old plan need the travel desk to rebook.
        ...(t.status === "BOOKED" ? { status: "APPROVED" } : {}),
      },
    });
    await assessTrip(t.id);
    if (t.status === "BOOKED") await notify({ tenantId, userIds: await usersWithPermission(tenantId, "expense.travel.manage"), kind: "TRAVEL", title: `${t.requestNumber} changed — rebook`, link: `/expenses/travel/${t.id}` });
  }
  await prisma.tripChange.update({ where: { id: c.id }, data: { status: "APPLIED", decidedAt: new Date() } });
  await moneyAudit(tenantId, actorUserId, { module: "FINANCE", action: "UPDATE", entityType: "TravelRequest", entityId: t.id, summary: `${t.requestNumber}: ${c.kind === "CANCEL" ? "cancellation" : "change"} approved and applied`, newValue: c.changes ?? undefined });
}

// ---------------------------------------------------------------------------
//  Bookings
// ---------------------------------------------------------------------------

export interface BookingInput { kind: string; vendor: string; reference: string; travelClass?: string | null; startsAt: Date; endsAt?: Date | null; cost: number; itineraryUrl?: string | null }

async function refreshTripCost(tripId: string) {
  const live = await prisma.travelBooking.findMany({ where: { tripId, status: "CONFIRMED" }, orderBy: { createdAt: "asc" } });
  const t = await prisma.travelRequest.findUniqueOrThrow({ where: { id: tripId } });
  const data: Prisma.TravelRequestUpdateInput = { actualCost: live.length ? r2(live.reduce((s, b) => s + Number(b.cost), 0)) : t.actualCost };
  if (live.length && t.status === "APPROVED") Object.assign(data, { status: "BOOKED", bookingRef: live[0]!.reference, bookedAt: new Date(), bookedBy: live[0]!.createdBy });
  await prisma.travelRequest.update({ where: { id: tripId }, data });
}

/** The travel desk records a booking; out-of-policy bookings wait for approval. */
export async function addBooking(tenantId: string, tripId: string, b: BookingInput, byUserId: string, amendedFromId: string | null = null): Promise<R & { id?: string }> {
  const t = await prisma.travelRequest.findFirst({ where: { id: tripId, tenantId }, include: { employee: { select: { userId: true } } } });
  if (!t) return { ok: false, message: "Trip not found." };
  if (!["APPROVED", "BOOKED", "IN_PROGRESS"].includes(t.status)) return { ok: false, message: "Book only an approved trip." };
  if (!["FLIGHT", "HOTEL", "TRAIN", "BUS", "CAB", "OTHER"].includes(b.kind)) return { ok: false, message: "Pick what is being booked." };
  if (!b.vendor.trim() || !b.reference.trim()) return { ok: false, message: "Enter the vendor and booking reference." };
  if (!(b.cost >= 0)) return { ok: false, message: "Enter the cost." };
  if (b.endsAt && b.endsAt < b.startsAt) return { ok: false, message: "It ends before it starts." };
  const v = checkBookingPolicy({ kind: b.kind, travelClass: b.travelClass ?? null, cost: b.cost, startsAt: b.startsAt, endsAt: b.endsAt ?? null }, t.travelType, policyRules(await travelPolicyFor(t.employeeId)));
  const row = await prisma.travelBooking.create({
    data: { tenantId, tripId, kind: b.kind, vendor: b.vendor.trim(), reference: b.reference.trim(), travelClass: b.travelClass || null, startsAt: b.startsAt, endsAt: b.endsAt ?? null, cost: b.cost, itineraryUrl: b.itineraryUrl ?? null, status: v.length ? "PENDING_APPROVAL" : "CONFIRMED", inPolicy: v.length === 0, violation: v.map((x) => x.message).join(" ") || null, amendedFromId, createdBy: byUserId },
  });
  if (v.length) {
    const wf = await startWorkflow({ tenantId, entityType: "TRAVEL_BOOKING", entityId: row.id, title: `${t.requestNumber}: out-of-policy ${b.kind.toLowerCase()} booking ${b.reference}`, details: row.violation, amount: b.cost, category: b.kind, requesterUserId: byUserId, subjectEmployeeId: t.employeeId });
    if (!wf.ok) { await prisma.travelBooking.delete({ where: { id: row.id } }); return wf; }
    await prisma.travelBooking.updateMany({ where: { id: row.id, status: "PENDING_APPROVAL" }, data: { workflowRequestId: wf.requestId } });
    const after = await prisma.travelBooking.findUniqueOrThrow({ where: { id: row.id } });
    return { ok: true, id: row.id, message: after.status === "CONFIRMED" ? "Booked." : `Out of policy — ${row.violation} Sent for approval.` };
  }
  await refreshTripCost(tripId);
  await notify({ tenantId, userIds: [t.employee.userId], kind: "TRAVEL", title: `${t.requestNumber}: ${b.kind.toLowerCase()} booked (${b.reference})`, link: `/expenses/travel/${t.id}` });
  return { ok: true, id: row.id, message: "Booked." };
}

export async function applyBookingDecision(tenantId: string, bookingId: string, approved: boolean): Promise<void> {
  const b = await prisma.travelBooking.findFirst({ where: { id: bookingId, tenantId, status: "PENDING_APPROVAL" } });
  if (!b) return;
  await prisma.travelBooking.update({ where: { id: b.id }, data: { status: approved ? "CONFIRMED" : "REJECTED" } });
  if (approved && b.amendedFromId) await prisma.travelBooking.updateMany({ where: { id: b.amendedFromId, status: "CONFIRMED" }, data: { status: "AMENDED" } });
  await refreshTripCost(b.tripId);
}

/** Amend a confirmed booking: a new booking replaces it (checked against policy again). */
export async function amendBooking(tenantId: string, bookingId: string, b: BookingInput, byUserId: string): Promise<R> {
  const old = await prisma.travelBooking.findFirst({ where: { id: bookingId, tenantId } });
  if (!old || old.status !== "CONFIRMED") return { ok: false, message: "Only a confirmed booking can be amended." };
  const res = await addBooking(tenantId, old.tripId, b, byUserId, old.id);
  if (!res.ok) return res;
  const fresh = await prisma.travelBooking.findUniqueOrThrow({ where: { id: res.id! } });
  if (fresh.status === "CONFIRMED") { await prisma.travelBooking.update({ where: { id: old.id }, data: { status: "AMENDED" } }); await refreshTripCost(old.tripId); }
  return { ok: true, message: fresh.status === "CONFIRMED" ? `Amended: ${old.reference} → ${fresh.reference}.` : res.message };
}

export async function cancelBooking(tenantId: string, bookingId: string): Promise<R> {
  const b = await prisma.travelBooking.findFirst({ where: { id: bookingId, tenantId, status: { in: ["CONFIRMED", "PENDING_APPROVAL"] } } });
  if (!b) return { ok: false, message: "Booking not found." };
  await prisma.travelBooking.update({ where: { id: b.id }, data: { status: "CANCELLED" } });
  await refreshTripCost(b.tripId);
  return { ok: true, message: `Cancelled ${b.reference}.` };
}

// ---------------------------------------------------------------------------
//  Checklist, insurance, advance
// ---------------------------------------------------------------------------

export async function setChecklistItem(tenantId: string, itemId: string, done: boolean, byUserId: string, fileUrl?: string | null): Promise<R> {
  const i = await prisma.tripChecklistItem.findFirst({ where: { id: itemId, tenantId } });
  if (!i) return { ok: false, message: "Checklist item not found." };
  await prisma.tripChecklistItem.update({ where: { id: i.id }, data: { done, doneAt: done ? new Date() : null, doneBy: done ? byUserId : null, ...(fileUrl ? { fileUrl } : {}) } });
  return { ok: true, message: `${i.label}: ${done ? "done" : "reopened"}.` };
}

export async function addChecklistItem(tenantId: string, tripId: string, kind: string, label: string): Promise<R> {
  if (!label.trim()) return { ok: false, message: "Describe the item." };
  await prisma.tripChecklistItem.create({ data: { tenantId, tripId, kind: kind in { VISA: 1, INSURANCE: 1, PASSPORT: 1, FOREX: 1 } ? kind : "OTHER", label: label.trim() } });
  return { ok: true, message: "Added to the checklist." };
}

export async function setTripInsurance(tenantId: string, tripId: string, input: { provider: string; policyNo: string; validTo: Date }, byUserId: string): Promise<R> {
  const t = await prisma.travelRequest.findFirst({ where: { id: tripId, tenantId } });
  if (!t) return { ok: false, message: "Trip not found." };
  if (input.validTo < (t.returnDate ?? t.departDate)) return { ok: false, message: "The insurance ends before the trip does." };
  await prisma.travelRequest.update({ where: { id: tripId }, data: { insuranceProvider: input.provider, insurancePolicyNo: input.policyNo, insuranceValidTo: input.validTo } });
  await prisma.tripChecklistItem.updateMany({ where: { tripId, kind: "INSURANCE", done: false }, data: { done: true, doneAt: new Date(), doneBy: byUserId } });
  return { ok: true, message: `Insured with ${input.provider} (${input.policyNo}).` };
}

/** Link an open cash advance of the traveller to the trip. */
export async function linkTripAdvance(tenantId: string, tripId: string, advanceId: string): Promise<R> {
  const t = await prisma.travelRequest.findFirst({ where: { id: tripId, tenantId } });
  const a = await prisma.cashAdvance.findFirst({ where: { id: advanceId, tenantId } });
  if (!t || !a || a.employeeId !== t.employeeId) return { ok: false, message: "That advance is not the traveller's." };
  if (["REJECTED", "SETTLED", "RECOVERED"].includes(a.status)) return { ok: false, message: "That advance is closed." };
  await prisma.travelRequest.update({ where: { id: tripId }, data: { advanceId } });
  return { ok: true, message: `Advance of ₹${Number(a.amount).toLocaleString("en-IN")} linked to ${t.requestNumber}.` };
}

// ---------------------------------------------------------------------------
//  Settlement
// ---------------------------------------------------------------------------

/** Work out (or refresh) the settlement of a trip, as a draft. */
export async function prepareTravelSettlement(tenantId: string, tripId: string, perDiemTier: string, notes?: string | null): Promise<R & { id?: string }> {
  const t = await prisma.travelRequest.findFirst({ where: { id: tripId, tenantId } });
  if (!t) return { ok: false, message: "Trip not found." };
  if (!["BOOKED", "IN_PROGRESS", "COMPLETED"].includes(t.status)) return { ok: false, message: "Settle a trip once it has been booked and taken." };
  const existing = await prisma.travelSettlement.findUnique({ where: { tripId } });
  if (existing && !["DRAFT", "REJECTED"].includes(existing.status)) return { ok: false, message: `The settlement is already ${existing.status.toLowerCase()}.` };
  const tier = t.travelType === "INTERNATIONAL" ? "INTERNATIONAL" : perDiemTier;
  const rate = (await expenseRateOn(tenantId, "PER_DIEM", tier, t.departDate)) ?? 0;
  const days = perDiemDays(t.departDate, t.returnDate);
  const claims = await prisma.expenseClaim.findMany({ where: { tripId, stage: { in: ["APPROVED", "PAYMENT_PENDING", "PAID"] } }, select: { approvedTotal: true } });
  const bookings = await prisma.travelBooking.findMany({ where: { tripId, status: "CONFIRMED" }, select: { cost: true } });
  const adv = t.advanceId ? await prisma.cashAdvance.findUnique({ where: { id: t.advanceId } }) : null;
  const perDiemAmount = r2(days * rate);
  const advanceOutstanding = adv && ["DISBURSED", "PARTIALLY_SETTLED"].includes(adv.status) ? Number(adv.outstanding) : 0;
  const n = travelSettlementNet({ perDiemAmount, advanceOutstanding });
  const data = {
    perDiemDays: days, perDiemRate: rate, perDiemAmount, claimsTotal: r2(claims.reduce((s, c) => s + Number(c.approvedTotal), 0)),
    bookingsTotal: r2(bookings.reduce((s, b) => s + Number(b.cost), 0)), advanceAmount: advanceOutstanding, netAmount: n.net, notes: notes ?? null, status: "DRAFT",
  };
  const s = existing
    ? await prisma.travelSettlement.update({ where: { id: existing.id }, data })
    : await prisma.travelSettlement.create({ data: { ...data, tenantId, tripId, employeeId: t.employeeId } });
  return { ok: true, id: s.id, message: `Per diem ${days} day(s) × ₹${rate.toLocaleString("en-IN")} = ₹${perDiemAmount.toLocaleString("en-IN")}${rate === 0 ? " (no approved per-diem rate for that tier)" : ""}; ${n.net >= 0 ? `₹${n.net.toLocaleString("en-IN")} payable` : `₹${(-n.net).toLocaleString("en-IN")} to recover`}.` };
}

export async function submitTravelSettlement(tenantId: string, settlementId: string, requesterUserId: string): Promise<R> {
  const s = await prisma.travelSettlement.findFirst({ where: { id: settlementId, tenantId } });
  if (!s) return { ok: false, message: "Settlement not found." };
  if (!["DRAFT", "REJECTED"].includes(s.status)) return { ok: false, message: `Already ${s.status.toLowerCase()}.` };
  const t = await prisma.travelRequest.findUniqueOrThrow({ where: { id: s.tripId } });
  await prisma.travelSettlement.update({ where: { id: s.id }, data: { status: "SUBMITTED" } });
  const wf = await startWorkflow({ tenantId, entityType: "TRAVEL_SETTLEMENT", entityId: s.id, title: `Settle ${t.requestNumber}: per diem ₹${Number(s.perDiemAmount).toLocaleString("en-IN")}, net ₹${Number(s.netAmount).toLocaleString("en-IN")}`, amount: Math.abs(Number(s.netAmount)), requesterUserId, subjectEmployeeId: s.employeeId });
  if (!wf.ok) { await prisma.travelSettlement.update({ where: { id: s.id }, data: { status: "DRAFT" } }); return wf; }
  await prisma.travelSettlement.updateMany({ where: { id: s.id, status: "SUBMITTED" }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, message: wf.message };
}

/** Approved: per diem settles the advance first, the rest is paid or recovered through payroll. */
export async function applyTravelSettlementDecision(tenantId: string, settlementId: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const s = await prisma.travelSettlement.findFirst({ where: { id: settlementId, tenantId, status: "SUBMITTED" } });
  if (!s) return;
  if (outcome !== "APPROVED") { await prisma.travelSettlement.update({ where: { id: s.id }, data: { status: outcome === "REJECTED" ? "REJECTED" : "DRAFT" } }); return; }
  const t = await prisma.travelRequest.findUniqueOrThrow({ where: { id: s.tripId } });
  const adv = t.advanceId ? await prisma.cashAdvance.findUnique({ where: { id: t.advanceId } }) : null;
  const open = adv && ["DISBURSED", "PARTIALLY_SETTLED"].includes(adv.status) ? Number(adv.outstanding) : 0;
  const n = travelSettlementNet({ perDiemAmount: Number(s.perDiemAmount), advanceOutstanding: open });
  const now = new Date();
  const ym = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  let adhocId: string | null = null;
  if (adv && n.settlesAdvance > 0) {
    await prisma.cashAdvance.update({ where: { id: adv.id }, data: { settledAmount: { increment: n.settlesAdvance }, outstanding: n.recover, status: n.recover > 0 ? "PARTIALLY_SETTLED" : "SETTLED" } });
  }
  if (n.payable > 0) {
    adhocId = (await prisma.adhocTransaction.create({ data: { employeeId: s.employeeId, type: "PAYMENT", name: `Per diem ${t.requestNumber}`, amount: n.payable, taxTreatment: "NON_TAXABLE", ...ym, comment: `${s.perDiemDays} day(s) at ₹${Number(s.perDiemRate)}`, sourceType: "TravelSettlement", sourceId: s.id, createdBy: actorUserId } })).id;
  }
  if (adv && n.recover > 0 && !(await prisma.adhocTransaction.count({ where: { sourceType: "CashAdvanceRecovery", sourceId: adv.id, isProcessed: false } }))) {
    adhocId = (await prisma.adhocTransaction.create({ data: { employeeId: s.employeeId, type: "DEDUCTION", name: `Cash advance recovery (${t.requestNumber})`, amount: n.recover, taxTreatment: "NON_TAXABLE", ...ym, sourceType: "CashAdvanceRecovery", sourceId: adv.id, createdBy: actorUserId } })).id;
  }
  await prisma.travelSettlement.update({ where: { id: s.id }, data: { status: "APPROVED", approvedAt: now, netAmount: n.net, advanceAmount: open, adhocId } });
  if (["BOOKED", "IN_PROGRESS"].includes(t.status)) await prisma.travelRequest.update({ where: { id: t.id }, data: { status: "COMPLETED" } });
  await moneyAudit(tenantId, actorUserId, { module: "FINANCE", action: "APPROVE", entityType: "TravelSettlement", entityId: s.id, summary: `${t.requestNumber} settled: per diem ₹${Number(s.perDiemAmount)}, ${n.payable > 0 ? `₹${n.payable} paid` : ""}${n.recover > 0 ? ` ₹${n.recover} recovered` : ""}`.trim() });
}

// ---------------------------------------------------------------------------
//  Reports and dashboards
// ---------------------------------------------------------------------------

export interface TripFilter { q?: string | null; status?: string | null; travelType?: string | null; from?: Date | null; to?: Date | null; purposeId?: string | null; employeeIds?: string[] | null }

export function tripWhere(tenantId: string, f: TripFilter): Prisma.TravelRequestWhereInput {
  return {
    tenantId,
    ...(f.status ? { status: f.status as never } : {}),
    ...(f.travelType ? { travelType: f.travelType } : {}),
    ...(f.purposeId ? { purposeId: f.purposeId } : {}),
    ...(f.employeeIds ? { employeeId: { in: f.employeeIds } } : {}),
    ...(f.from || f.to ? { departDate: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: new Date(f.to.getTime() + 86_399_999) } : {}) } } : {}),
    ...(f.q ? { OR: [{ requestNumber: { contains: f.q, mode: "insensitive" } }, { purpose: { contains: f.q, mode: "insensitive" } }, { toCity: { contains: f.q, mode: "insensitive" } }, { fromCity: { contains: f.q, mode: "insensitive" } }, { employee: { displayName: { contains: f.q, mode: "insensitive" } } }] } : {}),
  };
}

export async function travelReport(tenantId: string, kind: "trips" | "bookings" | "settlements" | "per-diem", f: TripFilter) {
  const trips = await prisma.travelRequest.findMany({ where: tripWhere(tenantId, f), include: { employee: { select: { displayName: true, employeeNumber: true, departmentId: true } } }, orderBy: { departDate: "desc" }, take: 5000 });
  const ids = trips.map((t) => t.id);
  const purposes = new Map((await prisma.tripPurpose.findMany({ where: { tenantId } })).map((p) => [p.id, p.name]));
  if (kind === "bookings") {
    const rows = await prisma.travelBooking.findMany({ where: { tenantId, tripId: { in: ids } }, orderBy: { startsAt: "asc" } });
    const trip = new Map(trips.map((t) => [t.id, t]));
    return { title: "Travel bookings", head: ["Trip", "Traveller", "Kind", "Vendor", "Reference", "Class", "Starts", "Ends", "Cost", "Status", "In policy", "Violation"], rows: rows.map((b) => [trip.get(b.tripId)?.requestNumber, trip.get(b.tripId)?.employee.displayName, b.kind, b.vendor, b.reference, b.travelClass ?? "", b.startsAt, b.endsAt, Number(b.cost), b.status, b.inPolicy ? "Yes" : "No", b.violation ?? ""]) };
  }
  if (kind === "settlements" || kind === "per-diem") {
    const rows = await prisma.travelSettlement.findMany({ where: { tenantId, tripId: { in: ids } } });
    const trip = new Map(trips.map((t) => [t.id, t]));
    if (kind === "per-diem") return { title: "Per diem", head: ["Trip", "Traveller", "Days", "Rate", "Per diem", "Status"], rows: rows.map((s) => [trip.get(s.tripId)?.requestNumber, trip.get(s.tripId)?.employee.displayName, Number(s.perDiemDays), Number(s.perDiemRate), Number(s.perDiemAmount), s.status]) };
    return { title: "Travel settlements", head: ["Trip", "Traveller", "Per diem", "Claims", "Company-paid bookings", "Advance", "Net (+pay / −recover)", "Status", "Approved"], rows: rows.map((s) => [trip.get(s.tripId)?.requestNumber, trip.get(s.tripId)?.employee.displayName, Number(s.perDiemAmount), Number(s.claimsTotal), Number(s.bookingsTotal), Number(s.advanceAmount), Number(s.netAmount), s.status, s.approvedAt]) };
  }
  return {
    title: "Trips", head: ["Trip", "Traveller", "Number", "Purpose", "Category", "From", "To", "Type", "Depart", "Return", "Estimated", "Actual", "Status", "Risk", "Policy issues"],
    rows: trips.map((t) => [t.requestNumber, t.employee.displayName, t.employee.employeeNumber, t.purpose, t.purposeId ? purposes.get(t.purposeId) ?? "" : "", t.fromCity, t.toCity, t.travelType, t.departDate, t.returnDate, num(t.estimatedCost), num(t.actualCost), t.status, t.riskLevel ?? "", ((t.violations ?? []) as unknown as Violation[]).map((v) => v.message).join(" ")]),
  };
}

/** Spend by month, purpose, department and destination for the dashboard. */
export async function travelSpend(tenantId: string, from: Date, to: Date) {
  const trips = await prisma.travelRequest.findMany({ where: { tenantId, departDate: { gte: from, lte: to }, status: { notIn: ["REJECTED", "CANCELLED"] } }, include: { employee: { select: { department: { select: { name: true } } } } } });
  const purposes = new Map((await prisma.tripPurpose.findMany({ where: { tenantId } })).map((p) => [p.id, p.name]));
  const cost = (t: (typeof trips)[number]) => Number(t.actualCost ?? t.estimatedCost ?? 0);
  const group = (key: (t: (typeof trips)[number]) => string) => {
    const m = new Map<string, { trips: number; spend: number }>();
    for (const t of trips) { const k = key(t); const v = m.get(k) ?? { trips: 0, spend: 0 }; v.trips++; v.spend = r2(v.spend + cost(t)); m.set(k, v); }
    return [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.spend - a.spend);
  };
  return {
    total: r2(trips.reduce((s, t) => s + cost(t), 0)), count: trips.length,
    international: trips.filter((t) => t.travelType === "INTERNATIONAL").length,
    outOfPolicy: trips.filter((t) => Array.isArray(t.violations) && (t.violations as unknown[]).length > 0).length,
    byMonth: group((t) => t.departDate.toISOString().slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    byPurpose: group((t) => (t.purposeId ? purposes.get(t.purposeId) ?? "Other" : "Unclassified")),
    byDepartment: group((t) => t.employee.department?.name ?? "No department"),
    byDestination: group((t) => t.toCity).slice(0, 10),
  };
}
