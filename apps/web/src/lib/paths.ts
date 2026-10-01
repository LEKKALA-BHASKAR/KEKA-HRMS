import "server-only";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The monorepo root: the nearest ancestor whose package.json declares workspaces. */
export function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try { if (JSON.parse(readFileSync(pkg, "utf8")).workspaces) return dir; } catch { /* keep walking */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}
