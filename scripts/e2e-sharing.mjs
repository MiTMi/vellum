/**
 * E2E: Phase 2 sharing UI (mock mode) — the Shared sidebar section,
 * viewer read-only gating, editor-role affordances, the Share popover's
 * People section, and the Library's Shared tab.
 *
 * Shared-with-me pages are seeded straight into the mock replica
 * (localStorage vellum:mockdb) with a `role` stamp — exactly the shape
 * the sync engine persists after pulling shared docs from the server.
 *
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5199 & node scripts/e2e-sharing.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5199") + "/app.html";
const SHOTS = "/tmp/shots-sharing";
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

  /* ------------------------- seed shared docs into the mock replica */
  await page.evaluate(() => {
    const now = Date.now();
    const docs = JSON.parse(localStorage.getItem("vellum:mockdb") ?? "[]");
    const para = (text) => [
      { type: "paragraph", content: [{ type: "text", text, styles: {} }] },
    ];
    docs.push(
      {
        _id: "mock_shared_root",
        _creationTime: now,
        title: "Trip planning",
        type: "doc",
        rank: 1,
        updatedAt: now,
        role: "viewer",
        content: para("Owner's plan — you are a viewer."),
      },
      {
        _id: "mock_shared_child",
        _creationTime: now,
        title: "Packing list",
        type: "doc",
        parentId: "mock_shared_root",
        rank: 1,
        updatedAt: now,
        role: "viewer",
        content: para("Socks."),
        isFavorite: true, // the OWNER's flag — must not leak into my favorites
      },
      {
        _id: "mock_shared_editable",
        _creationTime: now,
        title: "Shared notes",
        type: "doc",
        rank: 2,
        updatedAt: now,
        role: "editor",
        content: para("We can both edit this."),
      },
    );
    localStorage.setItem("vellum:mockdb", JSON.stringify(docs));
  });
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  /* ------------------------------------------- shared sidebar section */
  check("Shared section heading appears", await page.isVisible(".sidebar-heading:has-text('Shared')"));
  check(
    "shared root listed in Shared section",
    await page.isVisible(".tree-title:text('Trip planning')"),
  );
  const favTexts = await page.$$eval(".fav-item .tree-title", (els) =>
    els.map((e) => e.textContent),
  );
  check(
    "owner's favorite flag doesn't leak into my Favorites",
    !favTexts.includes("Packing list"),
  );

  /* -------------------------------------------------- viewer gating */
  await page.click(".tree-title:text('Trip planning')");
  await page.waitForTimeout(500);
  check("view-only note shown", await page.isVisible(".locked-note:has-text('view only')"));
  const editable = await page.$eval(
    ".bn-editor",
    (el) => el.getAttribute("contenteditable"),
  );
  check("editor is not editable for a viewer", editable === "false");
  check(
    "favorite star hidden on shared page",
    !(await page.isVisible(".topbar-right .icon-btn[title='Add to favorites']")),
  );

  // Share popover on a shared page: role note, no publish toggle.
  await page.click(".share-btn");
  await page.waitForTimeout(300);
  check(
    "popover explains my role",
    await page.isVisible(".share-note:has-text('Shared with you as a viewer')"),
  );
  check(
    "publish is owner-only on shared pages",
    await page.isVisible(".share-note:has-text('Only the owner can publish')"),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Page menu (⋯): no trash/duplicate for shared pages.
  await page.click(".topbar-right .icon-btn[title='More']");
  await page.waitForTimeout(300);
  check("no Move to Trash on shared page", !(await page.isVisible(".menu-item:has-text('Move to Trash')")));
  check("no Duplicate on shared page", !(await page.isVisible(".menu-item:has-text('Duplicate')")));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/1-viewer.png` });

  /* -------------------------------------------------- editor role */
  await page.click(".tree-title:text('Shared notes')");
  await page.waitForTimeout(500);
  check("no view-only note for editors", !(await page.isVisible(".locked-note")));
  const editable2 = await page.$eval(
    ".bn-editor",
    (el) => el.getAttribute("contenteditable"),
  );
  check("editor role can edit", editable2 === "true");

  /* --------------------------------- People section on my own page */
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "My shared doc");
  await page.waitForTimeout(400);
  await page.click(".share-btn");
  await page.waitForTimeout(300);
  check("People section present", await page.isVisible(".prop-menu-label:has-text('People')"));
  await page.fill(".people-email", "sister@example.com");
  await page.click(".people-invite");
  await page.waitForTimeout(300);
  check(
    "grant appears in the list",
    await page.isVisible(".people-row .people-name:has-text('sister@example.com')"),
  );
  // Role change persists through the mock store.
  await page.selectOption(".people-row .people-role", "viewer");
  await page.waitForTimeout(300);
  const roleVal = await page.$eval(".people-row .people-role", (el) => el.value);
  check("role change sticks", roleVal === "viewer");
  await page.screenshot({ path: `${SHOTS}/2-people.png` });
  await page.click(".people-remove");
  await page.waitForTimeout(300);
  check("removal empties the list", !(await page.isVisible(".people-row")));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  /* -------------------------------------------------- library tab */
  await page.click(".sidebar-item:has-text('Library')");
  await page.waitForTimeout(500);
  check("library has a Shared tab", await page.isVisible(".library-tab:has-text('Shared')"));
  await page.click(".library-tab:has-text('Shared')");
  await page.waitForTimeout(300);
  const rows = await page.$$eval(".library-table tbody tr", (els) =>
    els.map((e) => e.querySelector(".lib-name")?.textContent ?? ""),
  );
  check(
    "Shared tab lists every shared page",
    rows.some((r) => r.includes("Trip planning")) &&
      rows.some((r) => r.includes("Packing list")) &&
      rows.some((r) => r.includes("Shared notes")),
    rows.join(", "),
  );
  check(
    "shared pages have a Shared-with-me source",
    await page.isVisible(".lib-source-private:has-text('Shared with me')"),
  );
  // The Private tab must NOT contain shared pages.
  await page.click(".library-tab:has-text('Private')");
  await page.waitForTimeout(300);
  const privRows = await page.$$eval(".library-table tbody tr", (els) =>
    els.map((e) => e.querySelector(".lib-name")?.textContent ?? ""),
  );
  check(
    "Private tab excludes shared pages",
    !privRows.some((r) => r.includes("Trip planning")),
    privRows.join(", "),
  );
  await page.screenshot({ path: `${SHOTS}/3-library.png` });
} finally {
  await browser.close();
}

console.log(results.join("\n"));
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
