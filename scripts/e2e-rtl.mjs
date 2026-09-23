/**
 * E2E for right-to-left text (Hebrew): every editor block takes its
 * direction from its own text, so Hebrew blocks lay out right-to-left
 * (markers, checkboxes and nested indents on the right) while English
 * blocks on the same page stay left-to-right. Asserts geometry, not just
 * attributes. Mock data mode.
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5199 & node scripts/e2e-rtl.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5199") + "/app.html";
const SHOTS = "/tmp/shots-rtl";
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));
const mod = process.platform === "darwin" ? "Meta" : "Control";

/** Direction + key boxes of the Nth editor block. */
const block = (i) =>
  page.evaluate((i) => {
    const el = document.querySelectorAll(".bn-block-content")[i];
    const outer = el.closest(".bn-block-outer");
    const text = el.querySelector(".bn-inline-content");
    const box = (n) => (n ? n.getBoundingClientRect() : null);
    const r = (b) => (b ? { left: Math.round(b.left), right: Math.round(b.right) } : null);
    return {
      type: el.getAttribute("data-content-type"),
      dir: getComputedStyle(el).direction,
      outerDir: outer.getAttribute("dir"),
      text: r(box(text)),
      input: r(box(el.querySelector("input"))),
      editor: r(box(document.querySelector(".bn-editor"))),
    };
  }, i);

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });
  await page.click(".sidebar-footer button:has-text('New page')");
  await page.waitForTimeout(500);
  await page.fill(".page-title", "רשימת קניות לשבוע");
  await page.click(".bn-block-content");

  await page.keyboard.type("זו פסקה בעברית עם מילה באנגלית Vellum באמצע.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- פריט ראשון");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("פריט מקונן");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[] משימה לסמן");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("English paragraph stays left-to-right.");
  await page.waitForTimeout(500);

  const blocks = await page.evaluate(() =>
    [...document.querySelectorAll(".bn-block-content")].map((el) => el.textContent),
  );
  const at = (s) => blocks.findIndex((t) => t.includes(s));

  const para = await block(at("זו פסקה"));
  check("every block carries dir=\"auto\"", para.outerDir === "auto");
  check("a Hebrew paragraph resolves right-to-left", para.dir === "rtl");
  check(
    "…and is aligned to the right edge",
    para.text && para.editor && para.editor.right - para.text.right < 80,
    JSON.stringify(para.text),
  );

  const item = await block(at("פריט ראשון"));
  check("a Hebrew bullet item resolves right-to-left", item.dir === "rtl");

  const nested = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".bn-block-content")].find((n) =>
      n.textContent.includes("פריט מקונן"),
    );
    const group = el.closest(".bn-block-group");
    const cs = getComputedStyle(group);
    return { marginRight: cs.marginRight, marginLeft: cs.marginLeft };
  });
  check(
    "a nested Hebrew item indents from the right",
    nested.marginRight === "24px" && nested.marginLeft === "0px",
    JSON.stringify(nested),
  );

  const task = await block(at("משימה לסמן"));
  check("a Hebrew to-do resolves right-to-left", task.dir === "rtl");
  check(
    "…with its checkbox on the right of the text",
    task.input && task.text && task.input.left > task.text.left,
    JSON.stringify({ input: task.input, text: task.text }),
  );

  const english = await block(at("English paragraph"));
  check("an English paragraph on the same page stays left-to-right", english.dir === "ltr");

  const title = await page.evaluate(() => getComputedStyle(document.querySelector(".page-title")).unicodeBidi);
  check("the page title finds its own direction", title === "plaintext");

  // The sidebar and tab labels read correctly but keep beside their icon.
  const label = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".tree-title")].find((n) => n.textContent.includes("רשימת"));
    return t ? { bidi: getComputedStyle(t).unicodeBidi, align: getComputedStyle(t).textAlign } : null;
  });
  check(
    "sidebar labels are bidi-aware and stay beside their icon",
    label && label.bidi === "plaintext" && label.align === "left",
    JSON.stringify(label),
  );

  // Direction survives a reload: it is derived from text, never stored.
  await page.reload();
  await page.waitForSelector(".bn-block-content");
  await page.waitForTimeout(400);
  const again = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".bn-block-content")].find((n) =>
      n.textContent.includes("זו פסקה"),
    );
    return el ? getComputedStyle(el).direction : null;
  });
  check("right-to-left layout survives a reload", again === "rtl");

  // The AI composer handles Hebrew too.
  await page.keyboard.press(`${mod}+Shift+J`);
  await page.waitForSelector(".ai-panel-composer textarea", { timeout: 4000 });
  const composer = await page.evaluate(
    () => getComputedStyle(document.querySelector(".ai-panel-composer textarea")).unicodeBidi,
  );
  check("the AI composer is bidi-aware", composer === "plaintext");
  await page.screenshot({ path: `${SHOTS}/rtl.png` });
} catch (err) {
  check(`threw: ${err.message}`, false);
  await page.screenshot({ path: `${SHOTS}/crash.png` }).catch(() => {});
} finally {
  await browser.close();
  console.log(results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
