"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import type { ActionState } from "@/lib/forms";
import { toggleLikeAction, addCommentAction, deleteCommentAction, deletePostAction, votePollAction } from "@/app/actions/home-wall";
import type { PostDto, CommentDto, PersonDto } from "../_lib/wall";
import type { MentionSegment } from "@keka/services/src/home-wall";
import { Medal } from "./medal";
import { IconThumbUp, IconComment, IconKebab } from "./icons";
import d from "../dash.module.css";

const EMPTY: ActionState = {};
const fd = (v: Record<string, string>) => { const f = new FormData(); for (const [k, x] of Object.entries(v)) f.set(k, x); return f; };

/** Text with mentions linked to the person's profile. */
export function Segments({ segments }: { segments: MentionSegment[] }) {
  return (
    <>
      {segments.map((s, i) => ("id" in s
        ? <Link key={i} href={`/directory/${s.id}`} className={d.mention}>@{s.name}</Link>
        : <span key={i}>{s.text}</span>))}
    </>
  );
}

/** "6 days ago", "just now" — relative to the viewer's clock, rendered after hydration. */
export function Ago({ iso }: { iso: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); }, []);
  const t = new Date(iso);
  const abs = t.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
  if (now === null) return <time dateTime={iso} title={abs}>{abs}</time>;
  const s = Math.max(0, Math.round((now - t.getTime()) / 1000));
  const label = s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86_400 ? `${Math.floor(s / 3600)} hour${s < 7200 ? "" : "s"} ago`
    : s < 30 * 86_400 ? `${Math.floor(s / 86_400)} day${s < 2 * 86_400 ? "" : "s"} ago` : abs.split(",")[0];
  return <time dateTime={iso} title={abs}>{label}</time>;
}

function PersonLink({ p }: { p: PersonDto }) {
  return <Link href={`/directory/${p.id}`}>{p.name}</Link>;
}

function Kebab({ items }: { items: Array<{ label: string; onClick: () => void; danger?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  if (!items.length) return null;
  return (
    <div className={d.kebab} ref={ref}>
      <button type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><IconKebab /></button>
      {open ? (
        <div className={d.menu} role="menu">
          {items.map((i) => <button key={i.label} type="button" role="menuitem" style={i.danger ? { color: "var(--danger)" } : undefined} onClick={() => { setOpen(false); i.onClick(); }}>{i.label}</button>)}
        </div>
      ) : null}
    </div>
  );
}

/** Like toggle with an optimistic count. */
export function LikeButton({ target, id, liked, count, disabled }: { target: "post" | "announcement"; id: string; liked: boolean; count: number; disabled?: boolean }) {
  const [state, setState] = useState({ liked, count });
  const [pending, start] = useTransition();
  const router = useRouter();
  useEffect(() => { setState({ liked, count }); }, [liked, count]);
  return (
    <button
      type="button" className={d.stat} aria-pressed={state.liked} disabled={disabled || pending}
      aria-label={`${state.liked ? "Unlike" : "Like"} · ${state.count} like${state.count === 1 ? "" : "s"}`}
      onClick={() => {
        setState((s) => ({ liked: !s.liked, count: s.count + (s.liked ? -1 : 1) }));
        start(async () => {
          const r = await toggleLikeAction(EMPTY, fd({ target, id }));
          if (r.ok === false) setState({ liked, count });
          router.refresh();
        });
      }}
    >
      <IconThumbUp /> {state.count}
    </button>
  );
}

/** The comment thread and the "Press ENTER to submit" box. */
export function Comments({ target, id, comments, total, canComment, expanded, morePath }: {
  target: "post" | "announcement"; id: string; comments: CommentDto[]; total: number; canComment: boolean; expanded?: boolean; morePath?: string;
}) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const submit = () => {
    const body = text.trim();
    if (!body) return;
    start(async () => {
      const r = await addCommentAction(EMPTY, fd({ target, id, body }));
      if (r.ok) { setText(""); setMsg(null); } else setMsg(r.message ?? "Could not add your comment.");
      router.refresh();
    });
  };
  const remove = (commentId: string) => start(async () => {
    const r = await deleteCommentAction(EMPTY, fd({ commentId }));
    setMsg(r.ok ? null : r.message ?? null);
    router.refresh();
  });
  return (
    <div className={d.comments}>
      {total === 0 && canComment ? <span className={d.firstComment}>Be the first person to comment</span> : null}
      {!expanded && total > comments.length && morePath ? <Link href={morePath} className={d.linkBtn}>View all {total} comments</Link> : null}
      {comments.map((c) => (
        <div key={c.id} className={d.comment}>
          <Avatar name={c.author.name} photoUrl={c.author.photoUrl} size={30} />
          <div className={d.commentBubble}>
            <PersonLink p={c.author} />
            <div className={d.commentText}><Segments segments={c.segments} /></div>
            <div className={d.commentMeta}>
              <Ago iso={c.at} />
              {c.canDelete ? <button type="button" className={`${d.linkBtn} ${d.danger}`} onClick={() => remove(c.id)} disabled={pending}>Delete</button> : null}
            </div>
          </div>
        </div>
      ))}
      {canComment ? (
        <form className={d.commentForm} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input
            value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} disabled={pending}
            placeholder="Write your comment here... Press ENTER to submit" aria-label="Write a comment"
          />
        </form>
      ) : null}
      {msg ? <div className={d.err} role="alert">{msg}</div> : null}
    </div>
  );
}

function PollBody({ post }: { post: PostDto }) {
  const poll = post.poll!;
  const [changing, setChanging] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const showResults = poll.closed || (!!poll.mine && !changing);
  const vote = (optionId: string) => start(async () => {
    const r = await votePollAction(EMPTY, fd({ postId: post.id, optionId }));
    setMsg(r.ok ? null : r.message ?? null);
    setChanging(false);
    router.refresh();
  });
  const expires = poll.expiresAt ? new Date(poll.expiresAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }) : null;
  return (
    <>
      <div className={d.pollTitle}><Segments segments={post.segments} /></div>
      <div className={d.pollBox} role="group" aria-label="Poll options">
        {poll.rows.map((r) => showResults ? (
          <div key={r.id} className={`${d.bar}${poll.mine === r.id ? ` ${d.mine}` : ""}`} title={r.voters?.length ? r.voters.join(", ") : undefined}>
            <span className={d.barFill} style={{ width: `${r.pct}%` }} aria-hidden="true" />
            <span>{poll.mine === r.id ? "✓ " : ""}{r.label}</span>
            <span className={d.barCount}>{r.pct}% · {r.count}</span>
          </div>
        ) : (
          <button key={r.id} type="button" className={d.pollOpt} onClick={() => vote(r.id)} disabled={pending}>
            <span className={d.radio} aria-hidden="true" /> {r.label}
          </button>
        ))}
        <div className={d.pollFoot}>
          <span>{poll.total} vote{poll.total === 1 ? "" : "s"}</span>
          <span>·</span>
          <span>{poll.closed ? "Poll closed" : expires ? `Expires on ${expires}` : "No expiry"}</span>
          {poll.anonymous ? <><span>·</span><span>Anonymous poll</span></> : null}
          {poll.mine && !poll.closed && !changing ? <button type="button" className={d.changeVote} onClick={() => setChanging(true)}>Change vote</button> : null}
        </div>
        {msg ? <div className={d.err} role="alert">{msg}</div> : null}
      </div>
    </>
  );
}

const VERB = { POST: "created a post", POLL: "created a poll", PRAISE: "praised", WISH: "wished" } as const;

export function PostCard({ post, expanded }: { post: PostDto; expanded?: boolean }) {
  const router = useRouter();
  const [gone, setGone] = useState(false);
  const [, start] = useTransition();
  if (gone) return null;
  const copy = () => { void navigator.clipboard?.writeText(`${window.location.origin}/wall/${post.id}`); };
  const del = () => {
    if (!confirm("Delete this from the wall?")) return;
    start(async () => {
      const r = await deletePostAction(EMPTY, fd({ postId: post.id }));
      if (r.ok) setGone(true); else alert(r.message);
      router.refresh();
    });
  };
  const occasion = post.wish?.occasion === "BIRTHDAY" ? "a happy birthday" : post.wish?.occasion === "WORK_ANNIVERSARY" ? "a happy work anniversary" : "a warm welcome";
  return (
    <article className={`${d.card} ${d.post}`} aria-label={`${post.author.name} ${VERB[post.kind]}`}>
      <header className={d.postHead}>
        <Avatar name={post.author.name} photoUrl={post.author.photoUrl} size={42} />
        <div className={d.postWho}>
          <PersonLink p={post.author} />{" "}
          {post.kind === "PRAISE" && post.praise ? (
            <><span className={d.verb}>praised</span>{" "}{post.praise.recipients.map((r, i) => <span key={r.id}>{i ? ", " : ""}<PersonLink p={r} /></span>)}</>
          ) : post.kind === "WISH" && post.wish ? (
            <><span className={d.verb}>wished</span> <PersonLink p={post.wish.for} /> <span className={d.verb}>{occasion}</span></>
          ) : <span className={d.verb}>{VERB[post.kind]}</span>}
          {post.group ? <span className={d.groupTag}>{post.group}</span> : null}
          <span className={d.when}><Link href={`/wall/${post.id}`}><Ago iso={post.createdAt} /></Link></span>
        </div>
        <Kebab items={[
          { label: "Copy link", onClick: copy },
          ...(post.canDelete ? [{ label: "Delete", onClick: del, danger: true }] : []),
        ]} />
      </header>

      {post.kind === "POLL" && post.poll ? <PollBody post={post} /> : null}
      {post.kind === "PRAISE" && post.praise ? (
        <div className={d.praiseBand}>
          {post.praise.badge ? <Medal color={post.praise.badge.color} icon={post.praise.badge.icon} size={52} label={post.praise.badge.name} /> : null}
          <div style={{ minWidth: 0 }}>
            {post.praise.badge ? <strong>{post.praise.badge.name}</strong> : <strong>Praise</strong>}
            {post.praise.badge?.description ? <div className={d.praiseBadgeName}>{post.praise.badge.description}</div> : null}
            {post.praise.project ? <span className={d.projChip}>{post.praise.project}</span> : null}
          </div>
        </div>
      ) : null}
      {post.kind !== "POLL" ? <div className={d.postBody}><Segments segments={post.segments} /></div> : null}
      {post.imageUrl ? <img src={post.imageUrl} alt="" className={d.postImg} /> : null}
      {post.praise?.attachments.length ? (
        <div className={d.files}>{post.praise.attachments.map((a) => <a key={a.id} href={`/wall/files/${a.id}`}>{a.name}</a>)}</div>
      ) : null}

      <div className={d.postFoot}>
        <LikeButton target="post" id={post.id} liked={post.likedByMe} count={post.likes} />
        <span className={d.sep} aria-hidden="true" />
        <span className={d.stat}><IconComment /> {post.commentCount}</span>
      </div>
      <Comments target="post" id={post.id} comments={post.comments} total={post.commentCount} canComment={post.canComment} expanded={expanded} morePath={`/wall/${post.id}`} />
    </article>
  );
}

/** The feed, newest first; "Load more" asks the server for a longer page. */
export function Feed({ posts, next, moreHref, empty }: { posts: PostDto[]; next: string | null; moreHref: string | null; empty: string }) {
  return (
    <>
      {posts.length === 0 ? <div className={`${d.card} ${d.feedEmpty}`}>{empty}</div> : posts.map((p) => <PostCard key={p.id} post={p} />)}
      {next && moreHref ? <Link href={moreHref} className={`btn ${d.loadMore}`} scroll={false}>Load more</Link> : null}
    </>
  );
}
