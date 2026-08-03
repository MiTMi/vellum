/**
 * Verifies PDF export inside the real desktop app: launches Electron, stubs
 * the native save dialog, then invokes the app's own `vellum:export-pdf` IPC
 * handler and checks that a valid PDF lands on disk.
 *
 * Needs a built renderer (`npm run build`). The window will sit on the login
 * screen — irrelevant here, the handler lives in the main process.
 *
 * Usage: node scripts/electron-pdf-smoke.mjs
 */
import { _electron as electron } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";

const out = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "vellum-pdf-smoke-")),
  "page.pdf",
);

// An IDE-integrated terminal (VS Code, Cursor…) exports ELECTRON_RUN_AS_NODE=1,
// which makes any Electron binary start as plain Node — no app, no APIs, and a
// bare "Process failed to launch!" from Playwright. Drop it for the child.
const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env;

const app = await electron.launch({
  args: [".", "--no-sandbox"],
  env: { ...cleanEnv, ELECTRON_DISABLE_SANDBOX: "1" },
});

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

try {
  const result = await app.evaluate(async ({ dialog, ipcMain }, target) => {
    // The handler opens a native save dialog; force it to "choose" our path.
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });

    // Invoke the app's registered handler exactly as the renderer would.
    const handler = ipcMain._invokeHandlers.get("vellum:export-pdf");
    if (!handler) return { error: "vellum:export-pdf handler is not registered" };
    return await handler({}, {
      html: `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head>
             <body><h1>Export smoke test</h1><p>Hello.</p>
             <script>document.title = "SCRIPTS RAN"; </script></body></html>`,
      suggestedName: "smoke.pdf",
    });
  }, out);

  check("handler returned ok", result?.ok === true, JSON.stringify(result));
  if (result?.ok) {
    const buf = fs.readFileSync(out);
    check("file is a real PDF", buf.subarray(0, 5).toString("latin1") === "%PDF-");
    check("PDF has content", buf.length > 1000, `${buf.length} bytes`);
  }
} catch (err) {
  check(`fatal: ${err.message}`, false);
} finally {
  await app.close();
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
