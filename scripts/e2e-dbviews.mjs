/**
 * E2E part 3: database toolbar (filter/sort/search), calendar view,
 * board polish, sidebar recents.
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5199") + "/app.html";
const SHOTS = "/tmp/shots-dbviews";
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
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  // create database with rows
  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.click(".menu-item:has-text('New database')");
  await page.waitForTimeout(500);
  await page.fill(".page-title", "Tasks");
  await page.waitForSelector(".db-table");

  async function addRow(title) {
    await page.click(".new-row-btn");
    await page.waitForTimeout(250);
    await page.keyboard.type(title);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  }
  await addRow("Alpha task");
  await addRow("Beta task");
  await addRow("Gamma task");

  // set statuses: Alpha=In progress, Beta=Done
  async function setStatus(rowText, option) {
    await page.click(`.db-table tbody tr:has-text('${rowText}') .cell-select`);
    await page.waitForSelector(".select-popover");
    await page.click(`.select-option-row:has-text('${option}')`);
    await page.waitForTimeout(300);
  }
  await setStatus("Alpha task", "In progress");
  await setStatus("Beta task", "Done");

  // set a date on Alpha (today) via the date cell
  await page.click(".db-table tbody tr:has-text('Alpha task') .cell-date");
  await page.waitForSelector(".date-popover input");
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await page.fill(".date-popover input", iso);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ---------- toolbar: sort ----------
  await page.click(".icon-btn[title='Sort']");
  await page.waitForSelector(".menu");
  await page.click(".menu .menu-item:has-text('Name')");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const firstRow = await page.textContent(".db-table tbody tr >> nth=0");
  check("sort ascending by name", firstRow.includes("Alpha task"));
  check("sort chip shown", (await page.locator(".db-chip:has-text('Name')").count()) > 0);

  // ---------- toolbar: filter ----------
  await page.click(".icon-btn[title='Filter']");
  await page.waitForSelector(".popover");
  await page.click(".popover .menu-item:has-text('Status')");
  await page.click(".popover .menu-item:has-text('Done')");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const visibleRows = await page.locator(".db-table tbody tr").count();
  check("filter narrows to Done rows", visibleRows === 1, `rows=${visibleRows}`);
  check(
    "filter chip + count shown",
    (await page.locator(".db-chip:has-text('Status')").count()) > 0 &&
      ((await page.textContent(".db-count")) ?? "").includes("1 of 3"),
  );
  await page.screenshot({ path: `${SHOTS}/20-filter.png` });
  // clear filter
  await page.click(".db-chip:has-text('Status') button");
  await page.waitForTimeout(300);
  check("filter clears", (await page.locator(".db-table tbody tr").count()) === 3);

  // ---------- toolbar: search ----------
  await page.click(".icon-btn[title='Search in database']");
  await page.fill(".db-search input", "beta");
  await page.waitForTimeout(300);
  check("db search filters rows", (await page.locator(".db-table tbody tr").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ---------- blue New button ----------
  const before = await page.locator(".db-table tbody tr").count();
  await page.click(".btn.primary.db-new");
  await page.waitForTimeout(400);
  check(
    "toolbar New adds a row",
    (await page.locator(".db-table tbody tr").count()) === before + 1,
  );

  // ---------- board polish ----------
  await page.click(".db-tab:has-text('Board')");
  await page.waitForSelector(".board-view");
  const tinted = await page.locator(".board-col[data-color='blue']").count();
  check("board columns tinted by option color", tinted > 0);
  const dateText = await page.textContent(".board-card:has-text('Alpha task')");
  check(
    "board card shows long-format date",
    /\w+ \d{1,2}, \d{4}/.test(dateText ?? ""),
    dateText?.slice(0, 80),
  );
  check(
    "ghost new-page buttons",
    (await page.locator(".board-add:has-text('New page')").count()) >= 3,
  );
  await page.screenshot({ path: `${SHOTS}/21-board.png` });

  // ---------- calendar view ----------
  await page.click(".db-tab:has-text('Calendar')");
  await page.waitForSelector(".cal-grid");
  check(
    "calendar shows current month",
    ((await page.textContent(".cal-month")) ?? "").includes(String(today.getFullYear())),
  );
  check(
    "row with today's date appears on calendar",
    (await page.locator(".cal-cell.today .cal-card:has-text('Alpha task')").count()) > 0,
  );
  // create a row from a day cell
  await page.hover(".cal-cell.today");
  await page.click(".cal-cell.today .cal-add");
  await page.waitForTimeout(500);
  await page.fill(".page-title", "Born on calendar");
  await page.waitForTimeout(400);
  await page.click(".topbar .icon-btn[title='Back']");
  await page.waitForTimeout(500);
  check(
    "day-cell + creates dated row",
    (await page.locator(".cal-cell.today .cal-card:has-text('Born on calendar')").count()) > 0,
  );
  // month navigation
  const monthBefore = await page.textContent(".cal-month");
  await page.click(".cal-nav .icon-btn[title='Next month']");
  await page.waitForTimeout(200);
  const monthAfter = await page.textContent(".cal-month");
  check("month navigation works", monthBefore !== monthAfter);
  await page.click(".cal-nav .btn:has-text('Today')");
  await page.screenshot({ path: `${SHOTS}/22-calendar.png` });

  // ---------- calendar persists as the active view ----------
  await page.reload();
  await page.waitForSelector(".cal-grid", { timeout: 10000 });
  check("calendar view persists after reload", true);

  // ---------- sidebar recents ----------
  check(
    "sidebar shows Recents",
    (await page.locator(".sidebar-heading:has-text('Recents')").count()) > 0,
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
