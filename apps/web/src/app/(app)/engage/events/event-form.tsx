import { SpecForm } from "@/components/gov-forms";
import { saveEventAction } from "@/app/actions/engage-comms";
import { pretty } from "@/lib/engage-depth";

export const EVENT_KINDS = ["GENERAL", "TOWN_HALL", "CELEBRATION", "HEALTH_SCREENING", "TRAINING", "SPORTS"];
const IST = 330 * 60_000;

/** Create / edit form for a company event (times in IST). */
export function EventForm({ depts, comms, e }: { depts: Array<{ value: string; label: string }>; comms: boolean; e?: { id: string; title: string; kind: string; description: string | null; startsAt: Date; endsAt: Date; location: string | null; onlineUrl: string | null; capacity: number | null; rsvpBy: Date | null; departmentIds: string[]; allowQuestions: boolean } }) {
  const local = (d?: Date | null) => (d ? new Date(d.getTime() + IST).toISOString().slice(0, 16) : "");
  return (
    <SpecForm action={saveEventAction} hidden={e ? { id: e.id } : undefined} submitLabel={e ? "Save event" : "Save"} fields={[
      { name: "title", label: "Title", required: true, defaultValue: e?.title },
      { name: "kind", label: "Kind", type: "select", required: true, defaultValue: e?.kind ?? "GENERAL", options: EVENT_KINDS.map((k) => ({ value: k, label: pretty(k) })) },
      { name: "startsAt", label: "Starts", type: "datetime-local", required: true, defaultValue: local(e?.startsAt) },
      { name: "endsAt", label: "Ends", type: "datetime-local", required: true, defaultValue: local(e?.endsAt) },
      { name: "location", label: "Venue", defaultValue: e?.location },
      { name: "onlineUrl", label: "Online link (https://)", defaultValue: e?.onlineUrl },
      { name: "capacity", label: "Places", type: "number", hint: "Blank = unlimited; extra RSVPs join a waitlist", defaultValue: e?.capacity },
      { name: "rsvpBy", label: "RSVP by", type: "date", defaultValue: e?.rsvpBy ? e.rsvpBy.toISOString().slice(0, 10) : "" },
      { name: "allowQuestions", label: "Questions", type: "checkbox", defaultValue: e?.allowQuestions ?? false, placeholder: "Take questions in advance (always on for town halls)" },
      ...(comms && !e ? [{ name: "intent", label: "After saving", type: "select" as const, required: true, defaultValue: "publish", options: [{ value: "publish", label: "Publish to the calendar" }, { value: "draft", label: "Keep as draft" }] }] : []),
      { name: "departmentIds", label: "For departments (none = everyone)", type: "multiselect", options: depts, wide: true, defaultValue: e?.departmentIds ?? [] },
      { name: "description", label: "Description", type: "textarea", wide: true, defaultValue: e?.description },
    ]} />
  );
}
