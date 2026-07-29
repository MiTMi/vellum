import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";
import { IS_MOCK } from "./data/api";

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
  root.render(
    <React.StrictMode>
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    </React.StrictMode>,
  );
}
