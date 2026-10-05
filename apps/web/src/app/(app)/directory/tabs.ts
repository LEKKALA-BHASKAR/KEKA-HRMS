import type { SubTab } from "@/components/subtabs";

/** The sub-tabs under Org → Employees. */
export const DIRECTORY_TABS: SubTab[] = [
  { label: "Employee Directory", href: "/directory" },
  { label: "Organization Tree", href: "/directory/tree" },
  { label: "Expertise", href: "/directory/expertise" },
];
