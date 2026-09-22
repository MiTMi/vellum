import { useEffect, useState } from "react";
import { X } from "lucide-react";

/**
 * Desktop only. The packaged Mac app's screens are frozen at build time
 * while the hosted site updates itself, so a stale build can silently lack
 * whole features — the AI plan card went unnoticed for five weeks. A few
 * seconds after launch the app compares its baked-in build id
 * (`__VELLUM_BUILD__`, vite.config.ts) with the hosted /build.json and,
 * when they differ, shows the rebuild runbook. Dismissal is remembered per
 * hosted build, so the strip only returns when there is something new
 * again. In the browser the check is skipped: that build IS the hosted one.
 */
const SITE = import.meta.env.VITE_PUBLIC_SITE_URL;
const DELAY_MS = 5000;
const DISMISSED_KEY = "vellum:update-dismissed";

export default function UpdateBanner() {
  const [remote, setRemote] = useState<string | null>(null);

  useEffect(() => {
    if (!window.vellum?.isElectron || !SITE) return;
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${SITE.replace(/\/$/, "")}/build.json`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const { build } = (await res.json()) as { build?: string };
        if (!alive || !build || build === __VELLUM_BUILD__) return;
        if (localStorage.getItem(DISMISSED_KEY) === build) return;
        setRemote(build);
      } catch {
        // Offline, or the host is unreachable: nothing to say.
      }
    }, DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  if (!remote) return null;
  return (
    <div className="update-banner" role="status">
      <span>
        A newer Vellum is available (build {remote}; this app is{" "}
        {__VELLUM_BUILD__}). Quit Vellum, run <code>npm run dist</code> in{" "}
        <code>~/Notion/vellum</code>, then drag the new app from{" "}
        <code>release/</code> into Applications.
      </span>
      <button
        className="icon-btn"
        aria-label="Dismiss"
        title="Dismiss until the next update"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED_KEY, remote);
          } catch {
            // Storage blocked: dismiss for this session only.
          }
          setRemote(null);
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
