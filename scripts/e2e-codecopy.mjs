/** E2E: copy button on code blocks. */
import { chromium } from "playwright";
import fs from "fs";

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
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

try {
  await page.goto((process.env.E2E_URL ?? "http://localhost:5199") + "/app.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Code page");
  await page.click(".bn-editor");
  await page.keyboard.type("/code");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await page.keyboard.type('const answer = 42;\nconsole.log(answer);');
  await page.waitForTimeout(600);

  const codeBlock = page.locator('[data-content-type="codeBlock"]');
  check("code block exists", (await codeBlock.count()) > 0);

  await codeBlock.hover();
  await page.waitForSelector(".code-copy-btn", { timeout: 5000 });
  const btnBox = await page.locator(".code-copy-btn").boundingBox();
  const blockBox = await codeBlock.boundingBox();
  check(
    "button sits at top-right of the block",
    btnBox && blockBox &&
      Math.abs(btnBox.y - blockBox.y) < 30 &&
      btnBox.x > blockBox.x + blockBox.width * 0.7,
    btnBox && blockBox ? `btn(${Math.round(btnBox.x)},${Math.round(btnBox.y)}) block(${Math.round(blockBox.x)},${Math.round(blockBox.y)},w${Math.round(blockBox.width)})` : "",
  );

  await page.click(".code-copy-btn");
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("click copies code text", clip.includes("const answer = 42;") && clip.includes("console.log(answer);"), JSON.stringify(clip.slice(0, 40)));
  check("copied feedback shows", (await page.locator(".code-copy-btn.copied").count()) === 1);

  await page.screenshot({ path: "/tmp/shots-codecopy.png" });

  // moves away → hides
  await page.mouse.move(400, 100);
  await page.waitForTimeout(400);
  check("button hides when leaving block", (await page.locator(".code-copy-btn").count()) === 0);
} catch (err) {
  check(`UNCAUGHT: ${err.message}`, false);
  await page.screenshot({ path: "/tmp/shots-codecopy-fail.png" });
} finally {
  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
