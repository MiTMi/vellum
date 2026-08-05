/**
 * Help Center guide check (4/5) — the organising and navigation guides on
 * /help. Covers: organising the sidebar
 * (drag to reorder / nest, Move to, rename, sub-pages), navigation (back /
 * forward, breadcrumbs, recents, tab persistence) and the small print of the
 * sidebar itself (resize, right-click New page).
 *
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5210 & node scripts/e2e-guide-organizing.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5210") + "/app.html";
const SHOTS = "/tmp/shots-help4";
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
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

const MOD = "Meta";

/** HTML5 drag-and-drop that Playwright's mouse API can't synthesise. */
async function dragTree(fromText, toText, zone /* "inside" | "before" */) {
  // The drag state lives in React, so each phase needs its own tick —
  // firing dragstart/dragover/drop in one go leaves dragId still null.
  await page.evaluate((fromText) => {
    const rows = [...document.querySelectorAll(".tree-row")];
    const src = rows.find((r) => r.textContent.includes(fromText));
    if (!src) throw new Error(`row not found: ${fromText}`);
    window.__dt = new DataTransfer();
    src.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__dt }),
    );
  }, fromText);
  await page.waitForTimeout(300);

  await page.evaluate(
    ({ toText, zone }) => {
      const rows = [...document.querySelectorAll(".tree-row")];
      const dst = rows.find((r) => r.textContent.includes(toText));
      if (!dst) throw new Error(`row not found: ${toText}`);
      const box = dst.getBoundingClientRect();
      const y = zone === "inside" ? box.top + box.height / 2 : box.top + 2;
      dst.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: window.__dt,
          clientX: box.left + 40,
          clientY: y,
        }),
      );
    },
    { toText, zone },
  );
  await page.waitForTimeout(300);

  await page.evaluate(
    ({ toText, zone }) => {
      const rows = [...document.querySelectorAll(".tree-row")];
      const dst = rows.find((r) => r.textContent.includes(toText));
      const box = dst.getBoundingClientRect();
      const y = zone === "inside" ? box.top + box.height / 2 : box.top + 2;
      dst.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: window.__dt,
          clientX: box.left + 40,
          clientY: y,
        }),
      );
    },
    { toText, zone },
  );
  await page.waitForTimeout(800);
}

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 15000 });

  /* ------------------------------------------- right-click on New page */
  await page.click(".sidebar-footer .new-page", { button: "right" });
  await page.waitForTimeout(400);
  check(
    "right-clicking New page offers page or database",
    (await page.textContent(".menu")).includes("New database"),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* --------------------------------------------------- three top pages */
  for (const title of ["Alpha", "Beta", "Gamma"]) {
    await page.keyboard.press(`${MOD}+n`);
    await page.waitForTimeout(600);
    await page.fill(".page-title", title);
    await page.waitForTimeout(500);
  }
  const order = () =>
    page.$$eval(".tree-root > .tree-node > .tree-row .tree-title", (els) =>
      els.map((e) => e.textContent),
    );
  check("all three pages are at the top level", (await order()).join(",").includes("Alpha,Beta,Gamma"),
    (await order()).join(","));

  /* ------------------------------------------ drag to reorder (before) */
  await dragTree("Gamma", "Alpha", "before");
  const reordered = await order();
  check("dragging a page above another reorders the sidebar",
    reordered.indexOf("Gamma") < reordered.indexOf("Alpha"), reordered.join(","));

  /* -------------------------------------------- drag onto a page (nest) */
  await dragTree("Beta", "Alpha", "inside");
  await page.waitForTimeout(600);
  check("dropping a page onto another nests it",
    await page.isVisible(".tree-children .tree-row:has-text('Beta')"));
  await page.screenshot({ path: `${SHOTS}/tree.png` });

  /* ------------------------------------- the chevron collapses children */
  await page.click(".tree-row:has-text('Alpha') .tree-chevron");
  await page.waitForTimeout(500);
  check("the chevron collapses a page's children",
    !(await page.isVisible(".tree-children .tree-row:has-text('Beta')")));
  await page.click(".tree-row:has-text('Alpha') .tree-chevron");
  await page.waitForTimeout(400);

  /* -------------------------------------------- hover actions: + and … */
  await page.hover(".tree-row:has-text('Alpha')");
  await page.waitForTimeout(400);
  check("hovering a page shows + (add a page inside)",
    await page.isVisible(".tree-row:has-text('Alpha') .tree-action[title='Add a page inside']"));
  await page.click(".tree-row:has-text('Alpha') .tree-action[title='More']");
  await page.waitForTimeout(400);
  const rowMenu = await page.textContent(".menu");
  check("the row menu has favorite / rename / duplicate / trash",
    ["favorites", "Rename", "Duplicate", "Move to trash"].every((t) => rowMenu.includes(t)), rowMenu.replace(/\s+/g, " "));
  await page.click(".menu-item:has-text('Rename')");
  await page.waitForTimeout(400);
  await page.fill(".tree-rename", "Alpha renamed");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  check("renaming from the sidebar works", await page.isVisible(".tree-row:has-text('Alpha renamed')"));

  /* --------------------------------------------------------- Move to */
  await page.click(".tree-row:has-text('Beta')");
  await page.waitForTimeout(700);
  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(400);
  await page.click(".menu-item:has-text('Move to')");
  await page.waitForTimeout(500);
  check("Move to offers a search box", await page.isVisible("input[placeholder='Move page to…']"));
  check("Move to can send a page back to the top level",
    await page.isVisible(".menu-item:has-text('Move to top level')"));
  await page.click(".menu-item:has-text('Move to top level')");
  await page.waitForTimeout(800);
  check("the page is at the top level again",
    (await order()).includes("Beta"), (await order()).join(","));

  /* -------------------------------------------- back / forward / crumbs */
  await page.click(".tree-row:has-text('Gamma')");
  await page.waitForTimeout(600);
  await page.click(".topbar-left .icon-btn[title='Back']");
  await page.waitForTimeout(600);
  check("Back returns to the previous page", (await page.inputValue(".page-title")) === "Beta",
    await page.inputValue(".page-title"));
  await page.click(".topbar-left .icon-btn[title='Forward']");
  await page.waitForTimeout(600);
  check("Forward goes back again", (await page.inputValue(".page-title")) === "Gamma");

  /* ------------------------------------------------------------ recents */
  check("sidebar has a Recents list", await page.isVisible(".sidebar-heading:has-text('Recents')"));

  /* ------------------------------------------- favorites add and remove */
  await page.click(".topbar-right .icon-btn[title='Add to favorites']");
  await page.waitForTimeout(600);
  check("page is favorited", await page.isVisible(".sidebar-heading:has-text('Favorites')"));
  await page.click(".topbar-right .icon-btn[title='Remove from favorites']");
  await page.waitForTimeout(600);
  check("unfavoriting removes the section",
    !(await page.isVisible(".sidebar-heading:has-text('Favorites')")));

  /* --------------------------------------- tabs survive a reload */
  await page.keyboard.press(`${MOD}+t`);
  await page.waitForTimeout(400);
  await page.click(".tree-row:has-text('Alpha renamed')");
  await page.waitForTimeout(700);
  const tabCount = await page.locator(".tab").count();
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 15000 });
  await page.waitForTimeout(800);
  check("open tabs come back after a reload",
    (await page.locator(".tab").count()) === tabCount, `${tabCount} tabs`);
  check("the active tab reopens its page",
    (await page.inputValue(".page-title")) === "Alpha renamed",
    await page.inputValue(".page-title"));

  /* --------------------------------------------------- sidebar resize */
  const before = await page.evaluate(() => document.querySelector(".sidebar").getBoundingClientRect().width);
  const box = await page.locator(".sidebar-resizer").boundingBox();
  await page.mouse.move(box.x + 1, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => document.querySelector(".sidebar").getBoundingClientRect().width);
  check("the sidebar can be dragged wider", after > before + 40, `${before} → ${after}`);
  await page.screenshot({ path: `${SHOTS}/sidebar.png` });
} catch (err) {
  check(`script error: ${err.message}`, false);
} finally {
  console.log(results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
