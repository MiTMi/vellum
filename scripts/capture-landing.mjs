/**
 * Captures the product screenshots used by the landing page.
 *
 * Run on demand (not in CI) and commit the output — the landing page ships
 * static images, so this script only has to be re-run when the UI changes.
 *
 *   VITE_MOCK_CONVEX=1 npx vite --port 5199 &
 *   node scripts/capture-landing.mjs
 *
 * Mock mode on purpose: the shots must not contain the owner's real notes,
 * and a seeded workspace is reproducible. Same conventions as scripts/e2e.mjs
 * (CHROMIUM_PATH override, port 5199, /app.html entry).
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const BASE = (process.env.E2E_URL ?? "http://localhost:5199") + "/app.html";
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "landing",
  "assets",
);
fs.mkdirSync(OUT, { recursive: true });

/**
 * What a published link looks like once Vellum is hosted. Mock mode mints
 * `example.invalid` slugs (it has no backend), so the publish screenshot gets
 * the real URL shape written into the field before the shot is taken.
 */
const PUBLIC_URL_SAMPLE = "vellum.vercel.app/p/8f3c1a90b47e";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

const shot = async (name, opts = {}) => {
  // Chromium's spellchecker underlines product jargon in the seeded text —
  // real for a user, noise in a marketing shot.
  await page.$$eval("[contenteditable]", (els) =>
    els.forEach((el) => {
      el.spellcheck = false;
    }),
  );
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
  console.log("captured", `${name}.png`);
};

const type = async (text) => {
  await page.keyboard.type(text);
  await page.waitForTimeout(120);
};

async function runSlash(cmd) {
  await page.keyboard.type("/" + cmd);
  await page.waitForTimeout(450);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(450);
}

async function newPage(title) {
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", title);
  await page.waitForTimeout(450);
}

async function newDatabase(title) {
  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.waitForSelector(".menu", { timeout: 5000 });
  await page.click(".menu .menu-item:has-text('New database')");
  await page.waitForTimeout(700);
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

try {
  // ---------- a clean, light-themed workspace ----------
  await page.goto(BASE);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("vellum:theme", "light");
  });
  await page.goto(BASE);
  await page.waitForSelector(".page-title", { timeout: 15000 });
  await page.waitForSelector(".bn-editor", { timeout: 15000 });

  // ---------- seed a few sidebar pages so the tree looks lived-in ----------
  for (const t of ["Meeting notes", "Reading list", "Trip to Lisbon"]) {
    await newPage(t);
    await page.click(".bn-editor");
    await type(`Notes for ${t.toLowerCase()}.`);
    await page.waitForTimeout(400);
  }

  // ---------- 1. hero: a real-looking document ----------
  await newPage("Product roadmap");
  await page.click(".bn-editor");
  await runSlash("head");
  await type("Q3 focus");
  await page.keyboard.press("Enter");
  await type(
    "Three bets for the quarter, each with an owner and a rough shape of the work. Everything below links back to the tracker.",
  );
  await page.keyboard.press("Enter");
  await runSlash("check");
  await type("Rewrite the block schema");
  await page.keyboard.press("Enter");
  await type("Move sync onto the outbox");
  await page.keyboard.press("Enter");
  await type("Publish the changelog");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // empty item exits the checklist
  await page.waitForTimeout(300);
  await runSlash("heading 2");
  await type("Open questions");
  await page.keyboard.press("Enter");
  await runSlash("bullet");
  await type("Do we ship the Mac app and the web app on the same day?");
  await page.keyboard.press("Enter");
  await type("Who owns the migration runbook?");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // exit the bullet list
  await page.waitForTimeout(300);
  await runSlash("callout");
  await type("Ship the editor rewrite before the offline work starts.");
  await page.waitForTimeout(700);
  await page.mouse.move(720, 60); // park the cursor away from hover affordances
  await page.waitForTimeout(500);
  await shot("hero");
  // Social card: the same view cropped to the 1.91:1 ratio Open Graph wants.
  await shot("og", { clip: { x: 0, y: 0, width: 1440, height: 754 } });

  // ---------- 2. the slash menu ----------
  await newPage("Weekly notes");
  await page.click(".bn-editor");
  await type("Everything starts with a slash.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.waitForTimeout(600);
  await shot("editor");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ---------- 3. a database with a computed column ----------
  await newDatabase("Tasks");
  await page.waitForSelector(".db-table", { timeout: 10000 });
  for (const t of [
    "Rewrite the block schema",
    "Move sync onto the outbox",
    "Publish the changelog",
    "Design the landing page",
  ]) {
    await addRow(t);
  }

  const setStatus = async (rowText, option) => {
    await page.click(`.db-table tbody tr:has-text('${rowText}') .cell-select`);
    await page.waitForSelector(".select-popover", { timeout: 5000 });
    await page.click(`.select-option-row:has-text('${option}')`);
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  };
  await setStatus("Rewrite the block schema", "In progress");
  await setStatus("Move sync onto the outbox", "In progress");
  await setStatus("Publish the changelog", "Done");

  // A number column plus a formula over it — the "databases that think" shot.
  // "+" appends a plain text property; its header button opens the menu where
  // it gets renamed and retyped (same dance as scripts/e2e-dbfeatures.mjs).
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
  await page.waitForTimeout(450);
  await configureProp("Property 4", "Points", "Number");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);

  const setNumber = async (rowText, value) => {
    await page.click(`.db-table tbody tr:has-text('${rowText}') .cell-number`);
    await page.waitForTimeout(200);
    await page.keyboard.type(String(value));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  };
  await setNumber("Rewrite the block schema", 8);
  await setNumber("Move sync onto the outbox", 13);
  await setNumber("Publish the changelog", 3);
  await setNumber("Design the landing page", 5);

  const setDate = async (rowText, iso) => {
    await page.click(`.db-table tbody tr:has-text('${rowText}') .cell-date`);
    await page.waitForSelector(".date-popover input", { timeout: 5000 });
    await page.fill(".date-popover input", iso);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  };
  await setDate("Rewrite the block schema", "2026-08-14");
  await setDate("Move sync onto the outbox", "2026-08-21");
  await setDate("Publish the changelog", "2026-08-07");
  await setDate("Design the landing page", "2026-08-28");

  await page.click(".th-btn.add");
  await page.waitForTimeout(450);
  await configureProp("Property 5", "Effort", "Formula");
  await page.waitForSelector(".formula-input");
  await page.fill(".formula-input", 'prop("Points") * 2');
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  // Adding a column scrolls the table right; bring the Name column back.
  await page.$eval(".table-view", (el) => {
    el.scrollLeft = 0;
  });
  await page.mouse.move(720, 60);
  await page.waitForTimeout(500);
  await shot("database");

  // ---------- 4. the publish popover ----------
  // Mock mode's publish.set() mints a slug but has no backend to persist it
  // to, so the popover never reaches its "published" state on its own. Seed
  // the slug straight into the mock database instead.
  await page.evaluate(() => {
    const raw = localStorage.getItem("vellum:mockdb");
    if (!raw) return;
    const docs = JSON.parse(raw);
    const doc = docs.find((d) => d.title === "Product roadmap");
    if (!doc) return;
    doc.publicSlug = "8f3c1a90b47e";
    doc.publishedAt = Date.now();
    localStorage.setItem("vellum:mockdb", JSON.stringify(docs));
  });
  await page.goto(BASE);
  await page.waitForSelector(".page-title", { timeout: 15000 });
  await page.click(".sidebar .tree-title:has-text('Product roadmap')");
  await page.waitForSelector(".bn-editor", { timeout: 10000 });
  await page.waitForTimeout(700);
  await page.click(".topbar .share-btn");
  await page.waitForSelector(".publish-link", { timeout: 5000 });
  // Mock mode has no backend, so it mints an example.invalid slug. Show the
  // URL shape a hosted Vellum actually produces instead. (The field is
  // readOnly, hence the direct DOM write rather than page.fill.)
  await page.$eval(
    ".publish-link",
    (el, value) => {
      el.value = value;
    },
    `https://${PUBLIC_URL_SAMPLE}`,
  );
  await page.waitForTimeout(400);
  await shot("publish");

  // The og card is only ever read by scrapers at 1200×630 — shrink it so the
  // landing page doesn't ship a 3MB social image.
  try {
    execFileSync("sips", [
      "-z",
      "630",
      "1200",
      path.join(OUT, "og.png"),
      "--out",
      path.join(OUT, "og.png"),
    ]);
  } catch {
    console.warn("sips unavailable — og.png left at capture resolution");
  }

  console.log(`\nWrote screenshots to ${OUT}`);
} catch (err) {
  console.error("capture failed:", err);
  await page.screenshot({ path: "/tmp/capture-landing-failure.png" });
  process.exitCode = 1;
} finally {
  await browser.close();
}
