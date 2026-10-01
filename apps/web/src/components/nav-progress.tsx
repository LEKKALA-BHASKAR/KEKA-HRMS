"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * A thin bar at the top of the page while a navigation is in flight. Pages
 * render on the server, so a click can take a moment to show anything; this
 * acknowledges it at once. It deliberately is not a `loading.tsx` boundary:
 * streaming a shell first would make every 403 and 404 answer 200.
 */
export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [active, setActive] = useState(false);

  // Arrival at the new URL ends the navigation.
  useEffect(() => { setActive(false); }, [pathname, search]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/files/") || /\/(pdf|export)(\/|$|\?)/.test(url.pathname)) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      setActive(true);
    };
    const onSubmit = (e: SubmitEvent) => {
      const f = e.target as HTMLFormElement;
      // GET forms (filters, date pickers) navigate; action forms stay put.
      if ((f.method || "get").toLowerCase() === "get" && !f.getAttribute("action")?.startsWith("javascript")) setActive(true);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    return () => { document.removeEventListener("click", onClick); document.removeEventListener("submit", onSubmit); };
  }, []);

  return <div className={`nav-progress${active ? " active" : ""}`} role="progressbar" aria-hidden={!active} aria-label="Loading page" />;
}
