import Link from "next/link";
import { Card } from "@/components/ui";
import { MODULES } from "@keka/rbac";
import { requirePlatformAdmin } from "@/lib/platform/session";
import { createCompany } from "@/app/actions/platform";
import { PlatformShell } from "../../_shell";
import { ActionForm, ModulePicker, SubdomainField } from "../../_ui";
import s from "../../platform.module.css";

export const metadata = { title: "Onboard a company — BooS-HR Platform" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default async function NewCompanyPage() {
  const admin = await requirePlatformAdmin();
  const base = process.env.APP_BASE_DOMAIN ?? "";
  return (
    <PlatformShell admin={admin}>
      <div className="page-head">
        <div className="page-title-group">
          <h1>Onboard a company</h1>
          <div className="page-subtitle">Creates the company with its own address, the standard roles, and its first administrator. Their admin then sets up departments, HR admins, payroll and everything else themselves.</div>
        </div>
        <Link href="/platform" className="btn">Back to companies</Link>
      </div>
      <Card>
        <ActionForm action={createCompany} submit="Create company" pendingLabel="Creating…">
          <div className={s.section}>Company</div>
          <div className={s.formGrid}>
            <div className="field"><label className="label" htmlFor="name">Company name</label><input id="name" name="name" className="input" required placeholder="Blue Cloud Softech" /></div>
            <div className="field"><label className="label" htmlFor="legalName">Legal name <span className="muted">(optional)</span></label><input id="legalName" name="legalName" className="input" placeholder="Blue Cloud Softech Private Limited" /></div>
            <SubdomainField baseDomain={base} />
          </div>

          <div className={s.section}>Company admin</div>
          <div className={s.formGrid}>
            <div className="field"><label className="label" htmlFor="adminFirstName">First name</label><input id="adminFirstName" name="adminFirstName" className="input" required /></div>
            <div className="field"><label className="label" htmlFor="adminLastName">Last name</label><input id="adminLastName" name="adminLastName" className="input" required /></div>
            <div className="field"><label className="label" htmlFor="adminEmail">Work email</label><input id="adminEmail" name="adminEmail" type="email" className="input" required placeholder="hr@bluecloudsoftech.com" /><div className="hint">Gets full Global Admin access and a temporary password.</div></div>
            <div className="field"><label className="label" htmlFor="contactPhone">Phone <span className="muted">(optional)</span></label><input id="contactPhone" name="contactPhone" className="input" /></div>
          </div>

          <div className={s.section}>Plan and region</div>
          <div className={s.formGrid}>
            <div className="field"><label className="label" htmlFor="plan">Plan</label>
              <select id="plan" name="plan" className="select" defaultValue="GROWTH"><option value="FOUNDATION">Foundation</option><option value="STRENGTH">Strength</option><option value="GROWTH">Growth</option></select>
            </div>
            <div className="field"><label className="label" htmlFor="employeeLimit">Employee limit <span className="muted">(optional)</span></label><input id="employeeLimit" name="employeeLimit" type="number" min={1} className="input" placeholder="No limit" /></div>
            <div className="field"><label className="label" htmlFor="countryCode">Country</label><input id="countryCode" name="countryCode" className="input" defaultValue="IN" maxLength={2} /></div>
            <div className="field"><label className="label" htmlFor="currency">Currency</label><input id="currency" name="currency" className="input" defaultValue="INR" maxLength={3} /></div>
            <div className="field"><label className="label" htmlFor="timezone">Time zone</label><input id="timezone" name="timezone" className="input" defaultValue="Asia/Kolkata" /></div>
            <div className="field"><label className="label" htmlFor="fyStartMonth">Financial year starts</label>
              <select id="fyStartMonth" name="fyStartMonth" className="select" defaultValue="4">{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
            </div>
          </div>

          <div className={s.section}>Modules</div>
          <ModulePicker modules={MODULES} enabled={MODULES.map((m) => m.key)} />
          <div className="hint" style={{ marginTop: 8 }}>Core HR (people, organisation, documents, onboarding and exits, leave and attendance, settings) is always on.</div>
        </ActionForm>
      </Card>
    </PlatformShell>
  );
}
