import { WizardPage } from "../wizard-page";

/** "Add goals using AI": describe the goal in a sentence, pick from suggestions, then set metrics. */
export default async function AddGoalsWithAiPage({ searchParams }: { searchParams: Promise<{ back?: string; for?: string }> }) {
  return <WizardPage mode="ai" sp={await searchParams} />;
}
