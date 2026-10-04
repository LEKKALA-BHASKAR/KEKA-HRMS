import { SubTabs } from "@/components/subtabs";

/** Org › Documents sub-tabs: the document centre, library operations, e-signatures and letter operations. */
export function DocumentsTabs() {
  return (
    <SubTabs items={[
      { label: "Documents & letters", href: "/documents" },
      { label: "Library", href: "/documents/library" },
      { label: "E-sign", href: "/documents/esign" },
      { label: "Letter operations", href: "/documents/letters-admin" },
    ]} />
  );
}
