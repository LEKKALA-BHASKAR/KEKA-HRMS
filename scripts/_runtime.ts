/**
 * Lets a plain Node process load the web app's server modules: stubs the
 * bundler-only `server-only` marker and CSS imports, and resolves the "@/" path alias.
 * Imported first by scripts/jobs.ts and, via the test bootstrap, by tests.
 */
import path from "node:path";
import Module from "node:module";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../.env") });

const WEB_SRC = path.resolve(__dirname, "../apps/web/src");
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internal = Module as unknown as { _load: Loader };
const original = internal._load;
let extra: ((request: string) => unknown) | null = null;

/** Let the test bootstrap substitute further modules, such as next/headers. */
export function interceptModule(fn: (request: string) => unknown): void { extra = fn; }

internal._load = function patched(request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only" || request === "client-only") return {};
  // CSS modules: class names resolve to their own keys, so pages can render.
  // Not an ES module, so a default import receives the proxy itself.
  if (request.endsWith(".css")) return new Proxy({}, { get: (_t, k) => (typeof k === "string" && k !== "__esModule" ? k : undefined) });
  const sub = extra?.(request);
  if (sub !== undefined) return sub;
  if (request.startsWith("@/")) return original.call(this, path.join(WEB_SRC, request.slice(2)), parent, isMain);
  return original.call(this, request, parent, isMain);
} as Loader;
