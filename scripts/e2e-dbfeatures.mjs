/**
 * E2E: date ranges, the timeline view, and formula properties (mock mode).
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5199 & node scripts/e2e-dbfeatures.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.E2E_URL ?? "http://localhost:5199";
const SHOTS = "/tmp/shots-dbfeatures";
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

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.click(".menu-item:has-text('New database')");
  await page.waitForTimeout(500);
  await page.fill(".page-title", "Project plan");
  await page.waitForSelector(".db-table");

  const addRow = async (title) => {
    await page.click(".new-row-btn");
    await page.waitForTimeout(250);
    await page.keyboard.type(title);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  };
  await addRow("Design phase");
  await addRow("Build phase");

  // ---------- date range on the first row ----------
  const today = new Date();
  const start = iso(today);
  const later = new Date(today);
  later.setDate(later.getDate() + 6);
  const end = iso(later);

  await page.click(".db-table tbody tr:has-text('Design phase') .cell-date");
  await page.waitForSelector(".date-popover input[type=date]");
  await page.fill(".date-popover input[type=date]", start);
  await page.waitForTimeout(200);

  // Turn on the end date and fill the second input.
  await page.check(".date-range-toggle input");
  await page.waitForTimeout(200);
  const dateInputs = page.locator(".date-popover input[type=date]");
  check("end-date input appears when ranged", (await dateInputs.count()) === 2);
  await dateInputs.nth(1).fill(end);
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const cellText = await page.textContent(
    ".db-table tbody tr:has-text('Design phase') .cell-date",
  );
  check("cell shows the range with an arrow", cellText.includes("→"), cellText.trim());

  // A single date on the second row must still work (backward compatible).
  await page.click(".db-table tbody tr:has-text('Build phase') .cell-date");
  await page.waitForSelector(".date-popover input[type=date]");
  await page.fill(".date-popover input[type=date]", start);
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const single = await page.textContent(
    ".db-table tbody tr:has-text('Build phase') .cell-date",
  );
  check("a plain single date still renders", !single.includes("→"), single.trim());

  // ---------- timeline view ----------
  await page.click(".db-tab:has-text('Timeline')");
  await page.waitForSelector(".timeline-view", { timeout: 5000 });
  const bars = page.locator(".timeline-bar");
  check("timeline renders a bar per dated row", (await bars.count()) === 2);

  const widths = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".timeline-bar")).map(
      (b) => b.getBoundingClientRect().width,
    ),
  );
  check(
    "the ranged row's bar is wider than the single-day one",
    Math.max(...widths) > Math.min(...widths) * 2,
    widths.map(Math.round).join(" vs "),
  );
  check("today marker is drawn", (await page.locator(".timeline-today").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/timeline.png` });

  // A row with no date belongs in the "not scheduled" tray.
  await page.click(".db-tab:has-text('Table')");
  await page.waitForSelector(".db-table");
  await addRow("Unscheduled work");
  await page.click(".db-tab:has-text('Timeline')");
  await page.waitForSelector(".timeline-view");
  const undated = await page.textContent(".timeline-undated");
  check("undated rows are listed separately", undated.includes("Unscheduled work"));

  // ---------- formula property ----------
  await page.click(".db-tab:has-text('Table')");
  await page.waitForSelector(".db-table");

  // "+" appends a plain text property; the header button opens its menu,
  // where it gets renamed and retyped.
  const configureProp = async (oldName, newName, typeLabel) => {
    await page.click(`.db-table th .th-btn:has-text('${oldName}')`);
    await page.waitForSelector(".prop-menu", { timeout: 5000 });
    await page.fill(".prop-name-input", newName);
    await page.click(".prop-type-btn");
    await page.waitForSelector(".prop-type-list");
    await page.click(`.prop-type-list .menu-item:has-text('${typeLabel}')`);
    await page.waitForTimeout(400);
  };

  await page.click(".th-btn.add");
  await page.waitForTimeout(400);
  await configureProp("Property 4", "Points", "Number");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const setNumber = async (rowText, value) => {
    await page.click(`.db-table tbody tr:has-text('${rowText}') .cell-number`);
    await page.keyboard.type(String(value));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  };
  await setNumber("Design phase", 21);

  await page.click(".th-btn.add");
  await page.waitForTimeout(400);
  await configureProp("Property 5", "Double", "Formula");
  await page.waitForSelector(".formula-input");
  await page.fill(".formula-input", 'prop("Points") * 2');
  await page.waitForTimeout(400);
  check(
    "a valid formula reports no error",
    (await page.locator(".formula-error").count()) === 0,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  const computed = await page.textContent(
    ".db-table tbody tr:has-text('Design phase') .cell.computed:last-child",
  );
  check("formula computes from another property", computed.trim() === "42", computed.trim());

  // A broken formula must surface an error, not crash the table.
  await page.click(".db-table th .th-btn:has-text('Double')");
  await page.waitForSelector(".formula-input");
  await page.fill(".formula-input", "prop(");
  await page.waitForTimeout(400);
  check(
    "an invalid formula shows a message",
    (await page.locator(".formula-error").count()) === 1,
    (await page.textContent(".formula-error").catch(() => "")) ?? "",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("the table still renders with a broken formula", await page.isVisible(".db-table"));
  await page.screenshot({ path: `${SHOTS}/formula.png` });
} catch (err) {
  check(`fatal: ${err.message}`, false);
  await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
} finally {
  await browser.close();
}

console.log("\n" + results.join("\n"));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
