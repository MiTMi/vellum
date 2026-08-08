/**
 * E2E: the Library page — sidebar entry, tabs, visit tracking, source
 * column, title filter, row navigation.
 *
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5199 & node scripts/e2e-library.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5199") + "/app.html";
const SHOTS = "/tmp/shots-library";
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const results = [];
function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  /* --------------------------------------------------- seed some pages */
  // Welcome page exists. Add a page, a database with a row, and a favorite.
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Reading list");
  await page.waitForTimeout(400);
  // favorite it via the top bar star
  await page.click(".topbar-right .icon-btn[title='Add to favorites']");
  await page.waitForTimeout(300);

  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.click(".menu-item:has-text('New database')");
  await page.waitForTimeout(500);
  await page.fill(".page-title", "Projects");
  await page.waitForSelector(".db-table");
  await page.click(".new-row-btn");
  await page.waitForTimeout(250);
  await page.keyboard.type("Apollo");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  /* ------------------------------------------------- open the library */
  check("sidebar has a Library entry", await page.isVisible(".sidebar-item:has-text('Library')"));
  await page.click(".sidebar-item:has-text('Library')");
  await page.waitForTimeout(500);
  check("library page renders", await page.isVisible(".library-view"));
  check("library title shown", (await page.textContent(".library-header h1")) === "Library");
  const tabsText = await page.textContent(".library-tabs");
  check("all four tabs present", ["Recents", "Favorites", "Private", "Templates"].every((t) => tabsText.includes(t)));
  const headText = await page.textContent(".library-table thead");
  check("table has the four columns", ["Page name", "Source", "Last edited", "Last visited"].every((c) => headText.includes(c)));
  await page.screenshot({ path: `${SHOTS}/01-library.png` });

  /* -------------------------------------------- recents & visit times */
  const firstName = await page.textContent(".library-table tbody tr:nth-child(1) .lib-name");
  check("most recently visited page tops Recents", firstName.includes("Projects"), firstName.trim());
  const firstVisit = await page.textContent(".library-table tbody tr:nth-child(1) .lib-time:last-child");
  check("visited page shows a relative time", firstVisit.includes("Just now"), firstVisit.trim());

  /* --------------------------------------------------- source column */
  const rowSource = await page.textContent(".library-table tbody tr:has-text('Apollo') .lib-source");
  check("a database row's source is its database", rowSource.includes("Projects"), rowSource.trim());
  const topSource = await page.textContent(".library-table tbody tr:has-text('Reading list') .lib-source");
  check("top-level pages show Private as source", topSource.includes("Private"), topSource.trim());

  /* ----------------------------------------------------- favorites tab */
  await page.click(".library-tab:has-text('Favorites')");
  await page.waitForTimeout(300);
  const favRows = await page.locator(".library-table tbody tr").count();
  const favText = await page.textContent(".library-table tbody");
  check("favorites tab lists only the starred page", favRows === 1 && favText.includes("Reading list"));

  /* ------------------------------------------------------- search */
  await page.click(".library-tab:has-text('Private')");
  await page.waitForTimeout(300);
  await page.click(".library-toolbar .icon-btn[title='Filter by title']");
  await page.fill(".library-toolbar .db-search input", "apollo");
  await page.waitForTimeout(300);
  const filtered = await page.locator(".library-table tbody tr").count();
  check("title filter narrows the table", filtered === 1, `rows=${filtered}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  /* ------------------------------------------- row click navigates */
  await page.click(".library-table tbody tr:has-text('Reading list') .lib-name");
  await page.waitForTimeout(500);
  check("clicking a row opens the page", (await page.inputValue(".page-title").catch(() => "")) === "Reading list"
    || (await page.textContent(".page-title").catch(() => "")).includes("Reading list"));

  /* -------------------------------- source link navigates to parent */
  await page.click(".sidebar-item:has-text('Library')");
  await page.waitForTimeout(400);
  await page.click(".library-table tbody tr:has-text('Apollo') .lib-source-link");
  await page.waitForTimeout(500);
  check("source link opens the parent database", await page.isVisible(".db-table"));

  /* --------------------------------------- tab bar & breadcrumb text */
  await page.click(".sidebar-item:has-text('Library')");
  await page.waitForTimeout(400);
  check("tab bar names the library tab", (await page.textContent(".tab-bar")).includes("Library"));
  check("breadcrumb shows Library", (await page.textContent(".breadcrumbs")).includes("Library"));

  /* -------------------------------------------------- New page button */
  await page.click(".library-header .btn.primary");
  await page.waitForTimeout(500);
  check("New page from the library opens an empty page", await page.isVisible(".page-title"));
} catch (err) {
  check(`script error: ${err.message}`, false);
} finally {
  await browser.close();
}

console.log(results.join("\n"));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
