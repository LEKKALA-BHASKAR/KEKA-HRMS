/**
 * Runs once when the server starts. Refuses to start with broken
 * configuration — a loud failure at deploy beats a quiet one at sign-in.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkEnv } = await import("./lib/env");
  const r = checkEnv();
  if (!r.ok) {
    console.error(JSON.stringify({ level: "fatal", msg: "Invalid configuration", problems: r.problems }));
    // Throwing from register() aborts start-up, which is what production needs.
    if (process.env.NODE_ENV === "production") throw new Error(`Invalid configuration: ${r.problems.join("; ")}`);
  }
}
