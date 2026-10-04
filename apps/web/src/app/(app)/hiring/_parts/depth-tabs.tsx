import { SubTabs } from "@/components/subtabs";

/** Sub-pages of Hire › Sourcing. */
export function SourcingTabs() {
  return (
    <SubTabs items={[
      { label: "Channels & campaigns", href: "/hiring/sourcing" },
      { label: "Projects", href: "/hiring/sourcing/projects" },
      { label: "Rules", href: "/hiring/sourcing/rules" },
      { label: "Referrals", href: "/hiring/referrals" },
    ]} />
  );
}

/** Sub-pages of Hire › Tasks. */
export function TaskTabs() {
  return (
    <SubTabs items={[
      { label: "Task queues", href: "/hiring/tasks" },
      { label: "Exceptions & SLAs", href: "/hiring/exceptions" },
    ]} />
  );
}

/** Sub-pages of Hire › Candidates. */
export function CandidateTabs() {
  return (
    <SubTabs items={[
      { label: "All candidates", href: "/hiring/candidates" },
      { label: "Duplicates", href: "/hiring/candidates/duplicates" },
    ]} />
  );
}

export const when = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const day = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }) : "—");
export const inr = (n: unknown) => (n === null || n === undefined ? "—" : `₹${Number(n).toLocaleString("en-IN")}`);
export const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
