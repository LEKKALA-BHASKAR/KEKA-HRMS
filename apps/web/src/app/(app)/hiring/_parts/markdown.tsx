import type { ReactNode } from "react";

/**
 * The small Markdown the job-description editor writes — **bold**, *italic*,
 * bullet and numbered lists, [links](https://…) and "**Heading:**" lines —
 * rendered as React elements. No HTML is ever injected, so a description
 * cannot carry markup or script.
 */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("*")) out.push(<em key={`${key}-${i++}`}>{t.slice(1, -1)}</em>);
    else {
      const label = t.slice(1, t.indexOf("]"));
      out.push(<a key={`${key}-${i++}`} href={m[2]} target="_blank" rel="noreferrer noopener" style={{ color: "var(--brand-600)" }}>{label}</a>);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text?.trim()) return <p className="subtle">Not available</p>;
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const k = `l${blocks.length}`;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, `${k}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
    list = null;
  };
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
      list.items.push((bullet ?? numbered)![1]);
      return;
    }
    flush();
    if (!line) return;
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) { blocks.push(<h4 key={`h${idx}`}>{inline(heading[1], `h${idx}`)}</h4>); return; }
    blocks.push(<p key={`p${idx}`}>{inline(line, `p${idx}`)}</p>);
  });
  flush();
  return <div className={className}>{blocks}</div>;
}
