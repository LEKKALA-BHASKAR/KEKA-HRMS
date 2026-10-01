import { redirect } from "next/navigation";

/** Tax declarations now live under My Finances → Manage Tax. */
export default function MyTaxRedirect(): never {
  redirect("/finances/tax");
}
