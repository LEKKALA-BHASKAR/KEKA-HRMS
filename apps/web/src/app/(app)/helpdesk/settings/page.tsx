import { redirect } from "next/navigation";
import { requireHelpdeskAgent } from "../_ui/access";

/** /helpdesk/settings opens its first tab. */
export default async function HelpdeskSettingsIndex() {
  await requireHelpdeskAgent({ settings: true });
  redirect("/helpdesk/settings/categories");
}
