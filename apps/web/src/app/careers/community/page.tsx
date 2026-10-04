import Link from "next/link";
import type { Metadata } from "next";
import { GrowthForm } from "@/components/growth-forms";
import { tenantFromHost } from "@/lib/tenant-host";
import { joinTalentCommunityAction } from "../portal-actions";

export const metadata: Metadata = { title: "Talent community" };

/** Join the talent community without applying for a role: the recruiters can reach out when one fits. */
export default async function TalentCommunityPage() {
  const tenant = (await tenantFromHost())!;
  return (
    <>
      <Link href="/careers" className="text-sm subtle">‹ Careers</Link>
      <h1 style={{ fontSize: 26, margin: "8px 0 4px" }}>Join our talent community</h1>
      <p className="muted">Not ready to apply? Leave your details and {tenant.name}&apos;s recruiters will get in touch when a role matches your interests. You can ask us to remove your details at any time.</p>
      <div className="card" style={{ padding: 20 }}>
        <GrowthForm action={joinTalentCommunityAction} cols={2} submitLabel="Join" hidden={{ website: "" }} fields={[
          { name: "firstName", label: "First name", required: true },
          { name: "lastName", label: "Last name" },
          { name: "email", label: "Email", required: true },
          { name: "currentTitle", label: "Current role" },
          { name: "city", label: "City" },
          { name: "interests", label: "Skills and interests", placeholder: "e.g. react, product design" },
          { name: "consent", label: `I agree that ${tenant.name} may keep my details and contact me about roles.`, type: "checkbox" },
        ]} />
      </div>
    </>
  );
}
