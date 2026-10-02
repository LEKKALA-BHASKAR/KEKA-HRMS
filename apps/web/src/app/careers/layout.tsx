import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { tenantFromHost } from "@/lib/tenant-host";

/** The public careers site: open to anyone, branded with the company's name. */
export default async function CareersLayout({ children }: { children: ReactNode }) {
  const tenant = await tenantFromHost();
  if (!tenant) notFound();
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg, #f7f7f8)" }}>
      <header style={{ background: "#fff", borderBottom: "1px solid var(--border, #e4e4e7)" }}>
        <div style={{ maxWidth: 880, margin: "0 auto", padding: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Link href="/careers" className="strong" style={{ fontSize: 18 }}>{tenant.name} careers</Link>
          <Link href="/signin" className="text-sm subtle">Employee sign-in</Link>
        </div>
      </header>
      <main style={{ maxWidth: 880, margin: "0 auto", padding: "24px 16px" }}>{children}</main>
    </div>
  );
}
