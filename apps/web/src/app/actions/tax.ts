"use server";

import { prisma } from "@keka/db";
import { ageAtFyEnd, previousIncomeApplies } from "@keka/services";
import { fyStartYear, formatINR } from "@keka/shared";
import { requireViewer, type Viewer } from "@/lib/context";
import { saveFile, sniffUpload, MAX_UPLOAD_BYTES } from "@/lib/storage";
import {
  writeAudit, actionDone, parseForm, toErrorState, z, zBool, zNumber, zOptional, zPan, type ActionState,
} from "@/lib/forms";
import {
  declarationWindows, regimeSwitchState, roomLeft, sectionAllowed, sectionName, SECTION_BY_KEY, tabForSection,
  LANDLORD_PAN_THRESHOLD,
} from "@/app/(app)/finances/_lib/rules";

/**
 * An employee's own tax declaration: add and remove lines while the
 * declaration window is open, upload proof while the proof window is open,
 * declare rent and previous-employer income, and choose a regime before the
 * cut-off. Every action works on the signed-in employee's record only — no
 * id from the form ever selects whose declaration is changed — and every
 * write is audited against the declaration so the page can show its history.
 */

const PATHS = ["/finances/tax", "/finances/tax/previous-income", "/finances/pay/tax", "/finances"];
const MAX_AMOUNT = 1_00_00_000;

async function context(viewer: Viewer) {
  if (!viewer.employee) throw new Error("This login is not linked to an employee record.");
  const employeeId = viewer.employee.id;
  const now = new Date();
  const fy = fyStartYear(now, viewer.tenant.fyStartMonth);
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: {
      dateOfBirth: true, dateOfJoining: true,
      statutoryProfile: { select: { id: true, taxRegime: true, regimeLockedAt: true } },
      payGroup: {
        select: {
          declarationOpenDay: true, declarationCloseDay: true, declarationFyCutoff: true, newJoinerWindowDays: true,
          proofSubmissionDue: true, allowLateDeclaration: true, allowRegimeChoice: true, regimeChangeCutoff: true,
        },
      },
    },
  });
  if (!emp) throw new Error("Your employee record could not be found.");
  const declaration = await prisma.investmentDeclaration.findUnique({
    where: { employeeId_fyStartYear: { employeeId, fyStartYear: fy } },
    include: { items: true },
  });
  const windows = declarationWindows(emp.payGroup, {
    fy, currentFy: fy, now, joinedOn: emp.dateOfJoining, locked: declaration?.status === "LOCKED", fyStartMonth: viewer.tenant.fyStartMonth,
  });
  const regime = emp.statutoryProfile?.taxRegime ?? "NEW";
  return { employeeId, fy, emp, declaration, windows, regime, age: ageAtFyEnd(emp.dateOfBirth, fy) };
}

/** The declaration for the current year, created on first use. */
async function ensureDeclaration(employeeId: string, fy: number, regime: "OLD" | "NEW") {
  return prisma.investmentDeclaration.upsert({
    where: { employeeId_fyStartYear: { employeeId, fyStartYear: fy } },
    create: { employeeId, fyStartYear: fy, regime, status: "DRAFT" },
    update: {},
  });
}

/** Keep the header totals in step with the lines. */
async function retotal(declarationId: string) {
  const items = await prisma.declarationItem.findMany({ where: { declarationId }, select: { declaredAmount: true, approvedAmount: true } });
  const declared = items.reduce((s, i) => s + Number(i.declaredAmount), 0);
  const approved = items.reduce((s, i) => s + Number(i.approvedAmount), 0);
  await prisma.investmentDeclaration.update({
    where: { id: declarationId },
    data: { declaredTotal: declared, approvedTotal: approved, status: "SUBMITTED", submittedAt: new Date() },
  });
}

const itemSchema = z.object({
  section: z.string().min(1, "Choose a section"),
  category: z.string().min(2, "Describe the investment or payment").max(120, "Keep it under 120 characters"),
  description: zOptional(300),
  amount: zNumber({ min: 1, max: MAX_AMOUNT, required: true }),
});

export async function addDeclarationItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const viewer = await requireViewer();
    const parsed = parseForm(itemSchema, formData);
    if (parsed.state) return parsed.state;
    const { section, category, description } = parsed.data;
    const amount = Math.round((parsed.data.amount as number) * 100) / 100;
    const c = await context(viewer);
    if (!c.windows.declaration.open) return { ok: false, message: c.windows.declaration.note };
    const info = SECTION_BY_KEY.get(section);
    if (!info || !tabForSection(section)) return { ok: false, message: "Choose a valid section.", errors: { section: "Invalid section" } };
    if (!sectionAllowed(section, c.regime)) {
      return { ok: false, message: `${sectionName(section)} is not available under the new tax regime.`, errors: { section: "Not allowed under the new regime" } };
    }
    const existing = (c.declaration?.items ?? []).map((i) => ({ section: i.section, declaredAmount: Number(i.declaredAmount) }));
    const room = roomLeft(section, existing, c.age);
    if (room !== null && amount > room) {
      return {
        ok: false,
        message: room === 0
          ? `You have already declared the maximum allowed under ${sectionName(section)}.`
          : `Only ${formatINR(room)} more can be declared under ${sectionName(section)} — its ceiling is reached otherwise.`,
        errors: { amount: `At most ${formatINR(room)}` },
        values: Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>,
      };
    }
    const decl = c.declaration ?? (await ensureDeclaration(c.employeeId, c.fy, c.regime));
    const item = await prisma.declarationItem.create({
      data: { declarationId: decl.id, section, category, description, declaredAmount: amount },
    });
    await retotal(decl.id);
    await writeAudit(viewer, {
      module: "PAYROLL", action: "CREATE", entityType: "InvestmentDeclaration", entityId: decl.id,
      summary: `Declared ${formatINR(amount)} under ${sectionName(section)} — ${category}`,
      newValue: { itemId: item.id, section, category, amount },
    });
    return actionDone(PATHS, `Added ${formatINR(amount)} under ${sectionName(section)}.`);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function removeDeclarationItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const viewer = await requireViewer();
    const c = await context(viewer);
    if (!c.windows.declaration.open) return { ok: false, message: c.windows.declaration.note };
    const item = c.declaration?.items.find((i) => i.id === String(formData.get("itemId") ?? ""));
    // Only a line on the viewer's own declaration for this year can be found here.
    if (!item || !c.declaration) return { ok: false, message: "That declaration was not found." };
    if (item.proofStatus === "APPROVED") return { ok: false, message: "This declaration's proof has been accepted, so it can no longer be removed." };
    await prisma.declarationItem.delete({ where: { id: item.id } });
    await retotal(c.declaration.id);
    await writeAudit(viewer, {
      module: "PAYROLL", action: "DELETE", entityType: "InvestmentDeclaration", entityId: c.declaration.id,
      summary: `Removed ${formatINR(Number(item.declaredAmount))} under ${sectionName(item.section)} — ${item.category}`,
      oldValue: { itemId: item.id, section: item.section, category: item.category, amount: Number(item.declaredAmount) },
    });
    return actionDone(PATHS, "Declaration removed.");
  } catch (err) {
    return toErrorState(err);
  }
}

export async function submitProofAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const viewer = await requireViewer();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a file to upload.", errors: { file: "Required" } };
    if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: "Files are limited to 10 MB.", errors: { file: "Too large" } };
    const c = await context(viewer);
    if (!c.windows.proof.open) return { ok: false, message: c.windows.proof.note };
    const item = c.declaration?.items.find((i) => i.id === String(formData.get("itemId") ?? ""));
    if (!item || !c.declaration) return { ok: false, message: "That declaration was not found." };
    if (item.proofStatus === "APPROVED") return { ok: false, message: "This proof has already been accepted." };

    const data = Buffer.from(await file.arrayBuffer());
    const sniff = sniffUpload(data, file.type);
    if (!sniff.ok) return { ok: false, message: sniff.reason, errors: { file: sniff.reason } };
    const stored = await saveFile({
      tenantId: viewer.tenantId, filename: file.name || `Proof-${item.section}.pdf`, mimeType: sniff.mimeType, data,
      relatedType: "DeclarationItem", relatedId: item.id, employeeId: c.employeeId, uploadedBy: viewer.user.id,
    });
    await prisma.declarationItem.update({
      where: { id: item.id },
      data: { proofStatus: "SUBMITTED", proofFileUrl: `/files/${stored.id}`, proofRemark: null, reviewedBy: null, reviewedAt: null },
    });
    await writeAudit(viewer, {
      module: "PAYROLL", action: "UPDATE", entityType: "InvestmentDeclaration", entityId: c.declaration.id,
      summary: `Uploaded proof for ${sectionName(item.section)} — ${item.category} (${Math.max(1, Math.round(data.length / 1024))} KB)`,
      newValue: { itemId: item.id, fileId: stored.id },
    });
    return actionDone(PATHS, "Proof uploaded. Your payroll team will review it.");
  } catch (err) {
    return toErrorState(err);
  }
}

const hraSchema = z.object({
  annualRent: zNumber({ min: 0, max: MAX_AMOUNT, required: true }),
  isMetro: zBool(),
  landlordName: zOptional(120),
  landlordPan: zPan(),
  rentAddress: zOptional(300),
});

export async function saveRentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const viewer = await requireViewer();
    const parsed = parseForm(hraSchema, formData);
    if (parsed.state) return parsed.state;
    const d = parsed.data;
    const rent = d.annualRent as number;
    const c = await context(viewer);
    if (!c.windows.declaration.open) return { ok: false, message: c.windows.declaration.note };
    if (c.regime !== "OLD") return { ok: false, message: "The HRA exemption is not available under the new tax regime." };
    const values = Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;
    if (rent > 0 && !d.landlordName) return { ok: false, message: "Enter your landlord's name.", errors: { landlordName: "Required" }, values };
    if (rent > LANDLORD_PAN_THRESHOLD && !d.landlordPan) {
      return { ok: false, message: `Your landlord's PAN is required when annual rent exceeds ${formatINR(LANDLORD_PAN_THRESHOLD)}.`, errors: { landlordPan: "Required above ₹1,00,000 a year" }, values };
    }
    const decl = c.declaration ?? (await ensureDeclaration(c.employeeId, c.fy, c.regime));
    if (rent === 0) {
      await prisma.hraDeclaration.deleteMany({ where: { declarationId: decl.id } });
    } else {
      const data = { mode: "ANNUAL" as const, isMetro: d.isMetro, annualRent: rent, landlordName: d.landlordName, landlordPan: d.landlordPan, rentAddress: d.rentAddress };
      await prisma.hraDeclaration.upsert({ where: { declarationId: decl.id }, create: { declarationId: decl.id, ...data }, update: data });
    }
    await prisma.investmentDeclaration.update({ where: { id: decl.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    await writeAudit(viewer, {
      module: "PAYROLL", action: "UPDATE", entityType: "InvestmentDeclaration", entityId: decl.id,
      summary: rent === 0 ? "Removed rent declaration" : `Declared annual rent of ${formatINR(rent)}${d.isMetro ? " (metro)" : ""}`,
      newValue: { annualRent: rent, isMetro: d.isMetro },
    });
    return actionDone(PATHS, rent === 0 ? "Rent declaration removed." : "Rent declaration saved.");
  } catch (err) {
    return toErrorState(err);
  }
}

const previousSchema = z.object({
  previousEmployerIncome: zNumber({ min: 0, max: MAX_AMOUNT }),
  previousEmployerTds: zNumber({ min: 0, max: MAX_AMOUNT }),
  previousEmployerPf: zNumber({ min: 0, max: MAX_AMOUNT }),
  previousEmployerPt: zNumber({ min: 0, max: 2500 }),
}).refine((v) => (v.previousEmployerTds ?? 0) <= (v.previousEmployerIncome ?? 0), {
  message: "Tax deducted cannot exceed the income it was deducted from", path: ["previousEmployerTds"],
});

export async function savePreviousIncomeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const viewer = await requireViewer();
    const parsed = parseForm(previousSchema, formData);
    if (parsed.state) return parsed.state;
    const c = await context(viewer);
    if (!previousIncomeApplies(c.emp.dateOfJoining, c.fy, viewer.tenant.fyStartMonth)) {
      return { ok: false, message: "Previous employment details are not required for this financial year, as you joined before it began." };
    }
    if (!c.windows.declaration.open) return { ok: false, message: c.windows.declaration.note };
    const d = parsed.data;
    const data = {
      previousEmployerIncome: d.previousEmployerIncome, previousEmployerTds: d.previousEmployerTds,
      previousEmployerPf: d.previousEmployerPf, previousEmployerPt: d.previousEmployerPt,
    };
    const before = await prisma.employeeStatutoryProfile.findUnique({
      where: { employeeId: c.employeeId },
      select: { previousEmployerIncome: true, previousEmployerTds: true, previousEmployerPf: true, previousEmployerPt: true },
    });
    const profile = await prisma.employeeStatutoryProfile.upsert({
      where: { employeeId: c.employeeId }, create: { employeeId: c.employeeId, ...data }, update: data,
    });
    await writeAudit(viewer, {
      module: "PAYROLL", action: "UPDATE", entityType: "EmployeeStatutoryProfile", entityId: profile.id,
      summary: `Updated previous-employer income for FY ${c.fy}-${String(c.fy + 1).slice(2)}`,
      oldValue: before ? Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v === null ? null : Number(v)])) : null,
      newValue: data,
    });
    return actionDone(PATHS, "Previous employment details saved.");
  } catch (err) {
    return toErrorState(err);
  }
}

export async function switchRegimeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const viewer = await requireViewer();
    const target = String(formData.get("regime") ?? "");
    if (target !== "OLD" && target !== "NEW") return { ok: false, message: "Choose a regime." };
    const c = await context(viewer);
    const state = regimeSwitchState(c.emp.payGroup, c.emp.statutoryProfile?.regimeLockedAt ?? null, { isCurrentFy: true, now: new Date() });
    if (!state.allowed) return { ok: false, message: state.note };
    if (target === c.regime) return { ok: true, message: `You are already on the ${target === "NEW" ? "new" : "old"} regime.` };
    await prisma.$transaction([
      prisma.employeeStatutoryProfile.upsert({
        where: { employeeId: c.employeeId }, create: { employeeId: c.employeeId, taxRegime: target }, update: { taxRegime: target },
      }),
      prisma.investmentDeclaration.updateMany({ where: { employeeId: c.employeeId, fyStartYear: c.fy }, data: { regime: target } }),
    ]);
    const decl = c.declaration ?? (await ensureDeclaration(c.employeeId, c.fy, target));
    await writeAudit(viewer, {
      module: "PAYROLL", action: "UPDATE", entityType: "InvestmentDeclaration", entityId: decl.id,
      summary: `Switched tax regime from ${c.regime === "NEW" ? "new" : "old"} to ${target === "NEW" ? "new" : "old"} for FY ${c.fy}-${String(c.fy + 1).slice(2)}`,
      oldValue: { regime: c.regime }, newValue: { regime: target },
    });
    return actionDone([...PATHS, "/finances/pay"], `Your tax will now be computed under the ${target === "NEW" ? "new" : "old"} regime.`);
  } catch (err) {
    return toErrorState(err);
  }
}
