/**
 * Help Center guide check (5/5) — the writing guides on /help. Covers: the markdown shortcuts and
 * block affordances the "Writing" guides promise.
 *
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5210 & node scripts/e2e-guide-writing.mjs
 */
import { chromium } from "playwright";

const BASE = (process.env.E2E_URL ?? "http://localhost:5210") + "/app.html";

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

  await page.keyboard.press(`${MOD}+n`);
  await page.waitForTimeout(700);
  await page.fill(".page-title", "Markdown shortcuts");
  await page.waitForTimeout(400);
  await page.click(".bn-editor");

  const type = async (text) => {
    await page.keyboard.type(text);
    await page.waitForTimeout(350);
  };
  const newBlock = async () => {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  };

  await type("# Big heading");
  check("'# ' makes a Heading 1", (await page.locator(".bn-editor h1").count()) > 0);
  await newBlock();
  await type("## Medium heading");
  check("'## ' makes a Heading 2", (await page.locator(".bn-editor h2").count()) > 0);
  await newBlock();
  await type("### Small heading");
  check("'### ' makes a Heading 3", (await page.locator(".bn-editor h3").count()) > 0);
  await newBlock();
  await type("- a bullet");
  check(
    "'- ' makes a bullet list",
    (await page.locator(".bn-editor [data-content-type=bulletListItem]").count()) > 0,
  );
  await newBlock();
  await newBlock();
  await type("1. a numbered item");
  check(
    "'1. ' makes a numbered list",
    (await page.locator(".bn-editor [data-content-type=numberedListItem]").count()) > 0,
  );
  await newBlock();
  await newBlock();
  await type("[] a task");
  const checkboxes = await page.locator(".bn-editor input[type=checkbox]").count();
  check("'[] ' makes a check list", checkboxes > 0, `${checkboxes} checkboxes`);
  await newBlock();
  await newBlock();
  await type("> a quotation");
  check("'> ' makes a quote", (await page.locator(".bn-editor blockquote").count()) > 0);
  await newBlock();
  await newBlock();
  await type("**bold** and *italic* text");
  const bolds = await page.locator(".bn-editor strong").count();
  const italics = await page.locator(".bn-editor em").count();
  check("'**' and '*' style text inline", bolds > 0 && italics > 0, `${bolds} bold / ${italics} italic`);

  /* ------------------------------------------- block handles and menu */
  await page.hover(".bn-editor h1");
  await page.waitForTimeout(500);
  const handles = await page.locator(".bn-block-side-menu button, .bn-side-menu button").count();
  check("hovering a block reveals its handle buttons", handles > 0, `${handles} buttons`);

  /* ---------------------------------------------- selection toolbar */
  await page.click(".bn-editor h1");
  await page.keyboard.press(`${MOD}+a`);
  await page.waitForTimeout(600);
  check(
    "selecting text opens the formatting toolbar",
    await page.isVisible(".bn-formatting-toolbar"),
  );
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);

  /* ------------------------------------------ /table inserts a table */
  await page.click(".bn-editor p >> nth=-1").catch(() => {});
  await page.keyboard.press("End");
  await newBlock();
  await type("/table");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  check("'/table' inserts a table", (await page.locator(".bn-editor table").count()) > 0);

  /* ------------------------------------------- copy page contents */
  await page.waitForTimeout(800);
  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(400);
  await page.click(".menu-item:has-text('Copy page contents')");
  await page.waitForTimeout(900);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("'Copy page contents' copies the page as Markdown",
    clip.includes("# Big heading") && clip.includes("a bullet"), clip.slice(0, 120).replace(/\n/g, "⏎"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* --------------------------------------- small text & full width */
  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(400);
  await page.click(".menu-item:has-text('Small text')");
  await page.waitForTimeout(600);
  check("Small text narrows the type", await page.isVisible(".page-view.small-text"));
  await page.click(".menu-item:has-text('Full width')");
  await page.waitForTimeout(600);
  check("Full width widens the page", await page.isVisible(".page-inner.full"));
  await page.keyboard.press("Escape");
} catch (err) {
  check(`script error: ${err.message}`, false);
} finally {
  console.log(results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
