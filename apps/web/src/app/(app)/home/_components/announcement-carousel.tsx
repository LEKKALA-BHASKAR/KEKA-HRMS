"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acknowledgeAnnouncement } from "@/app/actions/workplace";
import type { AnnouncementSlide } from "../_lib/wall";
import { LikeButton } from "./feed";
import { AnnouncementArt } from "./announcement-art";
import { IconComment, IconUserCheck, IconEyeOpen, IconChevronLeft, IconChevronRight, IconKebab } from "./icons";
import { IconPlus } from "@/components/icons";
import d from "../dash.module.css";

/**
 * Keka's Announcements card: one announcement at a time with dots and side
 * arrows, its picture, title and excerpt, then likes · comments · acknowledged
 * and an Acknowledge button while the viewer still owes one.
 */
export function AnnouncementCarousel({ slides, canManage, canAct }: { slides: AnnouncementSlide[]; canManage: boolean; canAct: boolean }) {
  const [i, setI] = useState(0);
  const [menu, setMenu] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const n = slides.length;
  const s = slides[Math.min(i, Math.max(0, n - 1))];

  return (
    <section className={d.card} aria-labelledby="ann-title">
      <div className={d.annHead}>
        <h3 id="ann-title">Announcements</h3>
        {n > 1 ? (
          <div className={d.dots} role="tablist" aria-label="Choose an announcement">
            {slides.map((x, k) => <button key={x.id} type="button" role="tab" aria-selected={k === i} aria-current={k === i} aria-label={x.title} onClick={() => setI(k)} />)}
          </div>
        ) : null}
        {n > 0 ? <Link href="/announcements" className={d.annMore} title="View all announcements"><IconEyeOpen /> View more</Link> : <span style={{ marginLeft: "auto" }} />}
        {canManage ? <Link href="/announcements?new=1" className={d.plus} aria-label="New announcement" title="New announcement"><IconPlus width={16} height={16} /></Link> : null}
      </div>
      {!s ? <div style={{ height: 16 }} /> : (
        <>
          <div
            className={d.slideWrap}
            role="group" aria-roledescription="carousel"
            onKeyDown={(e) => { if (e.key === "ArrowLeft" && i > 0) setI(i - 1); if (e.key === "ArrowRight" && i < n - 1) setI(i + 1); }}
          >
            <div className={d.slide} aria-live="polite">
              <div className={d.annArt}>{s.bannerUrl ? <img src={s.bannerUrl} alt="" /> : <AnnouncementArt />}</div>
              <div style={{ minWidth: 0 }}>
                <h4 className={d.annTitle}><Link href={`/announcements/${s.id}`}>{s.title}</Link></h4>
                <div className={d.annExcerpt}>{s.excerpt}</div>
                <Link href={`/announcements/${s.id}`} className={d.viewMore}>view more</Link>
              </div>
            </div>
            {i > 0 ? <button type="button" className={`${d.sideNav} ${d.sidePrev}`} onClick={() => setI(i - 1)} aria-label="Previous announcement"><IconChevronLeft /></button> : null}
            {i < n - 1 ? <button type="button" className={`${d.sideNav} ${d.sideNext}`} onClick={() => setI(i + 1)} aria-label="Next announcement"><IconChevronRight /></button> : null}
          </div>
          <div className={d.annFoot}>
            <LikeButton target="announcement" id={s.id} liked={s.likedByMe} count={s.likes} disabled={!canAct} />
            <span className={d.sep} aria-hidden="true" />
            <Link href={`/announcements/${s.id}`} className={d.stat} aria-label={`${s.comments} comments`}><IconComment /> {s.comments}</Link>
            {s.requireAck ? (
              <>
                <span className={d.sep} aria-hidden="true" />
                <span className={d.stat} title="Acknowledged" aria-label={`${s.acks} acknowledged`}><IconUserCheck /> {s.acks}</span>
              </>
            ) : null}
            <div className={d.footRight}>
              {s.requireAck && !s.acknowledged && canAct ? (
                <button
                  type="button" className="btn primary sm" disabled={pending}
                  onClick={() => start(async () => {
                    const f = new FormData(); f.set("announcementId", s.id);
                    try { await acknowledgeAnnouncement(f); setMsg("Acknowledged."); } catch (e) { setMsg(e instanceof Error ? e.message : "Could not acknowledge."); }
                    router.refresh();
                  })}
                >{pending ? "Saving…" : "Acknowledge"}</button>
              ) : s.requireAck && s.acknowledged ? <span className="text-xs muted">Acknowledged</span> : null}
              <div className={d.kebab}>
                <button type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><IconKebab /></button>
                {menu ? (
                  <div className={d.menu} role="menu">
                    <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/announcements/${s.id}`); setMenu(false); }}>Copy link</button>
                    <Link role="menuitem" href={`/announcements/${s.id}`}>Open</Link>
                    {canManage ? <Link role="menuitem" href="/announcements">Manage announcements</Link> : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          {msg ? <div className={d.ok} role="status" style={{ padding: "0 22px 12px" }}>{msg}</div> : null}
        </>
      )}
    </section>
  );
}
