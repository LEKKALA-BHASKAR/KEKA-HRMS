import { SubTabs } from "@/components/subtabs";

/** Hire › Settings sub-pages. */
export function HireSettingsTabs() {
  return (
    <SubTabs items={[
      { label: "General", href: "/hiring/settings" },
      { label: "Approval chains", href: "/hiring/settings/approvals" },
      { label: "Scoring & fields", href: "/hiring/settings/talent" },
      { label: "Career site", href: "/hiring/settings/careers" },
    ]} />
  );
}
