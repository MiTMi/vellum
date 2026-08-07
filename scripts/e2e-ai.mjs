/**
 * E2E: the three AI features (mock mode — deterministic stubs, no key, no
 * network). Covers the selection menu, writing from a blank line, the AI
 * database column, and workspace Q&A.
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5199 & node scripts/e2e-ai.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5199") + "/app.html";
const SHOTS = "/tmp/shots-ai";
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

const mod = process.platform === "darwin" ? "Meta" : "Control";

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  /* ---------------- 1. selection menu: improve writing ---------------- */

  await page.fill(".page-title", "AI test page");
  await page.click(".bn-block-content");
  await page.keyboard.type("this sentence    has   bad spacing");
  await page.waitForTimeout(400);

  // Select the paragraph, then ⌘J.
  await page.keyboard.press(`${mod}+A`);
  await page.keyboard.press(`${mod}+J`);
  const menuOpened = await page
    .waitForSelector(".ai-menu", { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check("⌘J opens the AI menu over a selection", menuOpened);

  // ⌘J must NOT also open the workspace modal.
  check(
    "⌘J does not open the Q&A modal too",
    !(await page.locator(".ask-ai").isVisible().catch(() => false)),
  );

  await page.click(".ai-menu-item:has-text('Improve writing')");
  const gotResult = await page
    .waitForSelector(".ai-menu-result", { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  check("a result preview renders before anything is applied", gotResult);
  await page.screenshot({ path: `${SHOTS}/01-result.png` });

  const docBefore = await page.textContent(".bn-editor");
  check(
    "the document is untouched until the user accepts",
    docBefore.includes("has   bad spacing") ||
      docBefore.includes("has  bad spacing"),
  );

  await page.click(".ai-menu-item:has-text('Replace selection')");
  await page.waitForTimeout(700);
  const docAfter = await page.textContent(".bn-editor");
  check(
    "Replace selection rewrites the block",
    docAfter.includes("this sentence has bad spacing"),
    docAfter.slice(0, 80),
  );
  check("the menu closes after applying", !(await page.locator(".ai-menu").isVisible()));

  /* --------------- 2. writing from a blank line (regression) --------------- */

  await page.click(".bn-block-content >> nth=-1");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.keyboard.type("/Ask AI");
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");

  const blankMenu = await page
    .waitForSelector(".ai-menu", { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check("/Ask AI opens the menu on a blank line", blankMenu);

  // A free-form instruction with no selection is the write-from-scratch flow
  // that the server used to reject outright.
  await page.fill(".ai-menu-input input", "Draft a standup update");
  await page.keyboard.press("Enter");
  const blankResult = await page
    .waitForSelector(".ai-menu-result", { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  const blankError = await page
    .locator(".ai-menu-error")
    .textContent()
    .catch(() => null);
  check(
    "writing from a blank line is not rejected",
    blankResult && !blankError,
    blankError ?? "",
  );

  await page.click(".ai-menu-item:has-text('Insert below')");
  await page.waitForTimeout(700);
  check(
    "Insert below adds the generated text",
    (await page.textContent(".bn-editor")).includes("Draft a standup update"),
  );
  await page.screenshot({ path: `${SHOTS}/02-blank-line.png` });

  /* ---------------- 3. AI database property ---------------- */

  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.click(".menu-item:has-text('New database')");
  await page.waitForTimeout(500);
  await page.fill(".page-title", "AI columns");
  await page.waitForSelector(".db-table");

  await page.click(".new-row-btn");
  await page.waitForTimeout(250);
  await page.keyboard.type("Quarterly review");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  // Add a column, open its menu, and switch the type to AI.
  await page.click(".th-btn.add");
  await page.waitForTimeout(500);
  // The new column's header opens the property menu.
  await page.click(".db-table thead th:nth-last-child(2)");
  await page.waitForSelector(".prop-type-btn", { timeout: 5000 });
  await page.click(".prop-type-btn");
  await page.waitForSelector(".prop-type-list", { timeout: 5000 });

  const aiType = page.locator(".prop-type-list .menu-item", { hasText: "AI" });
  const aiTypeVisible = await aiType
    .first()
    .isVisible()
    .catch(() => false);
  check("AI appears as a property type", aiTypeVisible);
  if (aiTypeVisible) {
    await aiType.first().click();
    await page.waitForTimeout(400);
    const hasKinds = await page
      .locator(".menu-item:has-text('Key topics')")
      .isVisible()
      .catch(() => false);
    check("the AI column exposes its generate kinds", hasKinds);
    await page.screenshot({ path: `${SHOTS}/03-ai-column-config.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    const genBtn = page.locator(".ai-cell-generate").first();
    const hasGen = await genBtn.isVisible().catch(() => false);
    check("the AI cell offers a Generate button", hasGen);
    if (hasGen) {
      await genBtn.click();
      await page.waitForTimeout(900);
      const cellText = await page.textContent(".ai-cell");
      check(
        "generating fills the cell and flips to Regenerate",
        cellText.includes("Regenerate"),
        cellText.slice(0, 60),
      );
      await page.screenshot({ path: `${SHOTS}/04-ai-cell.png` });
    }
  }

  /* ---------------- 4. workspace Q&A ---------------- */

  await page.keyboard.press(`${mod}+Shift+J`);
  const askOpened = await page
    .waitForSelector(".ask-ai", { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check("⌘⇧J opens workspace Q&A", askOpened);

  if (askOpened) {
    await page.fill(".ask-ai input", "What is on the roadmap?");
    await page.keyboard.press("Enter");
    const answered = await page
      .waitForSelector(".ask-ai-body", { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    check("Q&A renders an answer", answered);
    await page.screenshot({ path: `${SHOTS}/05-ask-ai.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("Escape closes Q&A", !(await page.locator(".ask-ai").isVisible()));
  }

  // The sidebar entry point should be present in mock mode (available: true).
  check(
    "the sidebar advertises Ask AI",
    await page.locator(".sidebar-item:has-text('Ask AI')").isVisible(),
  );
} catch (err) {
  check(`threw: ${err.message}`, false);
  await page.screenshot({ path: `${SHOTS}/crash.png` }).catch(() => {});
} finally {
  await browser.close();
  console.log(results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  console.log(`screenshots: ${SHOTS}`);
  process.exit(failures === 0 ? 0 : 1);
}
