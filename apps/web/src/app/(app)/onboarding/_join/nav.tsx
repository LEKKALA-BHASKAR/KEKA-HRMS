import Link from "next/link";
import { PERMISSIONS } from "@keka/rbac";
import { can, type Viewer } from "@/lib/context";

/** The onboarding area's top tabs. */
export function OnboardingNav({ viewer, active }: { viewer: Viewer; active: "journeys" | "preboarding" | "desk" | "people" | "verification" | "insights" }) {
  const tabs: Array<[string, string, string, boolean]> = [
    ["journeys", "Journeys", "/onboarding", true],
    ["preboarding", "Preboarding", "/onboarding/preboarding", true],
    ["desk", "Preboarding desk", "/onboarding/preboarding/tasks", can(viewer, PERMISSIONS.ONBOARDING_MANAGE)],
    ["people", "Buddies & milestones", "/onboarding/people", true],
    ["verification", "Verification", "/onboarding/verification", can(viewer, PERMISSIONS.BGV_MANAGE)],
    ["insights", "Insights", "/onboarding/insights", can(viewer, PERMISSIONS.ONBOARDING_MANAGE)],
  ];
  return (
    <div className="tabs">
      {tabs.filter((t) => t[3]).map(([k, label, href]) => <Link key={k} className={`tab${active === k ? " active" : ""}`} href={href}>{label}</Link>)}
    </div>
  );
}
