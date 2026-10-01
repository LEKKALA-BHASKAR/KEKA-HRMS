import { Fragment } from "react";
import { requireViewer } from "@/lib/context";
import { CategoryPane, DetailEmpty, InboxFrame, ListPane, readNav, sortByDate } from "../_ui/panes";
import { matches } from "../_ui/format";
import { archiveSources } from "../_archive/sources";
import { IconSend } from "../_ui/icons";

/**
 * Inbox → Archive. The last three months of finished work: journey tasks
 * done or skipped, documents verified or rejected, decisions the viewer
 * made and the viewer's own requests once decided — each with its history.
 */
export default async function ArchivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireViewer();
  const nav = readNav("/inbox/archive", await searchParams);
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - 3);

  const sources = await archiveSources(viewer, since);
  const active = sources.find((src) => src.key === nav.cat) ?? sources[0];
  const view = { ...nav, cat: active.key };

  const items = sortByDate((await active.list()).filter((it) => matches(nav.q, it.person?.name, it.title, it.tag)), nav.sort);
  const selectedId = nav.id || items[0]?.id;
  const detail = selectedId ? await active.detail(selectedId) : null;

  return (
    <InboxFrame categories={<CategoryPane heading="Archive - last 3 months" nav={view}
      categories={sources.map((src) => ({ key: src.key, label: src.label, icon: src.icon }))} />}>
      <ListPane label={active.label} nav={view} items={items} activeId={detail ? selectedId : undefined}
        empty={`Nothing in ${active.label.toLowerCase()} from the last three months.`} />
      {detail ? <Fragment key={selectedId}>{detail}</Fragment> : (
        <DetailEmpty title={nav.id ? "Not in your archive" : "Nothing archived yet"} icon={<IconSend />}>
          {nav.id ? "This item is older than three months, or isn't yours to see." : "Finished items from the last three months show up here."}
        </DetailEmpty>
      )}
    </InboxFrame>
  );
}
