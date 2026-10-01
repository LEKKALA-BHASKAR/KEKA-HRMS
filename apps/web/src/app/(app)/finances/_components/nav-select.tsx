"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * A select that navigates: the Year picker on Payslips and the financial
 * year picker on Manage Tax. Each option carries the URL it leads to.
 */
export function NavSelect({ label, value, options, className }: {
  label: string; value: string; className?: string;
  options: Array<{ value: string; label: string; href: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <select
      aria-label={label}
      className={`select${className ? ` ${className}` : ""}`}
      value={value}
      disabled={pending}
      onChange={(e) => {
        const href = options.find((o) => o.value === e.target.value)?.href;
        if (href) start(() => router.push(href, { scroll: false }));
      }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
