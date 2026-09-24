import path from "node:path";
import { defineConfig } from "prisma/config";

// Load the monorepo-root .env so DATABASE_URL is available to the CLI.
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "../../.env") });

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema"),
  migrations: {
    path: path.join(__dirname, "prisma", "migrations"),
    seed: "tsx prisma/seed/index.ts",
  },
});
