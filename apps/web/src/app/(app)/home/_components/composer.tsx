"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/forms";
import { createPostAction, createPollAction, givePraisePostAction, polishWallTextAction } from "@/app/actions/home-wall";
import { EmployeePicker, type PickPerson } from "./employee-picker";
import { Medal } from "./medal";
import { IconPostPen, IconPollBars, IconMedal, IconAt, IconImage, IconSmile, IconClip, IconInfo, IconWand } from "./icons";
import { IconTrash } from "@/components/icons";
import d from "../dash.module.css";

export type ComposerTab = "post" | "poll" | "praise";
export interface ComposerBadge { id: string; name: string; description: string | null; icon: string; color: string }

const EMPTY: ActionState = {};
const EMOJI = ["👍", "🎉", "👏", "🙌", "🔥", "💯", "😊", "😄", "🚀", "🎂", "❤️", "🙏", "✅", "⭐", "💡", "🏆"];

/**
 * The wall composer: Post · Poll · Praise. Collapsed it reads like Keka's
 * placeholder; a click opens the full form. `initial` comes from
 * ?compose=post|poll|praise so a quick action can open it directly.
 */
export function Composer({ tabs, initial, group, people, badges, projects, tomorrow, maxDate }: {
  tabs: ComposerTab[]; initial: ComposerTab | null; group: { id: string; label: string } | null;
  people: PickPerson[]; badges: ComposerBadge[]; projects: Array<{ id: string; name: string }>;
  tomorrow: string; maxDate: string;
}) {
  const [tab, setTab] = useState<ComposerTab>(initial && tabs.includes(initial) ? initial : tabs[0]);
  const [open, setOpen] = useState(!!initial && tabs.includes(initial));
  const [toast, setToast] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 3500); return () => window.clearTimeout(t); }, [toast]);
  if (!tabs.length) return null;

  const done = (msg: string) => { setOpen(false); setToast(msg); router.refresh(); };
  const placeholder = tab === "post" ? "Write your post here and mention your peers" : tab === "poll" ? "What this poll is about" : "Give praise from here";

  return (
    <section className={d.card} aria-label="Create on the wall">
      <div className={d.ctabs} role="tablist" aria-label="What to create">
        {tabs.map((t) => (
          <button
            key={t} type="button" role="tab" aria-selected={tab === t}
            className={`${d.ctab} ${t === "post" ? d.ctabPost : t === "poll" ? d.ctabPoll : d.ctabPraise}`}
            onClick={() => setTab(t)}
          >
            {t === "post" ? <IconPostPen /> : t === "poll" ? <IconPollBars /> : <IconMedal />}
            {t === "post" ? "Post" : t === "poll" ? "Poll" : "Praise"}
          </button>
        ))}
      </div>
      {!open ? (
        <button type="button" className={d.prompt} onClick={() => setOpen(true)}>{placeholder}</button>
      ) : tab === "post" ? (
        <PostForm key="post" people={people} group={group} onCancel={() => setOpen(false)} onDone={done} />
      ) : tab === "poll" ? (
        <PollForm key="poll" group={group} tomorrow={tomorrow} maxDate={maxDate} onCancel={() => setOpen(false)} onDone={done} />
      ) : (
        <PraiseForm key="praise" people={people} badges={badges} projects={projects} group={group} onCancel={() => setOpen(false)} onDone={done} />
      )}
      {toast ? (
        <div className={d.toast} role="status">
          <span className={d.toastBar} aria-hidden="true">✓</span>
          <span className={d.toastBody}><strong>Success!</strong>{toast}</span>
        </div>
      ) : null}
    </section>
  );
}

function Audience({ group }: { group: { id: string; label: string } | null }) {
  return (
    <>
      <label htmlFor="wall-audience">Posting to</label>
      <select id="wall-audience" name="audience" className="select" defaultValue="org">
        <option value="org">Organization</option>
        {group ? <option value={group.id}>{group.label}</option> : null}
      </select>
    </>
  );
}

function useDone(state: ActionState, onDone: (m: string) => void) {
  const seen = useRef(state);
  useEffect(() => {
    if (state !== seen.current && state.ok) onDone(state.message ?? "Done");
    seen.current = state;
  }, [state, onDone]);
}

/** Insert text at the caret of a textarea held in React state. */
function insertAt(el: HTMLTextAreaElement | null, value: string, text: string, replaceBefore = 0): { next: string; caret: number } {
  const at = el ? el.selectionStart : value.length;
  const end = el ? el.selectionEnd : value.length;
  const start = Math.max(0, at - replaceBefore);
  const next = value.slice(0, start) + text + value.slice(end);
  return { next, caret: start + text.length };
}

function TextWithTools({ name, value, setValue, placeholder, people, allowImage, maxLength }: {
  name: string; value: string; setValue: (v: string) => void; placeholder: string; people: PickPerson[]; allowImage?: boolean; maxLength: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<null | { typed: boolean }>(null);
  const [emoji, setEmoji] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const put = (text: string, replaceBefore = 0) => {
    const { next, caret } = insertAt(ref.current, value, text, replaceBefore);
    setValue(next.slice(0, maxLength));
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(caret, caret); });
  };
  return (
    <>
      <textarea
        ref={ref} name={name} className={d.bare} placeholder={placeholder} value={value} maxLength={maxLength} autoFocus
        aria-label={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          if (v.length > value.length && v[e.target.selectionStart - 1] === "@") setMention({ typed: true });
        }}
      />
      {mention ? (
        <div>
          <EmployeePicker people={people} autoFocus placeholder="Mention a colleague" onPick={(p) => { put(`@[${p.name}](${p.id}) `, mention.typed ? 1 : 0); setMention(null); }} />
          <button type="button" className={d.linkBtn} onClick={() => setMention(null)}>Cancel mention</button>
        </div>
      ) : null}
      {emoji ? (
        <div role="group" aria-label="Emoji" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {EMOJI.map((e) => <button key={e} type="button" className={d.roundBtn} aria-label={`Insert ${e}`} onClick={() => { put(e); setEmoji(false); }}>{e}</button>)}
        </div>
      ) : null}
      <div className={d.iconRow}>
        <button type="button" className={d.roundBtn} aria-label="Mention someone" title="Mention someone" onClick={() => setMention({ typed: false })}><IconAt /></button>
        {allowImage ? (
          <label className={d.roundBtn} title="Add an image" aria-label="Add an image">
            <IconImage />
            <input type="file" name="image" accept="image/png,image/jpeg" hidden onChange={(e) => setImage(e.target.files?.[0]?.name ?? null)} />
          </label>
        ) : null}
        <button type="button" className={d.roundBtn} aria-label="Add an emoji" title="Add an emoji" onClick={() => setEmoji((x) => !x)}><IconSmile /></button>
        {image ? <span className="text-xs muted">{image}</span> : null}
      </div>
    </>
  );
}

function HelpMeWrite({ text, setText, kind, badge, names }: { text: string; setText: (v: string) => void; kind: "POST" | "PRAISE"; badge?: string; names?: string }) {
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, start] = useTransition();
  const suggestion = state.ok ? state.values?.text : null;
  return (
    <div className={d.aiRow}>
      <button
        type="button" className={d.aiBtn} disabled={pending || text.trim().length < 3}
        onClick={() => start(async () => {
          const f = new FormData();
          f.set("draft", text); f.set("kind", kind); if (badge) f.set("badge", badge); if (names) f.set("names", names);
          setState(await polishWallTextAction(EMPTY, f));
        })}
      >
        <IconWand /> {pending ? "Writing…" : "Help me write"}
      </button>
      {state.ok === false && state.message ? <span className={d.err} role="alert">{state.message}</span> : null}
      {suggestion ? (
        <div style={{ width: "100%" }}>
          <div className={d.aiSuggest}>{suggestion}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
            <button type="button" className="btn sm primary" onClick={() => { setText(suggestion); setState(EMPTY); }}>Use this</button>
            <button type="button" className="btn sm" onClick={() => setState(EMPTY)}>Discard</button>
            <span className="text-xs subtle">Generated by AI · check it before you post</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PostForm({ people, group, onCancel, onDone }: { people: PickPerson[]; group: { id: string; label: string } | null; onCancel: () => void; onDone: (m: string) => void }) {
  const [state, action, pending] = useActionState(createPostAction, EMPTY);
  const [body, setBody] = useState("");
  useDone(state, onDone);
  return (
    <form action={action}>
      <div className={d.cbody}>
        <TextWithTools name="body" value={body} setValue={setBody} placeholder="Write your post here and mention your peers" people={people} allowImage maxLength={3000} />
        <HelpMeWrite text={body} setText={setBody} kind="POST" />
        {state.ok === false && state.message ? <div className={d.err} role="alert">{state.message}</div> : null}
      </div>
      <div className={d.cfoot}>
        <Audience group={group} />
        <div className={d.cfootRight}>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={pending || !body.trim()}>{pending ? "Posting…" : "Post"}</button>
        </div>
      </div>
    </form>
  );
}

function PollForm({ group, tomorrow, maxDate, onCancel, onDone }: { group: { id: string; label: string } | null; tomorrow: string; maxDate: string; onCancel: () => void; onDone: (m: string) => void }) {
  const [state, action, pending] = useActionState(createPollAction, EMPTY);
  const [options, setOptions] = useState(["", "", ""]);
  const [question, setQuestion] = useState("");
  useDone(state, onDone);
  const err = state.errors ?? {};
  return (
    <form action={action}>
      <div className={d.cbody}>
        <input name="question" className={d.underline} placeholder="What this poll is about" aria-label="What this poll is about" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} autoFocus />
        {options.map((o, i) => (
          <div key={i} className={d.optRow}>
            <input name="option" className="input" placeholder="Add option here" aria-label={`Option ${i + 1}`} value={o} maxLength={120}
              onChange={(e) => setOptions((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />
            <button type="button" className={d.trash} aria-label={`Remove option ${i + 1}`} disabled={options.length <= 2}
              onClick={() => setOptions((x) => x.filter((_, j) => j !== i))}><IconTrash width={18} height={18} /></button>
          </div>
        ))}
        {options.length < 10 ? <button type="button" className={d.addOpt} onClick={() => setOptions((x) => [...x, ""])}>+Add Option</button> : null}
        {err.option ? <div className={d.err}>{err.option}</div> : null}
        <div className={d.pollMeta}>
          <label>Poll Expires on <input type="date" name="expiresOn" className="input" style={{ width: 160 }} min={tomorrow} max={maxDate} required aria-label="Poll expires on" /></label>
          <label><input type="checkbox" name="notify" /> Notify employees</label>
          <label title="Identity of the voters will be hidden"><input type="checkbox" name="anonymous" /> Anonymous poll</label>
        </div>
        {err.expiresOn ? <div className={d.err}>{err.expiresOn}</div> : null}
        {state.ok === false && state.message && !err.option && !err.expiresOn ? <div className={d.err} role="alert">{state.message}</div> : null}
      </div>
      <div className={d.cfoot}>
        <Audience group={group} />
        <div className={d.cfootRight}>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={pending || !question.trim()}>{pending ? "Posting…" : "Post"}</button>
        </div>
      </div>
    </form>
  );
}

function PraiseForm({ people, badges, projects, group, onCancel, onDone }: {
  people: PickPerson[]; badges: ComposerBadge[]; projects: Array<{ id: string; name: string }>; group: { id: string; label: string } | null;
  onCancel: () => void; onDone: (m: string) => void;
}) {
  const [state, action, pending] = useActionState(givePraisePostAction, EMPTY);
  const [message, setMessage] = useState("");
  const [badge, setBadge] = useState<ComposerBadge | null>(null);
  const [picking, setPicking] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  useDone(state, onDone);
  const recount = () => setCount(formRef.current ? new FormData(formRef.current).getAll("toEmployeeId").length : 0);
  const names = () => {
    if (!formRef.current) return "";
    const ids = new FormData(formRef.current).getAll("toEmployeeId").map(String);
    return people.filter((p) => ids.includes(p.id)).map((p) => p.name).join(", ");
  };
  return (
    <form ref={formRef} action={action} onInput={recount} onClick={() => window.setTimeout(recount, 0)}>
      <div className={d.cbody}>
        <EmployeePicker people={people} name="toEmployeeId" multiple max={10} autoFocus />
        <textarea name="message" className={d.bare} style={{ minHeight: 90 }} placeholder="What did the employee do to deserve the praise" aria-label="What did the employee do to deserve the praise"
          value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
        <HelpMeWrite text={message} setText={setMessage} kind="PRAISE" badge={badge?.name} names={names()} />
        <div className={d.badgeTile}>
          <span className={d.badgeBox}>{badge ? <Medal color={badge.color} icon={badge.icon} size={40} /> : <Medal color="#c9ced8" icon="star" size={40} />}</span>
          <button type="button" className={d.badgeLink} aria-expanded={picking} onClick={() => setPicking((x) => !x)}>{badge ? badge.name : "Select badge"}</button>
          {badge ? <button type="button" className={d.linkBtn} onClick={() => setBadge(null)}>Clear</button> : null}
          <input type="hidden" name="badgeId" value={badge?.id ?? ""} />
        </div>
        {picking ? (
          <div className={d.badgeGrid} role="group" aria-label="Badges">
            {badges.map((b) => (
              <button key={b.id} type="button" className={d.badgeChoice} aria-pressed={badge?.id === b.id} title={b.description ?? b.name}
                onClick={() => { setBadge(b); setPicking(false); }}>
                <Medal color={b.color} icon={b.icon} size={44} />
                <span>{b.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        <label className="label" htmlFor="praise-project" style={{ marginBottom: -6 }}>Projects (optional)</label>
        <select id="praise-project" name="projectId" className="select" defaultValue="">
          <option value="">Select project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className={d.attachRow}>
          <label>
            <IconClip width={16} height={16} /> Add Attachment
            <input type="file" name="attachment" multiple accept="application/pdf,image/png,image/jpeg" hidden
              onChange={(e) => setFiles(Array.from(e.target.files ?? []).map((f) => f.name))} />
            <span title="PDF, PNG or JPEG, up to 10 MB each"><IconInfo width={15} height={15} /></span>
          </label>
          <small>Max number of files allowed is 5</small>
          {files.length ? <small>{files.join(", ")}{files.length > 5 ? " — too many" : ""}</small> : null}
        </div>
        {state.ok === false && state.message ? <div className={d.err} role="alert">{state.message}</div> : null}
      </div>
      <div className={d.cfoot}>
        <Audience group={group} />
        <div className={d.cfootRight}>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={pending || !message.trim() || count === 0 || files.length > 5}>{pending ? "Posting…" : "Post"}</button>
        </div>
      </div>
    </form>
  );
}
