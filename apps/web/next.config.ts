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
      // Course videos: YouTube's privacy-enhanced player only.
      // ...and this app's own files (the inline résumé preview on a candidate).
      "frame-src 'self' https://www.youtube-nocookie.com",
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
    return [
      { source: "/:path*", headers },
      // Printable letters carry template HTML: no scripts at all. Later
      // entries win for the same header key.
      {
        source: "/documents/letters/:id/print",
        headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }],
      },
      // Stored files: no scripts, and only this app may frame one (the PDF
      // résumé preview). frame-ancestors overrides X-Frame-Options.
      {
        source: "/files/:id",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      // The embeddable jobs widget (Hire > Settings > Career site) is meant to
      // be framed by the company's own website; the page itself refuses to
      // render unless the company switched embedding on.
      {
        source: "/embed/:path*",
        headers: [{ key: "Content-Security-Policy", value: csp.replace("frame-ancestors 'none'", "frame-ancestors *") }],
      },
    ];
  },
};

export default config;
