import { redirect } from "next/navigation";

/** Notifications now live in the inbox, as Keka has them. */
export default function NotificationsPage(): never {
  redirect("/inbox/notifications");
}
