import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import { AuthGate } from "./components/Auth";
import { IS_DIRECT, IS_MOCK } from "./data/api";
import { initOfflineRuntime } from "./offline/runtime";
import { registerSW } from "./pwa/register";
import { initialTheme } from "./state";
import { isWarming } from "./lib/warmChunk";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "./styles/app.css";

// Theme must be on <html> before first paint — the login screen and boot
// states render before NavProvider (which owns the theme) mounts.
document.documentElement.dataset.theme = initialTheme();

// Offline app shell for the hosted build. No-ops in dev and inside Electron.
registerSW();

// A lazy chunk that fails to load almost always means this tab predates a
// deploy: the new service worker has evicted the old cache and the host no
// longer serves the old hashes. Vite reports it as `vite:preloadError`;
// flush pending edits and reload once into the current build. The stamp
// stops a reload loop when the failure is something else (offline with a
// cold cache), in which case the surface's own failed state handles it
// (lib/lazyModule.ts). Two failures never reload at all: a background
// warm-up (lib/warmChunk.ts) — nobody on screen asked for that chunk, and
// unloading a workspace someone is typing in over it is worse than a
// sticky failed state — and any failure while offline, where a reload
// can't fetch anything either. Those checks come before the stamp so a
// suppressed failure doesn't burn the reload budget a genuine
// stale-deploy failure needs seconds later.
window.addEventListener("vite:preloadError", (event) => {
  if (isWarming() || !navigator.onLine) return;
  const FLAG = "vellum:chunk-reload";
  try {
    const last = Number(sessionStorage.getItem(FLAG)) || 0;
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(FLAG, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.dispatchEvent(new Event("vellum:flush-edits"));
  window.location.reload();
});

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;

function MissingConvex() {
  return (
    <div className="boot-error">
      <div>
        <h1>Vellum isn’t connected to Convex yet</h1>
        <p>
          Run <code>./setup.sh</code> (or <code>npx convex dev</code>) in the
          project folder once — it creates <code>.env.local</code> with your
          deployment URL — then restart the app.
        </p>
      </div>
    </div>
  );
}

/** Holds rendering until the local replica has hydrated from IndexedDB. */
function Boot({
  ready,
  children,
}: {
  ready: Promise<void>;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    ready.then(
      () => alive && setState("ready"),
      (err) => {
        if (!alive) return;
        setError(String(err));
        setState("failed");
      },
    );
    return () => {
      alive = false;
    };
  }, [ready]);

  if (state === "failed") {
    return (
      <div className="boot-error">
        <div>
          <h1>Vellum couldn’t start</h1>
          <p>{error}</p>
        </div>
      </div>
    );
  }
  if (state === "loading") {
    return (
      <div className="empty-state" style={{ height: "100vh" }}>
        <div className="spinner" />
      </div>
    );
  }
  return <>{children}</>;
}

const root = ReactDOM.createRoot(document.getElementById("root")!);

if (IS_MOCK) {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} else if (!url) {
  root.render(<MissingConvex />);
} else {
  const convex = new ConvexReactClient(url, { unsavedChangesWarning: false });
  const ready = IS_DIRECT ? Promise.resolve() : initOfflineRuntime(convex);
  root.render(
    <React.StrictMode>
      <ConvexAuthProvider client={convex}>
        <AuthGate client={convex}>
          <Boot ready={ready}>
            <App />
          </Boot>
        </AuthGate>
      </ConvexAuthProvider>
    </React.StrictMode>,
  );
}
