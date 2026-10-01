"use server";

import { revalidatePath } from "next/cache";
import { verifyDocument } from "@/app/actions/workplace";

/**
 * Verify or reject a document from the inbox. The decision, its permission
 * and scope checks all stay in `verifyDocument`; this only refreshes the
 * inbox afterwards so the item leaves the queue.
 */
export async function verifyDocumentFromInbox(formData: FormData): Promise<void> {
  await verifyDocument(formData);
  revalidatePath("/inbox");
}
