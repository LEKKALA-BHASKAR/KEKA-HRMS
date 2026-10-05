import Link from "next/link";
import { prisma } from "@keka/db";
import { profileFacts, profileChecks } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Progress, Callout } from "@/components/ui";
import { SpecForm } from "@/components/spec-form";
import { saveProfileExtraAction } from "@/app/actions/core2-people";

export const metadata = { title: "Complete my profile — BooS-HR" };

/** Where each missing item is filled in. */
const WHERE: Record<string, { href: string; hint: string }> = {
  photo: { href: "/me/changes?tab=profile", hint: "Upload a clear headshot." },
  about: { href: "/me/changes?tab=profile", hint: "A line or two colleagues see on your profile." },
  "mobile number": { href: "/me/changes?tab=profile", hint: "Used for emergencies and sign-in help." },
  "personal email": { href: "/me/changes?tab=profile", hint: "Verify it under Privacy afterwards." },
  "date of birth": { href: "/me/changes?tab=profile", hint: "Needed for statutory filings." },
  "blood group": { href: "/me/changes?tab=profile", hint: "Shown on your ID card." },
  address: { href: "/me/changes?tab=profile", hint: "Current and permanent." },
  "bank account": { href: "/me/changes?tab=profile", hint: "Where your salary is paid." },
  PAN: { href: "/me/changes?tab=profile", hint: "For income tax." },
  Aadhaar: { href: "/me/changes?tab=profile", hint: "For provident fund." },
  "emergency contact": { href: "/me/changes?tab=profile", hint: "Someone we can call." },
};

/**
 * A guided checklist to finish my profile: each missing item in order with
 * where to fill it in, and the details that are mine to set straight away
 * (salutation, pronouns, languages).
 */
export default async function ProfileWizardPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const viewer = await requireViewer();
  if (!viewer.employee) return <><PageHead title="Complete my profile" /><Card><Empty title="No employee profile" /></Card></>;
  const sp = await searchParams;
  const me = viewer.employee.id;
  const [facts, extra] = await Promise.all([profileFacts(me), prisma.employeeProfileExtra.findUnique({ where: { employeeId: me } })]);
  const { checks, percent, missing } = profileChecks(facts!);
  const extrasDone = !!(extra?.pronouns || extra?.languages.length);
  const step = Math.min(Math.max(Number(sp.step) || 1, 1), 2);
  return (
    <>
      <PageHead title="Complete my profile" subtitle={`${percent}% complete`} actions={<Link className="btn" href="/me/changes">My details</Link>} />
      <Progress value={percent} tone={percent === 100 ? "success" : "warning"} />
      <div className="row gap-2" style={{ margin: "12px 0" }}>
        <Link className={`btn sm${step === 1 ? " primary" : ""}`} href="/me/profile-wizard?step=1">1. About you</Link>
        <Link className={`btn sm${step === 2 ? " primary" : ""}`} href="/me/profile-wizard?step=2">2. Records HR needs</Link>
      </div>
      {step === 1 ? (
        <Card title="About you" description="Yours to set; colleagues see these on your directory profile." action={extrasDone ? <Badge tone="success">done</Badge> : null}>
          <SpecForm action={saveProfileExtraAction} hidden={{ employeeId: me }} submitLabel="Save and continue" fields={[
            { name: "salutation", label: "Salutation", kind: "select", defaultValue: extra?.salutation ?? "", options: ["Mr", "Ms", "Mrs", "Mx", "Dr", "Prof"].map((v) => ({ value: v, label: v })) },
            { name: "pronouns", label: "Pronouns", defaultValue: extra?.pronouns ?? "", placeholder: "she/her" },
            { name: "languages", label: "Languages you speak (comma separated)", defaultValue: extra?.languages.join(", ") ?? "", wide: true },
          ]} />
          <div style={{ marginTop: 10 }}><Link href="/me/profile-wizard?step=2">Next: records HR needs</Link></div>
        </Card>
      ) : (
        <Card title="Records HR needs" description={missing.length ? `${missing.length} still to add. Changes go to HR for approval.` : "Everything is in place."}>
          {missing.length ? null : <Callout tone="success">Your profile is complete. Thank you.</Callout>}
          <ol>
            {checks.map((c) => (
              <li key={c.label} style={{ padding: "6px 0" }}>
                <Badge tone={c.done ? "success" : "warning"}>{c.done ? "done" : "to do"}</Badge> {c.label}
                {!c.done && WHERE[c.label] ? <> — <span className="muted text-sm">{WHERE[c.label]!.hint}</span> <Link href={WHERE[c.label]!.href}>Add it</Link></> : null}
              </li>
            ))}
          </ol>
          <div className="row gap-2" style={{ marginTop: 10 }}><Link href="/me/nominees">Then choose your nominees</Link><Link href="/me/privacy">Review your privacy</Link></div>
        </Card>
      )}
    </>
  );
}
