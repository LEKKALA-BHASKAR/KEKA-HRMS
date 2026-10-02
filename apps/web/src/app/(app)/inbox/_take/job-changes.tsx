import "server-only";
import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { approvalsWaitingOn, jobChangeLabel } from "@keka/services";
import type { Viewer } from "@/lib/context";
import { IconUserPlus } from "@/components/icons";
import { ApprovalDecision } from "../../payroll/_forms/approvals";
import { DetailPane, Facts, PersonStrip } from "../_ui/panes";
import { formatInstantDate } from "../_ui/format";
import { resolvePeople, who } from "../_ui/people";
import type { TakeSource } from "./types";

/**
 * Promotions and transfers waiting on a role the viewer holds in the
 * job-change approval chain (Payroll settings > Approval workflow, "Promotions
 * and transfers"). The chain decides who sees an item, exactly as the payroll
 * approvals queue does, and never shows the viewer their own request.
 */
export async function jobChangeSources(viewer: Viewer): Promise<TakeSource[]> {
  const tenantId = viewer.tenantId;
  const mine = async () => (await approvalsWaitingOn(tenantId, viewer.user.id)).filter((r) => r.action === "JOB_CHANGE" && r.mine && r.payload.jobChangeId);
  const load = async (ids: string[]) => {
    const changes = await prisma.jobChange.findMany({ where: { id: { in: ids }, tenantId, status: "PENDING_APPROVAL" } });
    const emps = await prisma.employee.findMany({
      where: { id: { in: changes.map((c) => c.employeeId) }, tenantId },
      select: { id: true, displayName: true, firstName: true, lastName: true, photoUrl: true, employeeNumber: true, jobTitleName: true, department: { select: { name: true } }, location: { select: { name: true } }, reportingManager: { select: { displayName: true } } },
    });
    return { changes: new Map(changes.map((c) => [c.id, c])), emps: new Map(emps.map((e) => [e.id, e])) };
  };

  return [{
    key: "job-changes", label: "Job changes", icon: <IconUserPlus />, always: false,
    count: async () => (await mine()).length,
    list: async () => {
      const rows = await mine();
      const { changes, emps } = await load(rows.map((r) => r.payload.jobChangeId!));
      return rows.flatMap((r) => {
        const c = changes.get(r.payload.jobChangeId!);
        const e = c ? emps.get(c.employeeId) : undefined;
        if (!c || !e) return [];
        return [{ id: r.id, at: r.requestedAt, person: { id: e.id, name: e.displayName ?? `${e.firstName} ${e.lastName}`, photoUrl: e.photoUrl }, title: `${jobChangeLabel(c.reason)} from ${formatDate(c.effectiveFrom)}` }];
      });
    },
    detail: async (id) => {
      const r = (await mine()).find((x) => x.id === id);
      if (!r) return null;
      const { changes, emps } = await load([r.payload.jobChangeId!]);
      const c = changes.get(r.payload.jobChangeId!);
      const e = c ? emps.get(c.employeeId) : undefined;
      if (!c || !e) return null;
      // Names for every field the change sets, so the approver sees from → to.
      const [title, dept, loc, mgr, band, grade] = await Promise.all([
        c.jobTitleId ? prisma.jobTitle.findFirst({ where: { id: c.jobTitleId, tenantId }, select: { name: true } }) : null,
        c.departmentId ? prisma.department.findFirst({ where: { id: c.departmentId, tenantId }, select: { name: true } }) : null,
        c.locationId ? prisma.location.findFirst({ where: { id: c.locationId, tenantId }, select: { name: true } }) : null,
        c.reportingManagerId ? prisma.employee.findFirst({ where: { id: c.reportingManagerId, tenantId }, select: { displayName: true } }) : null,
        c.bandId ? prisma.band.findFirst({ where: { id: c.bandId, tenantId }, select: { name: true } }) : null,
        c.payGradeId ? prisma.payGrade.findFirst({ where: { id: c.payGradeId, tenantId }, select: { name: true } }) : null,
      ]);
      const people = await resolvePeople(tenantId, [r.requestedBy]);
      const requester = who(people, r.requestedBy);
      const person = { id: e.id, name: e.displayName ?? `${e.firstName} ${e.lastName}`, photoUrl: e.photoUrl };
      const arrow = (from: string | null | undefined, to: string | null | undefined) => <>{from ?? "—"} → <strong>{to}</strong></>;
      return (
        <DetailPane title={`${jobChangeLabel(c.reason)} · ${person.name}`} sub={`Initiated on ${formatInstantDate(r.requestedAt)}`} status={{ label: "Pending", tone: "pending" }}
          actions={<><ApprovalDecision requestId={r.id} /><Link className="btn sm ghost" href={`/employees/${e.id}?tab=job`}>Open profile</Link></>}
          activity={[{ who: requester, text: `Asked for approval: ${r.label}`, at: r.requestedAt }]}>
          <PersonStrip person={person} meta={[e.jobTitleName, e.department?.name, e.employeeNumber].filter(Boolean).join(" · ")} />
          <Facts items={[
            ["Effective from", formatDate(c.effectiveFrom)],
            ["Reason", jobChangeLabel(c.reason)],
            title ? ["Designation", arrow(e.jobTitleName, title.name)] : null,
            dept ? ["Department", arrow(e.department?.name, dept.name)] : null,
            loc ? ["Location", arrow(e.location?.name, loc.name)] : null,
            mgr ? ["Reporting manager", arrow(e.reportingManager?.displayName, mgr.displayName)] : null,
            band ? ["Band", band.name] : null,
            grade ? ["Grade", grade.name] : null,
            c.note ? ["Note", c.note] : null,
            ["Approval level", `${r.currentLevel + 1} of ${r.payload.chain.length}`],
          ]} />
        </DetailPane>
      );
    },
  }];
}
