import type { Provider } from "../_lib/providers";
import { IconExternal } from "./icons";
import s from "../finances.module.css";

/** One service on Tax Filing or Tax Saving Investment: a wordmark, an outbound button and what it does. */
export function ProviderCard({ p }: { p: Provider }) {
  return (
    <section className={`${s.boxed} ${s.providerCard}`} aria-label={p.name}>
      <div className={s.providerHead}>
        <div>
          <div className={s.providerName}>{p.name}</div>
          {p.tagline ? <div className={s.muted} style={{ fontSize: 13 }}>{p.tagline}</div> : null}
        </div>
        <a className="btn primary" href={p.url} target="_blank" rel="noopener noreferrer">{p.action} <IconExternal width={16} height={16} /></a>
      </div>
      <ul className={s.providerPoints}>
        {p.points.map((t) => <li key={t}>{t}</li>)}
      </ul>
    </section>
  );
}
