import "server-only";
import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { CHANGE_TARGETS, diffChanges, fieldLabel } from "@keka/services";
import type { Viewer } from "@/lib/context";
import { decidableChangeRequests, displayChangeValue } from "@/lib/core-hr";
import { IconPencil } from "@/components/icons";
import { DecideForm } from "@/components/spec-form";
import { decideChangeRequestAction } from "@/app/actions/core-hr-depth";
import { DetailPane, Facts, PersonStrip } from "../_ui/panes";
import { resolvePeople, who } from "../_ui/people";
import type { TakeSource } from "./types";

/**
 * Change requests the viewer can decide: employees' profile changes (their
 * manager — reporting, dotted-line or acting — or HR), data corrections,
 * org changes and configuration changes waiting for a second administrator.
 * Same query as the Change requests queue, never the viewer's own.
 */
export async function changeRequestSources(viewer: Viewer): Promise<TakeSource[]> {
  const tenantId = viewer.tenantId;
  const mine = () => decidableChangeRequests(viewer, { take: 200 });
  const people = async (ids: string[]) => new Map((await prisma.employee.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, displayName: true, firstName: true, lastName: true, photoUrl: true, employeeNumber: true, jobTitleName: true, department: { select: { name: true } } },
  })).map((e) => [e.id, e]));
  return [{
    key: "change-requests", label: "Change requests", icon: <IconPencil />, always: false,
    count: async () => (await mine()).length,
    list: async () => {
      const rows = await mine();
      const emps = await people(rows.flatMap((r) => (r.employeeId ? [r.employeeId] : [])));
      return rows.map((r) => {
        const e = r.employeeId ? emps.get(r.employeeId) : undefined;
        return { id: r.id, at: r.createdAt, person: e ? { id: e.id, name: e.displayName ?? `${e.firstName} ${e.lastName}`, photoUrl: e.photoUrl } : null, heading: e ? undefined : CHANGE_TARGETS[r.targetType as keyof typeof CHANGE_TARGETS]?.label ?? r.targetType, title: r.title };
      });
    },
    detail: async (id) => {
      const [r] = await decidableChangeRequests(viewer, { id });
      if (!r) return null;
      const e = r.employeeId ? (await people([r.employeeId])).get(r.employeeId) : undefined;
      const requester = who(await resolvePeople(tenantId, [r.requestedBy]), r.requestedBy);
      const diff = r.operation === "DELETE" ? [] : diffChanges(r.previous as Record<string, unknown> | null, r.changes as Record<string, unknown>);
      return (
        <DetailPane title={r.title} sub={`Raised on ${formatDate(r.createdAt)}`} status={{ label: "Pending", tone: "pending" }}
          actions={<Link className="btn sm ghost" href="/admin/change-requests">Open queue</Link>}
          footer={<DecideForm action={decideChangeRequestAction} hidden={{ id: r.id }} />}
          activity={[{ who: requester, text: `Asked for approval: ${r.title}`, at: r.createdAt, note: r.reason }]}>
          {e ? <PersonStrip person={{ id: e.id, name: e.displayName ?? `${e.firstName} ${e.lastName}`, photoUrl: e.photoUrl }} meta={[e.jobTitleName, e.department?.name, e.employeeNumber].filter(Boolean).join(" · ")} /> : null}
          <Facts items={[
            ["Kind", CHANGE_TARGETS[r.targetType as keyof typeof CHANGE_TARGETS]?.label ?? r.targetType],
            ["Decided by", r.approverType === "MANAGER" ? "Manager (or HR)" : "HR"],
            ["Takes effect", r.effectiveDate ? formatDate(r.effectiveDate) : "On approval"],
            r.operation === "DELETE" ? ["Change", "Remove this record"] : null,
            ...diff.map((d) => [fieldLabel(d.field), <>{displayChangeValue(d.field, d.from)} → <strong>{displayChangeValue(d.field, d.to)}</strong></>] as [string, ReactNode]),
            r.reason ? ["Reason", r.reason] : null,
          ]} />
        </DetailPane>
      );
    },
  }];
}
