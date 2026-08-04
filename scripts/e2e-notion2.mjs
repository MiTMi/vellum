/**
 * E2E for the second Notion-parity batch: equation block, block anchor
 * links, row peek, comments, template picker, table grouping, computed
 * timestamp props, rollups and search snippets. Mock data mode.
 * Usage: node scripts/e2e-notion2.mjs [--shots-dir /tmp/shots]
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
const context = await browser.newContext({
  viewport: { width: 1360, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
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
async function newDatabase(title) {
  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.waitForSelector(".menu", { timeout: 5000 });
  await page.click(".menu .menu-item:has-text('New database')");
  await page.waitForTimeout(600);
  await page.fill(".page-title", title);
  await page.waitForTimeout(450);
}
async function addRow(title) {
  await page.click(".new-row-btn");
  await page.waitForTimeout(250);
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
}
/** Retype the last property column via its header menu. */
async function retypeLastProp(typeLabel) {
  await page.click(".col-add .th-btn.add");
  await page.waitForTimeout(400);
  await page.click(".db-table thead th:nth-last-child(2) .th-btn");
  await page.waitForSelector(".prop-menu", { timeout: 5000 });
  await page.click(".prop-menu .prop-type-btn");
  await page.waitForTimeout(300);
  await page.click(`.prop-type-list .menu-item:has-text('${typeLabel}')`);
  await page.waitForTimeout(400);
}

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE);
  await page.waitForSelector(".page-title", { timeout: 10000 });

  /* ---------------- 1. Equation block ---------------- */

  await newPage("Math Notes");
  await page.click(".bn-editor");
  await runSlash("equation");
  check(
    "equation block inserts in its empty state",
    (await page.locator(".equation-block.empty").count()) === 1,
  );
  await page.click(".equation-block");
  await page.waitForSelector(".equation-input", { timeout: 5000 });
  await page.fill(".equation-input", "E = mc^2");
  await page.waitForTimeout(300);
  check(
    "the editor live-previews KaTeX while typing",
    (await page.locator(".equation-preview .katex").count()) > 0,
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check(
    "committing renders the formula",
    (await page.locator(".equation-render .katex").count()) > 0,
  );
  await shot("equation");

  await page.reload();
  await page.waitForSelector(".bn-editor", { timeout: 10000 });
  await page.waitForTimeout(600);
  check(
    "equation survives reload",
    (await page.locator(".equation-render .katex").count()) > 0,
  );

  /* ---------------- 2. Block anchor links ---------------- */

  await page.click(".bn-editor");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("ANCHOR TARGET PARAGRAPH");
  await page.waitForTimeout(600);

  const anchorPara = page.locator(
    "[data-content-type='paragraph']:has-text('ANCHOR TARGET PARAGRAPH')",
  );
  await anchorPara.hover();
  await page.waitForSelector(".block-anchor-btn", { timeout: 5000 });
  check("hovering a block reveals the copy-link button", true);
  await page.click(".block-anchor-btn");
  await page.waitForTimeout(400);
  const copiedLink = await page.evaluate(() => navigator.clipboard.readText());
  check(
    "copies a #/page/<id>/block/<id> deep link",
    /#\/page\/[^/]+\/block\/[^/]+$/.test(copiedLink),
    copiedLink.slice(-46),
  );
  await shot("block-anchor");

  // Navigate away, then follow the link — it should come back and flash.
  await newPage("Elsewhere");
  await page.goto(copiedLink);
  await page.waitForTimeout(1500);
  check(
    "following the link returns to the right page",
    (await page.inputValue(".page-title")) === "Math Notes",
    await page.inputValue(".page-title"),
  );
  check(
    "the linked block is present after following the anchor",
    (await page
      .locator("[data-content-type='paragraph']:has-text('ANCHOR TARGET PARAGRAPH')")
      .count()) === 1,
  );

  /* ---------------- 3. Comments ---------------- */

  await page.waitForSelector(".comments", { timeout: 5000 });
  await page.fill(".comment-compose input", "Check this maths");
  await page.click(".comment-compose .btn.primary");
  await page.waitForTimeout(600);
  check(
    "comment is added and listed",
    (await page.locator(".comment-item").count()) === 1,
  );
  check(
    "header counts unresolved comments",
    (await page.textContent(".comments-header")).includes("1 comment"),
  );
  await shot("comments");

  await page.hover(".comment-item");
  await page.click(".comment-item .icon-btn[title='Resolve']");
  await page.waitForTimeout(500);
  check(
    "resolving marks it resolved",
    (await page.locator(".comment-item.resolved").count()) === 1,
  );

  await page.reload();
  await page.waitForSelector(".comments", { timeout: 10000 });
  await page.waitForTimeout(500);
  check(
    "comments survive reload",
    (await page.locator(".comment-item").count()) === 1,
  );
  await page.hover(".comment-item");
  await page.click(".comment-item .icon-btn[title='Delete comment']");
  await page.waitForTimeout(500);
  check(
    "deleting removes the comment",
    (await page.locator(".comment-item").count()) === 0,
  );

  /* ---------------- 4. Template picker on empty pages ---------------- */

  // Make "Math Notes" a template so a new page can offer it.
  await page.click(".topbar .icon-btn >> nth=-1");
  await page.waitForSelector(".page-menu", { timeout: 5000 });
  await page.click(".page-menu .toggle-row:has-text('Template')");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(600);
  check(
    "a fresh empty page offers the template picker",
    (await page.locator(".template-prompt").count()) === 1,
  );
  await shot("template-prompt");
  await page.click(".template-prompt-btn:has-text('Math Notes')");
  await page.waitForTimeout(1500);
  check(
    "applying a template fills the page with its content",
    (await page.textContent(".bn-editor")).includes("ANCHOR TARGET PARAGRAPH"),
  );
  check(
    "the prompt disappears once content exists",
    (await page.locator(".template-prompt").count()) === 0,
  );
  check(
    "the new page is not itself a template",
    (await page.locator(".template-item").count()) === 1,
  );

  /* ---------------- 5. Computed props + grouping + rollup ---------------- */

  await newDatabase("Projects");
  await addRow("Apollo");
  await addRow("Borealis");

  // Give Projects a number column so a rollup has something to sum.
  await retypeLastProp("Number");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const budgetCol = ".db-table tbody tr:has-text('Apollo') td:nth-last-child(2) .cell";
  await page.click(budgetCol);
  await page.keyboard.type("10");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.click(
    ".db-table tbody tr:has-text('Borealis') td:nth-last-child(2) .cell",
  );
  await page.keyboard.type("32");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  // Created-time column.
  await retypeLastProp("Created time");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const createdCells = await page
    .locator(".cell.cell-createdTime .cell-value")
    .allTextContents();
  check(
    "created-time column renders a date for every row",
    createdCells.length === 2 && createdCells.every((t) => t.trim().length > 4),
    createdCells.join(" | "),
  );

  // Group the table by Status.
  await page.click(".db-toolbar-right .btn.subtle:has-text('Group')");
  await page.waitForSelector(".menu", { timeout: 5000 });
  await page.click(".menu .menu-item:has-text('Status')");
  await page.waitForTimeout(500);
  const groupLabels = await page.locator(".group-row .chip").allTextContents();
  check(
    "grouping renders a section per select option plus a 'no value' group",
    groupLabels.length === 4 && groupLabels[3] === "No Status",
    groupLabels.join(" | "),
  );
  check(
    "ungrouped rows land in the 'No Status' group",
    (await page.textContent(".group-row:has-text('No Status')")).includes("2"),
  );
  await shot("grouping");

  // Collapse a group and confirm it persists across a reload.
  await page.click(".group-row:has-text('No Status') .group-toggle");
  await page.waitForTimeout(400);
  check(
    "collapsing a group hides its rows",
    (await page.locator(".db-table tbody tr:has-text('Apollo')").count()) === 0,
  );
  await page.reload();
  await page.waitForSelector(".db-table", { timeout: 10000 });
  await page.waitForTimeout(600);
  check(
    "collapsed state survives reload",
    (await page.locator(".db-table tbody tr:has-text('Apollo')").count()) === 0,
  );
  await page.click(".group-row:has-text('No Status') .group-toggle");
  await page.waitForTimeout(400);

  // Now a second database with a relation + rollup back into Projects.
  await newDatabase("Portfolios");
  await addRow("Everything");
  await retypeLastProp("Relation");
  await page.click(".prop-menu .prop-options .menu-item:has-text('Projects')");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.click(".db-table tbody tr:has-text('Everything') .cell-relation");
  await page.waitForSelector(".menu .qs-input-row", { timeout: 5000 });
  await page.click(".menu .menu-item:has-text('Apollo')");
  await page.waitForTimeout(250);
  await page.click(".menu .menu-item:has-text('Borealis')");
  await page.waitForTimeout(250);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  await retypeLastProp("Rollup");
  check(
    "rollup asks for a relation to follow",
    (await page.locator(".prop-menu .prop-menu-label:has-text('Relation')").count()) === 1,
  );
  await page.click(".prop-menu .prop-options .menu-item:has-text('Property 4')");
  await page.waitForTimeout(500);
  check(
    "picking a relation reveals the target's properties",
    (await page.locator(".prop-menu .prop-menu-label:has-text('Property')").count()) >= 1,
  );
  // Target property = the Number column we filled in (named "Property 4").
  const targetBtns = await page
    .locator(".prop-menu .prop-options .menu-item")
    .allTextContents();
  check(
    "target property list includes the related database's columns",
    targetBtns.some((t) => t.includes("Name")),
    targetBtns.slice(0, 6).join(" | "),
  );
  await page.click(".prop-menu .menu-item:has-text('Property 4') >> nth=-1");
  await page.waitForTimeout(400);
  await page.click(".prop-menu .menu-item:has-text('Sum')");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  const rollupText = await page.textContent(".cell-rollup");
  check(
    "rollup sums the related rows' values (10 + 32)",
    rollupText.trim() === "42",
    rollupText.trim(),
  );
  await shot("rollup");

  /* ---------------- 6. Row peek ---------------- */

  // .open-btn is revealed by hovering the title cell specifically.
  await page.hover(".db-table tbody tr:has-text('Everything') .title-cell");
  await page.click(".db-table tbody tr:has-text('Everything') .open-btn");
  await page.waitForSelector(".peek-modal", { timeout: 5000 });
  check(
    "the Open button peeks the row instead of navigating",
    (await page.inputValue(".peek-modal .page-title")) === "Everything",
  );
  check(
    "the database page stays behind the overlay",
    (await page.locator(".database-view").count()) >= 1,
  );
  check(
    "the peek shows the row's property panel",
    (await page.locator(".peek-modal .row-props").count()) === 1,
  );
  await shot("peek");

  await page.click(".peek-modal .bn-editor");
  await page.keyboard.type("Typed inside the peek");
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(
    "Escape closes the peek",
    (await page.locator(".peek-modal").count()) === 0,
  );

  await page.hover(".db-table tbody tr:has-text('Everything') .title-cell");
  await page.click(".db-table tbody tr:has-text('Everything') .open-btn");
  await page.waitForSelector(".peek-modal", { timeout: 5000 });
  check(
    "edits made in the peek persisted",
    (await page.textContent(".peek-modal .bn-editor")).includes(
      "Typed inside the peek",
    ),
  );
  await page.click(".peek-bar .btn.subtle");
  await page.waitForTimeout(600);
  check(
    "'Open as full page' navigates and closes the overlay",
    (await page.locator(".peek-modal").count()) === 0 &&
      (await page.inputValue(".page-title")) === "Everything",
  );

  /* ---------------- 7. Search snippets ---------------- */

  await page.keyboard.press("Meta+k");
  await page.waitForSelector(".quick-switcher", { timeout: 5000 });
  await page.fill(".qs-input-row input", "ANCHOR");
  await page.waitForTimeout(600);
  check(
    "body-text matches show a contextual snippet",
    (await page.locator(".qs-snippet").count()) >= 1,
  );
  check(
    "the matched term is highlighted in the snippet",
    (await page.locator(".qs-snippet mark").count()) >= 1,
    await page.locator(".qs-snippet").first().textContent(),
  );
  await shot("search-snippet");
  await page.keyboard.press("Escape");
} catch (err) {
  check(`fatal: ${err.message}`, false);
} finally {
  await browser.close();
}

console.log("\n" + results.join("\n"));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
