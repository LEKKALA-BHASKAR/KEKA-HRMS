/**
 * A praise badge medallion: a coloured disc on a ribbon with a small glyph.
 * Our own drawing (no Keka art); the colour and glyph come from PraiseBadge.
 */
const GLYPHS: Record<string, string> = {
  star: "m12 7.2 1.5 3 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5z",
  check: "m8.5 12.3 2.4 2.4 4.6-4.9",
  people: "M9.6 11.2a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8zm4.8 0a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8zM6.8 16.4a2.8 2.8 0 0 1 5.6 0m-.8 0a2.8 2.8 0 0 1 5.6 0",
  bolt: "M12.8 6.8 9.4 12.6h2.9l-1 4.6 3.4-5.8h-2.9z",
  heart: "M12 16.2s-4-2.5-4-5a2.1 2.1 0 0 1 4-1 2.1 2.1 0 0 1 4 1c0 2.5-4 5-4 5z",
  hand: "M10 16.5v-6m0 0V8.2a1 1 0 0 1 2 0v2.3m0-1.5a1 1 0 0 1 2 0v1.5m0-.5a1 1 0 0 1 2 0v2.6a4 4 0 0 1-4 4h-.6a3 3 0 0 1-2.4-1.2l-1.4-2a1 1 0 0 1 1.6-1.2l.8 1",
  bulb: "M10.3 15.2h3.4M10.8 17h2.4M12 7.2a3.4 3.4 0 0 0-2 6.1v1.1h4v-1.1a3.4 3.4 0 0 0-2-6.1z",
  rocket: "M12 6.8c2 1.4 2.8 3.6 2.4 6.2H9.6c-.4-2.6.4-4.8 2.4-6.2zM9.6 13l-1.4 1.8 1.6.4M14.4 13l1.4 1.8-1.6.4M11 16.4h2",
};

export function Medal({ color, icon, size = 44, label }: { color: string; icon: string; size?: number; label?: string }) {
  const glyph = GLYPHS[icon] ?? GLYPHS.star;
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 24 27.6" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d="M8 18.5 6.4 26l3.1-1.6L12 26.4l2.5-2 3.1 1.6L16 18.5z" fill={color} opacity=".55" />
      <circle cx="12" cy="11.8" r="9" fill={color} />
      <circle cx="12" cy="11.8" r="6.9" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth=".9" />
      <path d={glyph} fill={icon === "star" || icon === "bolt" || icon === "heart" ? "#fff" : "none"} stroke="#fff" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const BADGE_ICONS = Object.keys(GLYPHS);
