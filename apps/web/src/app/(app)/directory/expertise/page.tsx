import Link from "next/link";
import { prisma } from "@keka/db";
import { requireViewer, can } from "@/lib/context";
import { PERMISSIONS } from "@keka/rbac";
import { directoryWhere, nameOf } from "@/lib/directory";
import { directoryVisibilityWhere } from "@/lib/core-hr";
import { SubTabs } from "@/components/subtabs";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { DIRECTORY_TABS } from "../tabs";

export const metadata = { title: "Expertise — BooS-HR" };

/**
 * Who knows what: every skill and certification with the colleagues who
 * hold it (strongest first), and the languages people speak — so you can
 * find the right person rather than the right department.
 */
export default async function ExpertisePage({ searchParams }: { searchParams: Promise<{ skill?: string; cert?: string; lang?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const t = viewer.tenantId;
  const visible = { AND: [directoryWhere(t), await directoryVisibilityWhere(viewer)] };
  const unlisted = can(viewer, PERMISSIONS.EMPLOYEE_UPDATE) ? [] : (await prisma.employeeProfileExtra.findMany({ where: { tenantId: t, hideFromDirectory: true }, select: { employeeId: true } })).map((u) => u.employeeId);
  const people = { AND: [visible, { id: { notIn: unlisted } }] };
  const [skills, certs, langs] = await Promise.all([
    prisma.skill.findMany({ where: { tenantId: t, isActive: true, status: "ACTIVE" }, select: { id: true, name: true, category: true, levels: true, _count: { select: { employeeSkills: { where: { employee: people } } } } }, orderBy: [{ category: "asc" }, { name: "asc" }] }),
    prisma.course.findMany({ where: { tenantId: t, certificates: { some: { revokedAt: null, employee: people } } }, select: { id: true, title: true, _count: { select: { certificates: { where: { revokedAt: null, employee: people } } } } }, orderBy: { title: "asc" } }),
    prisma.employeeProfileExtra.findMany({ where: { tenantId: t, NOT: { languages: { isEmpty: true } }, employeeId: { notIn: unlisted } }, select: { employeeId: true, languages: true } }),
  ]);
  const langCount = new Map<string, number>();
  for (const l of langs) for (const x of l.languages) langCount.set(x, (langCount.get(x) ?? 0) + 1);
  const skill = sp.skill ? skills.find((s) => s.id === sp.skill) : null;
  const holders = skill ? await prisma.employeeSkill.findMany({ where: { skillId: skill.id, employee: people }, select: { level: true, employee: { select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true } } }, orderBy: { level: "desc" } }) : [];
  const cert = sp.cert ? certs.find((c) => c.id === sp.cert) : null;
  const certHolders = cert ? await prisma.learningCertificate.findMany({ where: { courseId: cert.id, revokedAt: null, employee: people }, select: { issuedAt: true, expiresAt: true, employee: { select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true } } } }) : [];
  const speakers = sp.lang ? await prisma.employee.findMany({ where: { AND: [people, { id: { in: langs.filter((l) => l.languages.includes(sp.lang!)).map((l) => l.employeeId) } }] }, select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true } }) : [];
  const levelName = (levels: unknown, i: number) => (Array.isArray(levels) && typeof levels[i] === "string" ? (levels[i] as string) : `Level ${i + 1}`);
  return (
    <>
      <SubTabs items={[...DIRECTORY_TABS]} active="/directory/expertise" />
      <PageHead title="Expertise" subtitle="Find colleagues by skill, certification or language" />
      <div className="grid grid-2">
        <Card title="Skills">
          {skills.length ? <div className="row gap-2 wrap">{skills.filter((s) => s._count.employeeSkills > 0).map((s) => <Link key={s.id} href={`/directory/expertise?skill=${s.id}`}><Badge tone={skill?.id === s.id ? "brand" : "neutral"}>{s.name} · {s._count.employeeSkills}</Badge></Link>)}</div> : <Empty title="No skills yet" />}
        </Card>
        <div>
          <Card title="Certifications">{certs.length ? <div className="row gap-2 wrap">{certs.map((c) => <Link key={c.id} href={`/directory/expertise?cert=${c.id}`}><Badge tone={cert?.id === c.id ? "brand" : "neutral"}>{c.title} · {c._count.certificates}</Badge></Link>)}</div> : <Empty title="No certifications yet" />}</Card>
          <Card title="Languages">{langCount.size ? <div className="row gap-2 wrap">{[...langCount].sort().map(([l, n]) => <Link key={l} href={`/directory/expertise?lang=${encodeURIComponent(l)}`}><Badge tone={sp.lang === l ? "brand" : "neutral"}>{l} · {n}</Badge></Link>)}</div> : <Empty title="No languages listed" />}</Card>
        </div>
      </div>
      {skill ? (
        <Card title={`${skill.name}${skill.category ? ` · ${skill.category}` : ""}`} action={<Link className="btn sm" href={`/directory?skill=${skill.id}`}>Open in directory</Link>}>
          <ul>{holders.map((h) => <li key={h.employee.id}><Link href={`/directory/${h.employee.id}`}>{nameOf(h.employee)}</Link> <span className="muted text-sm">{h.employee.jobTitleName ?? ""}</span> <Badge tone="info">{levelName(skill.levels, h.level)}</Badge></li>)}</ul>
        </Card>
      ) : null}
      {cert ? <Card title={cert.title} action={<Link className="btn sm" href={`/directory?cert=${cert.id}`}>Open in directory</Link>}><ul>{certHolders.map((h) => <li key={h.employee.id}><Link href={`/directory/${h.employee.id}`}>{nameOf(h.employee)}</Link> <span className="muted text-sm">{h.employee.jobTitleName ?? ""}</span></li>)}</ul></Card> : null}
      {sp.lang ? <Card title={`Speaks ${sp.lang}`}><ul>{speakers.map((p) => <li key={p.id}><Link href={`/directory/${p.id}`}>{nameOf(p)}</Link> <span className="muted text-sm">{p.jobTitleName ?? ""}</span></li>)}</ul></Card> : null}
    </>
  );
}
