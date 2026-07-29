/**
 * E2E smoke drive for Vellum (mock data mode).
 * Drives the real UI in Chromium and asserts the core flows work.
 * Usage: node scripts/e2e.mjs [--shots-dir /tmp/shots]
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") {
    const url = msg.location()?.url ?? "";
    consoleErrors.push(`${msg.text()} [${url}]`);
  }
});

async function shot(name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

try {
  // ---------- boot & bootstrap ----------
  await page.goto(BASE);
  await page.waitForSelector(".sidebar", { timeout: 10000 });
  await page.waitForSelector(".page-title", { timeout: 10000 });
  const title = await page.inputValue(".page-title");
  check("bootstrap seeds welcome page", title === "Welcome to Vellum", title);
  await page.waitForSelector(".bn-editor", { timeout: 10000 });
  const bodyText = await page.textContent(".bn-editor");
  check("welcome content renders", bodyText.includes("Things to try"));
  await shot("01-welcome");

  // ---------- create a page & type in the editor ----------
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Meeting Notes");
  await page.waitForTimeout(500);
  const sidebarHasPage = await page
    .locator(".tree-title", { hasText: "Meeting Notes" })
    .count();
  check("rename reflects in sidebar", sidebarHasPage > 0);

  await page.click(".bn-editor");
  await page.keyboard.type("Agenda for Monday");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700); // debounce flush
  check(
    "editor text persists in doc",
    (await page.textContent(".bn-editor")).includes("Agenda for Monday"),
  );

  // ---------- slash menu ----------
  await page.keyboard.type("/head");
  await page.waitForTimeout(400);
  const suggestionVisible = await page.locator(".bn-suggestion-menu, [class*='suggestion']").first().isVisible().catch(() => false);
  check("slash menu opens", suggestionVisible);
  await shot("02-slash-menu");
  await page.keyboard.press("Enter"); // pick Heading 1
  await page.keyboard.type("Big heading");
  await page.waitForTimeout(600);
  const h1 = await page.locator(".bn-editor h1, .bn-editor [data-level='1']").count();
  check("heading block inserted", h1 > 0);

  // ---------- icon picker ----------
  await page.hover(".page-head");
  await page.click(".head-action:has-text('Add icon')");
  await page.waitForSelector(".EmojiPickerReact", { timeout: 15000 });
  await page.click(".EmojiPickerReact button.epr-emoji:first-child, .EmojiPickerReact .epr-emoji-category-content button >> nth=0");
  await page.waitForTimeout(400);
  const iconSet = await page.locator(".page-icon").count();
  check("icon picker sets icon", iconSet > 0);

  // ---------- cover ----------
  await page.hover(".page-head");
  await page.click(".head-action:has-text('Add cover')");
  await page.waitForSelector(".cover-swatch");
  await page.click(".cover-swatch >> nth=6");
  await page.waitForTimeout(400);
  check("cover applied", (await page.locator(".page-cover").count()) > 0);
  await shot("03-page-with-cover");

  // ---------- reload persistence (mock uses localStorage) ----------
  await page.reload();
  await page.waitForSelector(".page-title");
  check(
    "content survives reload",
    (await page.textContent(".bn-editor")).includes("Agenda for Monday"),
  );

  // ---------- sub-page via sidebar + breadcrumbs ----------
  await page.hover(".tree-row:has-text('Meeting Notes')");
  await page.click(".tree-row:has-text('Meeting Notes') .tree-action[title='Add a page inside']");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Sub note");
  await page.waitForTimeout(500);
  const crumbs = await page.locator(".breadcrumbs .crumb").allTextContents();
  check(
    "breadcrumbs show parent / child",
    crumbs.some((c) => c.includes("Meeting Notes")) && crumbs.some((c) => c.includes("Sub note")),
    crumbs.join(" | "),
  );

  // ---------- quick switcher ----------
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.waitForSelector(".quick-switcher input");
  await page.fill(".quick-switcher input", "Meeting");
  await page.waitForTimeout(400);
  const qsRows = await page.locator(".qs-row .qs-title").allTextContents();
  check("search finds page", qsRows.some((t) => t.includes("Meeting Notes")), qsRows.join(","));
  await shot("04-quick-switcher");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check(
    "switcher navigates",
    (await page.inputValue(".page-title")) === "Meeting Notes",
  );

  // ---------- favorites ----------
  await page.click(".topbar .icon-btn[title*='favorites']");
  await page.waitForTimeout(300);
  const favVisible = await page.locator(".sidebar-heading:has-text('Favorites')").count();
  check("favorite adds sidebar section", favVisible > 0);

  // ---------- database: create, rename, rows ----------
  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.click(".menu-item:has-text('New database')");
  await page.waitForTimeout(500);
  await page.fill(".page-title", "Projects");
  await page.waitForTimeout(400);
  await page.waitForSelector(".db-table");
  const headers = await page.locator(".db-table th .th-label").allTextContents();
  check(
    "default database columns",
    headers.includes("Name") && headers.includes("Status") && headers.includes("Tags"),
    headers.join(","),
  );

  // new row
  await page.click(".new-row-btn");
  await page.waitForTimeout(300);
  await page.keyboard.type("Website redesign");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check(
    "row created with title",
    (await page.locator(".row-title:has-text('Website redesign')").count()) > 0,
  );

  // set select value
  await page.click(".db-table tbody tr >> nth=0 >> .cell-select");
  await page.waitForSelector(".select-popover");
  await page.click(".select-option-row:has-text('In progress')");
  await page.waitForTimeout(400);
  check(
    "select chip set",
    (await page.locator(".db-table .chip:has-text('In progress')").count()) > 0,
  );

  // create option inline
  await page.click(".db-table tbody tr >> nth=0 >> .cell-multiSelect");
  await page.waitForSelector(".select-popover");
  await page.fill(".select-search", "design");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(
    "multi-select option created",
    (await page.locator(".db-table .chip:has-text('design')").count()) > 0,
  );

  // date cell
  await page.click(".db-table tbody tr >> nth=0 >> .cell-date");
  await page.waitForSelector(".date-popover input");
  await page.fill(".date-popover input", "2026-08-15");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const dateText = await page.textContent(".db-table tbody tr >> nth=0 >> .cell-date");
  check("date cell set", dateText.includes("2026"), dateText);

  // add a property
  await page.click(".db-table th.col-add .th-btn.add");
  await page.waitForTimeout(400);
  const newHeaders = await page.locator(".db-table th .th-label").allTextContents();
  check("add property", newHeaders.length === headers.length + 1, newHeaders.join(","));

  // rename property via menu
  await page.click(".db-table th .th-btn:has-text('Property')");
  await page.waitForSelector(".prop-menu");
  await page.fill(".prop-name-input", "Budget");
  await page.click(".prop-type-btn");
  await page.click(".prop-type-list .menu-item:has-text('Number')");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(
    "property renamed + retyped",
    (await page.locator(".db-table th .th-label:has-text('Budget')").count()) > 0,
  );

  // number cell
  await page.click(".db-table tbody tr >> nth=0 >> .cell-number");
  await page.keyboard.type("12000");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check(
    "number cell set",
    (await page.textContent(".db-table tbody tr >> nth=0 >> .cell-number")).includes("12000"),
  );

  // second row for board
  await page.click(".new-row-btn");
  await page.keyboard.type("Mobile app");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await shot("05-table");

  // ---------- board view ----------
  await page.click(".db-tab:has-text('Board')");
  await page.waitForSelector(".board-view");
  const colHeads = await page.locator(".board-col-head .chip").allTextContents();
  check(
    "board columns from select options",
    colHeads.includes("In progress") && colHeads.includes("Not started"),
    colHeads.join(","),
  );
  check(
    "card in right column",
    (await page.locator(".board-col:has(.chip:has-text('In progress')) .board-card:has-text('Website redesign')").count()) > 0,
  );

  // drag card to Done column
  const card = page.locator(".board-card:has-text('Website redesign')");
  const doneCol = page.locator(".board-col:has(.board-col-head .chip:has-text('Done'))");
  await card.dragTo(doneCol);
  await page.waitForTimeout(500);
  check(
    "drag card between columns",
    (await page.locator(".board-col:has(.board-col-head .chip:has-text('Done')) .board-card:has-text('Website redesign')").count()) > 0,
  );
  await shot("06-board");

  // ---------- row opens as page with props panel ----------
  await page.click(".board-card:has-text('Website redesign')");
  await page.waitForSelector(".row-props");
  const propNames = await page.locator(".row-prop-name").allTextContents();
  check(
    "row page shows property panel",
    propNames.some((p) => p.includes("Status")) && propNames.some((p) => p.includes("Budget")),
    propNames.join(","),
  );
  await page.click(".bn-editor");
  await page.keyboard.type("Row body text works too");
  await page.waitForTimeout(700);
  await shot("07-row-page");

  // ---------- trash & restore ----------
  await page.hover(".tree-row:has-text('Sub note')");
  await page.click(".tree-row:has-text('Sub note') .tree-action[title='More']");
  await page.click(".menu-item:has-text('Move to trash')");
  await page.waitForTimeout(400);
  check(
    "trashed page leaves sidebar",
    (await page.locator(".tree-row:has-text('Sub note')").count()) === 0,
  );
  await page.click(".sidebar-footer .icon-btn[title='Trash']");
  await page.waitForSelector(".trash-modal");
  check(
    "trash lists page",
    (await page.locator(".trash-row:has-text('Sub note')").count()) > 0,
  );
  await page.click(".trash-row:has-text('Sub note') .icon-btn[title='Restore']");
  await page.waitForTimeout(400);
  check(
    "restore returns page & navigates",
    (await page.inputValue(".page-title")) === "Sub note",
  );

  // ---------- dark mode ----------
  await page.click(".topbar .icon-btn[title*='dark mode']");
  await page.waitForTimeout(300);
  const themeAttr = await page.getAttribute("html", "data-theme");
  check("dark mode toggles", themeAttr === "dark");
  await shot("08-dark-mode");

  // navigate to the database in dark mode for a screenshot
  await page.click(".tree-row:has-text('Projects')");
  await page.waitForTimeout(500);
  await shot("09-dark-table");

  // ---------- back / forward ----------
  await page.click(".topbar .icon-btn[title='Back']");
  await page.waitForTimeout(300);
  check(
    "back navigation",
    (await page.inputValue(".page-title")) === "Sub note",
  );
  await page.click(".topbar .icon-btn[title='Forward']");
  await page.waitForTimeout(300);
  check(
    "forward navigation",
    (await page.inputValue(".page-title")) === "Projects",
  );
} catch (err) {
  check(`UNCAUGHT: ${err.message}`, false);
  await shot("99-failure");
} finally {
  const relevantConsole = consoleErrors.filter(
    (e) => !e.includes("favicon") && !e.includes("Download the React DevTools"),
  );
  if (relevantConsole.length) {
    results.push(`console errors (${relevantConsole.length}):`);
    for (const e of relevantConsole.slice(0, 8)) results.push("   " + e.slice(0, 200));
  }
  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
