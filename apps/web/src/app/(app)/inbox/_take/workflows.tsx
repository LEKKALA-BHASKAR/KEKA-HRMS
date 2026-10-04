import "server-only";
import Link from "next/link";
import { prisma } from "@keka/db";
import { WORKFLOW_ENTITY_TYPES, GENERIC_REQUEST_CATEGORIES } from "@keka/services";
import type { Viewer } from "@/lib/context";
import { IconRepeat, IconCheck } from "@/components/icons";
import { ActButton } from "@/components/gov-forms";
import { decideWorkflowTaskAction, completeWorkTaskAction } from "@/app/actions/workflows";
import { DetailPane, Facts, PersonStrip } from "../_ui/panes";
import { formatInstantDate } from "../_ui/format";
import { resolvePeople, who } from "../_ui/people";
import type { TakeSource } from "./types";

const typeLabel = (t: string) => WORKFLOW_ENTITY_TYPES[t as keyof typeof WORKFLOW_ENTITY_TYPES] ?? t;

/**
 * Workflow-engine approvals assigned to the viewer (general requests, access
 * requests, role/policy changes, webhook endpoints, automation rules,
 * retention purges, compliance sign-offs, policy and consent publication),
 * and the tasks automation rules have given them.
 */
export async function workflowSources(viewer: Viewer): Promise<TakeSource[]> {
  const tenantId = viewer.tenantId, me = viewer.user.id;
  const pending = { tenantId, approverUserId: me, status: "PENDING", request: { status: "PENDING" } };
  const openTasks = { tenantId, assigneeUserId: me, status: "OPEN" };

  return [{
    key: "workflows", label: "Approvals", icon: <IconRepeat />, always: false,
    count: () => prisma.workflowTask.count({ where: pending }),
    list: async () => {
      const tasks = await prisma.workflowTask.findMany({ where: pending, include: { request: { select: { title: true, entityType: true, requesterUserId: true, createdAt: true } } }, orderBy: { createdAt: "desc" } });
      const people = await resolvePeople(tenantId, tasks.map((x) => x.request.requesterUserId));
      return tasks.map((x) => ({ id: x.id, at: x.createdAt, person: who(people, x.request.requesterUserId), title: x.request.title, tag: typeLabel(x.request.entityType), tagTone: x.dueAt && x.dueAt < new Date() ? "danger" as const : undefined }));
    },
    detail: async (id) => {
      const x = await prisma.workflowTask.findFirst({ where: { ...pending, id }, include: { request: { include: { events: { orderBy: { createdAt: "asc" } }, definition: { select: { name: true, version: true } } } } } });
      if (!x) return null;
      const r = x.request;
      const people = await resolvePeople(tenantId, [r.requesterUserId, x.delegatedFromUserId, ...r.events.map((e) => e.actorUserId)]);
      const requester = who(people, r.requesterUserId);
      return (
        <DetailPane title={r.title} sub={`${typeLabel(r.entityType)} · submitted ${formatInstantDate(r.createdAt)}`} status={{ label: "Pending", tone: "pending" }} avatar={requester}
          actions={<Link className="btn sm ghost" href={`/me/requests/${r.id}`}>Full history</Link>}
          footer={<div className="row gap-2 wrap">
            <ActButton action={decideWorkflowTaskAction} hidden={{ taskId: x.id, decision: "approve" }} label="Approve" variant="primary" input={{ name: "comment", placeholder: "Comment (optional)" }} />
            <ActButton action={decideWorkflowTaskAction} hidden={{ taskId: x.id, decision: "reject" }} label="Reject" variant="danger" input={{ name: "comment", placeholder: "Reason", required: true }} />
          </div>}
          activity={r.events.map((e) => ({ who: e.actorUserId ? who(people, e.actorUserId) : null, text: e.kind.replace(/_/g, " ").toLowerCase(), at: e.createdAt, note: e.note }))}>
          <PersonStrip person={requester} meta="Requested by" />
          <Facts items={[
            ["Step", `${x.stepOrder + 1}. ${x.stepName}${x.mode === "ALL" ? " (everyone must approve)" : ""}`],
            r.category ? ["Category", GENERIC_REQUEST_CATEGORIES[r.category as keyof typeof GENERIC_REQUEST_CATEGORIES] ?? r.category] : null,
            r.amount !== null ? ["Amount", Number(r.amount).toLocaleString("en-IN")] : null,
            r.details ? ["Details", r.details] : null,
            x.delegatedFromUserId ? ["On behalf of", who(people, x.delegatedFromUserId).name] : null,
            x.dueAt ? ["Due", formatInstantDate(x.dueAt)] : null,
            ["Route", r.definition ? `${r.definition.name} v${r.definition.version}` : "Built-in"],
          ]} />
        </DetailPane>
      );
    },
  }, {
    key: "work-tasks", label: "Tasks", icon: <IconCheck />, always: false,
    count: () => prisma.workTask.count({ where: openTasks }),
    list: async () => {
      const tasks = await prisma.workTask.findMany({ where: openTasks, orderBy: [{ dueOn: "asc" }, { createdAt: "desc" }] });
      const people = await resolvePeople(tenantId, tasks.map((x) => x.subjectEmployeeId));
      return tasks.map((x) => ({ id: x.id, at: x.createdAt, person: x.subjectEmployeeId ? who(people, x.subjectEmployeeId) : null, heading: x.subjectEmployeeId ? undefined : "Task", title: x.title, tag: x.dueOn ? `Due ${x.dueOn.toISOString().slice(0, 10)}` : undefined, tagTone: x.dueOn && x.dueOn < new Date() ? "danger" as const : undefined }));
    },
    detail: async (id) => {
      const x = await prisma.workTask.findFirst({ where: { ...openTasks, id } });
      if (!x) return null;
      const people = await resolvePeople(tenantId, [x.subjectEmployeeId]);
      return (
        <DetailPane title={x.title} sub={`Created ${formatInstantDate(x.createdAt)}`} status={{ label: "Open", tone: "pending" }}
          footer={<ActButton action={completeWorkTaskAction} hidden={{ id: x.id }} label="Mark done" variant="primary" />}
          activity={[{ who: null, text: "Created by automation", at: x.createdAt }]}>
          {x.subjectEmployeeId ? <PersonStrip person={who(people, x.subjectEmployeeId)} meta="About" /> : null}
          <Facts items={[x.description ? ["Details", x.description] : null, x.dueOn ? ["Due", x.dueOn.toISOString().slice(0, 10)] : null]} />
        </DetailPane>
      );
    },
  }];
}
