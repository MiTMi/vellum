/**
 * Help Center guide check (3/5) — the sharing, privacy and "doing more"
 * guides on /help. Covers: templates, page history,
 * comments, publishing, export/import, embeds & bookmarks, block links,
 * code copy, the Vault, settings and the theme.
 *
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5210 & node scripts/e2e-guide-sharing.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";

const BASE = (process.env.E2E_URL ?? "http://localhost:5210") + "/app.html";
const SHOTS = "/tmp/shots-help3";
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
const context = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

const MOD = "Meta";

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 15000 });

  /* -------------------------------------------------------- templates */
  await page.keyboard.press(`${MOD}+n`);
  await page.waitForTimeout(600);
  await page.fill(".page-title", "Meeting notes");
  await page.waitForTimeout(400);
  await page.click(".bn-editor");
  await page.keyboard.type("Agenda");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Decisions");
  await page.waitForTimeout(600);

  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(400);
  await page.click(".menu-item:has-text('Template')");
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(
    "marking a page as Template moves it to the sidebar's Templates section",
    await page.isVisible(".sidebar-heading:has-text('Templates')"),
  );
  check(
    "template row has a + to start a new page from it",
    await page.isVisible(".template-item .template-use"),
  );

  await page.click(".template-item .template-use");
  await page.waitForTimeout(1000);
  const fromTemplate = await page.textContent(".bn-editor");
  check(
    "the + button creates a copy with the template's content",
    fromTemplate.includes("Agenda") && fromTemplate.includes("Decisions"),
  );

  // The empty-page prompt.
  await page.keyboard.press(`${MOD}+n`);
  await page.waitForTimeout(900);
  check(
    "a brand-new empty page offers 'Start with a template'",
    await page.isVisible(".template-prompt:has-text('Start with a template')"),
  );
  await page.click(".template-prompt-btn:has-text('Meeting notes')");
  await page.waitForTimeout(1500);
  check(
    "picking a template fills the page",
    (await page.textContent(".bn-editor")).includes("Agenda"),
  );
  await page.screenshot({ path: `${SHOTS}/templates.png` });

  // ⌘K also lists templates.
  await page.keyboard.press(`${MOD}+k`);
  await page.waitForTimeout(500);
  check(
    "⌘K lists 'New from template'",
    (await page.textContent(".qs-results")).includes("New from template: Meeting notes"),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* ---------------------------------------------------- page history */
  await page.fill(".page-title", "History demo");
  await page.waitForTimeout(400);
  await page.click(".bn-editor");
  await page.keyboard.press("End");
  await page.keyboard.type(" — first draft");
  await page.waitForTimeout(900);
  await page.keyboard.type(" — second draft");
  await page.waitForTimeout(900);

  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(400);
  check("page menu has Page history", await page.isVisible(".menu-item:has-text('Page history')"));
  await page.click(".menu-item:has-text('Page history')");
  await page.waitForTimeout(900);
  check("history modal opens", await page.isVisible(".history-modal"));
  check("history lists saved versions", (await page.locator(".history-item").count()) > 0);
  check("history previews the selected version", await page.isVisible(".history-preview-text"));
  check("history offers Restore", await page.isVisible("button:has-text('Restore this version')"));
  await page.screenshot({ path: `${SHOTS}/history.png` });
  await page.click("button:has-text('Restore this version')");
  await page.waitForTimeout(1200);
  check("restoring closes the modal and repaints the page", !(await page.isVisible(".history-modal")));

  /* -------------------------------------------------------- comments */
  check("comments panel is on the page", await page.isVisible(".comments"));
  await page.fill(".comment-compose input", "Looks good to me.");
  await page.click(".comment-compose .btn.primary");
  await page.waitForTimeout(800);
  check("comment appears", (await page.textContent(".comment-item")).includes("Looks good to me."));
  check("comment can be resolved", await page.isVisible(".comment-actions .icon-btn[title='Resolve']"));
  await page.click(".comment-actions .icon-btn[title='Resolve']");
  await page.waitForTimeout(700);
  check("resolved comment is marked", await page.isVisible(".comment-item.resolved"));
  await page.click(".comment-actions .icon-btn[title='Delete comment']");
  await page.waitForTimeout(700);
  check("comment deleted", (await page.locator(".comment-item").count()) === 0);

  /* --------------------------------------------------------- sharing */
  await page.click(".share-btn");
  await page.waitForTimeout(500);
  check("share popover has 'Share to web'", await page.isVisible(".prop-menu-label:has-text('Share to web')"));
  check("share popover has an Export section", await page.isVisible(".prop-menu-label:has-text('Export')"));
  check("export offers Markdown/HTML/PDF",
    (await page.textContent(".menu")).includes("Export as Markdown") &&
      (await page.textContent(".menu")).includes("Export as HTML") &&
      (await page.textContent(".menu")).includes("Export as PDF"));
  // Demo mode has no backend to mint a real slug, so the link box itself is
  // covered by tests/publishFlow.test.ts (slug lifecycle) instead. Here we
  // only assert the control the guide tells people to click.
  check("share popover has a 'Publish to web' switch",
    await page.isVisible(".menu-item.toggle-row:has-text('Publish to web') .switch"));
  await page.screenshot({ path: `${SHOTS}/publish.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* ----------------------------------------------- export + import */
  await page.click(".share-btn");
  await page.waitForTimeout(400);
  const [mdDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click(".menu-item:has-text('Export as Markdown')"),
  ]);
  check("Markdown export downloads a .md file", mdDownload.suggestedFilename().endsWith(".md"),
    mdDownload.suggestedFilename());

  await page.click(".share-btn");
  await page.waitForTimeout(400);
  const [htmlDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click(".menu-item:has-text('Export as HTML')"),
  ]);
  check("HTML export downloads an .html file", htmlDownload.suggestedFilename().endsWith(".html"),
    htmlDownload.suggestedFilename());

  // Import a Markdown file into a fresh page.
  await page.keyboard.press(`${MOD}+n`);
  await page.waitForTimeout(800);
  await page.fill(".page-title", "Imported");
  await page.waitForTimeout(400);
  const mdPath = path.join(os.tmpdir(), "vellum-help-import.md");
  fs.writeFileSync(mdPath, "# Imported heading\n\nImported paragraph text.\n");
  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(400);
  check("page menu offers Markdown/HTML import",
    await page.isVisible(".menu-item:has-text('Import Markdown or HTML')"));
  await page.setInputFiles(".page-menu input[type=file]", mdPath);
  await page.waitForTimeout(1500);
  const importedText = await page.textContent(".bn-editor");
  check("imported content lands in the page", importedText.includes("Imported paragraph text."),
    importedText.slice(0, 60));

  /* ---------------------------------------------- embeds & bookmarks */
  await page.keyboard.press("Escape");
  await page.click(".bn-editor");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/embed");
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  check("embed block asks for a URL", await page.isVisible(".embed-input, .embed-block input"));
  await page.fill(".embed-block input", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  check("embed renders a player iframe", (await page.locator(".embed-block iframe").count()) > 0);
  check("embed footer names the provider",
    (await page.textContent(".embed-block")).includes("YouTube"));

  // Fresh page: the embed block above is not editable text, so there is no
  // caret to continue from.
  await page.keyboard.press(`${MOD}+n`);
  await page.waitForTimeout(900);
  await page.click(".bn-editor");
  await page.keyboard.type("/bookmark");
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  check("bookmark block asks for a link", await page.isVisible(".bookmark-input"));
  await page.fill(".bookmark-input", "https://example.com/article");
  await page.click(".bookmark-block .btn:has-text('Create bookmark')");
  await page.waitForTimeout(1500);
  check("bookmark renders a card with the site name",
    (await page.textContent(".bookmark-block")).toLowerCase().includes("example.com"));
  await page.screenshot({ path: `${SHOTS}/embeds.png` });

  /* ------------------------------------------------ code block + copy */
  await page.keyboard.press(`${MOD}+n`);
  await page.waitForTimeout(900);
  await page.click(".bn-editor");
  await page.keyboard.type("/code");
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.keyboard.type("const hello = 1;");
  await page.waitForTimeout(500);
  await page.hover(".bn-editor pre");
  await page.waitForTimeout(500);
  check("hovering a code block reveals a copy button", await page.isVisible(".code-copy-btn"));

  /* --------------------------------------------- copy link to a block */
  await page.hover(".bn-editor pre");
  await page.waitForTimeout(600);
  check("hovering a block reveals 'Copy link to block'", await page.isVisible(".block-anchor-btn"));
  await page.click(".block-anchor-btn");
  await page.waitForTimeout(600);
  const anchorUrl = await page.evaluate(() => navigator.clipboard.readText());
  check("block link is a #/page/<id>/block/<id> URL", /#\/page\/[^/]+\/block\/[^/]+$/.test(anchorUrl),
    anchorUrl.slice(-60));

  /* ------------------------------------------------------------ theme */
  await page.click(".topbar-right .icon-btn[title='Switch to dark mode']");
  await page.waitForTimeout(600);
  check("theme switches to dark", await page.isVisible(".app.theme-dark"));
  await page.click(".topbar-right .icon-btn[title='Switch to light mode']");
  await page.waitForTimeout(500);
  check("theme switches back to light", await page.isVisible(".app.theme-light"));

  /* --------------------------------------------------------- settings */
  await page.keyboard.press(`${MOD}+,`);
  await page.waitForTimeout(600);
  check("⌘, opens Settings", await page.isVisible(".settings-modal"));
  const settingsText = await page.textContent(".settings-body");
  check("Settings has Account, Security and Appearance",
    settingsText.includes("Account") && settingsText.includes("Security") && settingsText.includes("Appearance"));
  check("Appearance has a Light/Dark picker", await page.isVisible(".theme-picker"));
  await page.click(".theme-picker button:has-text('Dark')");
  await page.waitForTimeout(500);
  check("theme picker switches the app", await page.isVisible(".app.theme-dark"));
  await page.click(".theme-picker button:has-text('Light')");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/settings.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  /* ------------------------------------------------------------ vault */
  check("sidebar shows a Vault section", await page.isVisible(".sidebar-heading:has-text('Vault')"));
  await page.click(".vault-create");
  await page.waitForTimeout(900);
  check("vault setup asks for a passphrase", await page.isVisible(".vault-card:has-text('Set your Vault passphrase')"));
  const inputs = page.locator(".vault-input");
  await inputs.nth(0).fill("correct horse battery");
  await inputs.nth(1).fill("correct horse battery");
  await page.click(".vault-btn:has-text('Create Vault')");
  await page.waitForTimeout(1500);
  check("vault unlocks after setup", await page.isVisible(".vault-contents"));
  check("unlocked vault offers New page and Lock now",
    (await page.textContent(".vault-toolbar")).includes("New page") &&
      (await page.textContent(".vault-toolbar")).includes("Lock now"));

  await page.click(".vault-toolbar .vault-btn:has-text('New page')");
  await page.waitForTimeout(900);
  await page.fill(".page-title", "Secret note");
  await page.click(".bn-editor");
  await page.keyboard.type("Nobody else can read this.");
  await page.waitForTimeout(1200);

  // Stored data must be ciphertext.
  const stored = await page.evaluate(() => localStorage.getItem("vellum:mockdb") ?? "");
  check("vault content is never stored as plaintext", !stored.includes("Nobody else can read this."));
  check("vault titles are stored encrypted (venc1:)", stored.includes("venc1:"));

  // ⌘K must not surface vault pages by their text.
  await page.keyboard.press(`${MOD}+k`);
  await page.waitForTimeout(500);
  await page.fill(".qs-input-row input", "Nobody else");
  await page.waitForTimeout(800);
  const qsText = await page.textContent(".qs-results");
  check("vault text never appears in search", !qsText.includes("Secret note"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Lock and confirm the page is gated again.
  await page.click(".sidebar-item:has-text('Vault')");
  await page.waitForTimeout(800);
  await page.click(".vault-btn:has-text('Lock now')");
  await page.waitForTimeout(800);
  check("locking shows the unlock form", await page.isVisible(".vault-card:has-text('Unlock the Vault')"));
  check("sidebar shows a Locked chip", await page.isVisible(".vault-chip:has-text('Locked')"));
  await page.fill(".vault-input", "wrong passphrase");
  await page.click(".vault-btn:has-text('Unlock')");
  await page.waitForTimeout(1200);
  check("a wrong passphrase is rejected", await page.isVisible(".vault-error:has-text('Wrong passphrase')"));
  await page.fill(".vault-input", "correct horse battery");
  await page.click(".vault-btn:has-text('Unlock')");
  await page.waitForTimeout(1500);
  check("the right passphrase unlocks it", await page.isVisible(".vault-contents"));
  check("decrypted titles are listed", (await page.textContent(".vault-list")).includes("Secret note"));
  await page.screenshot({ path: `${SHOTS}/vault.png` });

  // Reload always re-locks.
  await page.reload();
  await page.waitForTimeout(2500);
  check("reloading re-locks the Vault", await page.isVisible(".vault-card:has-text('Unlock the Vault')"));
} catch (err) {
  check(`script error: ${err.message}`, false);
} finally {
  console.log(results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
