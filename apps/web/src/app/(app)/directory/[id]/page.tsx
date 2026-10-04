import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { directoryWhere, DIRECTORY_SELECT, nameOf } from "@/lib/directory";
import { directoryVisibilityWhere } from "@/lib/core-hr";
import { SubTabs } from "@/components/subtabs";
import { Avatar } from "@/components/avatar";
import { Panel, Field } from "@/components/keka";
import { IconTrophy } from "@/components/icons";
import { DIRECTORY_TABS } from "../tabs";
import s from "./profile.module.css";

const P = PERMISSIONS;

/** What a person row shows — a strict subset of DIRECTORY_SELECT. */
const { id, displayName, firstName, lastName, jobTitleName, photoUrl } = DIRECTORY_SELECT;
const PERSON_SELECT = { id, displayName, firstName, lastName, jobTitleName, photoUrl };

const PRAISE_SHOWN = 8;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const viewer = await requireViewer();
  const { id: personId } = await params;
  const e = await prisma.employee.findFirst({ where: { ...directoryWhere(viewer.tenantId), id: personId }, select: { displayName: true, firstName: true, lastName: true } });
  return { title: e ? `${nameOf(e)} — BooS-HR` : "Not found — BooS-HR" };
}

export default async function DirectoryProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const tenantId = viewer.tenantId;
  const { id: personId } = await params;

  // Directory fields only, and only for people the directory lists: someone
  // exited, preboarding or in another tenant simply does not exist here.
  // The company's visibility settings (same legal entity / business unit) apply here too.
  const e = await prisma.employee.findFirst({
    where: { AND: [{ ...directoryWhere(tenantId), id: personId }, await directoryVisibilityWhere(viewer)] },
    select: DIRECTORY_SELECT,
  });
  if (!e) notFound();

  const praiseWhere = { tenantId, toEmployeeId: e.id, isPublic: true };
  const [manager, reports, praise, praiseCount] = await Promise.all([
    e.reportingManagerId
      ? prisma.employee.findFirst({ where: { ...directoryWhere(tenantId), id: e.reportingManagerId }, select: PERSON_SELECT })
      : Promise.resolve(null),
    prisma.employee.findMany({
      where: { ...directoryWhere(tenantId), reportingManagerId: e.id },
      select: PERSON_SELECT,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.praise.findMany({
      where: praiseWhere,
      orderBy: { createdAt: "desc" },
      take: PRAISE_SHOWN,
      select: {
        id: true, badge: true, message: true, createdAt: true,
        fromEmployee: { select: { ...PERSON_SELECT, tenantId: true, status: true } },
      },
    }),
    prisma.praise.count({ where: praiseWhere }),
  ]);

  const name = nameOf(e);
  const first = e.displayName?.split(/\s+/)[0] || e.firstName;
  const target = {
    id: e.id,
    departmentId: e.department?.id ?? null,
    locationId: e.location?.id ?? null,
    legalEntityId: e.legalEntity?.id ?? null,
    businessUnitId: e.businessUnit?.id ?? null,
    reportingManagerId: e.reportingManagerId,
  };
  const canViewRecord = canAccessEmployee(viewer, target, P.EMPLOYEE_VIEW);
  const isSelf = viewer.employee?.id === e.id;
  // Open the tree where this person is visible: at them if they lead a team,
  // otherwise at their manager.
  const treeHref = reports.length ? `/directory/tree?root=${e.id}` : manager ? `/directory/tree?root=${manager.id}` : "/directory/tree";
  const listed = (status: string) => status !== "EXITED" && status !== "PREBOARDING";

  return (
    <>
      <SubTabs items={DIRECTORY_TABS} />

      <section className={s.banner} aria-labelledby="profile-name">
        <BannerPattern />
        <div className={s.bannerInner}>
          <Avatar name={name} photoUrl={e.photoUrl} size={112} ring className={s.bigAvatar} />
          <div className={s.identity}>
            <h1 id="profile-name" className={s.name}>
              {name}
              {isSelf ? <span className={s.youTag}>You</span> : null}
            </h1>
            <div className={s.meta}>
              <span>{e.jobTitleName ?? "—"}</span>
              {e.location ? <><span className={s.dot} aria-hidden="true">•</span><span>{e.location.name}</span></> : null}
            </div>
            {e.workEmail ? (
              <a href={`mailto:${e.workEmail}`} className={s.email}>
                <MailIcon />
                <span>{e.workEmail}</span>
              </a>
            ) : null}
          </div>
          <div className={s.actions}>
            {canViewRecord ? <Link href={`/employees/${e.id}`} className={s.primaryAction}>View full record</Link> : null}
            <Link href={treeHref} className={s.secondaryAction}>View in org tree</Link>
          </div>
        </div>
      </section>

      <div className={s.layout}>
        <div className={s.main}>
          <Panel title="About">
            {e.aboutMe?.trim() ? (
              <p className={s.about}>{e.aboutMe.trim()}</p>
            ) : (
              <p className={s.muted}>
                {isSelf ? "You have not written anything about yourself yet." : `${first} has not written anything about themselves yet.`}
              </p>
            )}
          </Panel>

          <Panel title="Work details">
            <div className={s.fields}>
              <Field label="Department">{e.department?.name ?? null}</Field>
              <Field label="Business unit">{e.businessUnit?.name ?? null}</Field>
              <Field label="Location">{e.location ? <>{e.location.name}{e.location.city && e.location.city !== e.location.name ? <span className={s.mutedInline}> · {e.location.city}</span> : null}</> : null}</Field>
              <Field label="Date of joining">{e.dateOfJoining ? formatDate(e.dateOfJoining) : null}</Field>
              <Field label="Employee number">{e.employeeNumber}</Field>
              <Field label="Reporting manager">
                {manager ? <Link href={`/directory/${manager.id}`}>{nameOf(manager)}</Link> : null}
              </Field>
            </div>
          </Panel>

          <Panel
            title={<>Praise received{praiseCount ? <span className={s.count}>{praiseCount}</span> : null}</>}
            subtitle="Public praise from colleagues"
          >
            {praise.length === 0 ? (
              <div className={s.emptyPraise}>
                <IconTrophy aria-hidden="true" />
                <span>No public praise yet.</span>
              </div>
            ) : (
              <ul className={s.praiseList}>
                {praise.map((p) => {
                  const from = p.fromEmployee;
                  const fromName = nameOf(from);
                  const linkable = from.tenantId === tenantId && listed(from.status);
                  return (
                    <li key={p.id} className={s.praise}>
                      <Avatar name={fromName} photoUrl={from.photoUrl} size={36} />
                      <div className={s.praiseBody}>
                        <div className={s.praiseHead}>
                          {linkable ? <Link href={`/directory/${from.id}`} className={s.praiseFrom}>{fromName}</Link> : <span className={s.praiseFrom}>{fromName}</span>}
                          {p.badge ? <span className={s.badge}>{p.badge}</span> : null}
                          <time className={s.praiseDate} dateTime={p.createdAt.toISOString()}>{formatDate(p.createdAt)}</time>
                        </div>
                        <p className={s.praiseMessage}>{p.message}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {praiseCount > praise.length ? (
              <div className={s.praiseMore}>Showing the latest {praise.length} of {praiseCount}.</div>
            ) : null}
          </Panel>
        </div>

        <aside className={s.side}>
          <Panel title="Reporting manager">
            {manager ? (
              <PersonRow person={manager} />
            ) : (
              <p className={s.muted}>{e.reportingManagerId ? "Their manager is no longer listed in the directory." : "No reporting manager — top of the organisation."}</p>
            )}
          </Panel>

          <Panel title={<>Direct reports{reports.length ? <span className={s.count}>{reports.length}</span> : null}</>}>
            {reports.length ? (
              <ul className={s.people}>
                {reports.map((r) => <li key={r.id}><PersonRow person={r} /></li>)}
              </ul>
            ) : (
              <p className={s.muted}>No one reports to {isSelf ? "you" : first}.</p>
            )}
          </Panel>
        </aside>
      </div>
    </>
  );
}

function PersonRow({ person }: { person: { id: string; displayName: string | null; firstName: string; lastName: string; jobTitleName: string | null; photoUrl: string | null } }) {
  const n = nameOf(person);
  return (
    <Link href={`/directory/${person.id}`} className={s.person}>
      <Avatar name={n} photoUrl={person.photoUrl} size={36} />
      <span className={s.personText}>
        <span className={s.personName}>{n}</span>
        <span className={s.personTitle}>{person.jobTitleName ?? "—"}</span>
      </span>
    </Link>
  );
}

function MailIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6.5 8.5-6.5" />
    </svg>
  );
}

/** An abstract blue banner: soft rings, a mesh of lines and drifting dots. Pure SVG. */
function BannerPattern() {
  return (
    <svg className={s.pattern} viewBox="0 0 1200 220" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="pb-base" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1556ad" />
          <stop offset=".55" stopColor="#1a65c7" />
          <stop offset="1" stopColor="#2f7fe0" />
        </linearGradient>
        <radialGradient id="pb-glow" cx=".82" cy=".1" r=".6">
          <stop offset="0" stopColor="#7fb6ff" stopOpacity=".55" />
          <stop offset="1" stopColor="#7fb6ff" stopOpacity="0" />
        </radialGradient>
        <pattern id="pb-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.3" fill="#fff" fillOpacity=".16" />
        </pattern>
        <linearGradient id="pb-fade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".7" />
          <stop offset="1" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
        <mask id="pb-dots-mask"><rect width="1200" height="220" fill="url(#pb-fade)" /></mask>
      </defs>
      <rect width="1200" height="220" fill="url(#pb-base)" />
      <rect width="1200" height="220" fill="url(#pb-glow)" />
      <rect x="560" width="640" height="220" fill="url(#pb-dots)" mask="url(#pb-dots-mask)" />
      <g fill="none" stroke="#fff">
        <circle cx="1040" cy="40" r="70" strokeOpacity=".16" strokeWidth="1.5" />
        <circle cx="1040" cy="40" r="120" strokeOpacity=".12" strokeWidth="1.5" />
        <circle cx="1040" cy="40" r="175" strokeOpacity=".08" strokeWidth="1.5" />
        <circle cx="1040" cy="40" r="235" strokeOpacity=".06" strokeWidth="1.5" />
        <path d="M0 170 C 180 120, 320 220, 520 160 S 860 90, 1200 150" strokeOpacity=".14" strokeWidth="2" />
        <path d="M0 196 C 200 150, 360 236, 560 184 S 900 120, 1200 178" strokeOpacity=".09" strokeWidth="2" />
        <path d="M700 220 L 820 120 L 930 190 L 1060 90 L 1200 160" strokeOpacity=".12" strokeWidth="1.2" />
        <path d="M820 120 L 900 40 L 1060 90 M900 40 L 930 190" strokeOpacity=".08" strokeWidth="1.2" />
      </g>
      <g fill="#fff">
        <circle cx="820" cy="120" r="3" fillOpacity=".35" />
        <circle cx="930" cy="190" r="2.5" fillOpacity=".3" />
        <circle cx="1060" cy="90" r="3.5" fillOpacity=".35" />
        <circle cx="900" cy="40" r="2.5" fillOpacity=".3" />
        <circle cx="1140" cy="190" r="26" fillOpacity=".05" />
        <circle cx="640" cy="30" r="16" fillOpacity=".05" />
      </g>
      <path d="M0 0 L 380 0 L 250 220 L 0 220 Z" fill="#0f2441" fillOpacity=".14" />
    </svg>
  );
}
