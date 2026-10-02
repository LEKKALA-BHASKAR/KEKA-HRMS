import { redirect } from "next/navigation";

/** The Time section's tab points here; the screen lives at /attendance. */
export default function Page() {
  redirect("/attendance");
}
