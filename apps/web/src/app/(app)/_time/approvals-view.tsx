import Link from "next/link";
import Form from "next/form";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import type { Viewer } from "@/lib/context";
import {
  TIME_CATEGORIES, CATEGORY_COLUMNS, listApprovals, countApprovals, categoryOf,
  type ApprovalScope, type StatusFilter, type TimeCat,
} from "@/lib/time-approvals";
import { ApprovalsTable, type TableRow } from "./approvals-table";
import s from "./time.module.css";

/**
 * Approvals for a set of time categories, as Keka lays them out: category
 * pills with what is waiting, a filter row (status, dates, department,
 * location, employee), and the category's table with bulk decisions.
 * Used by Time Attend › Approvals (everyone in scope) and by My Team (the
 * viewer's reporting line).
 */

export type ApprovalParams = { cat?: string; status?: string; from?: string; to?: string; dept?: string; loc?: string; q?: string };

const STATUSES: Array<[StatusFilter, string]> = [["PENDING", "Pending"], ["APPROVED", "Approved"], ["REJECTED", "Rejected"], ["CANCELLED", "Cancelled"], ["ALL", "All"]];
const day = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);

export async function ApprovalsView({ viewer, scope, cats, sp, base, extra = {} }: {
  viewer: Viewer; scope: ApprovalScope; cats: TimeCat[]; sp: ApprovalParams; base: string;
  /** Query parameters the page keeps (e.g. tab=approvals). */
  extra?: Record<string, string>;
}) {
  const categories = TIME_CATEGORIES.filter((c) => cats.includes(c.key));
  const counts = await Promise.all(categories.map((c) => countApprovals(viewer, c.key, scope)));
  const cat = categoryOf(sp.cat && cats.includes(sp.cat as TimeCat) ? sp.cat : null)
    ?? categories[counts.findIndex((n) => n > 0)] ?? categories[0];
  const status = (STATUSES.find(([k]) => k === sp.status)?.[0] ?? "PENDING") as StatusFilter;
  const from = day(sp.from), to = day(sp.to);

  const [rows, departments, locations] = await Promise.all([
    listApprovals(viewer, cat.key, {
      scope, status, from, to, departmentId: sp.dept || null, locationId: sp.loc || null, q: sp.q?.slice(0, 80) || null,
    }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const href = (patch: Partial<ApprovalParams>) => {
    const q = new URLSearchParams(extra);
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) q.set(k, v);
    return `${base}?${q.toString()}`;
  };
  const tableRows: TableRow[] = rows.map((r) => ({
    id: r.id, employee: r.employee, status: r.status, requestedOn: r.requestedOn.toISOString(), cells: r.cells, mapUrl: r.mapUrl ?? null,
    lastActionBy: r.lastActionBy, lastActionAt: r.lastActionAt?.toISOString() ?? null, decisionNote: r.decisionNote,
    nextApprover: r.nextApprover, canDecide: r.canDecide,
  }));
  const range = rows.length
    ? `${formatDate(new Date(Math.min(...rows.map((r) => r.requestedOn.getTime()))))} – ${formatDate(new Date(Math.max(...rows.map((r) => r.requestedOn.getTime()))))}`
    : null;

  return (
    <>
      {categories.length > 1 ? (
        <nav className={s.cats} aria-label="Request categories">
          {categories.map((c, i) => (
            <Link key={c.key} href={href({ cat: c.key })} scroll={false}
              className={`${s.cat}${c.key === cat.key ? ` ${s.catActive}` : ""}`} aria-current={c.key === cat.key ? "page" : undefined}>
              {c.label}{counts[i] > 0 ? <span className={s.catCount}>{counts[i]}</span> : null}
            </Link>
          ))}
        </nav>
      ) : null}

      <Form action={base} className={s.toolbar} scroll={false}>
        {Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <input type="hidden" name="cat" value={cat.key} />
        <input type="hidden" name="status" value={status} />
        <nav className={s.seg} aria-label="Status">
          {STATUSES.map(([k, label]) => (
            <Link key={k} href={href({ status: k })} scroll={false} aria-current={k === status ? "true" : undefined}>{label}</Link>
          ))}
        </nav>
        <label>From<input className="input" type="date" name="from" defaultValue={sp.from ?? ""} /></label>
        <label>To<input className="input" type="date" name="to" defaultValue={sp.to ?? ""} /></label>
        <label>Department
          <select className="select" name="dept" defaultValue={sp.dept ?? ""}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label>Location
          <select className="select" name="loc" defaultValue={sp.loc ?? ""}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>Employee<input className="input" name="q" defaultValue={sp.q ?? ""} placeholder="Search employee" /></label>
        <button className="btn" type="submit">Apply</button>
        {sp.from || sp.to || sp.dept || sp.loc || sp.q ? <Link className="btn ghost" href={href({ from: "", to: "", dept: "", loc: "", q: "" })}>Reset</Link> : null}
      </Form>

      <section className={s.card} aria-label={cat.label}>
        <div className={s.cardHead}>
          <h2 className={s.cardTitle}>{cat.label}</h2>
          {range ? <span className={s.cardMeta}>{range}</span> : null}
        </div>
        <ApprovalsTable
          rows={tableRows}
          columns={CATEGORY_COLUMNS[cat.key]}
          entity={cat.entity}
          inboxCat={cat.key}
          empty={status === "PENDING" ? `No pending ${cat.label.toLowerCase()} requests.` : `No ${cat.label.toLowerCase()} requests match these filters.`}
        />
      </section>
    </>
  );
}
