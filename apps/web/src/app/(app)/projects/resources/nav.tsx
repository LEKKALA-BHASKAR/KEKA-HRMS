import { PERMISSIONS as P } from "@keka/rbac";
import { can, canAny, type Viewer } from "@/lib/context";
import { SubTabs } from "@/components/subtabs";

/** Resource planner · Requests · Utilisation · Roles & cost. */
export function ResourceTabs({ viewer, active }: { viewer: Viewer; active: string }) {
  const items = [
    { label: "Planner", href: "/projects/resources" },
    canAny(viewer, [P.RESOURCE_MANAGE, P.RESOURCE_REQUEST]) && { label: "Requests", href: "/projects/resources/requests" },
    { label: "Utilisation", href: "/projects/resources/utilisation" },
    can(viewer, P.RESOURCE_MANAGE) && { label: "Roles & cost", href: "/projects/resources/settings" },
  ].filter((x): x is { label: string; href: string } => !!x);
  return <SubTabs items={items} active={active} />;
}

export const iso = (d: Date) => d.toISOString().slice(0, 10);
