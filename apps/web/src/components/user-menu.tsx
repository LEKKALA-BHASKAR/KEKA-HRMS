"use client";

import { useState, useRef, useEffect } from "react";
import { signOut } from "@/app/actions/auth";
import { IconLogout, IconChevronDown } from "./icons";

export function UserMenu({
  name, email, roles, initials,
}: { name: string; email: string; roles: string[]; initials: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="demo-account"
        style={{ width: "100%" }}
        aria-expanded={open}
      >
        <div className="avatar sm">{initials}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {name}
          </div>
          <div className="text-xs subtle" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {roles[0] ?? "Employee"}
          </div>
        </div>
        <IconChevronDown width={14} height={14} className="subtle" />
      </button>

      {open ? (
        <div
          style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0,
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: "var(--radius)", boxShadow: "var(--shadow-lg)",
            padding: 8, zIndex: 50,
          }}
        >
          <div style={{ padding: "6px 8px 10px", borderBottom: "1px solid var(--border)", marginBottom: 6 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>{name}</div>
            <div className="text-xs subtle" style={{ wordBreak: "break-all" }}>{email}</div>
            {roles.length > 0 ? (
              <div className="row gap-1 wrap" style={{ marginTop: 7 }}>
                {roles.map((r) => (
                  <span key={r} className="badge neutral" style={{ fontSize: 10.5 }}>{r}</span>
                ))}
              </div>
            ) : (
              <div className="text-xs subtle" style={{ marginTop: 6 }}>No roles assigned</div>
            )}
          </div>
          <form action={signOut}>
            <button type="submit" className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start" }}>
              <IconLogout width={15} height={15} />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
