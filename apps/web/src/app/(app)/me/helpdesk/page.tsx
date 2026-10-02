import { requireViewer } from "@/lib/context";
import { loadMyTickets, MyTicketsView, type MyTicketsSearch } from "../../helpdesk/_ui/my-tickets";

/** Me › Helpdesk: the tickets I raised and follow, and "+ New Ticket". */
export default async function MyHelpdeskPage({ searchParams }: { searchParams: Promise<MyTicketsSearch> }) {
  const viewer = await requireViewer();
  const data = await loadMyTickets(viewer, await searchParams);
  return <MyTicketsView data={data} basePath="/me/helpdesk" />;
}
