import type { ReactNode } from "react";
import s from "./hd.module.css";

/**
 * Renders the Markdown subset the helpdesk editor writes — **bold**,
 * *italic*, ++underline++, [links](https://…), "- " and "1. " lists,
 * "> " quotes and "# " headings — as React elements. Never raw HTML, so a
 * message cannot inject markup; only http(s) and mailto links survive.
 */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|\+\+([^+]+)\+\+|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[2] !== undefined) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<u key={k}>{m[3]}</u>);
    else if (m[4] !== undefined) out.push(<em key={k}>{m[4]}</em>);
    else if (m[5] !== undefined) {
      const href = /^(https?:\/\/|mailto:)/i.test(m[6]) ? m[6] : null;
      out.push(href ? <a key={k} href={href} target="_blank" rel="noreferrer noopener" className={s.link}>{m[5]}</a> : `${m[5]} (${m[6]})`);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Rich({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0, b = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ""));
      blocks.push(<ul key={b++}>{items.map((t, j) => <li key={j}>{inline(t, `u${b}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(<ol key={b++}>{items.map((t, j) => <li key={j}>{inline(t, `o${b}-${j}`)}</li>)}</ol>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) items.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={b++}>{items.map((t, j) => <div key={j}>{inline(t, `q${b}-${j}`)}</div>)}</blockquote>);
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      blocks.push(<h4 key={b++}>{inline(line.replace(/^#{1,3}\s+/, ""), `h${b}`)}</h4>);
      i++;
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(\s*[-*•]\s+|\s*\d+[.)]\s+|>\s?|#{1,3}\s+)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={b++}>{para.map((t, j) => <span key={j}>{j ? <br /> : null}{inline(t, `p${b}-${j}`)}</span>)}</p>);
  }
  return <div className={s.rich}>{blocks}</div>;
}
