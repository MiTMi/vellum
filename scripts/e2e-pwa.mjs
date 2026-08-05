/**
 * E2E for the offline app shell (service worker + web manifest).
 *
 * Needs a *built* app served over http — the worker only registers in PROD
 * builds and only over http(s):
 *   npm run build && npx vite preview --port 5197
 *   node scripts/e2e-pwa.mjs
 *
 * The interesting assertions are the negative ones: the worker must keep its
 * hands off Convex traffic (a cached mutation response would be a correctness
 * bug) and off /p/* (a cached published page could outlive an unpublish).
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_URL ?? "http://localhost:5197";

let failures = 0;
const results = [];
function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

/** Does a cross-origin/same-origin GET from the page and reports reachability. */
const canFetch = (url) =>
  page.evaluate(
    (u) =>
      fetch(u, { mode: "no-cors" }).then(
        () => true,
        () => false,
      ),
    url,
  );

try {
  /* ---------------- registration ---------------- */

  await page.goto(`${BASE}/app`);
  await page.waitForSelector("#root", { timeout: 15000 });

  const registered = await page.evaluate(() =>
    navigator.serviceWorker.ready.then(
      (r) => !!r.active,
      () => false,
    ),
  );
  check("service worker registers and activates", registered);

  const swScript = await page.evaluate(() =>
    navigator.serviceWorker.ready.then((r) => r.active?.scriptURL ?? ""),
  );
  check("…from /sw.js", swScript.endsWith("/sw.js"), swScript);

  // A worker only controls pages loaded after it claimed them.
  await page.reload();
  await page.waitForSelector("#root", { timeout: 15000 });
  check(
    "the worker controls the page after reload",
    await page.evaluate(() => !!navigator.serviceWorker.controller),
  );

  /* ---------------- manifest ---------------- */

  const manifestHref = await page.getAttribute("link[rel=manifest]", "href");
  check("app.html links a manifest", !!manifestHref, manifestHref ?? "(none)");

  const manifest = await page.evaluate(() =>
    fetch("/manifest.webmanifest").then((r) => (r.ok ? r.json() : null)),
  );
  check("manifest parses", !!manifest);
  check(
    "manifest is installable (name, start_url, display, icons)",
    !!manifest &&
      manifest.name === "Vellum" &&
      manifest.start_url === "/app" &&
      manifest.display === "standalone" &&
      manifest.icons.some((i) => i.sizes === "512x512"),
    manifest ? `${manifest.start_url} / ${manifest.display}` : "",
  );
  const iconsOk = await page.evaluate(
    (icons) =>
      Promise.all(icons.map((i) => fetch(i.src).then((r) => r.ok, () => false))).then(
        (r) => r.every(Boolean),
      ),
    manifest?.icons ?? [],
  );
  check("every manifest icon resolves", iconsOk);

  // The landing page installs the same shell.
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".hero h1", { timeout: 15000 });
  check(
    "the landing page links the manifest too",
    !!(await page.getAttribute("link[rel=manifest]", "href")),
  );

  // Visit the Help Center once online, like the other two entries above, so
  // the offline pass below is comparing like with like. (Under `vite
  // preview` it also matters: preview answers /assets/* with `Vary: Origin`,
  // which no cached response can satisfy — Vercel sends no Vary at all.)
  await page.goto(`${BASE}/help`);
  await page.waitForSelector(".help-index", { timeout: 15000 });

  /* ---------------- offline shell ---------------- */

  await context.setOffline(true);

  await page.goto(`${BASE}/app`);
  await page.waitForSelector("#root", { timeout: 15000 });
  check(
    "offline: /app boots the shell from cache",
    (await page.locator("#root").count()) === 1 &&
      (await page.evaluate(() => document.getElementById("root").children.length)) > 0,
  );

  await page.goto(`${BASE}/`);
  await page.waitForSelector(".hero h1", { timeout: 15000 });
  check(
    "offline: / boots the landing page from cache",
    (await page.textContent(".hero h1")).includes("Write it down"),
  );

  await page.goto(`${BASE}/help`);
  await page.waitForSelector(".help-index", { timeout: 15000 });
  check(
    "offline: /help boots the Help Center from cache",
    (await page.locator(".guide.is-open").count()) === 1,
  );

  /* ---------------- what the worker must NOT serve ---------------- */

  check(
    "offline: /p/<slug> is not served from cache",
    (await canFetch("/p/some-published-slug")) === false,
  );
  check(
    "offline: Convex traffic is not served from cache",
    (await canFetch("https://example-deployment.convex.cloud/api/query")) === false,
  );
  check(
    "offline: Convex file storage is not served from cache",
    (await canFetch(
      "https://example-deployment.convex.cloud/api/storage/abc123",
    )) === false,
  );

  await context.setOffline(false);
} catch (err) {
  check(`threw: ${err.message}`, false);
} finally {
  console.log("\n" + results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}
