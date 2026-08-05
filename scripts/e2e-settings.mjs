/**
 * E2E for the Settings modal (mock mode — account sections show the demo
 * note; the server-backed flows are covered by convex-tests and a
 * non-destructive CLI check against the real deployment).
 *
 *   VITE_MOCK_CONVEX=1 npx vite --port 5199
 *   node scripts/e2e-settings.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_URL ?? "http://localhost:5199";

let failures = 0;
const results = [];
function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

try {
  await page.goto(`${BASE}/app.html`);
  await page.waitForSelector(".sidebar", { timeout: 20000 });

  // Gear button opens the modal.
  await page.click('.sidebar-footer [title="Settings (⌘,)"]');
  await page.waitForSelector(".settings-modal", { timeout: 10000 });
  check("gear button opens Settings", true);

  const bodyText = await page.textContent(".settings-body");
  check("demo mode shows the no-account note", bodyText.includes("Demo mode has no account"));
  check("Security section renders", bodyText.includes("Security"));
  check("Appearance section renders", bodyText.includes("Theme"));

  // Theme picker actually flips the app theme.
  const before = await page.getAttribute("html", "data-theme");
  await page.click(`.theme-picker button:not(.active)`);
  await page.waitForTimeout(200);
  const after = await page.getAttribute("html", "data-theme");
  check("theme picker switches the theme", before !== after, `${before} → ${after}`);
  await page.click(`.theme-picker button:not(.active)`); // switch back

  // Escape closes; ⌘, reopens.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Escape closes Settings", (await page.locator(".settings-modal").count()) === 0);
  await page.keyboard.press("Meta+,");
  await page.waitForSelector(".settings-modal", { timeout: 5000 });
  check("⌘, reopens Settings", true);
  await page.keyboard.press("Escape");

  // ⌘K lists a Settings action.
  await page.keyboard.press("Meta+k");
  await page.fill(".qs-input-row input", "settings");
  await page.waitForTimeout(300);
  await page.click(".qs-results >> text=Settings");
  await page.waitForSelector(".settings-modal", { timeout: 5000 });
  check("⌘K → Settings action opens the modal", true);
  await page.keyboard.press("Escape");

  // With a vault present, the Security section gains the Vault row.
  await page.click("text=Create Vault");
  await page.waitForSelector(".vault-card", { timeout: 10000 });
  const inputs = page.locator(".vault-input");
  await inputs.nth(0).fill("correct horse battery");
  await inputs.nth(1).fill("correct horse battery");
  await page.click(".vault-btn");
  await page.waitForSelector(".vault-toolbar", { timeout: 10000 });
  await page.keyboard.press("Meta+,");
  await page.waitForSelector(".settings-modal", { timeout: 5000 });
  check(
    "unlocked vault shows a Lock now control in Settings",
    (await page.locator(".settings-modal >> text=Lock now").count()) === 1,
  );
  await page.click(".settings-modal >> text=Lock now");
  await page.waitForTimeout(300);
  check(
    "locking from Settings flips the row to Locked",
    (await page.locator(".settings-modal >> text=Locked").count()) >= 1,
  );
} catch (err) {
  check(`threw: ${err.message}`, false);
} finally {
  console.log("\n" + results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}
