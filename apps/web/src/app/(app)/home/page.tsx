import { redirect } from "next/navigation";

/** /home is the Dashboard, which lives at the site root. */
export default function HomeIndex() {
  redirect("/");
}
