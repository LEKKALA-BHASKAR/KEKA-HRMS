import { redirect } from "next/navigation";

/** My pay now lives under My Finances → My Pay. */
export default function MyPayRedirect(): never {
  redirect("/finances/pay");
}
