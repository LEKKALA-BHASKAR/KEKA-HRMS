import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { PRIVACY_REQUEST_KINDS } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { SpecForm, ActionButton } from "@/components/spec-form";
import { savePrivacySettingsAction, raisePrivacyRequestAction, withdrawPrivacyRequestAction, sendPersonalEmailCodeAction, verifyPersonalEmailAction } from "@/app/actions/core2-people";

export const metadata = { title: "My privacy — BooS-HR" };

/**
 * What colleagues see of me, a verified personal email, and requests about
 * my personal data (a copy, a correction, erasure, restriction, or being
 * left out of the directory), each routed for approval and answered by a
 * deadline.
 */
export default async function PrivacyPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) return <><PageHead title="My privacy" /><Card><Empty title="No employee profile" /></Card></>;
  const me = viewer.employee.id;
  const [extra, emp, requests] = await Promise.all([
    prisma.employeeProfileExtra.findUnique({ where: { employeeId: me } }),
    prisma.employee.findUnique({ where: { id: me }, select: { personalEmail: true } }),
    prisma.privacyRequest.findMany({ where: { tenantId: viewer.tenantId, employeeId: me }, orderBy: { createdAt: "desc" } }),
  ]);
  const verified = !!extra?.personalEmailVerifiedAt && extra.verifiedEmail === emp?.personalEmail;
  return (
    <>
      <PageHead title="My privacy" subtitle="What others see, and requests about your personal data" actions={<><Link className="btn" href="/me/preferences">Preferences</Link><a className="btn" href="/me/requests/export">Download my data</a></>} />
      {extra?.hideFromDirectory ? <Callout tone="info">You are left out of the employee directory.</Callout> : null}
      <div className="grid grid-2">
        <Card title="What colleagues see" description="People who are not HR see &quot;Hidden&quot; instead of these on your profile, and your birthday is left out of celebrations.">
          <SpecForm action={savePrivacySettingsAction} fields={[
            { name: "hideMobile", label: "Hide my mobile number", kind: "checkbox", defaultChecked: extra?.hideMobile ?? false },
            { name: "hidePersonalEmail", label: "Hide my personal email", kind: "checkbox", defaultChecked: extra?.hidePersonalEmail ?? false },
            { name: "hideBirthday", label: "Hide my birthday", kind: "checkbox", defaultChecked: extra?.hideBirthday ?? false },
          ]} />
        </Card>
        <Card title="Personal email" description={emp?.personalEmail ?? "No personal email on file."}>
          {!emp?.personalEmail ? <Link href="/me/changes">Add one under My details</Link> : verified ? <Badge tone="success">Verified {formatDate(extra!.personalEmailVerifiedAt!)}</Badge> : (
            <>
              <ActionButton action={sendPersonalEmailCodeAction} hidden={{}} label="Email me a code" variant="primary" />
              <div style={{ marginTop: 10 }}><SpecForm compact action={verifyPersonalEmailAction} submitLabel="Verify" fields={[{ name: "code", label: "Six-digit code", required: true }]} /></div>
            </>
          )}
        </Card>
      </div>
      <Card title="Requests about my data">
        <SpecForm action={raisePrivacyRequestAction} submitLabel="Send request" fields={[
          { name: "kind", label: "I would like", kind: "select", required: true, options: Object.entries(PRIVACY_REQUEST_KINDS).map(([value, label]) => ({ value, label })) },
          { name: "details", label: "Details", kind: "textarea", required: true },
        ]} />
        {requests.length ? (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="data">
            <thead><tr><th>Request</th><th>Raised</th><th>Answer due</th><th>Status</th><th /></tr></thead>
            <tbody>{requests.map((r) => <tr key={r.id}><td>{PRIVACY_REQUEST_KINDS[r.kind as keyof typeof PRIVACY_REQUEST_KINDS] ?? r.kind}{r.response ? <div className="text-xs muted">{r.response}</div> : null}</td><td>{formatDate(r.createdAt)}</td><td>{formatDate(r.dueDate)}</td><td><Badge tone={r.status === "COMPLETED" ? "success" : r.status === "REJECTED" ? "danger" : "neutral"}>{r.status.toLowerCase()}</Badge></td><td>{r.status === "PENDING" ? <ActionButton action={withdrawPrivacyRequestAction} hidden={{ id: r.id }} label="Withdraw" /> : null}</td></tr>)}</tbody>
          </table></div>
        ) : null}
      </Card>
    </>
  );
}
