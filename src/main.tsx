import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";
import { IS_DIRECT, IS_MOCK } from "./data/api";
import { initOfflineRuntime } from "./offline/runtime";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "./styles/app.css";

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
      <ConvexProvider client={convex}>
        <Boot ready={ready}>
          <App />
        </Boot>
      </ConvexProvider>
    </React.StrictMode>,
  );
}
