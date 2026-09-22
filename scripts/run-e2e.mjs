#!/usr/bin/env node
/**
 * Runs the mock-mode Playwright suites one after another and reports which
 * failed. CI calls this (`npm run e2e`, .github/workflows/ci.yml); it is the
 * same command locally.
 *
 * Needs the mock server the suites expect, started separately:
 *   VITE_MOCK_CONVEX=1 npx vite --port 5199 --strictPort
 *   node scripts/run-e2e.mjs                  # every default suite
 *   node scripts/run-e2e.mjs e2e-ai e2e-vault # only these
 *   node scripts/run-e2e.mjs --list           # print the selection, run nothing
 *
 * Every suite runs even after one fails, so a single run reports the whole
 * picture; the exit code is 1 if any suite failed (or timed out), 0 otherwise.
 *
 * Two suites are excluded unless named explicitly, because neither can run
 * against the mock server:
 *  - e2e-offline.mjs drives a REAL Convex deployment and needs the owner's
 *    password. It must never run in CI.
 *  - e2e-pwa.mjs needs a BUILT app under `vite preview` (port 5197) — the
 *    service worker only registers in PROD builds. CI runs it as its own step.
 *
 * Env: E2E_URL and CHROMIUM_PATH pass straight through to the suites.
 * E2E_SUITE_TIMEOUT_MS caps one suite (default 10 min), so a hung Playwright
 * wait costs one suite rather than the whole job.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXCLUDED = new Set(["e2e-offline.mjs", "e2e-pwa.mjs"]);
const SUITE_TIMEOUT_MS = Number(process.env.E2E_SUITE_TIMEOUT_MS) || 10 * 60_000;
const IN_ACTIONS = process.env.GITHUB_ACTIONS === "true";

/* ------------------------------------------------------------ selection */

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const named = args.filter((a) => !a.startsWith("--"));
for (const flag of flags) {
  if (flag !== "--list" && flag !== "--no-warmup") {
    console.error(`unknown option ${flag} (known: --list, --no-warmup)`);
    process.exit(2);
  }
}

// `e2e*.mjs`, which deliberately does not match this file (run-e2e.mjs).
const all = readdirSync(SCRIPTS_DIR)
  .filter((f) => /^e2e.*\.mjs$/.test(f))
  .sort();

let suites;
if (named.length > 0) {
  // Accept "e2e-ai", "e2e-ai.mjs" and "scripts/e2e-ai.mjs" alike.
  suites = named.map((n) => {
    const file = basename(n).replace(/(\.mjs)?$/, ".mjs");
    if (!all.includes(file)) {
      console.error(`no such suite: ${n} (looked for scripts/${file})`);
      process.exit(2);
    }
    return file;
  });
} else {
  suites = all.filter((f) => !DEFAULT_EXCLUDED.has(f));
}

// A glob that silently matches nothing must not read as a green run.
if (suites.length === 0) {
  console.error(`no e2e suites found in ${SCRIPTS_DIR}`);
  process.exit(2);
}

if (flags.has("--list")) {
  console.log(suites.join("\n"));
  process.exit(0);
}

/* -------------------------------------------------------------- browser */

// Most suites fall back to /opt/pw-browsers/chromium when CHROMIUM_PATH is
// unset. If Playwright's own browser is installed (`npx playwright install
// chromium`), point them at it instead — the same thing CI exports.
if (!process.env.CHROMIUM_PATH) {
  try {
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    if (path && existsSync(path)) process.env.CHROMIUM_PATH = path;
  } catch {
    // Leave it unset; the suites will report their own launch error.
  }
}

/**
 * Loads each entry once before the first suite. A cold Vite dev server
 * (every CI run) pre-bundles dependencies on the first request, which can
 * outlast the 10-15s selector timeouts of whichever suite happens to go
 * first. Best-effort: the suites are the verdict, so a failure here only
 * warns.
 */
async function warmUp(base) {
  const started = Date.now();
  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    const page = await browser.newPage();
    await page.goto(`${base}/app.html`, { waitUntil: "load", timeout: 120_000 });
    await page.waitForSelector("#root > *", { timeout: 120_000 });
    for (const path of ["/", "/help.html", "/legal.html"]) {
      await page.goto(base + path, { waitUntil: "load", timeout: 120_000 });
    }
    console.log(`warm-up: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.warn(`warm-up: skipped (${String(err?.message ?? err).split("\n")[0]})`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ run */

const base = process.env.E2E_URL ?? "http://localhost:5199";
console.log(`running ${suites.length} suite(s) against ${base}`);
console.log(`chromium: ${process.env.CHROMIUM_PATH ?? "(CHROMIUM_PATH unset — suite defaults apply)"}`);
if (!flags.has("--no-warmup")) await warmUp(base);

const results = [];
let interrupted = false;

for (const file of suites) {
  console.log(IN_ACTIONS ? `::group::${file}` : `\n━━━ ${file} ━━━`);
  const started = Date.now();
  const res = spawnSync(process.execPath, [join(SCRIPTS_DIR, file)], {
    stdio: "inherit",
    env: process.env,
    timeout: SUITE_TIMEOUT_MS,
  });
  const seconds = (Date.now() - started) / 1000;
  if (IN_ACTIONS) console.log("::endgroup::");

  let outcome = "PASS";
  let detail = "";
  if (res.error?.code === "ETIMEDOUT") {
    outcome = "TIMEOUT";
    detail = `killed after ${Math.round(SUITE_TIMEOUT_MS / 1000)}s`;
  } else if (res.error) {
    outcome = "FAIL";
    detail = res.error.message;
  } else if (res.signal) {
    outcome = "FAIL";
    detail = `killed by ${res.signal}`;
    interrupted = res.signal === "SIGINT";
  } else if (res.status !== 0) {
    outcome = "FAIL";
    detail = `exit ${res.status}`;
  }
  results.push({ file, outcome, detail, seconds });

  if (outcome !== "PASS" && IN_ACTIONS) {
    console.log(`::error title=e2e suite failed::${file} — ${outcome} ${detail}`);
  }
  if (interrupted) break; // Ctrl-C means stop, not "next suite".
}

/* -------------------------------------------------------------- summary */

const failed = results.filter((r) => r.outcome !== "PASS");
const width = Math.max(...results.map((r) => r.file.length));

console.log("\n━━━ e2e summary ━━━");
for (const r of results) {
  console.log(
    `${r.outcome.padEnd(7)}  ${r.file.padEnd(width)}  ${r.seconds.toFixed(1).padStart(6)}s  ${r.detail}`,
  );
}
console.log(`\n${results.length - failed.length}/${results.length} suites passed`);
if (results.length < suites.length) {
  console.log(`${suites.length - results.length} suite(s) not run (interrupted)`);
}
if (failed.length > 0) console.log(`FAILED: ${failed.map((r) => r.file).join(", ")}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map(
    (r) => `| ${r.outcome} | \`${r.file}\` | ${r.seconds.toFixed(1)}s | ${r.detail} |`,
  );
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    ["### e2e suites", "", "| Result | Suite | Time | Detail |", "| --- | --- | --- | --- |", ...rows, ""].join("\n"),
  );
}

process.exit(interrupted ? 130 : failed.length > 0 ? 1 : 0);
