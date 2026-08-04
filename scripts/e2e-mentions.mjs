/**
 * E2E drive for @-mention page links + backlinks ("Linked mentions").
 * Mock data mode, same harness as the other e2e scripts.
 * Usage: node scripts/e2e-mentions.mjs [--shots-dir /tmp/shots]
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

async function shot(name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function newPage(title) {
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(300);
  await page.fill(".page-title", title);
  await page.waitForTimeout(500); // rename debounce
}

try {
  await page.goto(BASE);
  await page.waitForSelector(".sidebar", { timeout: 10000 });
  await page.waitForSelector(".page-title", { timeout: 10000 });

  await newPage("Target Alpha");
  await newPage("Source Beta");

  // ---------- @-mention an existing page ----------
  await page.click(".bn-editor");
  await page.keyboard.type("Linking now: ");
  await page.keyboard.type("@Target Al");
  await page.waitForTimeout(500);
  const menuVisible = await page
    .locator(".bn-suggestion-menu, [class*='suggestion']")
    .first()
    .isVisible()
    .catch(() => false);
  check("@ opens the page mention menu", menuVisible);
  await shot("mention-menu");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  // @ now inserts an *inline* chip inside the paragraph (Notion-style),
  // rather than the standalone pageLink block the slash "Sub-page" item uses.
  const mentionCount = await page
    .locator(".page-mention:has-text('Target Alpha')")
    .count();
  check("@-mention inserts an inline chip for the existing page", mentionCount === 1);
  check(
    "the chip is inline, inside a paragraph",
    (await page
      .locator("[data-content-type='paragraph'] .page-mention")
      .count()) === 1,
  );
  check(
    "@-mention does not insert a block-level page link",
    (await page.locator(".page-link-block").count()) === 0,
  );

  // ---------- slash command variant ----------
  await page.keyboard.press("Enter");
  await page.keyboard.type("/link");
  await page.waitForTimeout(400);
  const slashItem = await page
    .locator("[class*='suggestion'] :text('Link to page')")
    .first()
    .isVisible()
    .catch(() => false);
  check("slash menu offers 'Link to page'", slashItem);
  await page.keyboard.press("Enter"); // pick "Link to page" → opens @ menu
  await page.waitForTimeout(500);
  await page.keyboard.type("Target");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const mentionCount2 = await page
    .locator(".page-mention:has-text('Target Alpha')")
    .count();
  check(
    "slash 'Link to page' inserts a mention too",
    mentionCount2 === 2,
    String(mentionCount2),
  );

  // ---------- backlinks on the target ----------
  await page.click(".page-mention:has-text('Target Alpha') >> nth=0");
  await page.waitForTimeout(500);
  check(
    "clicking the inline mention navigates to the target",
    (await page.inputValue(".page-title")) === "Target Alpha",
  );
  await page.waitForSelector(".backlinks", { timeout: 5000 });
  const header = await page.textContent(".backlinks-header");
  check(
    "target shows exactly one linked mention (per page, not per link)",
    header.includes("1 linked mention"),
    header,
  );
  const item = await page.textContent(".backlink-item");
  check("backlink lists the source page", item.includes("Source Beta"), item);
  await shot("backlinks");

  // ---------- backlink navigates back & collapses ----------
  await page.click(".backlinks-header");
  check(
    "backlinks section collapses",
    (await page.locator(".backlink-item").count()) === 0,
  );
  await page.click(".backlinks-header");
  await page.click(".backlink-item:has-text('Source Beta')");
  await page.waitForTimeout(500);
  check(
    "backlink navigates to the linking page",
    (await page.inputValue(".page-title")) === "Source Beta",
  );

  // ---------- persistence ----------
  await page.reload();
  await page.waitForSelector(".sidebar", { timeout: 10000 });
  await page.click(".tree-title:has-text('Target Alpha')");
  await page.waitForSelector(".backlinks", { timeout: 5000 });
  check(
    "backlinks survive reload",
    (await page.textContent(".backlinks-header")).includes("1 linked mention"),
  );

  // ---------- no backlinks section when none exist ----------
  await page.click(".tree-title:has-text('Source Beta')");
  await page.waitForTimeout(400);
  check(
    "pages without mentions show no backlinks section",
    (await page.locator(".backlinks").count()) === 0,
  );
} catch (err) {
  check(`fatal: ${err.message}`, false);
} finally {
  await browser.close();
}

console.log("\n" + results.join("\n"));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
