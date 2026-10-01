import { WizardPage } from "../wizard-page";

/** "Add goal" / "Create custom goal": straight to the metrics step with one blank goal. */
export default async function AddGoalPage({ searchParams }: { searchParams: Promise<{ back?: string; for?: string }> }) {
  return <WizardPage mode="custom" sp={await searchParams} />;
}
