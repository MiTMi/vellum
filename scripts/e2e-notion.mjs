/**
 * E2E for the Notion-parity batch: page templates, gallery view, relation
 * properties, the web bookmark block, and page history. Mock data mode.
 * Usage: node scripts/e2e-notion.mjs [--shots-dir /tmp/shots]
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.E2E_URL ?? "http://localhost:5199";
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
async function newPage(title) {
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(350);
  await page.fill(".page-title", title);
  await page.waitForTimeout(450);
}
async function openPageMenu() {
  await page.click(".topbar .icon-btn >> nth=-1");
  await page.waitForSelector(".page-menu", { timeout: 5000 });
}

try {
  // Start from a clean workspace so counts are deterministic.
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE);
  await page.waitForSelector(".page-title", { timeout: 10000 });

  /* ---------------- 1. Templates ---------------- */

  await newPage("Weekly Review");
  await page.click(".bn-editor");
  await page.keyboard.type("Wins this week:");
  await page.waitForTimeout(500);

  await openPageMenu();
  check(
    "page menu offers a Template toggle",
    (await page.locator(".page-menu .toggle-row:has-text('Template')").count()) === 1,
  );
  await page.click(".page-menu .toggle-row:has-text('Template')");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  check(
    "sidebar grows a Templates section",
    (await page.locator(".sidebar-heading:has-text('Templates')").count()) === 1,
  );
  check(
    "the template is listed there",
    (await page.locator(".template-item:has-text('Weekly Review')").count()) === 1,
  );
  // …and is no longer a normal tree page.
  check(
    "template leaves the Private tree",
    (await page.locator(".tree-root >> text=Weekly Review").count()) === 0,
  );
  await shot("templates-section");

  // Spawn an instance from the sidebar "+".
  await page.hover(".template-item:has-text('Weekly Review')");
  await page.click(".template-item:has-text('Weekly Review') .template-use");
  await page.waitForTimeout(700);
  check(
    "instantiating a template opens the new page with no suffix",
    (await page.inputValue(".page-title")) === "Weekly Review",
    await page.inputValue(".page-title"),
  );
  check(
    "the instance carries the template's content",
    (await page.textContent(".bn-editor")).includes("Wins this week:"),
  );
  check(
    "the instance is a normal page, not another template",
    (await page.locator(".template-item").count()) === 1,
  );
  check(
    "the instance appears in the Private tree",
    (await page.locator(".tree-root >> text=Weekly Review").count()) === 1,
  );

  // …and from the command palette.
  await page.keyboard.press("Meta+k");
  await page.waitForSelector(".quick-switcher", { timeout: 5000 });
  await page.fill(".qs-input-row input", "New from template");
  await page.waitForTimeout(350);
  const tplRow = await page
    .locator(".qs-row:has-text('New from template')")
    .count();
  check("command palette offers 'New from template'", tplRow >= 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* ---------------- 2. Bookmark block ---------------- */

  await newPage("Bookmarks");
  await page.click(".bn-editor");
  await runSlash("bookmark");
  check(
    "bookmark block inserts in its empty state",
    (await page.locator(".bookmark-block.empty").count()) === 1,
  );
  await page.fill(".bookmark-input", "https://www.example.com/article");
  await page.click(".bookmark-block .btn.subtle");
  await page.waitForTimeout(800);
  const cardText = await page.textContent(".bookmark-card");
  check(
    "bookmark resolves into a card with title + host",
    cardText.includes("example.com"),
    cardText.replace(/\s+/g, " ").slice(0, 70),
  );
  await shot("bookmark");

  await page.reload();
  await page.waitForSelector(".bn-editor", { timeout: 10000 });
  await page.waitForTimeout(600);
  check(
    "bookmark card survives reload",
    (await page.locator(".bookmark-card").count()) === 1,
  );
  check(
    "and keeps its fetched metadata",
    (await page.textContent(".bookmark-card")).includes("example.com"),
  );

  /* ---------------- 3. Page history ---------------- */

  await page.click(".bn-editor");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("FIRST VERSION");
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.keyboard.type("SECOND VERSION");
  await page.waitForTimeout(700);

  await openPageMenu();
  await page.click(".page-menu .menu-item:has-text('Page history')");
  await page.waitForSelector(".history-modal", { timeout: 5000 });
  const snapshots = await page.locator(".history-item").count();
  check("page history lists snapshots", snapshots > 0, `${snapshots} snapshot(s)`);
  const preview = await page.textContent(".history-preview-text");
  check(
    "the newest snapshot previews the pre-edit content",
    preview.includes("FIRST VERSION") && !preview.includes("SECOND VERSION"),
    preview.replace(/\s+/g, " ").slice(-60),
  );
  await shot("history");

  await page.click(".history-actions .btn.primary");
  await page.waitForTimeout(900);
  const restored = await page.textContent(".bn-editor");
  check(
    "restoring rolls the page back",
    restored.includes("FIRST VERSION") && !restored.includes("SECOND VERSION"),
  );

  /* ---------------- 4. Gallery view ---------------- */

  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.waitForSelector(".menu", { timeout: 5000 });
  await page.click(".menu .menu-item:has-text('New database')");
  await page.waitForTimeout(600);
  await page.fill(".page-title", "Projects");
  await page.waitForTimeout(450);

  async function addRow(title) {
    await page.click(".new-row-btn");
    await page.waitForTimeout(250);
    await page.keyboard.type(title);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(350);
  }
  await addRow("Apollo");
  await addRow("Borealis");

  check(
    "database toolbar offers a Gallery tab",
    (await page.locator(".db-tab:has-text('Gallery')").count()) === 1,
  );
  await page.click(".db-tab:has-text('Gallery')");
  await page.waitForTimeout(500);
  const cards = await page.locator(".gallery-card:not(.gallery-new)").count();
  check("gallery renders one card per row", cards === 2, `${cards} cards`);
  const galleryText = await page.textContent(".gallery-view");
  check(
    "cards show row titles",
    galleryText.includes("Apollo") && galleryText.includes("Borealis"),
  );
  await shot("gallery");

  await page.reload();
  await page.waitForSelector(".database-view", { timeout: 10000 });
  await page.waitForTimeout(500);
  check(
    "gallery is the persisted active view after reload",
    (await page.locator(".gallery-view").count()) === 1,
  );

  // Clicking a card opens the row.
  await page.click(".gallery-card:has-text('Apollo')");
  await page.waitForTimeout(600);
  check(
    "clicking a gallery card opens the row page",
    (await page.inputValue(".page-title")) === "Apollo",
  );

  /* ---------------- 5. Relation property ---------------- */

  // A second database whose rows will link to Projects.
  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.waitForSelector(".menu", { timeout: 5000 });
  await page.click(".menu .menu-item:has-text('New database')");
  await page.waitForTimeout(600);
  await page.fill(".page-title", "Tasks");
  await page.waitForTimeout(450);
  await addRow("Ship the thing");

  // Add a property, retype it to Relation, point it at Projects.
  await page.click(".col-add .th-btn.add");
  await page.waitForTimeout(400);
  await page.click(".db-table thead th:nth-last-child(2) .th-btn");
  await page.waitForSelector(".prop-menu", { timeout: 5000 });
  await page.click(".prop-menu .prop-type-btn");
  await page.waitForTimeout(300);
  await page.click(".prop-type-list .menu-item:has-text('Relation')");
  await page.waitForTimeout(400);
  check(
    "relation type offers a related-database picker",
    (await page.locator(".prop-menu .prop-menu-label:has-text('Related database')").count()) === 1,
  );
  await page.click(".prop-menu .prop-options .menu-item:has-text('Projects')");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Link two rows through the cell popover.
  await page.click(".db-table tbody tr:has-text('Ship the thing') .cell-relation");
  await page.waitForSelector(".menu .qs-input-row", { timeout: 5000 });
  const linkable = await page.locator(".menu .menu-item .move-title").allTextContents();
  check(
    "the relation popover lists the target database's rows",
    linkable.some((t) => t.includes("Apollo")) &&
      linkable.some((t) => t.includes("Borealis")),
    linkable.join(" | "),
  );
  await page.click(".menu .menu-item:has-text('Apollo')");
  await page.waitForTimeout(300);
  await page.click(".menu .menu-item:has-text('Borealis')");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  let chips = await page.locator(".cell-relation .relation-chip").allTextContents();
  check(
    "linked rows render as chips showing live titles",
    chips.length === 2 && chips.join(",").includes("Apollo"),
    chips.join(" | "),
  );
  await shot("relations");

  await page.reload();
  await page.waitForSelector(".db-table", { timeout: 10000 });
  await page.waitForTimeout(500);
  chips = await page.locator(".cell-relation .relation-chip").allTextContents();
  check("relation survives reload", chips.length === 2, chips.join(" | "));

  // Renaming the target row updates the chip (ids are stored, not titles).
  await page.click(".cell-relation .relation-chip >> nth=0");
  await page.waitForTimeout(600);
  check(
    "clicking a relation chip navigates to the linked row",
    (await page.inputValue(".page-title")) === "Apollo",
  );
  await page.fill(".page-title", "Apollo Renamed");
  await page.waitForTimeout(600);
  await page.click(".sidebar .tree-title:has-text('Tasks')");
  await page.waitForTimeout(600);
  chips = await page.locator(".cell-relation .relation-chip").allTextContents();
  check(
    "chips follow renames of the linked row",
    chips.join(",").includes("Apollo Renamed"),
    chips.join(" | "),
  );
} catch (err) {
  check(`fatal: ${err.message}`, false);
} finally {
  await browser.close();
}

console.log("\n" + results.join("\n"));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
