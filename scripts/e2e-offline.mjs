/**
 * E2E offline-sync drive for Vellum (REAL Convex mode).
 * Requires: a dev deployment (.env.local) with current functions pushed,
 * and a vite server running WITHOUT VITE_MOCK_CONVEX.
 *
 * Flow: edit online → go offline → keep editing + create a page →
 * "restart" the app while still offline (replica must serve from IndexedDB)
 * → reconnect → assert everything converged on the server. Cleans up after
 * itself.
 *
 * Usage: E2E_URL=http://localhost:5201 node scripts/e2e-offline.mjs
 */
import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import fs from "fs";

const BASE = process.env.E2E_URL ?? "http://localhost:5201";
const SHOTS = process.argv.includes("--shots-dir")
  ? process.argv[process.argv.indexOf("--shots-dir") + 1]
  : "/tmp/shots";
fs.mkdirSync(SHOTS, { recursive: true });

const envLocal = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const convexUrl = envLocal.match(/VITE_CONVEX_URL=(\S+)/)?.[1];
if (!convexUrl) throw new Error("VITE_CONVEX_URL not found in .env.local");
const server = new ConvexHttpClient(convexUrl);

let failures = 0;
const results = [];
function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

const ts = Date.now();
const PAGE_TITLE = `Offline Test ${ts}`;
const BORN_TITLE = `Born Offline ${ts}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

async function shot(name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const chipHidden = () =>
  page.waitForFunction(() => !document.querySelector(".sync-chip"), null, {
    timeout: 20000,
  });

try {
  // ---------- boot online ----------
  await page.goto(BASE);
  await page.waitForSelector(".sidebar", { timeout: 15000 });
  await chipHidden();
  check("boots online with no sync chip", true);

  // ---------- create + edit a page online ----------
  await page.click(".sidebar-footer .new-page");
  await page.waitForSelector(".page-title", { timeout: 10000 });
  await page.fill(".page-title", PAGE_TITLE);
  await page.click(".bn-editor");
  await page.keyboard.type("written online");
  await page.waitForTimeout(1200); // debounce + drain
  await chipHidden();
  let pages = await server.query(api.pages.list, {});
  const onlinePage = pages.find((p) => p.title === PAGE_TITLE);
  check("online edit reaches the server", !!onlinePage);

  // ---------- go offline ----------
  await context.setOffline(true);
  await page.waitForSelector(".sync-chip", { timeout: 20000 });
  const chipText = await page.textContent(".sync-chip");
  check("sync chip shows offline", chipText.includes("Offline"), chipText);

  // keep editing the existing page
  await page.click(".bn-editor");
  await page.keyboard.press("End");
  await page.keyboard.type(" plus offline words");
  await page.waitForTimeout(600);

  // create a brand-new page while offline
  await page.click(".sidebar-footer .new-page");
  await page.waitForSelector(".page-title", { timeout: 10000 });
  await page.fill(".page-title", BORN_TITLE);
  await page.click(".bn-editor");
  await page.keyboard.type("offline-born content");
  await page.waitForTimeout(800);
  const sidebarCount = await page
    .locator(`.tree-title:has-text("${BORN_TITLE}")`)
    .count();
  check("offline-created page appears in sidebar", sidebarCount > 0);
  await shot("offline-editing");

  // ---------- 'restart' while still offline ----------
  // A second tab with Convex blocked (assets still load): the replica must
  // hydrate from IndexedDB with every offline change intact.
  const page2 = await context.newPage();
  await context.setOffline(false);
  await page2.route(/convex\.cloud/, (route) => route.abort());
  // Close intercepted sockets immediately — a half-open mock reads as
  // "connected" to the Convex client; a real outage closes the socket.
  await page2.routeWebSocket(/convex\.cloud/, (ws) => ws.close());
  await page2.goto(BASE);
  await page2.waitForSelector(".sidebar", { timeout: 15000 });
  const tree2 = await page2.textContent(".sidebar");
  check(
    "offline restart: pages hydrate from IndexedDB",
    tree2.includes(PAGE_TITLE) && tree2.includes(BORN_TITLE),
  );
  await page2.click(`.tree-title:has-text("${PAGE_TITLE}")`);
  await page2.waitForSelector(".bn-editor", { timeout: 10000 });
  const body2 = await page2.textContent(".bn-editor");
  check(
    "offline restart: edited content served locally",
    body2.includes("plus offline words"),
    body2.slice(0, 80),
  );
  const chip2 = await page2.textContent(".sync-chip").catch(() => "");
  check("offline restart: chip shows pending changes", chip2.includes("Offline"), chip2);
  await page2.screenshot({ path: `${SHOTS}/offline-restart.png` });
  await page2.close();

  // ---------- reconnect & converge ----------
  await page.reload(); // page1 reconnects with real network
  await page.waitForSelector(".sidebar", { timeout: 15000 });
  await chipHidden();
  check("reconnect: sync chip clears", true);

  pages = await server.query(api.pages.list, {});
  const edited = pages.find((p) => p.title === PAGE_TITLE);
  const born = pages.find((p) => p.title === BORN_TITLE);
  check("reconnect: offline-created page reached the server", !!born);
  check(
    "reconnect: offline-created page has a real Convex id",
    !!born && !String(born._id).startsWith("local_"),
    born?._id,
  );
  const editedDoc = edited
    ? await server.query(api.pages.get, { id: edited._id })
    : null;
  check(
    "reconnect: offline edit merged into server doc",
    !!editedDoc?.contentText?.includes("plus offline words"),
    editedDoc?.contentText ?? "(missing)",
  );
  const bornDoc = born ? await server.query(api.pages.get, { id: born._id }) : null;
  check(
    "reconnect: offline-born content on server",
    !!bornDoc?.contentText?.includes("offline-born content"),
  );

  // UI shows the born page under its real id (remap happened, no dead tab).
  await page.click(`.tree-title:has-text("${BORN_TITLE}")`);
  await page.waitForSelector(".bn-editor", { timeout: 10000 });
  check(
    "reconnect: offline-born page opens in UI",
    (await page.textContent(".bn-editor")).includes("offline-born content"),
  );
  await shot("reconnected");
} catch (err) {
  check(`fatal: ${err.message}`, false);
} finally {
  // ---------- cleanup test pages from the dev deployment ----------
  try {
    const pages = await server.query(api.pages.list, {});
    for (const p of pages) {
      if (p.title === PAGE_TITLE || p.title === BORN_TITLE) {
        await server.mutation(api.pages.trash, { id: p._id });
        await server.mutation(api.pages.deleteForever, { id: p._id });
      }
    }
  } catch {
    /* leave test pages if cleanup fails */
  }
  await browser.close();
}

console.log("\n" + results.join("\n"));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
