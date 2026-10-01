import { prisma } from "@keka/db";

/**
 * How complete a person's profile is: the things an employee supplies about
 * themselves. Work details (department, manager, title) are HR's to set and
 * do not count. One definition, used by the Welcome page and stored on the
 * employee for reports.
 */
export interface ProfileFacts {
  photoUrl: string | null; aboutMe: string | null; mobile: string | null; personalEmail: string | null;
  dateOfBirth: Date | null; bloodGroup: string | null;
  addresses: number; bankAccounts: number; emergencyContacts: number; identityTypes: string[];
}

export function profileChecks(f: ProfileFacts): { checks: Array<{ label: string; done: boolean }>; percent: number; missing: string[] } {
  const checks = [
    { label: "photo", done: !!f.photoUrl },
    { label: "about", done: !!f.aboutMe?.trim() },
    { label: "mobile number", done: !!f.mobile },
    { label: "personal email", done: !!f.personalEmail },
    { label: "date of birth", done: !!f.dateOfBirth },
    { label: "blood group", done: !!f.bloodGroup },
    { label: "address", done: f.addresses > 0 },
    { label: "bank account", done: f.bankAccounts > 0 },
    { label: "PAN", done: f.identityTypes.includes("PAN") },
    { label: "Aadhaar", done: f.identityTypes.includes("AADHAAR") },
    { label: "emergency contact", done: f.emergencyContacts > 0 },
  ];
  const missing = checks.filter((c) => !c.done).map((c) => c.label);
  return { checks, missing, percent: Math.round(((checks.length - missing.length) / checks.length) * 100) };
}

export async function profileFacts(employeeId: string): Promise<ProfileFacts | null> {
  const e = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      photoUrl: true, aboutMe: true, mobile: true, personalEmail: true, dateOfBirth: true, bloodGroup: true,
      identityDocs: { select: { type: true } },
      _count: { select: { addresses: true, bankAccounts: true, emergencyContacts: true } },
    },
  });
  if (!e) return null;
  return { ...e, addresses: e._count.addresses, bankAccounts: e._count.bankAccounts, emergencyContacts: e._count.emergencyContacts, identityTypes: e.identityDocs.map((i) => i.type) };
}

/** Recompute and store the figure after anything that changes it. */
export async function recomputeProfileCompletion(employeeId: string): Promise<number | null> {
  const facts = await profileFacts(employeeId);
  if (!facts) return null;
  const { percent } = profileChecks(facts);
  await prisma.employee.update({ where: { id: employeeId }, data: { profileCompletion: percent } });
  return percent;
}
