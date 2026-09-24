import Link from "next/link";

/**
 * Rendered by Next when a page calls forbidden(). Returns a 403, so an
 * authorisation failure is distinguishable from a real error in logs.
 */
export default function Forbidden() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card" style={{ maxWidth: 520 }}>
        <div className="card-body">
          <div className="row gap-2" style={{ marginBottom: 10 }}>
            <span className="badge warning">403</span>
            <h2 style={{ margin: 0 }}>You do not have access to this page</h2>
          </div>
          <p className="muted text-sm" style={{ marginBottom: 8 }}>
            Your roles do not grant the permission this page requires. Navigation is
            assembled from your permissions, so reaching this page usually means the link
            came from outside the app.
          </p>
          <p className="muted text-sm" style={{ marginBottom: 18 }}>
            If you should have access, ask a Global Admin to review your role assignment —
            they may also need to widen the department or location scope on your grant.
          </p>
          <div className="row gap-2">
            <Link className="btn primary" href="/">Back to dashboard</Link>
            <Link className="btn" href="/helpdesk">Raise a ticket</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
