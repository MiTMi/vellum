/**
 * E2E part 5: the "..." page menu — fonts, toggles, lock, move-to,
 * copy contents, import markdown, word count.
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.E2E_URL ?? "http://localhost:5199";
const SHOTS = "/tmp/shots-pagemenu";
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
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

const openMenu = async () => {
  await page.click(".topbar .icon-btn[title='More']");
  await page.waitForSelector(".page-menu");
};

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  // ---------- menu opens with all sections ----------
  await openMenu();
  check("font row renders", (await page.locator(".font-option").count()) === 3);
  check(
    "toggles render",
    (await page.locator(".toggle-row:has-text('Small text')").count()) === 1 &&
      (await page.locator(".toggle-row:has-text('Full width')").count()) === 1 &&
      (await page.locator(".toggle-row:has-text('Lock page')").count()) === 1,
  );
  const footer = await page.textContent(".menu-footer");
  check("word count footer", /Word count: \d+ words/.test(footer ?? ""), footer?.slice(0, 40));
  await page.screenshot({ path: `${SHOTS}/40-menu.png` });

  // ---------- serif font ----------
  await page.click(".font-option.font-serif");
  await page.waitForTimeout(400);
  const ff = await page.evaluate(
    () => getComputedStyle(document.querySelector(".page-title")).fontFamily,
  );
  check("serif font applies", ff.toLowerCase().includes("georgia"), ff);
  await page.click(".font-option.font-default");
  await page.waitForTimeout(300);

  // ---------- small text & full width ----------
  await page.click(".toggle-row:has-text('Small text')");
  await page.waitForTimeout(400);
  const fs2 = await page.evaluate(
    () => getComputedStyle(document.querySelector(".bn-editor")).fontSize,
  );
  check("small text applies", fs2 === "14px", fs2);
  await page.click(".toggle-row:has-text('Full width')");
  await page.waitForTimeout(400);
  check(
    "full width applies",
    (await page.locator(".page-inner.full").count()) === 1,
  );
  await page.screenshot({ path: `${SHOTS}/41-fullwidth.png` });
  await page.click(".toggle-row:has-text('Small text')");
  await page.click(".toggle-row:has-text('Full width')");
  await page.waitForTimeout(300);

  // ---------- copy page contents ----------
  await page.click(".menu-item:has-text('Copy page contents')");
  await page.waitForTimeout(500);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("copy contents puts markdown on clipboard", clip.includes("Things to try"), clip.slice(0, 40));
  await page.keyboard.press("Escape");

  // ---------- lock page ----------
  await openMenu();
  await page.click(".toggle-row:has-text('Lock page')");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check("locked note shows", (await page.locator(".locked-note").count()) === 1);
  const editable = await page.evaluate(
    () => document.querySelector(".bn-editor")?.getAttribute("contenteditable"),
  );
  check("editor not editable when locked", editable === "false", String(editable));
  const titleRO = await page.evaluate(
    () => document.querySelector(".page-title")?.hasAttribute("readonly"),
  );
  check("title readonly when locked", titleRO === true);
  // unlock
  await openMenu();
  await page.click(".toggle-row:has-text('Lock page')");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(
    "unlock restores editing",
    (await page.evaluate(
      () => document.querySelector(".bn-editor")?.getAttribute("contenteditable"),
    )) === "true",
  );

  // ---------- move to ----------
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Target parent");
  await page.waitForTimeout(400);
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Wandering page");
  await page.waitForTimeout(400);
  await openMenu();
  await page.click(".menu-item:has-text('Move to')");
  await page.waitForSelector(".qs-input-row.small input");
  await page.fill(".qs-input-row.small input", "Target");
  await page.waitForTimeout(300);
  await page.click(".menu-item:has-text('Target parent')");
  await page.waitForTimeout(500);
  const crumbs = await page.locator(".breadcrumbs .crumb").allTextContents();
  check(
    "move-to reparents page",
    crumbs.some((c) => c.includes("Target parent")) &&
      crumbs.some((c) => c.includes("Wandering page")),
    crumbs.join(" | "),
  );

  // ---------- import markdown ----------
  fs.writeFileSync(
    "/tmp/e2e-import.md",
    "## Imported heading\n\n- alpha bullet\n- beta bullet\n",
  );
  await openMenu();
  await page.locator(".page-menu input[type='file']").setInputFiles("/tmp/e2e-import.md");
  await page.waitForTimeout(700);
  const body = await page.textContent(".bn-editor");
  check(
    "markdown import appends blocks",
    body.includes("Imported heading") && body.includes("alpha bullet"),
  );
  await page.screenshot({ path: `${SHOTS}/42-import.png` });

  // ---------- duplicate via menu ----------
  await openMenu();
  await page.click(".menu-item:has-text('Duplicate')");
  await page.waitForTimeout(500);
  check(
    "duplicate navigates to copy",
    (await page.inputValue(".page-title")).includes("(copy)"),
  );

  // ---------- database menu: CSV + row count footer ----------
  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.click(".menu-item:has-text('New database')");
  await page.waitForTimeout(500);
  await openMenu();
  const dbFooter = await page.textContent(".menu-footer");
  check("db footer shows row count", /\d+ rows?/.test(dbFooter ?? ""), dbFooter?.slice(0, 30));
  check(
    "db menu offers CSV export",
    (await page.locator(".menu-item:has-text('Export as CSV')").count()) === 1,
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
