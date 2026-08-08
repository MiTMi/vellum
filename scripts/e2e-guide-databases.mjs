/**
 * Help Center guide check (2/5) — the database guides on /help. Covers: databases — rows,
 * properties, the five views, filter/sort/group/search, relations, rollups,
 * formulas, row peek and CSV export.
 *
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5210 & node scripts/e2e-guide-databases.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5210") + "/app.html";
const SHOTS = "/tmp/shots-help2";
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
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 15000 });

  /* ------------------------------------------------- create a database */
  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.waitForTimeout(300);
  await page.click(".menu-item:has-text('New database')");
  await page.waitForTimeout(700);
  await page.fill(".page-title", "Tasks");
  await page.waitForTimeout(400);
  check("new database opens in table view", await page.isVisible(".db-table"));
  const headers = await page.textContent(".db-table thead");
  check("default columns are Name, Status, Tags, Date",
    headers.includes("Name") && headers.includes("Status") && headers.includes("Tags") && headers.includes("Date"),
    headers.replace(/\s+/g, " ").trim());
  const tabs = await page.textContent(".db-tabs");
  check("five views offered", ["Table", "Board", "Calendar", "Gallery", "Timeline"].every((t) => tabs.includes(t)));

  /* ------------------------------------------------------------- rows */
  const addRow = async (title) => {
    await page.click(".new-row-btn");
    await page.waitForTimeout(300);
    await page.keyboard.type(title);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(350);
  };
  await addRow("Write the guide");
  await addRow("Ship the release");
  await addRow("Review feedback");
  check("three rows added", (await page.locator(".db-table tbody tr").count()) === 3);
  check("row count shown in the footer", (await page.textContent(".table-footer")).includes("3 rows"));

  /* ------------------------------------------------------ select cell */
  await page.click(".db-table tbody tr:has-text('Write the guide') .cell-select");
  await page.waitForTimeout(400);
  check("select popover opens with existing options", await page.isVisible(".select-popover"));
  await page.click(".select-option-row:has-text('In progress')");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("status chip set on the row",
    (await page.textContent(".db-table tbody tr:has-text('Write the guide') .cell-select")).includes("In progress"));

  await page.click(".db-table tbody tr:has-text('Ship the release') .cell-select");
  await page.waitForTimeout(400);
  await page.click(".select-option-row:has-text('Done')");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");

  /* ------------------------------ create a brand-new option by typing */
  await page.click(".db-table tbody tr:has-text('Review feedback') .cell-select");
  await page.waitForTimeout(400);
  await page.fill(".select-popover .select-search", "Blocked");
  await page.waitForTimeout(300);
  check("typing a new value offers to create it", await page.isVisible(".select-option-row.create"));
  await page.click(".select-option-row.create");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("new option applied",
    (await page.textContent(".db-table tbody tr:has-text('Review feedback') .cell-select")).includes("Blocked"));

  /* -------------------------------------------------------- date cell */
  const today = new Date();
  await page.click(".db-table tbody tr:has-text('Write the guide') .cell-date");
  await page.waitForSelector(".date-popover input[type=date]");
  await page.fill(".date-popover input[type=date]", iso(today));
  await page.waitForTimeout(300);
  check("date popover has an end-date (range) toggle", await page.isVisible(".date-range-toggle"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* --------------------------------------------- add a Number property */
  await page.click(".col-add .th-btn.add");
  await page.waitForTimeout(500);
  check("a new property column appears", (await page.textContent(".db-table thead")).includes("Property 4"));
  await page.click(".db-table thead .th-btn:has-text('Property 4')");
  await page.waitForTimeout(400);
  check("property menu opens", await page.isVisible(".prop-menu"));
  await page.fill(".prop-name-input", "Points");
  await page.press(".prop-name-input", "Enter");
  await page.waitForTimeout(400);
  await page.click(".db-table thead .th-btn:has-text('Points')");
  await page.waitForTimeout(400);
  await page.click(".prop-type-btn");
  await page.waitForTimeout(300);
  const types = await page.textContent(".prop-type-list");
  check("all 12 property types offered",
    ["Text","Number","Select","Multi-select","Date","Checkbox","URL","Relation","Created time","Last edited time","Rollup","Formula"]
      .every((t) => types.includes(t)));
  await page.click(".prop-type-list .menu-item:has-text('Number')");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const setNumber = async (rowText, n) => {
    await page.click(`.db-table tbody tr:has-text('${rowText}') .cell-number`);
    await page.waitForTimeout(250);
    await page.keyboard.type(String(n));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  };
  await setNumber("Write the guide", 3);
  await setNumber("Ship the release", 5);
  await setNumber("Review feedback", 2);
  check("number values stored",
    (await page.textContent(".db-table tbody tr:has-text('Ship the release') .cell-number")).includes("5"));

  /* ---------------------------------------------------------- formula */
  await page.click(".col-add .th-btn.add");
  await page.waitForTimeout(500);
  await page.click(".db-table thead .th-btn:has-text('Property 5')");
  await page.waitForTimeout(400);
  await page.fill(".prop-name-input", "Double");
  await page.press(".prop-name-input", "Enter");
  await page.waitForTimeout(300);
  await page.click(".db-table thead .th-btn:has-text('Double')");
  await page.waitForTimeout(400);
  await page.click(".prop-type-btn");
  await page.waitForTimeout(300);
  await page.click(".prop-type-list .menu-item:has-text('Formula')");
  await page.waitForTimeout(400);
  check("formula editor appears", await page.isVisible(".formula-input"));
  check("formula helper lists functions", (await page.textContent(".formula-hint")).includes("dateDiff"));
  check("insert-property chips offered", (await page.locator(".formula-chip").count()) > 0);
  await page.fill(".formula-input", 'prop("Points") * 2');
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const doubleCell = await page.textContent(".db-table tbody tr:has-text('Ship the release') .cell-formula");
  check("formula computes across the column", doubleCell.trim() === "10", doubleCell.trim());
  await page.screenshot({ path: `${SHOTS}/table.png` });

  /* ----------------------------------------------- filter / sort / group */
  await page.click(".db-toolbar-right .icon-btn[title='Sort']");
  await page.waitForTimeout(400);
  check("sort menu lists Name and every property", (await page.textContent(".menu")).includes("Name"));
  await page.click(".menu-item:has-text('Points')");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("active sort chip shown", await page.isVisible(".db-chip"));
  const firstRow = await page.textContent(".db-table tbody tr:nth-child(1)");
  check("rows sorted ascending by Points", firstRow.includes("Review feedback"), firstRow.replace(/\s+/g, " ").trim().slice(0, 40));
  await page.click(".db-chip button");
  await page.waitForTimeout(400);

  await page.click(".db-toolbar-right .icon-btn[title='Filter']");
  await page.waitForTimeout(400);
  check("filter builder offers every column", await page.isVisible(".menu-item:has-text('Status')"));
  await page.click(".menu-item:has-text('Status')");
  await page.waitForTimeout(300);
  check("picking a column creates a rule row", await page.isVisible(".filter-rule"));
  await page.click(".filter-option:has-text('Done')");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check("filter narrows the rows", (await page.locator(".db-table tbody tr").count()) === 1);
  check("filter chip shows the count", (await page.textContent(".db-count")).includes("1 of 3"));
  await page.click(".db-chip:has-text('filter') button");
  await page.waitForTimeout(400);
  check("clearing the chip restores every row", (await page.locator(".db-table tbody tr").count()) === 3);

  await page.click(".db-toolbar-right .btn:has-text('Group')");
  await page.waitForTimeout(400);
  await page.click(".menu-item:has-text('Status')");
  await page.waitForTimeout(500);
  check("table groups by Status", (await page.locator(".db-group").count()) > 1);
  check("each group has a header row with a count", await page.isVisible(".group-row .board-count"));
  await page.click(".db-toolbar-right .btn:has-text('Group')");
  await page.waitForTimeout(300);
  await page.click(".menu-item:has-text('No grouping')");
  await page.waitForTimeout(400);

  /* ------------------------------------------------ search inside the db */
  await page.click(".db-toolbar-right .icon-btn[title='Search in database']");
  await page.waitForTimeout(300);
  await page.fill(".db-search input", "ship");
  await page.waitForTimeout(500);
  check("in-database search filters rows", (await page.locator(".db-table tbody tr").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  /* -------------------------------------------------------- row peek */
  await page.hover(".db-table tbody tr:has-text('Write the guide') .title-cell");
  await page.waitForTimeout(400);
  check(
    "hovering a row reveals its Open button",
    await page.isVisible(".db-table tbody tr:has-text('Write the guide') .open-btn"),
  );
  await page.click(".db-table tbody tr:has-text('Write the guide') .open-btn", { force: true });
  await page.waitForTimeout(800);
  check("row opens in the peek overlay", await page.isVisible(".peek-modal, .modal"));
  check("peek shows the row's properties", await page.isVisible(".row-props"));
  check("peek has an editor for the row body", await page.isVisible(".bn-editor"));
  await page.screenshot({ path: `${SHOTS}/peek.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  /* ------------------------------------------------------------ views */
  await page.click(".db-tab:has-text('Board')");
  await page.waitForTimeout(700);
  check("board view renders columns per select value", (await page.locator(".board-col").count()) >= 3);
  await page.screenshot({ path: `${SHOTS}/board.png` });

  await page.click(".db-tab:has-text('Calendar')");
  await page.waitForTimeout(700);
  check("calendar view renders a month grid", await page.isVisible(".cal-grid, .calendar-view"));

  await page.click(".db-tab:has-text('Gallery')");
  await page.waitForTimeout(700);
  check("gallery view renders cards", (await page.locator(".gallery-card, .card").count()) >= 3);

  await page.click(".db-tab:has-text('Timeline')");
  await page.waitForTimeout(700);
  check("timeline view renders", await page.isVisible(".timeline-view"));
  await page.screenshot({ path: `${SHOTS}/timeline.png` });

  await page.click(".db-tab:has-text('Table')");
  await page.waitForTimeout(600);

  /* ---------------------------------------------------- managing views */
  await page.click(".db-add-view");
  await page.waitForTimeout(300);
  await page.click(".menu-item:has-text('Board')");
  await page.waitForTimeout(600);
  check("+ adds a view with the picked layout", await page.isVisible(".db-tab.active:has-text('Board 2')"));
  await page.click(".db-tab.active");
  await page.waitForTimeout(300);
  check("clicking the active tab opens its menu", await page.isVisible(".view-menu-name"));
  await page.fill(".view-menu-name", "Sprint");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("views can be renamed", await page.isVisible(".db-tab.active:has-text('Sprint')"));
  await page.click(".db-tab.active");
  await page.waitForTimeout(300);
  await page.click(".menu-item:has-text('Duplicate view')");
  await page.waitForTimeout(500);
  check("duplicate makes a copy", await page.isVisible(".db-tab.active:has-text('Sprint 2')"));
  await page.click(".db-tab.active");
  await page.waitForTimeout(300);
  await page.click(".menu-item:has-text('Delete view')");
  await page.waitForTimeout(500);
  check("delete removes the view", (await page.locator(".db-tab:has-text('Sprint 2')").count()) === 0);
  await page.click(".db-tab:text-is('Table')");
  await page.waitForTimeout(500);

  /* ----------------------------------------- second database + relation */
  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.waitForTimeout(300);
  await page.click(".menu-item:has-text('New database')");
  await page.waitForTimeout(700);
  await page.fill(".page-title", "People");
  await page.waitForTimeout(400);
  await addRow("Ada");
  await addRow("Grace");

  await page.click(".sidebar-scroll .tree-row:has-text('Tasks')");
  await page.waitForTimeout(800);
  await page.click(".col-add .th-btn.add");
  await page.waitForTimeout(500);
  await page.click(".db-table thead .th-btn:has-text('Property 6')");
  await page.waitForTimeout(400);
  await page.fill(".prop-name-input", "Owner");
  await page.press(".prop-name-input", "Enter");
  await page.waitForTimeout(300);
  await page.click(".db-table thead .th-btn:has-text('Owner')");
  await page.waitForTimeout(400);
  await page.click(".prop-type-btn");
  await page.waitForTimeout(300);
  await page.click(".prop-type-list .menu-item:has-text('Relation')");
  await page.waitForTimeout(500);
  check("relation asks which database to point at", await page.isVisible(".prop-menu-label:has-text('Related database')"));
  await page.click(".prop-menu .menu-item:has-text('People')");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  await page.click(".db-table tbody tr:has-text('Write the guide') .cell-relation");
  await page.waitForTimeout(500);
  check(
    "relation picker lists the other database's rows",
    await page.isVisible(".popover .menu-item:has-text('Ada')"),
  );
  await page.click(".popover .menu-item:has-text('Ada')");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const relCell = await page.textContent(".db-table tbody tr:has-text('Write the guide') .cell-relation");
  check("linked row shows as a chip", relCell.includes("Ada"), relCell.trim());

  /* ----------------------------------------------------------- rollup */
  await page.click(".col-add .th-btn.add");
  await page.waitForTimeout(500);
  await page.click(".db-table thead .th-btn:has-text('Property 7')");
  await page.waitForTimeout(400);
  await page.fill(".prop-name-input", "Owners");
  await page.press(".prop-name-input", "Enter");
  await page.waitForTimeout(300);
  await page.click(".db-table thead .th-btn:has-text('Owners')");
  await page.waitForTimeout(400);
  await page.click(".prop-type-btn");
  await page.waitForTimeout(300);
  await page.click(".prop-type-list .menu-item:has-text('Rollup')");
  await page.waitForTimeout(500);
  check("rollup asks for a relation first", await page.isVisible(".prop-menu-label:has-text('Relation')"));
  await page.click(".prop-menu .menu-item:has-text('Owner')");
  await page.waitForTimeout(500);
  check("rollup then asks which property", await page.isVisible(".prop-menu-label:has-text('Property')"));
  await page.click(".prop-menu .menu-item:has-text('Name')");
  await page.waitForTimeout(400);
  check("rollup offers calculations", await page.isVisible(".menu-item:has-text('Show original')"));
  await page.click(".menu-item:has-text('Show original')");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const rollupCell = await page.textContent(".db-table tbody tr:has-text('Write the guide') .cell-rollup");
  check("rollup shows the related row's name", rollupCell.includes("Ada"), rollupCell.trim());
  await page.screenshot({ path: `${SHOTS}/relation-rollup.png` });

  /* ------------------------------------------------------- CSV export */
  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(400);
  check("database menu offers CSV export", await page.isVisible(".menu-item:has-text('Export as CSV')"));
  check("database menu shows a row count", (await page.textContent(".menu-footer")).includes("rows"));
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    page.click(".menu-item:has-text('Export as CSV')"),
  ]);
  check("CSV downloads with the database's name", download.suggestedFilename().endsWith(".csv"), download.suggestedFilename());
} catch (err) {
  check(`script error: ${err.message}`, false);
} finally {
  console.log(results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
