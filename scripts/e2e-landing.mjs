/**
 * E2E for the marketing landing page (the "/" entry of the two-entry build).
 *
 * Runs against the same mock-mode vite server as the other suites:
 *   VITE_MOCK_CONVEX=1 npx vite --port 5199
 *   node scripts/e2e-landing.mjs
 *
 * Note this one hits the server ROOT, not /app.html — the landing page is the
 * whole point. It also follows a CTA through to the workspace, which proves
 * the /app → app.html route resolves.
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
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));
const failedRequests = [];
page.on("requestfailed", (req) => failedRequests.push(req.url()));

try {
  /* ---------------- structure ---------------- */

  await page.goto(BASE);
  await page.waitForSelector(".hero h1", { timeout: 10000 });

  check(
    "hero headline renders",
    (await page.textContent(".hero h1")).includes("Your ideas"),
    await page.textContent(".hero h1"),
  );
  check("sticky nav is present", (await page.locator(".nav").count()) === 1);
  check(
    "six feature cards",
    (await page.locator(".feature").count()) === 6,
    String(await page.locator(".feature").count()),
  );
  check(
    "four deep-dive rows",
    (await page.locator(".deep .row").count()) === 4,
    String(await page.locator(".deep .row").count()),
  );
  check("footer renders", (await page.locator(".footer").count()) === 1);

  // Anchor links in the nav must actually land somewhere.
  for (const id of ["features", "sync", "publish"]) {
    check(`#${id} section exists`, (await page.locator(`#${id}`).count()) === 1);
  }

  /* ---------------- images ---------------- */

  // The deep-dive screenshots are loading="lazy"; flipping them to eager is a
  // deterministic way to make them fetch (scrolling races the smooth-scroll
  // animation and can leave the last one below the fold).
  await page.$$eval("img", (els) =>
    els.forEach((el) => {
      el.loading = "eager";
    }),
  );
  await page
    .waitForFunction(
      () => Array.from(document.images).every((i) => i.complete),
      null,
      { timeout: 20000 },
    )
    .catch(() => {}); // fall through — the assertion below reports which one

  const images = await page.$$eval("img", (els) =>
    els.map((el) => ({
      src: el.currentSrc || el.src,
      loaded: el.complete && el.naturalWidth > 0,
    })),
  );
  check("page has product screenshots", images.length >= 5, `${images.length} images`);
  const brokenImages = images.filter((i) => !i.loaded).map((i) => i.src);
  check("every image loads", brokenImages.length === 0, brokenImages.join(", "));
  check(
    "no failed requests",
    failedRequests.length === 0,
    failedRequests.join(", "),
  );

  /* ---------------- CTAs ---------------- */

  const ctas = await page.$$eval("[data-cta]", (els) =>
    els.map((el) => ({ href: el.getAttribute("href"), text: el.textContent.trim() })),
  );
  check("landing has CTAs", ctas.length >= 3, `${ctas.length} CTAs`);
  check(
    "every CTA points at /app",
    ctas.every((c) => c.href === "/app"),
    ctas.map((c) => c.href).join(", "),
  );
  check(
    "CTAs read 'Get started' without a prior session",
    ctas.every((c) => c.text === "Get started"),
    ctas.map((c) => c.text).join(" | "),
  );

  const macLink = await page.getAttribute(".hero .btn-secondary", "href");
  check(
    "hero offers a Mac download link",
    (macLink ?? "").startsWith("https://github.com/"),
    macLink ?? "(none)",
  );

  /* ---------------- returning visitor ---------------- */

  await page.evaluate(() => localStorage.setItem("vellum:hasSession", "1"));
  await page.reload();
  await page.waitForSelector(".hero h1", { timeout: 10000 });
  const returning = await page.$$eval("[data-cta]", (els) =>
    els.map((el) => el.textContent.trim()),
  );
  check(
    "CTAs flip to 'Open Vellum' for a returning visitor",
    returning.length > 0 && returning.every((t) => t === "Open Vellum"),
    returning.join(" | "),
  );

  /* ---------------- CTA actually opens the workspace ---------------- */

  await page.click(".hero [data-cta]");
  await page.waitForSelector(".sidebar", { timeout: 15000 });
  await page.waitForSelector(".page-title", { timeout: 15000 });
  check(
    "clicking the CTA boots the workspace",
    (await page.locator(".bn-editor").count()) > 0,
  );
  check(
    "…at the /app URL",
    new URL(page.url()).pathname === "/app",
    new URL(page.url()).pathname,
  );
} catch (err) {
  check(`threw: ${err.message}`, false);
} finally {
  console.log("\n" + results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}
