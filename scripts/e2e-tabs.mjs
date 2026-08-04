/**
 * E2E part 4: tabs, share/export, sidebar collapse/expand, menu positioning.
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5199") + "/app.html";
const SHOTS = "/tmp/shots-tabs";
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  // ---------- tab bar basics ----------
  check("tab bar renders", (await page.locator(".tab-bar").count()) > 0);
  check("one initial tab", (await page.locator(".tab").count()) === 1);
  const firstTabTitle = await page.textContent(".tab.active .tab-title");
  check("tab shows page title", firstTabTitle === "Welcome to Vellum", firstTabTitle);

  // + opens a new tab
  await page.click(".tab-new");
  await page.waitForTimeout(300);
  check("+ adds a tab", (await page.locator(".tab").count()) === 2);
  check(
    "new tab is active and empty",
    (await page.textContent(".tab.active .tab-title")) === "New tab" &&
      (await page.locator(".empty-state").count()) > 0,
  );

  // navigate in tab 2 → title updates
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Second tab page");
  await page.waitForTimeout(500);
  check(
    "tab title follows navigation",
    (await page.textContent(".tab.active .tab-title")) === "Second tab page",
  );

  // switch back to tab 1 → old page shown
  await page.click(".tab >> nth=0");
  await page.waitForTimeout(400);
  check(
    "switching tabs restores page",
    (await page.inputValue(".page-title")) === "Welcome to Vellum",
  );
  await page.screenshot({ path: `${SHOTS}/30-tabs.png` });

  // per-tab history: tab 1 back button state is independent
  // close tab 2
  await page.click(".tab >> nth=1 >> .tab-close");
  await page.waitForTimeout(300);
  check("close tab works", (await page.locator(".tab").count()) === 1);

  // Cmd/Ctrl+T opens tab
  await page.keyboard.press("Control+t");
  await page.waitForTimeout(300);
  check("Ctrl+T opens tab", (await page.locator(".tab").count()) === 2);
  await page.click(".tab >> nth=1 >> .tab-close");

  // tabs persist across reload
  await page.click(".tab-new");
  await page.waitForTimeout(200);
  await page.reload();
  await page.waitForSelector(".tab-bar");
  await page.waitForTimeout(400);
  check("tabs persist across reload", (await page.locator(".tab").count()) === 2);
  await page.click(".tab >> nth=1 >> .tab-close");
  await page.waitForTimeout(200);

  // ---------- sidebar collapse / expand ----------
  await page.click(".sidebar-top .icon-btn[title*='Collapse']");
  await page.waitForTimeout(300);
  check("sidebar collapses", (await page.locator(".sidebar").count()) === 0);
  const expandBtn = page.locator(".tab-bar .icon-btn[title*='Open sidebar']");
  check("expand button visible in tab bar", await expandBtn.isVisible());
  await expandBtn.click();
  await page.waitForTimeout(300);
  check("sidebar expands again", (await page.locator(".sidebar").count()) === 1);

  // ---------- '...' menu opens on the right ----------
  await page.click(".tab >> nth=0");
  await page.waitForTimeout(300);
  await page.click(".topbar .icon-btn[title='More']");
  await page.waitForSelector(".menu");
  const box = await page.locator(".menu").boundingBox();
  check(
    "'...' menu opens near the right edge",
    box !== null && box.x > 1440 * 0.6,
    box ? `x=${Math.round(box.x)}` : "no box",
  );
  await page.screenshot({ path: `${SHOTS}/31-more-menu.png` });
  await page.keyboard.press("Escape");

  // ---------- share / export ----------
  await page.click(".share-btn");
  await page.waitForSelector(".menu:has-text('Export')");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.click(".menu-item:has-text('Export as Markdown')"),
  ]);
  check(
    "markdown export downloads",
    download.suggestedFilename().endsWith(".md"),
    download.suggestedFilename(),
  );
  const mdPath = `/tmp/shots-tabs/${download.suggestedFilename()}`;
  await download.saveAs(mdPath);
  const md = fs.readFileSync(mdPath, "utf8");
  check("markdown contains page content", md.includes("Things to try"), md.slice(0, 60));

  // CSV export for a database
  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.click(".menu-item:has-text('New database')");
  await page.waitForTimeout(500);
  await page.fill(".page-title", "Export DB");
  await page.waitForTimeout(300);
  await page.click(".new-row-btn");
  await page.keyboard.type("Row one");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await page.click(".share-btn");
  await page.waitForSelector(".menu:has-text('Export')");
  const [csvDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.click(".menu-item:has-text('Export as CSV')"),
  ]);
  check(
    "csv export downloads",
    csvDownload.suggestedFilename().endsWith(".csv"),
    csvDownload.suggestedFilename(),
  );
  const csvPath = `/tmp/shots-tabs/${csvDownload.suggestedFilename()}`;
  await csvDownload.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, "utf8");
  check(
    "csv has header and row",
    csv.includes('"Name"') && csv.includes('"Row one"'),
    csv.split("\n")[0],
  );
} catch (err) {
  check(`UNCAUGHT: ${err.message}`, false);
  await page.screenshot({ path: `${SHOTS}/99-failure.png` });
} finally {
  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
