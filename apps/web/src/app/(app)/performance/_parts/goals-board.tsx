import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { goalBucket, progressSeries, parseTimeframe, timeframeOfDates, type GoalBucket } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { nameOf } from "@/lib/directory";
import { Avatar } from "@/components/avatar";
import { EmptyState } from "@/components/keka";
import { IconTarget, IconUser, IconUsers, IconBuilding, IconCalendar, IconSearch, IconChevronRight, IconSparkle, IconDotsVertical, IconPlus, IconChevronDown } from "@/components/icons";
import { CheckIn, GoalStatus, PublishDraftGoal } from "../forms";
import { AutoSubmitSelect } from "./toast";
import s from "./perform.module.css";

/**
 * The goals page as Keka lays it out (Me › Performance › Goals, and the
 * Performance workspace's Goals tab): My / Department / Company goals, a
 * timeframe picker, filters, the average-progress line, the status buckets,
 * and goals grouped by timeframe.
 */

export type GoalScope = "team" | "mine" | "department" | "company";
const SCOPE_LABEL: Record<GoalScope, string> = { team: "My Team Goals", mine: "My Goals", department: "Department Goals", company: "Company Goals" };
const SCOPE_ICON: Record<GoalScope, typeof IconUser> = { team: IconUsers, mine: IconUser, department: IconUsers, company: IconBuilding };

export const BUCKETS: Array<{ key: GoalBucket; label: string; colour: string }> = [
  { key: "NOT_STARTED", label: "Not started", colour: "#8891a3" },
  { key: "AT_RISK", label: "At risk", colour: "#e5484d" },
  { key: "NEEDS_ATTENTION", label: "Needs attention", colour: "#f5b83d" },
  { key: "ON_TRACK", label: "On track", colour: "#46a758" },
  { key: "CLOSED", label: "Closed", colour: "#3b82f6" },
  { key: "DRAFT", label: "Draft", colour: "#c4c9d4" },
];
const BUCKET = new Map(BUCKETS.map((b) => [b.key, b]));
const LEVEL_LABEL: Record<string, string> = { INDIVIDUAL: "Individual", TEAM: "Team", DEPARTMENT: "Department", COMPANY: "Company" };
const num = (v: unknown) => Number(v ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export async function GoalsBoard({ viewer, base, scope, scopes, sp, title }: {
  viewer: Viewer; base: string; scope: GoalScope; scopes: GoalScope[];
  sp: { tf?: string; type?: string; status?: string; tag?: string; q?: string; expand?: string };
  title: string;
}) {
  const me = viewer.employee?.id ?? "__none__";
  const fy = viewer.tenant.fyStartMonth;
  const myDept = viewer.employee ? (await prisma.employee.findUnique({ where: { id: me }, select: { departmentId: true } }))?.departmentId ?? null : null;
  const reports = [...viewer.allReportIds];
  const where = scope === "mine" ? { employeeId: me }
    : scope === "team" ? { employeeId: { in: reports } }
    : scope === "department" ? { level: "DEPARTMENT" as const, departmentId: myDept ?? "__none__" }
    : { level: "COMPANY" as const };
  const all = await prisma.goal.findMany({
    where: { tenantId: viewer.tenantId, ...where, ...(scope !== "mine" && scope !== "team" ? { status: { not: "DRAFT" as const } } : {}) },
    include: {
      employee: { select: { id: true, displayName: true, firstName: true, lastName: true, photoUrl: true } },
      checkIns: { select: { recordedAt: true, progressPercent: true }, orderBy: { recordedAt: "asc" } },
      _count: { select: { childGoals: true, checkIns: true } },
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
  });

  const today = new Date();
  const rows = all.map((g) => {
    const label = g.timeframe && parseTimeframe(g.timeframe, fy) ? g.timeframe : timeframeOfDates(g.startDate, g.dueDate, fy);
    const tf = parseTimeframe(label, fy)!;
    const pct = Math.round(Number(g.progressPercent));
    const span = Math.max(1, g.dueDate.getTime() - g.startDate.getTime());
    const expected = Math.round(Math.max(0, Math.min(100, ((today.getTime() - g.startDate.getTime()) / span) * 100)));
    const bucket = goalBucket({ status: g.status, progressPercent: pct, checkIns: g._count.checkIns });
    const tags = Array.isArray(g.tags) ? (g.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
    return { g, label, tf, pct, expected, bucket, tags };
  });
  const allTags = [...new Set(rows.flatMap((r) => r.tags))].sort();

  const tfMode = sp.tf === "past" || sp.tf === "all" ? sp.tf : "current";
  const q = (sp.q ?? "").trim().toLowerCase();
  const filtered = rows.filter((r) =>
    (tfMode === "all" || (tfMode === "past" ? r.tf.end < startOfToday(today) : r.tf.end >= startOfToday(today)))
    && (!sp.type || r.g.level === sp.type)
    && (!sp.status || r.bucket === sp.status)
    && (!sp.tag || r.tags.includes(sp.tag))
    && (!q || r.g.title.toLowerCase().includes(q)));

  const live = filtered.filter((r) => r.bucket !== "DRAFT" && r.g.status !== "CANCELLED");
  const avg = live.length ? Math.round(live.reduce((t, r) => t + r.pct, 0) / live.length) : 0;
  const counts = new Map<GoalBucket, number>();
  for (const r of filtered) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1);
  const from = live.length ? new Date(Math.min(...live.map((r) => r.g.startDate.getTime()))) : new Date(today.getTime() - 180 * 86_400_000);
  const series = progressSeries(live.map((r) => ({ checkIns: r.g.checkIns.map((c) => ({ at: c.recordedAt, progress: Number(c.progressPercent) })) })), from, today, 8);

  const groups = new Map<string, typeof filtered>();
  for (const r of filtered) groups.set(r.label, [...(groups.get(r.label) ?? []), r]);
  const ordered = [...groups.entries()].sort((a, b) => {
    const ta = a[1][0].tf, tb = b[1][0].tf;
    return ta.start.getTime() - tb.start.getTime() || tb.end.getTime() - ta.end.getTime();
  });

  const editable = (g: (typeof all)[number]) => g.employeeId ? g.employeeId === me || viewer.allReportIds.has(g.employeeId) : can(viewer, PERMISSIONS.GOALS_MANAGE);
  const back = encodeURIComponent(scope === "mine" ? base : `${base}?scope=${scope}`);
  const link = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { scope: scope === scopes[0] ? undefined : scope, tf: sp.tf, type: sp.type, status: sp.status, tag: sp.tag, q: sp.q, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const qs = p.toString();
    return qs ? `${base}${base.includes("?") ? "&" : "?"}${qs}` : base;
  };
  const canAdd = scope === "mine" || scope === "team" || can(viewer, PERMISSIONS.GOALS_MANAGE);

  return (
    <>
      <div className={s.head}>
        <div className={s.headLeft}>
          <h1 className={s.h1}>{title}</h1>
          <form method="get" action={base.split("?")[0]} className={s.tfSelect}>
            {hidden(base, { scope: scope === scopes[0] ? undefined : scope, type: sp.type, status: sp.status, tag: sp.tag, q: sp.q })}
            <span className={s.toolbarDot} aria-hidden="true" />
            <AutoSubmitSelect name="tf" defaultValue={tfMode} aria-label="Timeframe">
              <option value="current">Current timeframes</option>
              <option value="past">Past timeframes</option>
              <option value="all">All timeframes</option>
            </AutoSubmitSelect>
          </form>
        </div>
        {canAdd ? (
          <div className={s.actions}>
            <Link href={`/performance/goals/ai?back=${back}`} className={s.aiBtn}><IconSparkle aria-hidden="true" />Add goals using AI</Link>
            <span className={s.split}>
              <Link href={`/performance/goals/new?back=${back}`} className="btn primary"><IconPlus width={15} height={15} aria-hidden="true" /> Add goal</Link>
              <details className={s.splitMenu}>
                <summary aria-label="More ways to add a goal"><IconChevronDown width={15} height={15} /></summary>
                <div className={s.menu}>
                  <Link href={`/performance/goals/new?back=${back}`}>Create custom goal</Link>
                  <Link href={`/performance/goals/ai?back=${back}`}>Add goals using AI</Link>
                </div>
              </details>
            </span>
          </div>
        ) : null}
      </div>

      <nav className={s.seg} aria-label="Whose goals">
        {scopes.map((sc) => {
          const Icon = SCOPE_ICON[sc];
          return <Link key={sc} href={sc === scopes[0] ? base : `${base}${base.includes("?") ? "&" : "?"}scope=${sc}`} className={s.segItem} aria-current={sc === scope ? "page" : undefined}><Icon aria-hidden="true" />{SCOPE_LABEL[sc]}</Link>;
        })}
      </nav>

      {all.length === 0 ? (
        <div className="k-panel" style={{ marginTop: 22 }}>
          <div style={{ minHeight: 320, display: "grid", placeItems: "center" }}>
            <EmptyState icon={<IconTarget width={52} height={52} />} title={scope === "mine" ? "No goals yet" : `No ${SCOPE_LABEL[scope].toLowerCase()} yet`}>
              There are no goals available. Add goals to align and track progress.
              {canAdd ? (
                <div className={s.actions} style={{ justifyContent: "center", marginTop: 18 }}>
                  <Link href={`/performance/goals/ai?back=${back}`} className={s.aiBtn}><IconSparkle aria-hidden="true" />Add goals using AI</Link>
                  <Link href={`/performance/goals/new?back=${back}`} className="btn primary"><IconPlus width={15} height={15} aria-hidden="true" /> Add goal</Link>
                </div>
              ) : null}
            </EmptyState>
          </div>
        </div>
      ) : (
        <>
          <form method="get" action={base.split("?")[0]} className={s.filters} role="search">
            {hidden(base, { scope: scope === scopes[0] ? undefined : scope, tf: sp.tf })}
            <label className={s.filter}>
              <span className={s.filterLabel}>Goal type</span>
              <AutoSubmitSelect name="type" defaultValue={sp.type ?? ""}>
                <option value="">All types</option>
                {["INDIVIDUAL", "TEAM", "DEPARTMENT", "COMPANY"].map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
              </AutoSubmitSelect>
            </label>
            <label className={s.filter}>
              <span className={s.filterLabel}>Status</span>
              <AutoSubmitSelect name="status" defaultValue={sp.status ?? ""}>
                <option value="">All statuses</option>
                {BUCKETS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </AutoSubmitSelect>
            </label>
            <label className={s.filter}>
              <span className={s.filterLabel}>Tags</span>
              <AutoSubmitSelect name="tag" defaultValue={sp.tag ?? ""}>
                <option value="">All tags</option>
                {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
              </AutoSubmitSelect>
            </label>
            <div className={s.search}>
              <IconSearch aria-hidden="true" />
              <input name="q" defaultValue={sp.q ?? ""} placeholder="Search" aria-label="Search goals" />
            </div>
          </form>

          <div className={s.stats}>
            <div className={s.avg}>
              <div>
                <div className={s.avgLabel}>Average progress</div>
                <div className={s.avgValue}>{avg} %</div>
              </div>
              <Spark series={series.map((p) => p.value)} />
            </div>
            <div className={s.byStatus}>
              <div className={s.byStatusTitle}>Goal by status ( {filtered.length} goal{filtered.length === 1 ? "" : "s"})</div>
              <div className={s.legend}>
                {BUCKETS.filter((b) => b.key !== "DRAFT" || counts.get("DRAFT")).map((b) => (
                  <div key={b.key} className={s.legendItem}>
                    <span className={s.dot} style={{ background: b.colour }} aria-hidden="true" />
                    <Link href={link({ status: sp.status === b.key ? undefined : b.key })}>{b.label} ({counts.get(b.key) ?? 0})</Link>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {ordered.length === 0 ? (
            <div className="k-panel"><div style={{ minHeight: 160, display: "grid", placeItems: "center" }}><EmptyState title="No goals match">Try another timeframe or clear the filters. <Link href={link({ tf: "all", type: undefined, status: undefined, tag: undefined, q: undefined })} style={{ color: "var(--brand-600)" }}>Show everything</Link></EmptyState></div></div>
          ) : ordered.map(([label, list], gi) => {
            const groupLive = list.filter((r) => r.bucket !== "DRAFT" && r.g.status !== "CANCELLED");
            const gAvg = groupLive.length ? Math.round(groupLive.reduce((t, r) => t + r.pct, 0) / groupLive.length) : 0;
            const open = sp.expand === "all" || gi === 0 || list[0].tf.end >= startOfToday(today);
            return (
              <details key={label} open={open}>
                <summary className={s.groupHead}>
                  <IconChevronRight className={s.groupChevron} aria-hidden="true" />
                  <span className={s.groupLabel}>{label}</span>
                  <span className={s.groupBar} aria-hidden="true"><span style={{ width: `${gAvg}%` }} /></span>
                  <span className={s.groupPct}>{gAvg}%</span>
                  {gi === 0 ? <span className={s.groupTools}><Link href={link({ expand: "all" })}>Expand all goals</Link></span> : null}
                </summary>
                <div className={s.goalList}>
                  {list.map(({ g, pct, expected, bucket }) => {
                    const b = BUCKET.get(bucket)!;
                    const numeric = !["PERCENTAGE", "COMPLETION"].includes(g.metricType);
                    const owner = g.employee ? nameOf(g.employee) : null;
                    const canEdit = editable(g);
                    return (
                      <div key={g.id} className={s.goalRow}>
                        <div className={s.goalTitle}>
                          <IconTarget aria-hidden="true" />
                          <div style={{ minWidth: 0 }}>
                            <div className={s.goalName}>{g.title}</div>
                            <div className={s.goalMeta}>
                              <span>{g._count.childGoals} Sub-goal{g._count.childGoals === 1 ? "" : "s"}</span>
                              <span>· {g._count.checkIns} Check-in{g._count.checkIns === 1 ? "" : "s"}</span>
                              {bucket === "DRAFT" ? <span className="badge neutral">Draft</span> : null}
                              {g.status === "CANCELLED" ? <span className="badge neutral">Cancelled</span> : null}
                            </div>
                          </div>
                        </div>
                        <div className={s.cellMuted}>{g.level === "INDIVIDUAL" ? <IconUser aria-hidden="true" /> : <IconUsers aria-hidden="true" />}{LEVEL_LABEL[g.level]}</div>
                        <div title={owner ?? viewer.tenant.name}>{owner ? <Avatar name={owner} photoUrl={g.employee!.photoUrl} size={30} /> : <span className={s.cellMuted}><IconBuilding aria-hidden="true" /></span>}</div>
                        <div className={s.cellMuted}><IconCalendar aria-hidden="true" />Due {formatDate(g.dueDate)}</div>
                        <div className={s.prog}>
                          <div className={s.progTop}>
                            <div className={s.progBar} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${g.title} progress`}>
                              <span style={{ width: `${Math.min(100, pct)}%`, background: b.colour }} />
                            </div>
                            <span className={s.progPct}>{pct}%</span>
                            {bucket !== "DRAFT" && bucket !== "CLOSED" ? <span className={s.progExp} title="Where it should be by now">({expected}%)</span> : null}
                          </div>
                          <div className={s.progRange}>
                            {numeric ? `${num(g.startValue)} → ${num(g.targetValue)}${g.metricName ? ` ${g.metricName}` : ""} · now ${num(g.currentValue)}` : g.metricType === "COMPLETION" ? (pct >= 100 ? "Completed" : "Not completed") : `0 % → 100 %`}
                          </div>
                        </div>
                        {canEdit ? (
                          <details className={s.kebab}>
                            <summary aria-label={`Actions for ${g.title}`}><IconDotsVertical /></summary>
                            <div className={s.kebabMenu}>
                              {bucket === "DRAFT" ? <PublishDraftGoal goalId={g.id} /> : null}
                              {bucket !== "DRAFT" && !["CANCELLED", "COMPLETED", "MISSED"].includes(g.status) && (g._count.childGoals === 0 || g.rollupMethod === "MANUAL") ? (
                                <><div className={s.kebabTitle}>Check in</div><CheckIn goalId={g.id} metric={g.metricType} current={Number(g.currentValue)} /></>
                              ) : null}
                              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                                <span className="text-xs subtle">{b.label}{g.timeframe ? ` · ${g.timeframe}` : ""}</span>
                                <GoalStatus goalId={g.id} cancelled={g.status === "CANCELLED"} />
                              </div>
                            </div>
                          </details>
                        ) : <span />}
                      </div>
                    );
                  })}
                </div>
                {canAdd && gi === 0 ? <Link href={`/performance/goals/new?back=${back}`} className="btn ghost sm" style={{ color: "var(--brand-600)", margin: "4px 0 10px" }}><IconPlus width={14} height={14} aria-hidden="true" /> Add goal</Link> : null}
              </details>
            );
          })}
        </>
      )}
    </>
  );
}

const startOfToday = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Keep a page's own query (e.g. ?view=…) and the current filters on GET forms. */
function hidden(base: string, extra: Record<string, string | undefined>) {
  const own = new URLSearchParams(base.split("?")[1] ?? "");
  const out = [...own.entries()].map(([k, v]) => <input key={`b-${k}`} type="hidden" name={k} value={v} />);
  for (const [k, v] of Object.entries(extra)) if (v) out.push(<input key={k} type="hidden" name={k} value={v} />);
  return out;
}

/** The small line: expected (dashed, 0 → 100) against actual average progress. */
function Spark({ series }: { series: number[] }) {
  const w = 320, h = 96, pad = 6;
  const x = (i: number) => pad + (i / Math.max(1, series.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2);
  const actual = series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className={s.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`Average progress over time, now ${series[series.length - 1] ?? 0}%`}>
      <line x1={x(0)} y1={y(0)} x2={x(series.length - 1)} y2={y(100)} stroke="#8891a3" strokeWidth="1.3" strokeDasharray="5 4" />
      <path d={actual} fill="none" stroke="#7c6fe0" strokeWidth="2.2" strokeLinejoin="round" />
      <text x={pad} y={h - 1} fontSize="9" fill="#8891a3">0</text>
    </svg>
  );
}
