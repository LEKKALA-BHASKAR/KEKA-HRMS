"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  saveTravelPolicy, reviseTravelPolicy, submitTravelPolicy, retireTravelPolicy, saveTripPurpose, saveDestinationRisk, saveTravelerProfile,
  editTrip, requestTripChange, addBooking, amendBooking, cancelBooking, setChecklistItem, addChecklistItem, setTripInsurance, linkTripAdvance,
  prepareTravelSettlement, submitTravelSettlement, FLIGHT_CLASSES,
} from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { storeUpload } from "@/lib/money";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zBool, zId, zOptionalId, formList, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
const paths = (tripId?: string) => ["/expenses", "/expenses/travel", "/expenses/travel/policies", "/expenses/travel/dashboard", "/me/expenses", "/inbox", ...(tripId ? [`/expenses/travel/${tripId}`] : [])];

/** The trip, when the viewer is its traveller, the travel desk, or approves for the traveller. */
async function tripFor(viewer: Viewer, tripId: string, mode: "own" | "desk" | "own-or-desk" | "view") {
  const t = await prisma.travelRequest.findFirst({ where: { id: tripId, tenantId: viewer.tenantId }, include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } } });
  if (!t) return null;
  const own = t.employeeId === viewer.employee?.id;
  const desk = can(viewer, P.TRAVEL_MANAGE);
  if (mode === "own") return own ? t : null;
  if (mode === "desk") return desk ? t : null;
  if (mode === "own-or-desk") return own || desk ? t : null;
  return own || desk || canAccessEmployee(viewer, t.employee, P.EXPENSE_APPROVE) ? t : null;
}

// --- Policies and master data ----------------------------------------------

const classes = FLIGHT_CLASSES;
const policySchema = z.object({
  id: zOptionalId(), name: zName(80), description: zOptional(300),
  domesticFlightClass: z.enum(classes), internationalFlightClass: z.enum(classes),
  hotelCapPerNight: zNumber({ min: 0 }), groundDailyCap: zNumber({ min: 0 }), minAdvanceDays: zRequiredNumber({ min: 0, max: 90 }),
  secondApprovalAbove: zNumber({ min: 0 }), internationalNeedsSecondApproval: zBool(), requireInsuranceInternational: zBool(), passportValidityMonths: zRequiredNumber({ min: 0, max: 24 }),
});

export async function saveTravelPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAVEL_MANAGE);
  const parsed = parseForm(policySchema, formData);
  if (parsed.state) return parsed.state;
  const bandIds = formList(formData, "bandIds");
  if (bandIds.length && (await prisma.band.count({ where: { tenantId: viewer.tenantId, id: { in: bandIds } } })) !== bandIds.length) return { ok: false, message: "Unknown band." };
  try {
    const res = await saveTravelPolicy({ tenantId: viewer.tenantId, ...parsed.data, bandIds, actorUserId: viewer.user.id });
    if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: parsed.data.id ? "UPDATE" : "CREATE", entityType: "TravelPolicy", entityId: res.id, summary: `Saved travel policy ${parsed.data.name}`, newValue: { ...parsed.data, bandIds } });
    return res.ok ? done(paths(), res.message) : { ok: false, message: res.message };
  } catch (err) { return toErrorState(err); }
}

export async function travelPolicyOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAVEL_MANAGE);
  const id = String(formData.get("id") ?? "");
  const op = String(formData.get("op") ?? "");
  const p = await prisma.travelPolicy.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!p) return { ok: false, message: "Policy not found." };
  const res = op === "submit" ? await submitTravelPolicy(viewer.tenantId, id, viewer.user.id, viewer.employee?.id ?? null)
    : op === "revise" ? await reviseTravelPolicy(viewer.tenantId, id)
    : op === "retire" ? await retireTravelPolicy(viewer.tenantId, id)
    : { ok: false, message: "Unknown action." };
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: op === "retire" ? "DELETE" : "UPDATE", entityType: "TravelPolicy", entityId: id, summary: `${p.name}: ${op} — ${res.message}` });
  return res.ok ? done(paths(), res.message) : { ok: false, message: res.message };
}

const purposeSchema = z.object({ id: zOptionalId(), code: zName(20), name: zName(80), isBillable: zBool(), isActive: zBool() });

export async function saveTripPurposeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAVEL_MANAGE);
  const parsed = parseForm(purposeSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await saveTripPurpose(viewer.tenantId, parsed.data);
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: parsed.data.id ? "UPDATE" : "CREATE", entityType: "TripPurpose", entityId: parsed.data.id, summary: `Trip purpose ${parsed.data.code}: ${res.message}` });
  return res.ok ? done(paths(), res.message) : { ok: false, message: res.message };
}

const riskSchema = z.object({ destination: zName(80), level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]), advisory: zOptional(500), blockTravel: zBool() });

export async function saveDestinationRiskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAVEL_MANAGE);
  const parsed = parseForm(riskSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await saveDestinationRisk(viewer.tenantId, { ...parsed.data, actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "DestinationRisk", summary: res.message });
  return res.ok ? done(paths(), res.message) : { ok: false, message: res.message };
}

const profileSchema = z.object({
  seatPreference: zOptional(30), mealPreference: zOptional(30), frequentFlyer: zOptional(120), hotelPreference: zOptional(120),
  passportNumber: zOptional(20), passportExpiry: zDate(), passportCountry: zOptional(60), notes: zOptional(500),
});

export async function saveTravelerProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(profileSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await saveTravelerProfile(viewer.employee.id, parsed.data);
  if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "TravelerProfile", entityId: viewer.employee.id, summary: "Travel preferences updated" });
  return res.ok ? done(paths(), res.message) : { ok: false, message: res.message };
}

// --- Trips ------------------------------------------------------------------

const editSchema = z.object({
  tripId: zId(), purpose: zName(300), fromCity: zName(60), toCity: zName(60), departDate: zRequiredDate(), returnDate: zDate(),
  travelType: z.enum(["DOMESTIC", "INTERNATIONAL"]), needsAccommodation: zBool(), estimatedCost: zNumber({ min: 0 }), purposeId: zOptionalId(), destinationCountry: zOptional(60),
});

export async function editTripAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(editSchema, formData);
  if (parsed.state) return parsed.state;
  const { tripId, ...d } = parsed.data;
  const t = await tripFor(viewer, tripId, "own");
  if (!t) return { ok: false, message: "Trip not found." };
  const res = await editTrip(tripId, t.employeeId, d);
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "TravelRequest", entityId: tripId, summary: `${t.requestNumber} edited`, oldValue: { toCity: t.toCity, departDate: t.departDate, returnDate: t.returnDate, estimatedCost: t.estimatedCost }, newValue: d });
  return res.ok ? done(paths(tripId), res.message) : { ok: false, message: res.message };
}

const changeSchema = z.object({ tripId: zId(), kind: z.enum(["CHANGE", "CANCEL"]), reason: zName(500), departDate: zDate(), returnDate: zDate(), toCity: zOptional(60), estimatedCost: zNumber({ min: 0 }) });

export async function requestTripChangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(changeSchema, formData);
  if (parsed.state) return parsed.state;
  const { tripId, kind, reason, ...changes } = parsed.data;
  const t = await tripFor(viewer, tripId, "own");
  if (!t) return { ok: false, message: "Trip not found." };
  const res = await requestTripChange({ tripId, employeeId: t.employeeId, requesterUserId: viewer.user.id, kind, reason, changes });
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "TravelRequest", entityId: tripId, summary: `${t.requestNumber}: ${kind === "CANCEL" ? "cancellation" : "change"} requested — ${reason}`, newValue: changes });
  return res.ok ? done(paths(tripId), res.message) : { ok: false, message: res.message };
}

// --- Bookings and itinerary -------------------------------------------------

const bookingSchema = z.object({
  tripId: zId(), bookingId: zOptionalId(), kind: z.enum(["FLIGHT", "HOTEL", "TRAIN", "CAB", "OTHER"]), vendor: zName(80), reference: zName(60),
  travelClass: zOptional(30), startsAt: zRequiredDate(), endsAt: zDate(), cost: zRequiredNumber({ min: 0, max: 10_000_000 }),
});

export async function saveBookingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAVEL_MANAGE);
  const parsed = parseForm(bookingSchema, formData);
  if (parsed.state) return parsed.state;
  const { tripId, bookingId, ...b } = parsed.data;
  const t = await tripFor(viewer, tripId, "desk");
  if (!t) return { ok: false, message: "Trip not found." };
  try {
    const up = await storeUpload(viewer, formData.get("itinerary"), "TravelItinerary", t.employeeId);
    const input = { ...b, itineraryUrl: up?.url ?? null };
    const res = bookingId ? await amendBooking(viewer.tenantId, bookingId, input, viewer.user.id) : await addBooking(viewer.tenantId, tripId, input, viewer.user.id);
    if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: bookingId ? "UPDATE" : "CREATE", entityType: "TravelBooking", entityId: bookingId ?? (res as { id?: string }).id ?? null, summary: `${t.requestNumber}: ${b.kind.toLowerCase()} ${b.vendor} ${b.reference} ₹${b.cost} — ${res.message}`, newValue: input });
    return res.ok ? done(paths(tripId), res.message) : { ok: false, message: res.message };
  } catch (err) { return toErrorState(err); }
}

export async function cancelBookingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TRAVEL_MANAGE);
  const id = String(formData.get("bookingId") ?? "");
  const b = await prisma.travelBooking.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!b) return { ok: false, message: "Booking not found." };
  const res = await cancelBooking(viewer.tenantId, id);
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "DELETE", entityType: "TravelBooking", entityId: id, summary: `Booking ${b.reference} cancelled` });
  return res.ok ? done(paths(b.tripId), res.message) : { ok: false, message: res.message };
}

/** Store an itinerary document (ticket, hotel voucher) on a booking. */
export async function uploadItineraryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("bookingId") ?? "");
  const b = await prisma.travelBooking.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!b) return { ok: false, message: "Booking not found." };
  const t = await tripFor(viewer, b.tripId, "own-or-desk");
  if (!t) return { ok: false, message: "Booking not found." };
  try {
    const up = await storeUpload(viewer, formData.get("itinerary"), "TravelItinerary", t.employeeId);
    if (!up) return { ok: false, message: "Choose the file." };
    await prisma.travelBooking.update({ where: { id }, data: { itineraryUrl: up.url } });
    await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "TravelBooking", entityId: id, summary: `Itinerary stored for ${b.reference}` });
    return done(paths(b.tripId), "Itinerary stored.");
  } catch (err) { return toErrorState(err); }
}

// --- Checklist, insurance, advance -----------------------------------------

export async function checklistAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const tripId = String(formData.get("tripId") ?? "");
  const t = await tripFor(viewer, tripId, "own-or-desk");
  if (!t) return { ok: false, message: "Trip not found." };
  try {
    let res;
    if (formData.get("op") === "add") res = await addChecklistItem(viewer.tenantId, tripId, String(formData.get("kind") ?? "OTHER"), String(formData.get("label") ?? ""));
    else {
      const itemId = String(formData.get("itemId") ?? "");
      if (!(await prisma.tripChecklistItem.findFirst({ where: { id: itemId, tripId } }))) return { ok: false, message: "Checklist item not found." };
      const up = await storeUpload(viewer, formData.get("file"), "TravelDocument", t.employeeId);
      res = await setChecklistItem(viewer.tenantId, itemId, formData.get("done") !== "false", viewer.user.id, up?.url ?? null);
    }
    if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "TripChecklistItem", entityId: tripId, summary: `${t.requestNumber}: ${res.message}` });
    return res.ok ? done(paths(tripId), res.message) : { ok: false, message: res.message };
  } catch (err) { return toErrorState(err); }
}

const insuranceSchema = z.object({ tripId: zId(), provider: zName(80), policyNo: zName(60), validTo: zRequiredDate() });

export async function tripInsuranceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(insuranceSchema, formData);
  if (parsed.state) return parsed.state;
  const t = await tripFor(viewer, parsed.data.tripId, "own-or-desk");
  if (!t) return { ok: false, message: "Trip not found." };
  const res = await setTripInsurance(viewer.tenantId, t.id, parsed.data, viewer.user.id);
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "TravelRequest", entityId: t.id, summary: `${t.requestNumber}: ${res.message}` });
  return res.ok ? done(paths(t.id), res.message) : { ok: false, message: res.message };
}

export async function linkTripAdvanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const tripId = String(formData.get("tripId") ?? "");
  const t = await tripFor(viewer, tripId, "own-or-desk");
  if (!t) return { ok: false, message: "Trip not found." };
  const res = await linkTripAdvance(viewer.tenantId, tripId, String(formData.get("advanceId") ?? ""));
  if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "TravelRequest", entityId: tripId, summary: `${t.requestNumber}: ${res.message}` });
  return res.ok ? done(paths(tripId), res.message) : { ok: false, message: res.message };
}

// --- Settlement -------------------------------------------------------------

const settleSchema = z.object({ tripId: zId(), perDiemTier: z.enum(["TIER_1", "TIER_2", "TIER_3", "INTERNATIONAL"]), notes: zOptional(500), intent: z.enum(["prepare", "submit"]).default("prepare") });

export async function travelSettlementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(settleSchema, formData);
  if (parsed.state) return parsed.state;
  const t = await tripFor(viewer, parsed.data.tripId, "own-or-desk");
  if (!t) return { ok: false, message: "Trip not found." };
  const prep = await prepareTravelSettlement(viewer.tenantId, t.id, parsed.data.perDiemTier, parsed.data.notes);
  if (!prep.ok || !prep.id) return { ok: false, message: prep.message };
  let message = prep.message;
  if (parsed.data.intent === "submit") {
    const sub = await submitTravelSettlement(viewer.tenantId, prep.id, viewer.user.id);
    if (!sub.ok) return { ok: false, message: sub.message };
    message = `${prep.message} ${sub.message}`;
  }
  await writeAudit(viewer, { module: "FINANCE", action: parsed.data.intent === "submit" ? "CREATE" : "UPDATE", entityType: "TravelSettlement", entityId: prep.id, summary: `${t.requestNumber} settlement ${parsed.data.intent === "submit" ? "submitted" : "worked out"}: ${prep.message}` });
  return done(paths(t.id), message);
}
