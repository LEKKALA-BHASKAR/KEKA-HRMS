import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, KeyValue, Callout, Empty } from "@/components/ui";
import { Disclosure } from "@/app/(app)/org/forms";
import {
  PayGroupForm, DeletePayGroupButton, FilingForm, PtRegistrationForm, LwfRegistrationForm,
  DeleteRegistrationButton, ApprovalRuleForm, DeleteRuleButton, PayslipSettingsForm,
} from "../_forms/config";

const P = PERMISSIONS;
const pc = (v: unknown) => `${Number(v ?? 0)}%`;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const IN_STATES: Array<[string, string]> = [
  ["AP", "Andhra Pradesh"], ["AS", "Assam"], ["BR", "Bihar"], ["CH", "Chandigarh"],
  ["CG", "Chhattisgarh"], ["DL", "Delhi"], ["GA", "Goa"], ["GJ", "Gujarat"], ["HR", "Haryana"],
  ["JH", "Jharkhand"], ["KA", "Karnataka"], ["KL", "Kerala"], ["MP", "Madhya Pradesh"],
  ["MH", "Maharashtra"], ["ML", "Meghalaya"], ["OR", "Odisha"], ["PY", "Puducherry"],
  ["PB", "Punjab"], ["RJ", "Rajasthan"], ["SK", "Sikkim"], ["TN", "Tamil Nadu"],
  ["TS", "Telangana"], ["UP", "Uttar Pradesh"], ["UK", "Uttarakhand"], ["WB", "West Bengal"],
];

export default async function PayGroupsPage({
  searchParams,
}: { searchParams: Promise<{ edit?: string; section?: string }> }) {
  const viewer = await requireAuth(P.PAYGROUP_MANAGE);
  const sp = await searchParams;
  const canStatutory = can(viewer, P.STATUTORY_MANAGE);
  const canSettings = can(viewer, P.PAYROLL_SETTINGS);

  const [payGroups, entities, locations, roles] = await Promise.all([
    prisma.payGroup.findMany({
      where: { tenantId: viewer.tenantId },
      include: {
        legalEntity: { select: { legalName: true } },
        filingDetail: true,
        payslipSetting: true,
        approvalRules: true,
        ptRegistrations: { include: { linkedLocations: { include: { location: { select: { name: true } } } } } },
        lwfRegistrations: { include: { linkedLocations: { include: { location: { select: { name: true } } } } } },
        _count: { select: { employees: true, salaryStructures: true, componentLinks: true, payrollRuns: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.legalEntity.findMany({
      where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" },
    }),
    prisma.location.findMany({
      where: { tenantId: viewer.tenantId }, select: { id: true, name: true, stateCode: true }, orderBy: { name: "asc" },
    }),
    prisma.role.findMany({
      where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" },
    }),
  ]);

  const entityOpts = entities.map((e) => ({ value: e.id, label: e.name }));
  const locationOpts = locations.map((l) => ({ value: l.id, label: `${l.name} (${l.stateCode ?? "no state"})`, stateCode: l.stateCode }));
  const stateOpts = IN_STATES.map(([code, name]) => ({ value: code, label: `${name} (${code})` }));
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const editing = sp.edit ? payGroups.find((g) => g.id === sp.edit) : undefined;

  // Locations not covered by any PT registration on any pay group.
  const mappedPt = new Set(payGroups.flatMap((g) => g.ptRegistrations.flatMap((r) => r.linkedLocations.map((l) => l.locationId))));
  const unmapped = locations.filter((l) => !mappedPt.has(l.id));

  return (
    <>
      <PageHead
        title="Pay groups"
        subtitle="The pay group is the real segmentation unit — it carries the pay schedule, every statutory registration, and the salary structures"
      />

      <Callout tone="info" title="Why the pay group matters more than the legal entity">
        Statutory registrations (PF, ESI, state-wise PT and LWF) and income-tax filing
        details all attach here. Moving an employee to a pay group on another entity
        synchronises their legal entity automatically.
      </Callout>

      {unmapped.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <Callout tone="warning" title={`${unmapped.length} location(s) have no PT registration`}>
            {unmapped.map((l) => `${l.name} (${l.stateCode ?? "no state"})`).join(", ")} — employees
            based there will have no Professional Tax deducted.
          </Callout>
        </div>
      ) : null}

      <div style={{ height: 16 }} />

      <Card title={editing ? `Edit ${editing.name}` : "Create a pay group"}>
        {editing ? (
          <>
            <PayGroupForm entities={entityOpts} group={{
              id: editing.id, legalEntityId: editing.legalEntityId, name: editing.name,
              description: editing.description, frequency: editing.frequency,
              payPeriodStartDay: editing.payPeriodStartDay, payPeriodEndDay: editing.payPeriodEndDay,
              attendanceCutoffDay: editing.attendanceCutoffDay, payDay: editing.payDay,
              pfEnabled: editing.pfEnabled, esiEnabled: editing.esiEnabled, ptEnabled: editing.ptEnabled,
              lwfEnabled: editing.lwfEnabled, tdsEnabled: editing.tdsEnabled,
              declarationOpenDay: editing.declarationOpenDay, declarationCloseDay: editing.declarationCloseDay,
              declarationFyCutoff: iso(editing.declarationFyCutoff),
              newJoinerWindowDays: editing.newJoinerWindowDays,
              proofSubmissionDue: iso(editing.proofSubmissionDue), proofMandatory: editing.proofMandatory,
              allowLateDeclaration: editing.allowLateDeclaration, allowRegimeChoice: editing.allowRegimeChoice,
              regimeChangeCutoff: iso(editing.regimeChangeCutoff),
              approvalWorkflowEnabled: editing.approvalWorkflowEnabled,
            }} />
            <div style={{ marginTop: 10 }}>
              <Link className="btn ghost sm" href="/payroll/pay-groups">Done editing</Link>
            </div>
          </>
        ) : (
          <Disclosure label="+ New pay group">
            <PayGroupForm entities={entityOpts} />
          </Disclosure>
        )}
      </Card>

      <div style={{ height: 16 }} />

      <div className="stack gap-4">
        {payGroups.length === 0 ? <Card><Empty title="No pay groups yet" /></Card> : null}
        {payGroups.map((g) => (
          <Card
            key={g.id}
            title={g.name}
            description={`${g.legalEntity.legalName} · ${g._count.employees} employees · ${g._count.salaryStructures} structures · ${g._count.payrollRuns} runs`}
            action={
              <div className="row gap-2 wrap">
                {(["pf", "esi", "pt", "lwf", "tds"] as const).map((h) => {
                  const on = g[`${h}Enabled` as "pfEnabled"];
                  return <Badge key={h} tone={on ? "success" : "neutral"}>{h.toUpperCase()}{on ? "" : " off"}</Badge>;
                })}
                <Link className="btn sm" href={`/payroll/pay-groups?edit=${g.id}`}>Edit</Link>
                <DeletePayGroupButton id={g.id} name={g.name} />
              </div>
            }
          >
            <div className="grid grid-2" style={{ alignItems: "start" }}>
              <div>
                <div className="stat-label" style={{ marginBottom: 8 }}>Pay schedule</div>
                <KeyValue items={[
                  ["Frequency", g.frequency.toLowerCase().replace("_", "-")],
                  ["Period", `day ${g.payPeriodStartDay} to ${g.payPeriodEndDay === 0 ? "month end" : `day ${g.payPeriodEndDay}`}`],
                  ["Attendance cut-off", g.attendanceCutoffDay ? `day ${g.attendanceCutoffDay}` : "period end"],
                  ["Maker-checker", g.approvalWorkflowEnabled ? `on · ${g.approvalRules.length} rule(s)` : "off"],
                  ["Declarations", `day ${g.declarationOpenDay}–${g.declarationCloseDay}, FY cut-off ${formatDate(g.declarationFyCutoff)}`],
                  ["Regime choice", g.allowRegimeChoice ? `until ${formatDate(g.regimeChangeCutoff)}` : "locked"],
                ]} />
              </div>
              <div>
                <div className="stat-label" style={{ marginBottom: 8 }}>Statutory identity</div>
                <KeyValue items={[
                  ["PAN / TAN", <span className="mono text-sm" key="t">{g.filingDetail?.pan ?? "—"} / {g.filingDetail?.tan ?? "—"}</span>],
                  ["PF registration", <span className="mono text-sm" key="p">{g.filingDetail?.pfRegistrationNumber ?? "—"}</span>],
                  ["PF", g.filingDetail ? `${pc(g.filingDetail.pfEmployeeRate)} on ₹${Number(g.filingDetail.pfWageCeiling).toLocaleString("en-IN")} ceiling${g.filingDetail.pfCapAtCeiling ? "" : " (uncapped)"}` : "—"],
                  ["ESI registration", <span className="mono text-sm" key="e">{g.filingDetail?.esiRegistrationNumber ?? "—"}</span>],
                  ["ESI", g.filingDetail ? `${pc(g.filingDetail.esiEmployeeRate)} / ${pc(g.filingDetail.esiEmployerRate)} below ₹${Number(g.filingDetail.esiWageLimit).toLocaleString("en-IN")}` : "—"],
                ]} />
              </div>
            </div>

            <div className="divider" />

            <div className="grid grid-2" style={{ alignItems: "start" }}>
              <div>
                <div className="stat-label" style={{ marginBottom: 8 }}>Professional Tax ({g.ptRegistrations.length})</div>
                {g.ptRegistrations.length === 0 ? <p className="text-sm subtle">None registered.</p> : (
                  <div className="stack gap-2">
                    {g.ptRegistrations.map((r) => (
                      <div key={r.id} className="row gap-2" style={{ justifyContent: "space-between" }}>
                        <span className="text-sm">
                          <strong>{r.stateName}</strong>{r.localBodyType ? ` · ${r.localBodyType.toLowerCase()}` : ""}
                          {" · "}{r.frequency.toLowerCase().replace("_", "-")}
                          <div className="text-xs subtle">{r.linkedLocations.map((l) => l.location.name).join(", ") || "no linked locations"}</div>
                        </span>
                        {canStatutory ? <DeleteRegistrationButton kind="pt" id={r.id} label={`${r.stateCode} PT`} /> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="stat-label" style={{ marginBottom: 8 }}>Labour Welfare Fund ({g.lwfRegistrations.length})</div>
                {g.lwfRegistrations.length === 0 ? <p className="text-sm subtle">None registered.</p> : (
                  <div className="stack gap-2">
                    {g.lwfRegistrations.map((r) => (
                      <div key={r.id} className="row gap-2" style={{ justifyContent: "space-between" }}>
                        <span className="text-sm">
                          <strong>{r.stateName}</strong> · employer {r.employerInsideCtc ? "inside" : "above"} CTC
                          <div className="text-xs subtle">{r.linkedLocations.map((l) => l.location.name).join(", ") || "no linked locations"}</div>
                        </span>
                        {canStatutory ? <DeleteRegistrationButton kind="lwf" id={r.id} label={`${r.stateCode} LWF`} /> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {g.approvalRules.length > 0 ? (
              <>
                <div className="divider" />
                <div className="stat-label" style={{ marginBottom: 8 }}>Approval rules</div>
                <div className="stack gap-2">
                  {g.approvalRules.map((r) => (
                    <div key={r.id} className="row gap-2" style={{ justifyContent: "space-between" }}>
                      <span className="text-sm">
                        <Badge tone="brand">{r.action.replace(/_/g, " ").toLowerCase()}</Badge> {r.name}
                        <span className="text-xs subtle"> — {(r.approverRoleIds as string[]).map((id) => roleName.get(id) ?? "removed role").join(" → ")}</span>
                      </span>
                      {canSettings ? <DeleteRuleButton id={r.id} /> : null}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            <div className="divider" />
            <div className="row gap-2 wrap" style={{ alignItems: "flex-start" }}>
              {canStatutory ? (
                <div style={{ flex: "1 1 100%" }}>
                  <Disclosure label="Filing details" variant="default">
                    <FilingForm payGroupId={g.id} filing={g.filingDetail ? {
                      pan: g.filingDetail.pan, tan: g.filingDetail.tan, tanCircle: g.filingDetail.tanCircle,
                      citTds: g.filingDetail.citTds,
                      form16SignatoryName: g.filingDetail.form16SignatoryName,
                      form16SignatoryDesignation: g.filingDetail.form16SignatoryDesignation,
                      form16SignatoryPan: g.filingDetail.form16SignatoryPan,
                      responsiblePersonName: g.filingDetail.responsiblePersonName,
                      responsiblePersonDesignation: g.filingDetail.responsiblePersonDesignation,
                      responsiblePersonPan: g.filingDetail.responsiblePersonPan,
                      pfRegistrationNumber: g.filingDetail.pfRegistrationNumber,
                      pfRegistrationDate: iso(g.filingDetail.pfRegistrationDate),
                      pfSignatoryName: g.filingDetail.pfSignatoryName,
                      pfWageCeiling: Number(g.filingDetail.pfWageCeiling), pfCapAtCeiling: g.filingDetail.pfCapAtCeiling,
                      pfEmployeeRate: Number(g.filingDetail.pfEmployeeRate), pfEmployerRate: Number(g.filingDetail.pfEmployerRate),
                      epsRate: Number(g.filingDetail.epsRate), epsWageCeiling: Number(g.filingDetail.epsWageCeiling),
                      edliRate: Number(g.filingDetail.edliRate), pfAdminRate: Number(g.filingDetail.pfAdminRate),
                      esiRegistrationNumber: g.filingDetail.esiRegistrationNumber,
                      esiRegistrationDate: iso(g.filingDetail.esiRegistrationDate),
                      esiSignatoryName: g.filingDetail.esiSignatoryName,
                      esiWageLimit: Number(g.filingDetail.esiWageLimit),
                      esiEmployeeRate: Number(g.filingDetail.esiEmployeeRate), esiEmployerRate: Number(g.filingDetail.esiEmployerRate),
                      esiEmployerInsideCtc: g.filingDetail.esiEmployerInsideCtc,
                      esiHideEmployerOnPayslip: g.filingDetail.esiHideEmployerOnPayslip,
                      esiIncludeArrears: g.filingDetail.esiIncludeArrears,
                    } : null} />
                  </Disclosure>
                </div>
              ) : null}
              {canStatutory ? (
                <div style={{ flex: "1 1 100%" }}>
                  <Disclosure label="+ PT registration" variant="default">
                    <PtRegistrationForm payGroupId={g.id} locations={locationOpts} states={stateOpts} />
                  </Disclosure>
                </div>
              ) : null}
              {canStatutory ? (
                <div style={{ flex: "1 1 100%" }}>
                  <Disclosure label="+ LWF registration" variant="default">
                    <LwfRegistrationForm payGroupId={g.id} locations={locationOpts} states={stateOpts} />
                  </Disclosure>
                </div>
              ) : null}
              {canSettings ? (
                <div style={{ flex: "1 1 100%" }}>
                  <Disclosure label="+ Approval rule" variant="default">
                    <ApprovalRuleForm payGroupId={g.id} roles={roles.map((r) => ({ value: r.id, label: r.name }))} />
                  </Disclosure>
                </div>
              ) : null}
              {canSettings ? (
                <div style={{ flex: "1 1 100%" }}>
                  <Disclosure label="Payslip settings" variant="default">
                    <PayslipSettingsForm payGroupId={g.id}
                      s={g.payslipSetting as unknown as Record<string, boolean | string> | null} />
                  </Disclosure>
                </div>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
