"use client";

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  const isForbidden = error.name === "ForbiddenError" || error.message.startsWith("Forbidden:");

  return (
    <div style={{ maxWidth: 520, margin: "60px auto" }}>
      <div className="card">
        <div className="card-body">
          <h2 style={{ marginBottom: 6 }}>
            {isForbidden ? "You do not have access to this page" : "Something went wrong"}
          </h2>
          <p className="muted text-sm" style={{ marginBottom: 16 }}>
            {isForbidden
              ? "Your roles do not grant the permission this page requires. If you believe this is a mistake, ask a Global Admin to review your role assignment."
              : "An unexpected error occurred while rendering this page."}
          </p>
          {!isForbidden ? (
            <pre
              className="mono text-xs"
              style={{
                background: "var(--surface-sunken)", padding: 12,
                borderRadius: "var(--radius)", overflow: "auto", marginBottom: 16,
              }}
            >
              {error.message}
            </pre>
          ) : null}
          <div className="row gap-2">
            <button className="btn primary" onClick={reset}>Try again</button>
            <a className="btn" href="/">Back to dashboard</a>
          </div>
        </div>
      </div>
    </div>
  );
}
