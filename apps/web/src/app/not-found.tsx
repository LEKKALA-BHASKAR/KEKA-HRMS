import Link from "next/link";

/**
 * A missing record and a record the viewer may not see look the same: both
 * are "not found", so the page never confirms that something exists.
 */
export default function NotFound() {
  return (
    <div style={{ minHeight: "60vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card" style={{ maxWidth: 520 }}>
        <div className="card-body">
          <div className="row gap-2" style={{ marginBottom: 10 }}>
            <span className="badge neutral">404</span>
            <h2 style={{ margin: 0 }}>Nothing here</h2>
          </div>
          <p className="muted text-sm" style={{ marginBottom: 18 }}>
            The page or record does not exist, or it is not one you can see. If you followed a
            link from a colleague, it may belong to someone outside your scope.
          </p>
          <div className="row gap-2">
            <Link className="btn primary" href="/">Back to dashboard</Link>
            <Link className="btn" href="/inbox">Your inbox</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
