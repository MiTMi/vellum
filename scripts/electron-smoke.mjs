/**
 * Electron smoke test: launches the real desktop app (built renderer,
 * mock data mode) and verifies the window boots and renders the workspace.
 * Run under xvfb on Linux: xvfb-run -a node scripts/electron-smoke.mjs
 */
import { _electron as electron } from "playwright";

const app = await electron.launch({
  args: [".", "--no-sandbox"],
  env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" },
});

const window = await app.firstWindow();
await window.waitForSelector(".sidebar", { timeout: 15000 });
await window.waitForSelector(".page-title", { timeout: 15000 });
const title = await window.inputValue(".page-title");
console.log("window title field:", JSON.stringify(title));

// type into the editor to prove the renderer is interactive
await window.click(".bn-editor");
await window.keyboard.type("Hello from Electron");
await window.waitForTimeout(600);
const ok = (await window.textContent(".bn-editor")).includes("Hello from Electron");
console.log(ok ? "PASS electron renderer interactive" : "FAIL electron renderer");

await window.screenshot({ path: "/tmp/electron-smoke.png" });
await app.close();
process.exit(ok ? 0 : 1);
