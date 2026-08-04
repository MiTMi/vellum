/**
 * E2E: the embed block and the export menu (mock mode — no backend, no auth).
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5199 & node scripts/e2e-embeds.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5199") + "/app.html";
const SHOTS = "/tmp/shots-embeds";
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

// Never let the test actually pull third-party players over the network.
await page.route(/youtube\.com|figma\.com|maps\.google\.com/, (route) =>
  route.fulfill({ status: 200, contentType: "text/html", body: "<p>stub</p>" }),
);

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Embeds playground");
  await page.click(".bn-editor");

  // ---------- insert an embed block from the slash menu ----------
  await page.keyboard.type("/embed");
  await page.waitForTimeout(500);
  // Assert "/embed" selects the Embed item — the bookmark block used to
  // claim that alias and would silently win the Enter key.
  const firstItem = (
    await page.textContent(
      ".bn-suggestion-menu [data-selected], .bn-suggestion-menu-item",
    )
  ).trim();
  check(
    "'/embed' selects the Embed item, not 'File'",
    firstItem.startsWith("Embed") && !firstItem.startsWith("File"),
    firstItem,
  );
  await page.keyboard.press("Enter");
  await page.waitForSelector(".embed-block.empty", { timeout: 5000 });
  check("slash menu inserts an embed block", true);

  // The button must stay disabled until the URL is actually embeddable.
  await page.fill(".embed-input", "not a url");
  const disabled = await page.isDisabled(".embed-block.empty .btn");
  check("Embed button disabled for a non-URL", disabled);

  // ---------- YouTube URL becomes a player iframe ----------
  await page.fill(".embed-input", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.click(".embed-block.empty .btn");
  await page.waitForSelector(".embed-block .embed-frame iframe", { timeout: 5000 });
  const src = await page.getAttribute(".embed-frame iframe", "src");
  check(
    "YouTube link renders the embed player",
    src === "https://www.youtube.com/embed/dQw4w9WgXcQ",
    src,
  );
  const provider = await page.textContent(".embed-provider");
  check("provider label shows YouTube", provider.trim() === "YouTube", provider);

  const sandbox = await page.getAttribute(".embed-frame iframe", "sandbox");
  check(
    "iframe is sandboxed",
    !!sandbox && sandbox.includes("allow-scripts") && !sandbox.includes("allow-top-navigation"),
    sandbox,
  );

  // ---------- it survives a reload (props persisted, not component state) ----
  await page.waitForTimeout(700); // debounced save
  await page.reload();
  await page.waitForSelector(".embed-frame iframe", { timeout: 10000 });
  const srcAfter = await page.getAttribute(".embed-frame iframe", "src");
  check("embed persists across reload", srcAfter === src, srcAfter);

  // The player should fill the writing column, not sit at some intrinsic size.
  const widths = await page.evaluate(() => ({
    frame: document.querySelector(".embed-frame").getBoundingClientRect().width,
    column: document.querySelector(".bn-editor").getBoundingClientRect().width,
  }));
  check(
    "player fills the column width",
    widths.frame > widths.column * 0.9,
    `${Math.round(widths.frame)}px of ${Math.round(widths.column)}px`,
  );
  await page.screenshot({ path: `${SHOTS}/embed.png` });

  // ---------- export menu offers PDF ----------
  await page.click(".topbar .icon-btn[title='More'], .topbar-more, .page-more", {
    timeout: 5000,
  }).catch(async () => {
    // Fall back to the sidebar row menu if the top bar button moved.
    await page.click(".tree-item .tree-more", { force: true });
  });
  await page.waitForSelector(".page-menu", { timeout: 5000 });
  const menuText = await page.textContent(".page-menu");
  check("menu offers Export as PDF", menuText.includes("Export as PDF"));
  check(
    "menu offers Markdown + HTML import/export",
    menuText.includes("Export as Markdown") &&
      menuText.includes("Export as HTML") &&
      menuText.includes("Import Markdown or HTML"),
  );
  await page.screenshot({ path: `${SHOTS}/export-menu.png` });
} catch (err) {
  check(`fatal: ${err.message}`, false);
} finally {
  await browser.close();
}

console.log("\n" + results.join("\n"));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
