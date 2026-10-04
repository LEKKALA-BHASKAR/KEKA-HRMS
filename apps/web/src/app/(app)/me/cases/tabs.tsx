import { SubTabs } from "@/components/subtabs";

/** Me › Cases sub-tabs: grievances and actions, documents to sign, the knowledge base. */
export function MeCasesTabs({ toSign }: { toSign?: number }) {
  return (
    <SubTabs items={[
      { label: "My cases", href: "/me/cases" },
      { label: "Documents to sign", href: "/me/sign", count: toSign },
      { label: "Knowledge base", href: "/me/knowledge" },
    ]} />
  );
}
