import { SubTabs } from "@/components/subtabs";

/** The Insights section's own tabs. */
export function InsightsNav() {
  return (
    <SubTabs items={[
      { label: "Scorecards", href: "/insights" },
      { label: "Metric catalog", href: "/insights/metrics" },
      { label: "KPIs & KRAs", href: "/insights/kpis" },
      { label: "Report operations", href: "/insights/reports" },
      { label: "People analytics", href: "/insights/people" },
      { label: "Dashboards", href: "/storyboards" },
    ]} />
  );
}
