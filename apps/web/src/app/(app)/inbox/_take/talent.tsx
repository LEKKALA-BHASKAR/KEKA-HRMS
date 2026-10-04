import "server-only";
import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatINR } from "@keka/shared";
import { hireChain } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { IconBriefcase, IconDollarCircle } from "@/components/icons";
import { DecideRecommendation } from "../../performance/_parts/talent-forms";
import { DecideOfferStep } from "../../hiring/_parts/talent-forms";
import { DetailPane, Facts, Message, PersonStrip } from "../_ui/panes";
import { formatInstantDate } from "../_ui/format";
import { resolvePeople, who } from "../_ui/people";
import type { TakeSource } from "./types";

const P = PERMISSIONS;

/**
 * Inbox › Take Action for the talent areas: managers' salary-increment and
 * promotion recommendations from review-to-pay (for whoever revises salaries,
 * within their scope, never their own), and offer approvals waiting on the
 * viewer's level of a multi-level hiring chain.
 */
export async function talentSources(viewer: Viewer): Promise<TakeSource[]> {
  const tenantId = viewer.tenantId;
  const out: TakeSource[] = [];

  if (can(viewer, P.SALARY_REVISE)) {
    const me = viewer.employee?.id;
    const where = {
      tenantId, status: "PENDING",
      employee: { ...scopedEmployeeWhere(viewer, P.SALARY_REVISE), ...(me ? { NOT: { id: me } } : {}) },
    } as Prisma.SalaryRecommendationWhereInput;
    const include = { employee: { select: { id: true, displayName: true, firstName: true, lastName: true, photoUrl: true, employeeNumber: true, jobTitleName: true, department: { select: { name: true } } } }, cycle: { select: { id: true, name: true } } } as const;
    out.push({
      key: "salary-increments", label: "Salary increments", icon: <IconDollarCircle />, always: false,
      count: () => prisma.salaryRecommendation.count({ where }),
      list: async () => {
        const rows = await prisma.salaryRecommendation.findMany({ where, include, orderBy: { createdAt: "asc" }, take: 200 });
        return rows.map((r) => ({
          id: r.id, at: r.createdAt,
          person: { id: r.employee.id, name: r.employee.displayName ?? `${r.employee.firstName} ${r.employee.lastName}`, photoUrl: r.employee.photoUrl },
          title: `${Number(r.incrementPercent)}% increment${r.recommendPromotion ? " + promotion" : ""}`, heading: r.cycle.name,
        }));
      },
      detail: async (id) => {
        const r = await prisma.salaryRecommendation.findFirst({ where: { ...where, id }, include });
        if (!r) return null;
        const [people, review] = await Promise.all([
          resolvePeople(tenantId, [r.recommendedById]),
          prisma.employeeReview.findFirst({ where: { id: r.reviewId, cycle: { tenantId } }, select: { finalRating: true, rawRating: true } }),
        ]);
        const person = { id: r.employee.id, name: r.employee.displayName ?? `${r.employee.firstName} ${r.employee.lastName}`, photoUrl: r.employee.photoUrl };
        const by = who(people, r.recommendedById);
        const rating = review?.finalRating ?? review?.rawRating;
        return (
          <DetailPane title={`Salary increment · ${person.name}`} sub={`${r.cycle.name} · recommended ${formatInstantDate(r.createdAt)}`} status={{ label: "Pending", tone: "pending" }}
            actions={<><DecideRecommendation id={r.id} /><Link className="btn sm ghost" href={`/performance/cycles/${r.cycle.id}/pay`}>Open review-to-pay</Link></>}
            activity={[{ who: by, text: "Recommended this increment", at: r.createdAt, note: r.justification }]}>
            <PersonStrip person={person} meta={[r.employee.jobTitleName, r.employee.department?.name, r.employee.employeeNumber].filter(Boolean).join(" · ")} />
            <Facts items={[
              ["Recommended by", by.name],
              ["Increment", `${Number(r.incrementPercent)}%`],
              ["Promotion", r.recommendPromotion ? (r.proposedJobTitle ? `Yes — to ${r.proposedJobTitle}` : "Yes") : "No"],
              rating !== null && rating !== undefined ? ["Review rating", String(Number(rating))] : null,
            ]} />
            <Message label="Justification">{r.justification}</Message>
          </DetailPane>
        );
      },
    });
  }

  const offerWhere: Prisma.HireApprovalStepWhereInput = { tenantId, kind: "OFFER", status: "PENDING", approverUserId: viewer.user.id };
  const loadApps = (ids: string[]) => prisma.application.findMany({
    where: { id: { in: ids }, tenantId, offer: { status: "PENDING_APPROVAL" } },
    include: { offer: true, job: { select: { id: true, title: true, departmentId: true } }, candidate: { select: { id: true, firstName: true, lastName: true, currentTitle: true, currentEmployer: true } } },
  });
  out.push({
    key: "hire-approvals", label: "Offer approvals", icon: <IconBriefcase />, always: false,
    count: async () => {
      const steps = await prisma.hireApprovalStep.findMany({ where: offerWhere, select: { entityId: true } });
      return steps.length ? (await loadApps(steps.map((s) => s.entityId))).length : 0;
    },
    list: async () => {
      const steps = await prisma.hireApprovalStep.findMany({ where: offerWhere, orderBy: { createdAt: "asc" } });
      const apps = new Map((await loadApps(steps.map((s) => s.entityId))).map((a) => [a.id, a]));
      return steps.flatMap((s) => {
        const a = apps.get(s.entityId);
        if (!a?.offer) return [];
        return [{ id: a.id, at: s.createdAt, person: { id: a.candidate.id, name: `${a.candidate.firstName} ${a.candidate.lastName}`, photoUrl: null }, title: `${a.job.title} · ${formatINR(Number(a.offer.annualCtc))}`, heading: "Offer approval" }];
      });
    },
    detail: async (id) => {
      const step = await prisma.hireApprovalStep.findFirst({ where: { ...offerWhere, entityId: id } });
      if (!step) return null;
      const [a] = await loadApps([id]);
      if (!a?.offer) return null;
      const chain = await hireChain(tenantId, "OFFER", a.id);
      const dept = a.job.departmentId ? await prisma.department.findFirst({ where: { id: a.job.departmentId, tenantId }, select: { name: true } }) : null;
      const people = await resolvePeople(tenantId, chain.steps.map((s) => s.approverUserId));
      const name = `${a.candidate.firstName} ${a.candidate.lastName}`;
      return (
        <DetailPane title={`Offer · ${name}`} sub={`${a.job.title} · level ${chain.steps.findIndex((x) => x.id === step.id) + 1} of ${chain.steps.length}`} status={{ label: "Pending", tone: "pending" }}
          actions={<><DecideOfferStep applicationId={a.id} /><Link className="btn sm ghost" href={`/hiring/applications/${a.id}`}>Open candidate</Link></>}
          activity={chain.steps.filter((s) => s.status === "APPROVED" || s.status === "REJECTED").map((s) => ({ who: who(people, s.approverUserId), text: `${s.status === "APPROVED" ? "Approved" : "Rejected"} level ${chain.steps.indexOf(s) + 1}`, at: s.decidedAt ?? s.createdAt, note: s.comment ?? undefined }))}>
          <PersonStrip person={{ id: a.candidate.id, name, photoUrl: null }} meta={[a.candidate.currentTitle, a.candidate.currentEmployer].filter(Boolean).join(" · ")} />
          <Facts items={[
            ["Job", a.job.title],
            dept ? ["Department", dept.name] : null,
            ["Annual CTC", formatINR(Number(a.offer.annualCtc))],
            a.offer.proposedJoiningDate ? ["Joining", a.offer.proposedJoiningDate.toISOString().slice(0, 10)] : null,
            ["Chain", chain.steps.map((s, i) => `${i + 1}. ${who(people, s.approverUserId).name} (${s.status.toLowerCase()})`).join(" → ")],
          ]} />
        </DetailPane>
      );
    },
  });
  return out;
}
