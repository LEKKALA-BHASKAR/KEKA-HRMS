import path from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// Next only reads .env from the app directory. This is a monorepo with a
// single root .env, so load it here before the config is evaluated.
loadEnv({ path: path.resolve(__dirname, "../../.env") });

const config: NextConfig = {
  // Workspace packages ship TypeScript source rather than build output, so
  // Next has to compile them alongside the app.
  transpilePackages: ["@keka/db", "@keka/payroll", "@keka/rbac", "@keka/services", "@keka/shared"],
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
    // Lets requireAuth() call forbidden(), which renders forbidden.tsx with a
    // real 403 instead of surfacing an authorisation failure as a 500.
    authInterrupts: true,
  },
  typescript: { ignoreBuildErrors: false },
};

export default config;
