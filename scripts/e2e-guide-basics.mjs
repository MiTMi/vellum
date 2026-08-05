/**
 * Help Center guide check (1/5) — every step asserted here is a step written
 * in a guide on /help. If this fails, the guide is wrong.
 *
 * Covers: the workspace tour, the editor, sub-pages, mentions/backlinks,
 * icons & covers, page options, favorites, tabs, ⌘K and the trash.
 *
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5210 & node scripts/e2e-guide-basics.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5210") + "/app.html";
const SHOTS = "/tmp/shots-help1";
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const results = [];
function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ??
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

const MOD = "Meta";

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 15000 });

  /* ---------------------------------------------------- workspace tour */
  check("sidebar has a Search row with ⌘K", await page.isVisible(".sidebar-item:has-text('Search')"));
  check("sidebar has a Private section", await page.isVisible(".sidebar-heading:has-text('Private')"));
  check("sidebar footer has New page", await page.isVisible(".sidebar-footer .new-page"));
  check("tab bar is present", await page.isVisible(".tab-bar"));
  check("top bar has Share", await page.isVisible(".share-btn"));
  check("welcome page was seeded", (await page.locator(".tree-row").count()) > 0);

  /* ------------------------------------------------------ new page ⌘N */
  await page.keyboard.press(`${MOD}+n`);
  await page.waitForTimeout(600);
  await page.fill(".page-title", "Guide test page");
  await page.waitForTimeout(500);
  check(
    "⌘N creates a page and the title saves to the sidebar",
    await page.isVisible(".tree-row:has-text('Guide test page')"),
  );

  /* ------------------------- title Enter jumps into the editor body -- */
  await page.click(".page-title");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.keyboard.type("First line of the page.");
  await page.waitForTimeout(400);
  check(
    "Enter in the title moves the cursor into the body",
    (await page.textContent(".bn-editor")).includes("First line of the page."),
  );

  /* ------------------------------------------ markdown shortcut: ## + space */
  await page.keyboard.press("Enter");
  await page.keyboard.type("## A heading");
  await page.waitForTimeout(400);
  check(
    "typing '## ' makes a heading",
    (await page.locator(".bn-editor h2").count()) > 0,
  );

  /* --------------------------------------------------- slash menu items */
  await page.keyboard.press("Enter");
  await page.keyboard.type("/callout");
  await page.waitForTimeout(600);
  check("slash menu opens and finds Callout", await page.isVisible(".bn-suggestion-menu"));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("callout block inserted", (await page.locator(".callout-block").count()) > 0);
  await page.keyboard.type("Remember this.");
  await page.waitForTimeout(300);

  // Equation
  await page.click(".bn-editor");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/equation");
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const eqBox = await page.locator(".equation-input, .equation-block").count();
  check("equation block inserted", eqBox > 0);
  await page.screenshot({ path: `${SHOTS}/editor.png` });

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* ------------------------------------------------------- table of contents */
  await page.click(".bn-editor p >> nth=0");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table of contents");
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("table of contents block inserted", (await page.locator(".toc-block").count()) > 0);

  /* ---------------------------------------------------------- sub-page */
  await page.click(".bn-editor");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/sub-page");
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  await page.fill(".page-title", "Child page");
  await page.waitForTimeout(500);
  check(
    "/sub-page creates a child page and navigates to it",
    (await page.inputValue(".page-title")) === "Child page",
  );
  const crumbs = await page.textContent(".breadcrumbs");
  check("breadcrumbs show the parent", crumbs.includes("Guide test page"), crumbs.trim());

  /* ------------------------------------------------- @ mention + backlink */
  await page.click(".bn-editor");
  await page.keyboard.type("See ");
  await page.keyboard.type("@Guide test");
  await page.waitForTimeout(800);
  check("@ menu lists matching pages", await page.isVisible(".bn-suggestion-menu"));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  check("mention chip inserted", (await page.locator(".page-mention").count()) > 0);

  // Back to the parent — it should now show a linked mention.
  await page.click(".breadcrumbs .crumb:has-text('Guide test page')");
  await page.waitForTimeout(900);
  check(
    "target page shows Linked mentions",
    await page.isVisible(".backlinks-header:has-text('linked mention')"),
  );
  await page.screenshot({ path: `${SHOTS}/backlinks.png` });

  /* --------------------------------------------------------- icon & cover */
  await page.click(".head-action:has-text('Add icon')");
  await page.waitForTimeout(400);
  check("icon picker opens", await page.isVisible(".icon-picker"));
  await page.waitForSelector(".icon-picker [data-unified]", { timeout: 15000 });
  await page.click(".icon-picker [data-unified] >> nth=0");
  await page.waitForTimeout(600);
  check("page icon set", await page.isVisible(".page-icon"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.click(".head-action:has-text('Add cover')");
  await page.waitForTimeout(400);
  const coverOptions = await page.locator(".cover-swatch").count();
  check("cover picker offers gradients", coverOptions > 0, `${coverOptions} gradients`);
  check("cover picker offers upload", await page.isVisible(".cover-picker button:has-text('Upload image')"));
  await page.click(".cover-swatch >> nth=0");
  await page.waitForTimeout(600);
  check("cover applied", await page.isVisible(".page-cover"));
  await page.keyboard.press("Escape");

  /* ----------------------------------------------------------- favorite */
  await page.click(".topbar-right .icon-btn[title='Add to favorites']");
  await page.waitForTimeout(500);
  check(
    "favorited page appears under Favorites",
    await page.isVisible(".sidebar-heading:has-text('Favorites')"),
  );

  /* ------------------------------------------------------- page menu (…) */
  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(400);
  check("page menu has font options", await page.isVisible(".font-row"));
  check("page menu has Small text toggle", await page.isVisible(".menu-item:has-text('Small text')"));
  check("page menu has Full width toggle", await page.isVisible(".menu-item:has-text('Full width')"));
  check("page menu has Lock page", await page.isVisible(".menu-item:has-text('Lock page')"));
  check("page menu has Template toggle", await page.isVisible(".menu-item:has-text('Template')"));
  check("page menu has Move to", await page.isVisible(".menu-item:has-text('Move to')"));
  check("page menu has Export as Markdown", await page.isVisible(".menu-item:has-text('Export as Markdown')"));
  check("page menu shows a word count", (await page.textContent(".menu-footer")).includes("Word count"));
  await page.screenshot({ path: `${SHOTS}/pagemenu.png` });

  // Serif font
  await page.click(".font-option.font-serif");
  await page.waitForTimeout(500);
  check("serif font applies", await page.isVisible(".page-view.font-serif"));
  await page.click(".font-option.font-default");
  await page.waitForTimeout(300);

  // Lock the page and confirm the editor goes read-only.
  await page.click(".menu-item:has-text('Lock page')");
  await page.waitForTimeout(600);
  check("locked page shows the lock note", await page.isVisible(".locked-note"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(300);
  await page.click(".menu-item:has-text('Lock page')");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  check("page unlocks again", !(await page.isVisible(".locked-note")));

  /* ------------------------------------------------------------- ⌘K */
  await page.keyboard.press(`${MOD}+k`);
  await page.waitForTimeout(500);
  check("⌘K opens the switcher", await page.isVisible(".quick-switcher"));
  check("actions section listed", await page.isVisible(".qs-section:has-text('Actions')"));
  const actionText = await page.textContent(".qs-results");
  check("New page action", actionText.includes("New page"));
  check("New database action", actionText.includes("New database"));
  check("theme action", actionText.toLowerCase().includes("mode"));
  check("Open trash action", actionText.includes("Open trash"));
  check("Settings action", actionText.includes("Settings"));
  await page.fill(".qs-input-row input", "First line");
  await page.waitForTimeout(800);
  const hasSnippet = await page.isVisible(".qs-snippet");
  check("full-text search finds body text with a snippet", hasSnippet);
  await page.screenshot({ path: `${SHOTS}/quickswitcher.png` });
  await page.keyboard.press("Escape");

  /* ------------------------------------------------------------- tabs */
  const tabsBefore = await page.locator(".tab").count();
  await page.keyboard.press(`${MOD}+t`);
  await page.waitForTimeout(400);
  check("⌘T opens a new tab", (await page.locator(".tab").count()) === tabsBefore + 1);
  await page.click(".tab.active .tab-close");
  await page.waitForTimeout(400);
  check("tab closes", (await page.locator(".tab").count()) === tabsBefore);

  /* ------------------------------------------------- sidebar collapse ⌘\ */
  await page.keyboard.press(`${MOD}+\\`);
  await page.waitForTimeout(400);
  check("⌘\\ collapses the sidebar", !(await page.isVisible(".sidebar")));
  await page.keyboard.press(`${MOD}+\\`);
  await page.waitForTimeout(400);
  check("⌘\\ reopens the sidebar", await page.isVisible(".sidebar"));

  /* ------------------------------------------------------ duplicate ⌘D */
  await page.keyboard.press(`${MOD}+d`);
  await page.waitForTimeout(900);
  const dupTitle = await page.inputValue(".page-title");
  check("⌘D duplicates the page", dupTitle.includes("copy") || dupTitle.includes("Copy"), dupTitle);

  /* ------------------------------------------------------------ trash */
  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(300);
  await page.click(".menu-item:has-text('Move to Trash')");
  await page.waitForTimeout(700);
  await page.click(".sidebar-footer .icon-btn[title='Trash']");
  await page.waitForTimeout(500);
  check("trash modal lists the deleted page", await page.isVisible(".trash-row"));
  check("trash offers Empty trash", await page.isVisible("button:has-text('Empty trash')"));
  await page.click(".trash-row .icon-btn[title='Restore']");
  await page.waitForTimeout(700);
  check("restore reopens the page", await page.isVisible(".page-title"));
  await page.screenshot({ path: `${SHOTS}/final.png` });
} catch (err) {
  check(`script error: ${err.message}`, false);
} finally {
  console.log(results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
