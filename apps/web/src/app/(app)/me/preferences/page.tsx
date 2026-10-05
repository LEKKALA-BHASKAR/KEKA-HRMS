import Link from "next/link";
import { prisma } from "@keka/db";
import { MUTABLE_NOTIFICATION_KINDS } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { managedTeam } from "@/lib/core-hr";
import { PageHead, Card, Callout } from "@/components/ui";
import { SpecForm, ActionButton } from "@/components/spec-form";
import { savePreferencesAction, sendManagerDigestAction } from "@/app/actions/core2-people";

export const metadata = { title: "My preferences — BooS-HR" };

/**
 * How BooS-HR talks to me and looks to me: which notifications arrive by
 * email or in the app, a team digest for managers, text size, contrast,
 * motion and link underlines, and how numbers are written.
 */
export default async function PreferencesPage() {
  const viewer = await requireViewer();
  const [pref, team] = await Promise.all([prisma.userPreference.findUnique({ where: { userId: viewer.user.id } }), managedTeam(viewer)]);
  const kinds = Object.entries(MUTABLE_NOTIFICATION_KINDS).map(([value, label]) => ({ value, label }));
  return (
    <>
      <PageHead title="My preferences" subtitle="Notifications, digest, accessibility and display" actions={<><Link className="btn" href="/me/privacy">Privacy</Link><Link className="btn" href="/me/changes">My details</Link></>} />
      <Callout tone="info">Approvals, security notices and workflow requests always reach you, whatever you mute.</Callout>
      <Card title="Notifications and display">
        <SpecForm action={savePreferencesAction} submitLabel="Save preferences" fields={[
          { name: "preferredChannel", label: "Reach me by", kind: "select", required: true, defaultValue: pref?.preferredChannel ?? "BOTH", options: [{ value: "BOTH", label: "Email and in the app" }, { value: "IN_APP", label: "In the app only" }, { value: "EMAIL", label: "Email (and the app)" }] },
          { name: "locale", label: "Numbers and dates", kind: "select", defaultValue: pref?.locale ?? "", options: [{ value: "en-IN", label: "India (12,34,567)" }, { value: "en-US", label: "US (1,234,567)" }, { value: "en-GB", label: "UK (1,234,567)" }] },
          { name: "emailMuted", label: "No emails about", kind: "checks", wide: true, options: kinds, defaultValues: pref?.emailMuted ?? [] },
          { name: "inAppMuted", label: "No in-app notifications about", kind: "checks", wide: true, options: kinds, defaultValues: pref?.inAppMuted ?? [] },
          ...(team.size ? [
            { name: "digestFrequency", label: "Team digest", kind: "select" as const, required: true, defaultValue: pref?.digestFrequency ?? "NONE", options: [{ value: "NONE", label: "Off" }, { value: "DAILY", label: "Daily" }, { value: "WEEKLY", label: "Weekly" }] },
            { name: "digestSections", label: "Digest covers", kind: "checks" as const, wide: true, defaultValues: pref?.digestSections ?? ["approvals", "team-leave"], options: [{ value: "approvals", label: "Approvals waiting" }, { value: "team-leave", label: "Team leave this week" }, { value: "probation", label: "Probations ending" }, { value: "documents", label: "Documents to verify" }] },
          ] : []),
          { name: "fontScale", label: "Text size", kind: "select", required: true, defaultValue: String(pref?.fontScale ?? 100), options: [{ value: "100", label: "Standard" }, { value: "115", label: "Larger" }, { value: "130", label: "Largest" }] },
          { name: "highContrast", label: "High contrast text", kind: "checkbox", defaultChecked: pref?.highContrast ?? false },
          { name: "reducedMotion", label: "Reduce motion", kind: "checkbox", defaultChecked: pref?.reducedMotion ?? false },
          { name: "underlineLinks", label: "Underline links", kind: "checkbox", defaultChecked: pref?.underlineLinks ?? false },
        ]} />
      </Card>
      {team.size ? (
        <Card title="Team digest" description={`A summary of what needs you across your ${team.size} people.`} action={<ActionButton action={sendManagerDigestAction} hidden={{}} label="Send me one now" />}>
          <p className="text-sm muted">{pref?.digestFrequency && pref.digestFrequency !== "NONE" ? `Sent ${pref.digestFrequency.toLowerCase()}.` : "Scheduled digests are off; you can still send one now."}</p>
        </Card>
      ) : null}
    </>
  );
}
