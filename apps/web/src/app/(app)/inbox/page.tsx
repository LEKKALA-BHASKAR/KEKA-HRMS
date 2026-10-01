import { Fragment } from "react";
import Link from "next/link";
import { requireViewer } from "@/lib/context";
import { IconCheck } from "@/components/icons";
import { EmptyState } from "@/components/keka";
import { CategoryPane, DetailEmpty, InboxFrame, ListPane, hrefFor, readNav, sortByDate } from "./_ui/panes";
import { matches } from "./_ui/format";
import { takeActionSources } from "./_take/registry";
import { BulkScope, BulkSwap } from "./_ui/bulk";

/**
 * Inbox → Take Action. Everything waiting on the viewer, by category, in
 * Keka's three panes. Each category's queue is scoped exactly as before:
 * only people in the viewer's approval line, never their own requests.
 */
export default async function TakeActionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireViewer();
  const nav = readNav("/inbox", await searchParams);

  const sources = await takeActionSources(viewer);
  const counts = await Promise.all(sources.map((src) => src.count()));
  const visible = sources.map((src, i) => ({ src, count: counts[i] })).filter((x) => x.src.always || x.count > 0);

  if (visible.length === 0) {
    return (
      <div className="k-panel">
        <EmptyState icon={<IconCheck />} title="Nothing to act on">
          Approvals and tasks routed to you — leave, attendance, timesheets, expenses and more — appear here.
        </EmptyState>
      </div>
    );
  }

  const active = visible.find((x) => x.src.key === nav.cat) ?? visible.find((x) => x.count > 0) ?? visible[0];
  const view = { ...nav, cat: active.src.key };

  const all = await active.src.list();
  const items = sortByDate(all.filter((it) => matches(nav.q, it.person?.name, it.heading, it.title, it.tag)), nav.sort);
  const selectedId = nav.id || items[0]?.id;
  const detail = selectedId ? await active.src.detail(selectedId) : null;

  let right;
  if (detail) {
    right = <Fragment key={selectedId}>{detail}</Fragment>;
  } else if (nav.id) {
    // The item was decided (or was never in this viewer's queue).
    const next = items.find((it) => it.id !== nav.id);
    right = (
      <DetailEmpty title="All done here" icon={<IconCheck />}>
        This one is no longer waiting on you — decided items move to your <Link href="/inbox/archive" className="strong">Archive</Link>.
        {next ? <div style={{ marginTop: 14 }}><Link className="btn sm primary" href={hrefFor(view, { id: next.id })} scroll={false}>Next: {next.person?.name ?? next.title}</Link></div> : null}
      </DetailEmpty>
    );
  } else {
    right = (
      <DetailEmpty title={nav.q ? "No matches" : "You're all caught up"} icon={<IconCheck />}>
        {nav.q ? "Try another name or task." : `Nothing in ${active.src.label.toLowerCase()} is waiting on you.`}
      </DetailEmpty>
    );
  }

  const categories = <CategoryPane heading="Pending tasks" nav={view}
    categories={visible.map((x) => ({ key: x.src.key, label: x.src.label, icon: x.src.icon, count: x.count, hot: x.count > 0 }))} />;
  const list = (
    <ListPane label={active.src.label} nav={view} items={items} activeId={detail ? selectedId : nav.id}
      empty={`Nothing in ${active.src.label.toLowerCase()} is waiting on you.`} selectable={!!active.src.bulk && items.length > 0} />
  );
  // Categories that support Approve all get Keka's checkboxes and bulk card.
  return active.src.bulk ? (
    <InboxFrame categories={categories}>
      <BulkScope entity={active.src.bulk.entity} noun={active.src.bulk.noun} ids={items.map((it) => it.id)}>
        {list}
        <BulkSwap>{right}</BulkSwap>
      </BulkScope>
    </InboxFrame>
  ) : (
    <InboxFrame categories={categories}>
      {list}
      {right}
    </InboxFrame>
  );
}
