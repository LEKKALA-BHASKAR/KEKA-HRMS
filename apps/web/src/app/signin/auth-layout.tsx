import type { ReactNode } from "react";
import { SunsetScene } from "./scene";
import s from "./auth.module.css";

/**
 * The frame every sign-in screen shares: a scenic panel on the left and a
 * white panel on the right holding the form, with the wordmark at its foot.
 */
export function AuthLayout({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className={s.page}>
      <div className={s.scene} aria-hidden="true">
        <SunsetScene className={s.sceneSvg} />
      </div>
      <main className={s.panel}>
        <div className={s.panelInner}>
          <h1 className={s.title}>{title}</h1>
          {subtitle ? <p className={s.subtitle}>{subtitle}</p> : null}
          {children}
        </div>
        <footer className={s.footer}>
          <span className={s.wordmark} aria-label="BooS-HR">BooS-HR</span>
          <span className={s.footerText}>HR &amp; Payroll for your whole organisation.</span>
        </footer>
      </main>
    </div>
  );
}
