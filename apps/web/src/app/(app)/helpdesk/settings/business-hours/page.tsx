import Link from "next/link";
import { prisma } from "@keka/db";
import { helpdeskTime } from "@keka/services";
import { requireHelpdeskAgent } from "../../_ui/access";
import { HelpdeskTabs, SettingsTabs } from "../../_ui/tabs";
import { BusinessHoursForm, type HoursValue } from "../../_ui/settings-hours";
import s from "../../_ui/hd.module.css";

const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Mon–Fri 09:00–18:00", or "Round the clock" for an empty schedule. */
function summary(schedule: Array<{ day: number; from: string; to: string }>) {
  if (!schedule.length) return "Round the clock";
  return schedule.map((w) => `${SHORT[w.day - 1]} ${w.from}–${w.to}`).join(", ");
}

/**
 * Settings › Business Hours: the working calendars SLA targets count in.
 * The list on the left; the selected (or a new) one on the right, with the
 * categories that use it.
 */
export default async function BusinessHoursPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { viewer } = await requireHelpdeskAgent({ settings: true });
  const sp = await searchParams;
  const rows = await prisma.helpdeskBusinessHours.findMany({
    where: { tenantId: viewer.tenantId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    include: { categories: { select: { id: true, name: true, parentId: true }, orderBy: { name: "asc" } } },
  });
  const selected = sp.id === "new" ? null : rows.find((r) => r.id === sp.id) ?? rows[0] ?? null;
  const value: HoursValue = selected
    ? {
      id: selected.id, name: selected.name, description: selected.description, timezone: selected.timezone, observeHolidays: selected.observeHolidays, isDefault: selected.isDefault,
      schedule: helpdeskTime.parseSchedule(selected.schedule, selected.timezone).days,
    }
    : { id: null, name: "", description: null, timezone: "Asia/Kolkata", observeHolidays: true, isDefault: false, schedule: [] };
  const used = selected?.categories.filter((c) => !c.parentId) ?? [];

  return (
    <div className={s.page}>
      <HelpdeskTabs canSettings active="/helpdesk/settings/categories" />
      <SettingsTabs active="business-hours" />
      <div className={s.bhGrid}>
        <div className={s.bhList}>
          <div style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="text-sm muted">{rows.length} set{rows.length === 1 ? "" : "s"} of hours</span>
            <Link href="/helpdesk/settings/business-hours?id=new" className="btn primary sm">+ Add</Link>
          </div>
          {rows.map((r) => (
            <Link key={r.id} href={`/helpdesk/settings/business-hours?id=${r.id}`} className={`${s.bhItem}${r.id === selected?.id ? ` ${s.bhItemActive}` : ""}`}>
              <div className={s.bhItemTitle}>{r.name}{r.isDefault ? " · Default" : ""}</div>
              <div className={s.bhItemDesc}>{summary(helpdeskTime.parseSchedule(r.schedule, r.timezone).days)} · {r.timezone}</div>
            </Link>
          ))}
        </div>
        <div className="stack gap-4">
          <BusinessHoursForm key={value.id ?? "new"} value={value} />
          {selected ? (
            <div className={`${s.panel} ${s.panelPad}`}>
              <div className={s.fieldLabel}>Used in</div>
              {used.length ? (
                <div className={s.usedChips}>{used.map((c) => <span key={c.id} className={s.usedChip}>{c.name}</span>)}</div>
              ) : <div className="text-sm muted">No category uses these hours{selected.isDefault ? "; categories without their own hours fall back to them" : ""}.</div>}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
