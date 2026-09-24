import { PageHead, Card, Callout, Badge } from "./ui";

/**
 * A module whose schema exists and whose navigation is wired, but whose
 * screens come after the payroll spine. Stating that plainly beats a
 * half-built screen that implies more than it does.
 */
export function ModuleRoadmap({
  title, subtitle, built, next, schemaTables,
}: {
  title: string;
  subtitle: string;
  built: string[];
  next: string[];
  schemaTables: string[];
}) {
  return (
    <>
      <PageHead title={title} subtitle={subtitle} />

      <Callout tone="info" title="Scheduled after the payroll spine">
        This milestone delivered multi-tenancy, authentication, the role model, the employee
        record, and the six-step payroll run with the full Indian statutory stack. The
        database schema for this module is already in place, so the screens build on top of
        it rather than needing a migration.
      </Callout>

      <div style={{ height: 16 }} />

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Already in place">
          <ul className="stack gap-2" style={{ margin: 0, paddingLeft: 18 }}>
            {built.map((b) => <li key={b} className="text-sm">{b}</li>)}
          </ul>
        </Card>

        <Card title="What the screens will add">
          <ul className="stack gap-2" style={{ margin: 0, paddingLeft: 18 }}>
            {next.map((x) => <li key={x} className="text-sm">{x}</li>)}
          </ul>
        </Card>
      </div>

      <div style={{ height: 16 }} />

      <Card title="Schema tables backing this module" tight>
        <div style={{ padding: 14 }}>
          <div className="row gap-1 wrap">
            {schemaTables.map((t) => (
              <span key={t} className="badge neutral mono" style={{ fontSize: 10.5 }}>{t}</span>
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}
