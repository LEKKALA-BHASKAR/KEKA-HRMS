import { requireViewer } from "@/lib/context";
import { PageHead } from "@/components/ui";
import { Plans } from "../_parts/sections";

/** Performance › Improvement Plans. Without PIP rights, a person sees only their own plans. */
export default async function PlansPage() {
  const viewer = await requireViewer();
  return (
    <>
      <PageHead title="Improvement Plans" subtitle="Plans that run for a fixed period and end in a recorded decision" />
      <Plans viewer={viewer} />
    </>
  );
}
