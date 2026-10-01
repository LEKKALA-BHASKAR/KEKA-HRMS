import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, MONTH_SHORT } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { Panel, Field, Chip, EmptyState, Notice } from "@/components/keka";
import { Masked } from "@/components/masked";
import { IconWallet } from "@/components/icons";
import { FlagIN, IconClip } from "./_components/icons";
import s from "./finances.module.css";

export const metadata = { title: "My Finances" };

const n = (v: unknown) => Number(v ?? 0);
const days = (v: unknown) => { const x = n(v); return Number.isInteger(x) ? String(x) : x.toFixed(1); };
const dm = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_SHORT[d.getUTCMonth()]}`;
const NA = <span className={s.muted}>Not Available</span>;

type IdType = "PAN" | "AADHAAR" | "PASSPORT" | "VOTER_ID" | "DRIVING_LICENCE";
const ID_LABEL: Record<IdType, string> = {
  PAN: "PAN Card", AADHAAR: "Aadhaar Card", PASSPORT: "Passport", VOTER_ID: "Voter ID", DRIVING_LICENCE: "Driving Licence",
};
/** How each identity type shows up among uploaded documents, for the file count. */
const ID_DOC_MATCH: Record<IdType, RegExp> = {
  PAN: /\bpan\b/i, AADHAAR: /aadha?ar/i, PASSPORT: /passport/i, VOTER_ID: /voter/i, DRIVING_LICENCE: /driving/i,
};
/** Accepted as photo ID and as proof of address, in order of preference. */
const PROOF_ORDER: IdType[] = ["AADHAAR", "PASSPORT", "VOTER_ID", "DRIVING_LICENCE"];

export default async function FinancesSummaryPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconWallet />} title="No employee record">This login is not linked to an employee record, so there are no finances to show.</EmptyState>;
  }
  const employeeId = viewer.employee.id;

  const [emp, slip, docs] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: employeeId, tenantId: viewer.tenantId },
      select: {
        firstName: true, middleName: true, lastName: true, displayName: true, dateOfBirth: true, gender: true, dateOfJoining: true,
        location: { select: { id: true, name: true, state: true } },
        payGroup: {
          select: {
            pfEnabled: true, esiEnabled: true, ptEnabled: true,
            ptRegistrations: { where: { isActive: true }, select: { stateName: true, locationName: true, establishmentId: true, linkedLocations: { select: { locationId: true } } } },
          },
        },
        bankAccounts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }], take: 1 },
        identityDocs: true,
        statutoryProfile: true,
        addresses: true,
        dependents: { select: { name: true, relationship: true } },
        emergencyContacts: { select: { name: true, relationship: true } },
      },
    }),
    prisma.payslip.findFirst({
      where: { employeeId, status: "RELEASED", isSegregated: false, run: { tenantId: viewer.tenantId } },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      include: { run: { select: { id: true, periodStart: true, periodEnd: true } } },
    }),
    prisma.employeeDocument.findMany({
      where: { tenantId: viewer.tenantId, employeeId, fileUrl: { not: null }, status: { notIn: ["REJECTED", "NOT_APPLICABLE"] } },
      select: { name: true, documentType: { select: { name: true } } },
    }),
  ]);
  if (!emp) return <EmptyState icon={<IconWallet />} title="No employee record">Your employee record could not be found.</EmptyState>;

  const line = slip
    ? await prisma.payrollRunEmployee.findUnique({
        where: { runId_employeeId: { runId: slip.runId, employeeId } },
        select: { totalDays: true, payableDays: true, lopDays: true, esiEmployee: true },
      })
    : null;

  const fullName = [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ");
  const bank = emp.bankAccounts[0] ?? null;
  const profile = emp.statutoryProfile;
  const pg = emp.payGroup;

  // --- Statutory ---
  const pfOn = !!pg?.pfEnabled && (profile?.pfEnabled ?? true);
  const esiStatus = profile?.esicNumber || n(line?.esiEmployee) > 0 ? "Enabled"
    : !pg?.esiEnabled || profile?.esiEnabled === false ? "Not Applicable" : "Not Eligible";
  const ptReg = pg?.ptRegistrations.find((r) => emp.location && r.linkedLocations.some((l) => l.locationId === emp.location!.id)) ?? null;
  const ptOn = !!pg?.ptEnabled && (profile?.ptEnabled ?? true) && !!ptReg;

  // --- Identity ---
  const ids = new Map(emp.identityDocs.map((d) => [d.type as string, d]));
  const fileCount = (t: IdType) =>
    (ids.get(t)?.fileUrl ? 1 : 0) + docs.filter((d) => ID_DOC_MATCH[t].test(`${d.name} ${d.documentType?.name ?? ""}`)).length;
  const parent = [...emp.dependents, ...emp.emergencyContacts].find((p) => /father|mother|parent/i.test(p.relationship))?.name ?? null;
  const addr = emp.addresses.find((a) => a.type === "PERMANENT") ?? emp.addresses.find((a) => a.type === "CURRENT") ?? null;
  const address = addr ? [addr.line1, addr.line2, addr.city, addr.state, addr.postalCode].filter(Boolean).join(", ") : null;
  const gender = emp.gender ? emp.gender.charAt(0) + emp.gender.slice(1).toLowerCase().replace(/_/g, " ") : null;
  const proof = PROOF_ORDER.find((t) => ids.has(t)) ?? null;
  const canSeeDocs = can(viewer, PERMISSIONS.DOCUMENT_VIEW);

  const idHeader = (t: IdType) => {
    const doc = ids.get(t)!;
    const count = fileCount(t);
    const files = <><IconClip width={17} height={17} />{count} file(s)</>;
    return (
      <div className={s.idHead}>
        <FlagIN />
        <span className={s.idTitle}>{ID_LABEL[t]}</span>
        {doc.isVerified ? <Chip kind="verified">Verified</Chip> : <Chip kind="on-duty">Pending verification</Chip>}
        {canSeeDocs && count > 0
          ? <Link className={s.files} href="/documents?tab=mine" aria-label={`${count} file(s) for ${ID_LABEL[t]}`}>{files}</Link>
          : <span className={s.files} style={{ color: "var(--text-muted)" }}>{files}</span>}
      </div>
    );
  };
  const clip = (v: string | null) => (v ? <span className={s.ellipsis} title={v}>{v}</span> : NA);

  const proofFields = (t: IdType): ReactNode => {
    const doc = ids.get(t)!;
    const number = t === "AADHAAR"
      ? <Masked value={doc.number.replace(/\D/g, "")} keep={4} group={4} />
      : <Masked value={doc.number} keep={t === "PASSPORT" ? 3 : 4} />;
    return (
      <div className={s.fields}>
        <Field label={t === "AADHAAR" ? "Aadhaar Number" : `${ID_LABEL[t]} Number`}>{number}</Field>
        {t === "AADHAAR" ? <Field label="Enrollment Number">{NA}</Field>
          : <Field label="Expiry Date">{doc.expiryDate ? formatDate(doc.expiryDate) : NA}</Field>}
        <Field label="Date of Birth">{emp.dateOfBirth ? formatDate(emp.dateOfBirth) : NA}</Field>
        <Field label="Name">{clip((doc.nameOnDoc ?? fullName).toUpperCase())}</Field>
        <Field label="Address">{clip(address)}</Field>
        <Field label="Gender">{gender ?? NA}</Field>
      </div>
    );
  };

  return (
    <>
      <section className={`${s.boxed} ${s.strip}`} aria-label="Payroll summary">
        <h2 className={s.stripTitle}>Payroll summary</h2>
        {slip && line ? (
          <>
            <Field label="Last Processed Cycle">
              {MONTH_SHORT[slip.month - 1]} {slip.year} ({dm(slip.run.periodStart)} - {dm(slip.run.periodEnd)})
            </Field>
            <Field label="Working Days">{line.totalDays}</Field>
            <Field label="Loss of Pay">{days(line.lopDays)}</Field>
            <Field label="Payslip">
              <Link className={s.link} href={`/finances/pay/payslips?month=${slip.year}-${String(slip.month).padStart(2, "0")}`}>View payslip</Link>
            </Field>
          </>
        ) : (
          <span className={s.muted}>No payroll has been processed for you yet. Your first payslip will show here once it is released.</span>
        )}
      </section>

      <div className={s.cols}>
        <div className={s.stack}>
          <Panel title="Payment Information" className={s.ruled}>
            {bank ? (
              <div className={s.fields}>
                <div className={s.span2}><Field label="Payment Mode">Bank Transfer</Field></div>
                <Field label="Bank Name">{bank.bankName}</Field>
                <Field label="Account Number"><Masked value={bank.accountNumber} keep={4} /></Field>
                <Field label="IFSC Code"><span className="mono">{bank.ifsc}</span></Field>
                <Field label="Name on the Account">{(bank.accountHolder ?? fullName).toUpperCase()}</Field>
                <Field label="Branch">{bank.branch ?? "N/A"}</Field>
                <Field label="Verification">{bank.isVerified ? <Chip kind="verified">Verified</Chip> : <Chip kind="on-duty">Not verified</Chip>}</Field>
              </div>
            ) : (
              <>
                <div className={s.fields}><Field label="Payment Mode">{NA}</Field></div>
                <div style={{ marginTop: 18 }}><Notice>No bank account is on record. Ask your HR team to add one so your salary can be paid by bank transfer.</Notice></div>
              </>
            )}
          </Panel>

          <Panel title="Statutory Information" className={s.ruled}>
            <div className={s.group}>
              <h3 className={s.subhead}>PF Account Information</h3>
              <div className={s.fields}>
                <div className={s.span2}><Field label="PF Status">{pfOn ? "Enabled" : "Not Enabled"}</Field></div>
                {pfOn ? (
                  <>
                    <Field label="PF Number">{profile?.pfAccountNumber ? <span className={s.ellipsis} title={profile.pfAccountNumber}>{profile.pfAccountNumber}</span> : NA}</Field>
                    <Field label="Universal Account Number">{profile?.uan ?? NA}</Field>
                    <Field label="PF Join Date">{profile?.pfJoinDate ? formatDate(profile.pfJoinDate) : formatDate(emp.dateOfJoining)}</Field>
                    <Field label="Name">{fullName.toUpperCase()}</Field>
                  </>
                ) : null}
              </div>
            </div>
            <div className={s.group}>
              <h3 className={s.subhead}>ESI Account Information</h3>
              <div className={s.fields}>
                <Field label="ESI Status">{esiStatus}</Field>
                {profile?.esicNumber ? <Field label="ESI Number">{profile.esicNumber}</Field> : null}
              </div>
            </div>
            <div className={s.group}>
              <h3 className={s.subhead}>PT Details</h3>
              {ptOn && ptReg ? (
                <div className={s.fields}>
                  <Field label="State">{ptReg.stateName}</Field>
                  <Field label="Registered Location">{ptReg.locationName ?? (emp.location ? `PT ${emp.location.name}` : `PT ${ptReg.stateName}`)}</Field>
                </div>
              ) : (
                <div className={s.fields}>
                  <Field label="State">{emp.location?.state ?? NA}</Field>
                  <Field label="Status">Not Applicable</Field>
                </div>
              )}
            </div>
          </Panel>
        </div>

        <Panel title="Identity Information" className={s.ruled}>
          {!ids.has("PAN") && !proof ? (
            <EmptyState title="No identity documents">Your PAN and Aadhaar have not been added yet. Ask your HR team to record them — your PAN is needed for income tax and to protect your payslips.</EmptyState>
          ) : null}
          {ids.has("PAN") ? (
            <div>
              {idHeader("PAN")}
              <div className={s.fields}>
                <Field label="Permanent Account Number (PAN)"><Masked value={ids.get("PAN")!.number.toUpperCase()} keep={4} /></Field>
                <Field label="Name">{clip((ids.get("PAN")!.nameOnDoc ?? fullName).toUpperCase())}</Field>
                <Field label="Date of Birth">{emp.dateOfBirth ? formatDate(emp.dateOfBirth) : NA}</Field>
                <Field label="Parent's Name">{parent ? clip(parent.toUpperCase()) : NA}</Field>
              </div>
            </div>
          ) : (
            <Notice>No PAN is on record. Without one, tax is deducted at a higher rate and your payslips cannot be password protected.</Notice>
          )}
          {proof ? (
            <>
              <h3 className={s.idSection}>Photo ID</h3>
              {idHeader(proof)}
              {proofFields(proof)}
              <h3 className={s.idSection}>Address Proof</h3>
              {idHeader(proof)}
              {proofFields(proof)}
            </>
          ) : null}
        </Panel>
      </div>
    </>
  );
}
