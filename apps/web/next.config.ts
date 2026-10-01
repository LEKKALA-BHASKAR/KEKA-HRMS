import path from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// Next only reads .env from the app directory. This is a monorepo with a
// single root .env, so load it here before the config is evaluated.
loadEnv({ path: path.resolve(__dirname, "../../.env") });

const config: NextConfig = {
  // Workspace packages ship TypeScript source rather than build output, so
  // Next has to compile them alongside the app.
  transpilePackages: ["@keka/db", "@keka/payroll", "@keka/rbac", "@keka/services", "@keka/shared", "@keka/time", "@keka/documents"],
  experimental: {
    // Uploads are capped at 10 MB in lib/storage.ts; leave room for the form.
    serverActions: { bodySizeLimit: "11mb" },
    // Lets requireAuth() call forbidden(), which renders forbidden.tsx with a
    // real 403 instead of surfacing an authorisation failure as a 500.
    authInterrupts: true,
  },
  typescript: { ignoreBuildErrors: false },
  poweredByHeader: false,
  // The dev-only Next badge defaults to bottom-left, on top of the user menu.
  devIndicators: { position: "bottom-right" },
  async headers() {
    // Next inlines its bootstrap scripts, so script-src needs 'unsafe-inline'
    // until nonces are wired through; everything else is locked to self.
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; ");
    const headers = [
      { key: "Content-Security-Policy", value: csp },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
      ...(process.env.NODE_ENV === "production"
        ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
        : []),
    ];
    return [{ source: "/:path*", headers }];
  },
};

export default config;
