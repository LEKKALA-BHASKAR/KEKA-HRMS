import { redirect } from "next/navigation";

/** The Time section's tab points here; the screen lives at /attendance?tab=shifts. */
export default function Page() {
  redirect("/attendance?tab=shifts");
}
