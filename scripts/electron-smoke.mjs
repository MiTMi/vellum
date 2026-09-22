/**
 * Electron smoke test: launches the real desktop app (built renderer,
 * mock data mode) and verifies the window boots and renders the workspace.
 * Run under xvfb on Linux: xvfb-run -a node scripts/electron-smoke.mjs
 *
 * Build first with `VITE_MOCK_CONVEX=1 npx vite build`. The script types into
 * the open page, so it refuses a production dist: one run against the real
 * build typed into the signed-in workspace and queued the edit in the user's
 * outbox. It also runs the app on a throwaway profile (VELLUM_SMOKE_PROFILE,
 * honoured by electron/main.cjs) so the user's replica is never opened.
 */
import { _electron as electron } from "playwright";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dist = new URL("../dist/", import.meta.url).pathname;
if (!existsSync(join(dist, "app.html"))) {
  console.error("dist/app.html missing — run `VITE_MOCK_CONVEX=1 npx vite build` first");
  process.exit(1);
}
// A mock-mode build never references the deployment: main.tsx's Convex branch
// is dead code under IS_MOCK and the inlined VITE_CONVEX_URL goes with it.
const assets = join(dist, "assets");
const entry = readdirSync(assets).find((f) => /^app-.*\.js$/.test(f));
if (!entry || /\.convex\.(cloud|site)/.test(readFileSync(join(assets, entry), "utf8"))) {
  console.error(
    "dist/ is a production build — this smoke types into the open page, so it only runs against `VITE_MOCK_CONVEX=1 npx vite build`",
  );
  process.exit(1);
}

// IDE terminals export ELECTRON_RUN_AS_NODE=1, which makes the Electron
// binary start as plain Node; drop it for the child (see electron-pdf-smoke).
const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env;
const profile = mkdtempSync(join(tmpdir(), "vellum-smoke-"));

const app = await electron.launch({
  args: [".", "--no-sandbox"],
  env: { ...cleanEnv, ELECTRON_DISABLE_SANDBOX: "1", VELLUM_SMOKE_PROFILE: profile },
});

let ok; // assigned inside the try; a throw never reaches the exit below
try {
  const window = await app.firstWindow();
  await window.waitForSelector(".sidebar", { timeout: 15000 });
  await window.waitForSelector(".page-title", { timeout: 15000 });
  const title = await window.inputValue(".page-title");
  console.log("window title field:", JSON.stringify(title));

  // type into the editor to prove the renderer is interactive
  await window.click(".bn-editor");
  await window.keyboard.type("Hello from Electron");
  await window.waitForTimeout(600);
  ok = (await window.textContent(".bn-editor")).includes("Hello from Electron");
  console.log(ok ? "PASS electron renderer interactive" : "FAIL electron renderer");

  await window.screenshot({ path: "/tmp/electron-smoke.png" });
} finally {
  await app.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
