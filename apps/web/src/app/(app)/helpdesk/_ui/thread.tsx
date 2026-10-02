import { Attachments, Initials } from "./bits";
import { Rich } from "./rich";
import { threadTime } from "./format";
import s from "./hd.module.css";

export interface ThreadItem {
  id: string; authorLabel: string; authorUserId: string | null; body: string; isSystem: boolean; createdAt: Date;
  files: Array<{ id: string; filename: string }>;
}

/**
 * The conversation: the ticket's description first, then replies, with the
 * history lines ("Ticket status changed to …") between them. The viewer's
 * own side sits on the right. Internal notes never come through here.
 */
export function Thread({ opening, items, mineUserIds }: {
  opening: { authorLabel: string; body: string; createdAt: Date; files: Array<{ id: string; filename: string }>; mine: boolean };
  items: ThreadItem[];
  /** Messages by these users render on the right ("our side"). */
  mineUserIds: Set<string>;
}) {
  const msg = (key: string, who: string, body: string, at: Date, files: ThreadItem["files"], mine: boolean) => (
    <div key={key} className={`${s.msg}${mine ? ` ${s.msgMine}` : ""}`}>
      <div className={s.msgWho}><Initials name={who} size={28} /><span>{who}</span><span className={s.msgTime}>{threadTime(at)}</span></div>
      <div className={s.msgBody}><Rich text={body} /></div>
      <Attachments files={files} />
    </div>
  );
  return (
    <div className={s.thread}>
      {msg("opening", opening.authorLabel, opening.body, opening.createdAt, opening.files, opening.mine)}
      {items.map((c) => c.isSystem
        ? <div key={c.id} className={s.system}>{c.body} · {threadTime(c.createdAt)}</div>
        : msg(c.id, c.authorLabel, c.body, c.createdAt, c.files, !!c.authorUserId && mineUserIds.has(c.authorUserId)))}
    </div>
  );
}
