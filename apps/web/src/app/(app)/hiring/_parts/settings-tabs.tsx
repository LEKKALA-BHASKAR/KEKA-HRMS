import { SubTabs } from "@/components/subtabs";

/** Hire › Settings sub-pages. */
export function HireSettingsTabs() {
  return (
    <SubTabs items={[
      { label: "General", href: "/hiring/settings" },
      { label: "Approval chains", href: "/hiring/settings/approvals" },
      { label: "Scoring & fields", href: "/hiring/settings/talent" },
      { label: "Career site", href: "/hiring/settings/careers" },
      { label: "Careers content", href: "/hiring/settings/careers/content" },
      { label: "Site SEO & access", href: "/hiring/settings/careers/site" },
      { label: "Stages", href: "/hiring/settings/stages" },
      { label: "Operations", href: "/hiring/settings/ops" },
      { label: "Interviewing", href: "/hiring/settings/interviewing" },
      { label: "Offers", href: "/hiring/settings/offers" },
    ]} />
  );
}
