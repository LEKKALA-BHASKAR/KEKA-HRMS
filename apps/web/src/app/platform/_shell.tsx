import type { ReactNode } from "react";
import type { PlatformViewer } from "@/lib/platform/session";
import { PlatformNav } from "./_ui";
import s from "./platform.module.css";

export function PlatformShell({ admin, children }: { admin: PlatformViewer; children: ReactNode }) {
  return (
    <div className={s.shell}>
      <PlatformNav name={admin.name} />
      <main className={s.main}>{children}</main>
    </div>
  );
}
