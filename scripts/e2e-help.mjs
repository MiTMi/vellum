/**
 * E2E: the Help Center at /help.
 *
 * Pins the skeleton the same way `e2e-landing.mjs` pins the landing page —
 * every guide in the index has an article, hash routing shows exactly one at
 * a time, search filters the index, and the guides link back to the app.
 * Structural edits to help.html must keep this passing.
 *
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5199 & node scripts/e2e-help.mjs
 *        E2E_URL=https://vellum-gilt.vercel.app node scripts/e2e-help.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_URL ?? "http://localhost:5199";
const HELP = `${BASE}/help`;

let failures = 0;
const results = [];
function check(name, ok, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

try {
  await page.goto(HELP);
  await page.waitForSelector(".help-index", { timeout: 15000 });

  /* ------------------------------------------------------- structure */
  const links = await page.$$eval(".help-index a", (els) =>
    els.map((e) => e.getAttribute("href")),
  );
  check("the index lists 21 guides", links.length === 21, String(links.length));

  const ids = await page.$$eval(".guide", (els) => els.map((e) => e.id));
  check("every index entry has a guide", links.every((h) => ids.includes(h.slice(1))),
    links.filter((h) => !ids.includes(h.slice(1))).join(", ") || "all matched");
  check("no orphan guides", ids.every((id) => links.includes(`#${id}`)),
    ids.filter((id) => !links.includes(`#${id}`)).join(", ") || "none");

  check("nav and footer come from the landing design",
    (await page.locator(".nav .wordmark").count()) === 1 &&
      (await page.locator(".footer").count()) === 1);

  /* --------------------------------------------------------- routing */
  check("exactly one guide is open on arrival",
    (await page.locator(".guide.is-open").count()) === 1);
  check("that guide is the first one",
    (await page.locator(".guide.is-open").getAttribute("id")) === "getting-started");

  await page.goto(`${HELP}#formulas`);
  await page.waitForTimeout(600);
  check("a deep link opens its guide",
    (await page.locator(".guide.is-open").getAttribute("id")) === "formulas");
  check("only one guide is ever visible",
    (await page.locator(".guide.is-open").count()) === 1);
  check("the index marks the open guide",
    (await page.textContent(".help-index a.is-active")).includes("Relations"));
  check("the document title names the guide",
    (await page.title()).startsWith("Relations, rollups & formulas"));

  await page.click(".help-index a[href='#vault']");
  await page.waitForTimeout(600);
  check("clicking the index switches guides",
    (await page.locator(".guide.is-open").getAttribute("id")) === "vault");

  await page.goBack();
  await page.waitForTimeout(600);
  check("the back button works", (await page.locator(".guide.is-open").getAttribute("id")) === "formulas");

  /* ------------------------------------------------ prev / next links */
  const navLinks = await page.locator(".guide.is-open .guide-nav a").count();
  check("each guide links to its neighbours", navLinks === 2, String(navLinks));
  await page.click(".guide.is-open .guide-nav a.next");
  await page.waitForTimeout(600);
  check("Next moves on", (await page.locator(".guide.is-open").getAttribute("id")) === "templates");

  /* ------------------------------------------------------------ search */
  await page.fill(".help-search input", "passphrase");
  await page.waitForTimeout(400);
  const visible = await page.$$eval(".help-index a", (els) =>
    els.filter((e) => !e.hidden).map((e) => e.textContent.trim()),
  );
  check("search finds guides by their body text, not just titles",
    visible.includes("The Vault"), visible.join(", "));
  check("search hides the rest", visible.length < 21, `${visible.length} shown`);
  const visuallyShown = await page.$$eval(".help-index a", (els) =>
    els.filter((e) => getComputedStyle(e).display !== "none").length,
  );
  check(
    "hidden links are actually invisible (computed style)",
    visuallyShown === visible.length,
    `${visuallyShown} visible vs ${visible.length} unhidden`,
  );

  await page.fill(".help-search input", "zzzzzz");
  await page.waitForTimeout(400);
  check("a search with no hits says so", await page.isVisible(".help-index-empty"));
  await page.fill(".help-search input", "");
  await page.waitForTimeout(400);
  check("clearing the search restores every guide",
    (await page.$$eval(".help-index a", (els) => els.filter((e) => !e.hidden).length)) === 21);

  /* --------------------------------------------------- links back out */
  const cta = await page.getAttribute("[data-cta]", "href");
  check("the header CTA points at the app", cta === "/app", String(cta));
  check("the landing page links to Help",
    await (async () => {
      await page.goto(BASE);
      await page.waitForSelector(".nav", { timeout: 15000 });
      return (await page.locator(".nav-links a[href='/help']").count()) === 1;
    })());
} catch (err) {
  check(`script error: ${err.message}`, false);
} finally {
  console.log(results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
