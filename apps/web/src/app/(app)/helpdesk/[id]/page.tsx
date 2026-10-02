import { notFound, redirect } from "next/navigation";
import { requireViewer } from "@/lib/context";
import { ticketAccess } from "../_ui/ticket-access";

/**
 * Older links (/helpdesk/<id>) land on the view that fits the viewer: the
 * agent view for tickets they work, their own view for tickets they raised
 * or follow.
 */
export default async function TicketRedirect({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const a = await ticketAccess(viewer, id);
  if (a?.agent) redirect(`/helpdesk/tickets/${id}`);
  if (a?.own || a?.follower) redirect(`/me/helpdesk/${id}`);
  notFound();
}
