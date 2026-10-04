import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { saveGuideAction, toggleGuideAction, saveQuestionAction, toggleQuestionAction } from "@/app/actions/hire-interviews";
import { HireSettingsTabs } from "../../_parts/settings-tabs";
import { pretty } from "../../_parts/depth-tabs";

export const metadata = { title: "Interviewing · Hire" };

/** Hire › Settings › Interviewing: interviewer guides by role and the shared question bank. */
export default async function InterviewingSettingsPage({ searchParams }: { searchParams: Promise<{ competency?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.INTERVIEW_MANAGE);
  const { competency } = await searchParams;
  const [guides, questions, depts] = await Promise.all([
    prisma.interviewGuide.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { title: "asc" } }),
    prisma.questionBankItem.findMany({ where: { tenantId: viewer.tenantId, ...(competency ? { competency } : {}) }, orderBy: [{ competency: "asc" }, { createdAt: "desc" }] }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const competencies = [...new Set((await prisma.questionBankItem.findMany({ where: { tenantId: viewer.tenantId }, select: { competency: true } })).map((q) => q.competency))].sort();
  return (
    <>
      <HireSettingsTabs />
      <PageHead title="Interviewing" subtitle="Guides interviewers read before a round, and the question bank they draw from." actions={<Link className="btn" href="/hiring/interviews/capacity">Interviewer capacity</Link>} />
      <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
        <Card title="Interview guides" tight>
          {guides.length === 0 ? <Empty title="No guides yet" /> : (
            <table className="data"><tbody>
              {guides.map((g) => (
                <tr key={g.id}>
                  <td><div className="strong">{g.title}</div><div className="text-xs muted">{g.roleKeyword ? `Roles matching “${g.roleKeyword}”` : "All roles"}</div>
                    <Reveal label="Edit"><GrowthForm action={saveGuideAction} hidden={{ id: g.id }} cols={2} fields={[
                      { name: "title", label: "Title", required: true, defaultValue: g.title }, { name: "roleKeyword", label: "For roles containing", defaultValue: g.roleKeyword },
                      { name: "departmentId", label: "Department", type: "select", options: depts.map((d) => ({ value: d.id, label: d.name })), defaultValue: g.departmentId },
                      { name: "body", label: "Guide", type: "textarea", rows: 8, required: true, defaultValue: g.body },
                    ]} /></Reveal>
                  </td>
                  <td><Badge tone={g.isActive ? "success" : "neutral"}>{g.isActive ? "In use" : "Retired"}</Badge></td>
                  <td className="right"><ActButton action={toggleGuideAction} hidden={{ id: g.id }} label={g.isActive ? "Retire" : "Restore"} /></td>
                </tr>
              ))}
            </tbody></table>
          )}
          <div style={{ padding: 12 }}>
            <Reveal label="New guide">
              <GrowthForm action={saveGuideAction} cols={2} fields={[
                { name: "title", label: "Title", required: true }, { name: "roleKeyword", label: "For roles containing", placeholder: "e.g. engineer" },
                { name: "departmentId", label: "Department", type: "select", options: depts.map((d) => ({ value: d.id, label: d.name })) },
                { name: "body", label: "Guide", type: "textarea", rows: 8, required: true },
              ]} />
            </Reveal>
          </div>
        </Card>
        <Card title="Question bank" tight action={<form className="row gap-1"><select className="input" name="competency" defaultValue={competency ?? ""} aria-label="Competency"><option value="">All competencies</option>{competencies.map((c) => <option key={c} value={c}>{c}</option>)}</select><button className="btn sm">Filter</button></form>}>
          {questions.length === 0 ? <Empty title="No questions yet" /> : (
            <table className="data" data-testid="question-bank"><tbody>
              {questions.map((q) => (
                <tr key={q.id}><td>{q.text}<div className="text-xs muted">{q.competency} · {pretty(q.difficulty)}{q.guidance ? ` · look for: ${q.guidance}` : ""}</div></td><td><Badge tone={q.isActive ? "success" : "neutral"}>{q.isActive ? "Active" : "Retired"}</Badge></td><td className="right"><ActButton action={toggleQuestionAction} hidden={{ id: q.id }} label={q.isActive ? "Retire" : "Restore"} /></td></tr>
              ))}
            </tbody></table>
          )}
          <div style={{ padding: 12 }}>
            <GrowthForm action={saveQuestionAction} cols={3} submitLabel="Add question" fields={[
              { name: "text", label: "Question", type: "textarea", required: true }, { name: "competency", label: "Competency", required: true },
              { name: "difficulty", label: "Difficulty", type: "select", options: ["EASY", "MEDIUM", "HARD"].map((x) => ({ value: x, label: pretty(x) })), defaultValue: "MEDIUM" },
              { name: "guidance", label: "What a good answer covers" },
            ]} />
          </div>
        </Card>
      </div>
    </>
  );
}
