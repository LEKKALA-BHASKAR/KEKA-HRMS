import "server-only";
import type { Viewer } from "@/lib/context";
import { timeSources } from "./time";
import { coreSources } from "./sources";
import { jobChangeSources } from "./job-changes";
import { workflowSources } from "./workflows";
import type { SourceFactory, TakeSource } from "./types";

/**
 * Inbox › Take Action, assembled from one factory per area. To add a
 * category, write a factory in its own file under _take/ (see ./types for
 * the contract — a scoped count, list and detail, and `bulk` if it supports
 * Approve all) and add it to this list. Order here is the order on screen.
 */
export const SOURCE_FACTORIES: SourceFactory[] = [
  timeSources,
  coreSources,
  jobChangeSources,
  workflowSources,
];

export async function takeActionSources(viewer: Viewer): Promise<TakeSource[]> {
  const groups = await Promise.all(SOURCE_FACTORIES.map((f) => f(viewer)));
  return groups.flat();
}
