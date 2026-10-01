/**
 * A person's picture, or their initials on a colour picked from their name —
 * the same person always gets the same colour, on every page.
 */
const COLOURS = ["#4fc3a1", "#3d8fe6", "#8bc34a", "#ff9f1c", "#9b7ede", "#ef6f8f", "#36b8c9", "#e5735a", "#5c7cfa", "#26a69a"];

export function avatarColour(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

export function Avatar({ name, photoUrl, size = 32, ring, className }: { name: string; photoUrl?: string | null; size?: number; ring?: boolean; className?: string }) {
  const style = {
    width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)),
    background: photoUrl ? undefined : avatarColour(name),
    boxShadow: ring ? "0 0 0 2px rgba(255,255,255,.9)" : undefined,
  };
  return (
    <span className={`k-avatar${className ? ` ${className}` : ""}`} style={style} title={name} aria-hidden={!photoUrl}>
      {photoUrl ? <img src={photoUrl} alt={name} width={size} height={size} /> : initialsOf(name)}
    </span>
  );
}
