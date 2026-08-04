/**
 * E2E for the newer editor/nav features: callout block, table-of-contents
 * block, and the ⌘K command palette. Mock data mode.
 * Usage: node scripts/e2e-blocks2.mjs [--shots-dir /tmp/shots]
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5199") + "/app.html";
const SHOTS = process.argv.includes("--shots-dir")
  ? process.argv[process.argv.indexOf("--shots-dir") + 1]
  : "/tmp/shots";
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
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

async function shot(name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function runSlash(cmd) {
  await page.keyboard.type("/" + cmd);
  await page.waitForTimeout(450);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
}

try {
  await page.goto(BASE);
  await page.waitForSelector(".page-title", { timeout: 10000 });
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(300);
  await page.fill(".page-title", "Blocks Playground");
  await page.click(".bn-editor");

  // ---------- Callout block ----------
  await runSlash("callout");
  let callout = await page.locator(".callout-block").count();
  check("callout block inserts", callout === 1);
  await page.keyboard.type("Remember to hydrate");
  await page.waitForTimeout(300);
  check(
    "callout holds typed text",
    (await page.textContent(".callout-content")).includes("Remember to hydrate"),
  );

  // change color + emoji via the popover
  const startColor = await page
    .locator(".callout-block")
    .getAttribute("data-color");
  await page.click(".callout-emoji");
  await page.waitForSelector(".callout-menu", { timeout: 3000 });
  await page.click(".callout-menu-colors .callout-blue");
  await page.waitForTimeout(300);
  const newColor = await page.locator(".callout-block").getAttribute("data-color");
  check("callout color changes via popover", newColor === "blue", `${startColor}→${newColor}`);
  await page.click(".callout-emoji");
  await page.waitForSelector(".callout-menu", { timeout: 3000 });
  await page.click(".callout-menu-emoji >> nth=2"); // ⚠️
  await page.waitForTimeout(300);
  const emoji = await page.textContent(".callout-emoji");
  check("callout emoji changes via popover", emoji.trim().length > 0 && emoji !== "💡", emoji);
  await shot("callout");

  // ---------- Table of contents ----------
  // Add some headings first.
  await page.click(".bn-editor");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await runSlash("head"); // Heading 1
  await page.keyboard.type("Introduction");
  await page.keyboard.press("Enter");
  await runSlash("toc");
  check("toc block inserts", (await page.locator(".toc-block").count()) === 1);
  await page.waitForTimeout(300);
  const tocText = await page.textContent(".toc-block");
  check("toc lists the heading", tocText.includes("Introduction"), tocText);

  // add a second heading and confirm the toc updates live
  await page.click(".bn-editor");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await runSlash("head");
  await page.keyboard.type("Second Section");
  await page.waitForTimeout(500);
  check(
    "toc updates live as headings are added",
    (await page.textContent(".toc-block")).includes("Second Section"),
  );
  await shot("toc");

  // clicking a toc entry scrolls (smoke: no error, entry is a button)
  await page.click(".toc-item:has-text('Introduction')");
  await page.waitForTimeout(300);
  check("toc entry is clickable", true);

  // ---------- persistence ----------
  await page.reload();
  await page.waitForSelector(".bn-editor", { timeout: 10000 });
  await page.waitForTimeout(400);
  check("callout survives reload", (await page.locator(".callout-block").count()) === 1);
  check(
    "callout keeps its blue color after reload",
    (await page.locator(".callout-block").getAttribute("data-color")) === "blue",
  );
  check("toc survives reload", (await page.locator(".toc-block").count()) === 1);

  // ---------- Command palette (⌘K) ----------
  await page.keyboard.press("Meta+k");
  await page.waitForSelector(".quick-switcher", { timeout: 5000 });
  const hasActions = await page.locator(".qs-section:has-text('Actions')").count();
  check("command palette shows an Actions section", hasActions === 1);
  const actionRows = await page
    .locator(".qs-row .qs-title")
    .allTextContents();
  check(
    "palette offers New page / database / theme / trash",
    actionRows.some((t) => t.includes("New page")) &&
      actionRows.some((t) => t.includes("New database")) &&
      actionRows.some((t) => /light mode|dark mode/.test(t)) &&
      actionRows.some((t) => t.includes("Open trash")),
    actionRows.slice(0, 5).join(" | "),
  );
  await shot("command-palette");

  // filter by typing a command keyword
  await page.fill(".qs-input-row input", "theme");
  await page.waitForTimeout(300);
  const themeRow = await page.locator(".qs-row:has-text('mode')").count();
  check("typing 'theme' surfaces the theme command", themeRow >= 1);

  // run the theme toggle
  const beforeTheme = await page.evaluate(
    () => document.documentElement.dataset.theme,
  );
  await page.click(".qs-row:has-text('mode')");
  await page.waitForTimeout(400);
  const afterTheme = await page.evaluate(
    () => document.documentElement.dataset.theme,
  );
  check("running the theme command toggles the theme", beforeTheme !== afterTheme, `${beforeTheme}→${afterTheme}`);

  // run "New page" from the palette
  await page.keyboard.press("Meta+k");
  await page.waitForSelector(".quick-switcher", { timeout: 5000 });
  await page.fill(".qs-input-row input", "new page");
  await page.waitForTimeout(300);
  await page.click(".qs-row:has-text('New page')");
  await page.waitForTimeout(500);
  check(
    "running 'New page' opens a fresh untitled page",
    (await page.inputValue(".page-title")) === "",
  );
} catch (err) {
  check(`fatal: ${err.message}`, false);
} finally {
  await browser.close();
}

console.log("\n" + results.join("\n"));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
