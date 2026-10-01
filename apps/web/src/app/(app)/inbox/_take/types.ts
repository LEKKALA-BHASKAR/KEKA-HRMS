import type { ReactNode } from "react";
import type { Viewer } from "@/lib/context";
import type { ListItem } from "../_ui/panes";

/**
 * One category in Inbox › Take Action. A source owns a single scoped query
 * and uses it for the count, the list and the detail, so a link to something
 * outside the viewer's scope (or already decided) finds nothing.
 */
export interface TakeSource {
  key: string;
  label: string;
  icon: ReactNode;
  /** Listed even with nothing waiting. Keka hides empty categories, so prefer false. */
  always: boolean;
  count: () => Promise<number>;
  list: () => Promise<ListItem[]>;
  detail: (id: string) => Promise<ReactNode | null>;
  /**
   * Bulk "Approve all / Reject all" for this category: the entity name the
   * decide-many action takes and the noun shown on the bulk card.
   */
  bulk?: { entity: string; noun: string };
}

/** A module that contributes sources for a viewer — one per area. */
export type SourceFactory = (viewer: Viewer) => Promise<TakeSource[]>;
