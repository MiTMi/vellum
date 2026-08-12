/**
 * E2E for the end-to-end-encrypted Vault and for image-upload compression.
 *
 * Runs against the mock-mode vite server like the other suites:
 *   VITE_MOCK_CONVEX=1 npx vite --port 5199
 *   node scripts/e2e-vault.mjs
 *
 * Mock mode persists the whole replica to localStorage ("vellum:mockdb"),
 * which is exactly what makes the central assertion possible: after typing
 * a secret into a vault page, that plaintext must appear NOWHERE at rest —
 * only ciphertext envelopes. The same run also covers lock/unlock, wrong
 * passphrases, reload-locks-the-vault, search exclusion, and that a pasted
 * image lands as a much smaller WebP.
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_URL ?? "http://localhost:5199";
const PASS = "correct horse battery";
const SECRET_TITLE = "Operation Nightingale";
const SECRET_BODY = "the launch codes are 897234";

let failures = 0;
const results = [];
function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

/** Everything mock mode has persisted, as one big string. */
const storageDump = () =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .map((k) => localStorage.getItem(k))
      .join("\n"),
  );

try {
  await page.goto(`${BASE}/app.html`);
  await page.waitForSelector(".sidebar", { timeout: 20000 });

  /* ---------------- create + set up the vault ---------------- */

  await page.click("text=Create Vault");
  await page.waitForSelector(".vault-card", { timeout: 10000 });
  check("vault setup form appears", true);

  const inputs = page.locator(".vault-input");
  await inputs.nth(0).fill(PASS);
  await inputs.nth(1).fill(PASS);
  await page.click(".vault-btn");
  await page.waitForSelector(".vault-toolbar", { timeout: 10000 });
  check("vault unlocks after setup", true);

  /* ---------------- write a secret page ---------------- */

  await page.click(".vault-toolbar >> text=New page");
  await page.waitForSelector(".page-title", { timeout: 10000 });
  await page.fill(".page-title", SECRET_TITLE);
  await page.click(".bn-editor");
  await page.keyboard.type(SECRET_BODY);
  await page.waitForTimeout(1200); // let the debounced saves flush

  const atRest = await storageDump();
  check("secret title is not stored in plaintext", !atRest.includes(SECRET_TITLE));
  check("secret body is not stored in plaintext", !atRest.includes(SECRET_BODY));
  check(
    "ciphertext envelopes ARE stored",
    atRest.includes("venc1:") && atRest.includes("__venc"),
  );

  /* ---------------- lock: nothing readable ---------------- */

  await page.click(".breadcrumbs >> text=Vault");
  await page.waitForSelector(".vault-toolbar", { timeout: 10000 });
  check(
    "unlocked vault lists the page by its decrypted title",
    (await page.locator(`.vault-item >> text=${SECRET_TITLE}`).count()) === 1,
  );
  await page.click("text=Lock now");
  await page.waitForSelector(".vault-card", { timeout: 10000 });
  check("locking returns the unlock form", true);
  check(
    "locked vault shows no page titles",
    (await page.locator(`text=${SECRET_TITLE}`).count()) === 0,
  );

  // ⌘K search finds nothing from the vault.
  await page.keyboard.press("Meta+k");
  await page.fill(".qs-input-row input", "Nightingale");
  await page.waitForTimeout(400);
  check(
    "⌘K finds nothing while locked",
    (await page.locator(`.qs-results >> text=${SECRET_TITLE}`).count()) === 0,
  );
  await page.fill(".qs-input-row input", "launch codes");
  await page.waitForTimeout(400);
  check(
    "⌘K body search finds nothing while locked",
    (await page.locator(".qs-results .qs-snippet").count()) === 0,
  );
  await page.keyboard.press("Escape");

  /* ---------------- wrong passphrase, then right one ---------------- */

  await page.fill(".vault-input", "not the passphrase");
  await page.click(".vault-btn");
  await page.waitForSelector(".vault-error", { timeout: 10000 });
  check("wrong passphrase is rejected", true);

  await page.fill(".vault-input", PASS);
  await page.click(".vault-btn");
  await page.waitForSelector(".vault-toolbar", { timeout: 10000 });
  check(
    "correct passphrase decrypts the listing again",
    (await page.locator(`.vault-item >> text=${SECRET_TITLE}`).count()) === 1,
  );

  // ⌘K finds the vault page by title while unlocked.
  await page.keyboard.press("Meta+k");
  await page.fill(".qs-input-row input", "Nightingale");
  await page.waitForTimeout(400);
  check(
    "⌘K finds the decrypted title while unlocked",
    (await page.locator(`.qs-results >> text=${SECRET_TITLE}`).count()) >= 1,
  );
  await page.keyboard.press("Escape");

  // Open the page and confirm the body decrypts.
  await page.click(`.vault-item >> text=${SECRET_TITLE}`);
  await page.waitForSelector(".bn-editor", { timeout: 10000 });
  check(
    "page body decrypts in the editor",
    (await page.textContent(".bn-editor")).includes(SECRET_BODY),
  );

  /* -------------- vault refuses file uploads ---------------- */
  // Storage blobs bypass the vault's encryption, so pasting an image into
  // a vault page must never upload (audit fix 2026-08-12).
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 60;
    canvas.height = 60;
    canvas.getContext("2d").fillRect(0, 0, 60, 60);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const file = new File([blob], "secret.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.querySelector(".bn-editor").dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }),
    );
  });
  await page.waitForTimeout(1200);
  check(
    "vault page refuses image paste (no img rendered)",
    (await page.locator(".bn-editor img").count()) === 0,
  );


  /* ---------------- reload → locked again ---------------- */

  await page.reload();
  await page.waitForSelector(".sidebar", { timeout: 20000 });
  check(
    "reload relocks: page shows the unlock gate",
    (await page.locator(".vault-card").count()) === 1 &&
      (await page.locator(`text=${SECRET_BODY}`).count()) === 0,
  );

  /* ---------------- image paste compression ---------------- */

  // A plaintext page with the editor focused.
  await page.click(".sidebar-footer >> text=New page");
  await page.waitForSelector(".bn-editor", { timeout: 10000 });
  await page.click(".bn-editor");

  // Paste a 2400×1600 generated PNG. Mock uploads store data URLs, so the
  // stored size is directly observable.
  const sizes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2400;
    canvas.height = 1600;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, 2400, 1600);
    grad.addColorStop(0, "#ff0080");
    grad.addColorStop(1, "#00ff80");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2400, 1600);
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `hsl(${i}, 70%, 50%)`;
      ctx.fillRect((i * 37) % 2400, (i * 91) % 1600, 60, 60);
    }
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const file = new File([blob], "big.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const target = document.querySelector(".bn-editor");
    target.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
    return { original: blob.size };
  });

  await page
    .waitForSelector('.bn-editor img[src^="data:image/"]', { timeout: 15000 })
    .catch(() => {});
  const img = await page
    .$eval('.bn-editor img[src^="data:image/"]', (el) => el.src.slice(0, 60) + "|" + el.src.length)
    .catch(() => null);

  if (img === null) {
    check("pasted image appears in the editor", false, "no data-url img found");
  } else {
    const [head, len] = img.split("|");
    // A data URL's length ≈ bytes × 4/3.
    const storedBytes = Math.round((Number(len) * 3) / 4);
    check("pasted image appears in the editor", true);
    check("pasted image is re-encoded as WebP", head.startsWith("data:image/webp"));
    check(
      "pasted image shrank by at least 3×",
      storedBytes * 3 < sizes.original,
      `original ${sizes.original} B → stored ~${storedBytes} B`,
    );
  }
} catch (err) {
  check(`threw: ${err.message}`, false);
} finally {
  console.log("\n" + results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}
