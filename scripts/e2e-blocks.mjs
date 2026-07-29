/**
 * E2E part 2: editor blocks — sub-page links, tables, image upload.
 * Usage: node scripts/e2e-blocks.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.E2E_URL ?? "http://localhost:5199";
const SHOTS = "/tmp/shots-blocks";
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (err) => check(`pageerror: ${err.message}`, false));

try {
  await page.goto(BASE);
  // fresh workspace
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  // Create a host page
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Blocks playground");
  await page.click(".bn-editor");

  // ---------- table block via slash ----------
  await page.keyboard.type("/table");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/10-slash-table.png` });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("table block inserted", (await page.locator(".bn-editor table").count()) > 0);
  // type into first cell
  await page.keyboard.type("Cell A1");
  await page.waitForTimeout(700);
  check(
    "table cell editable",
    (await page.textContent(".bn-editor table")).includes("Cell A1"),
  );

  // ---------- table persists across page navigation ----------
  await page.waitForTimeout(700); // let the debounced save flush
  await page.click(".tree-row:has-text('Welcome')");
  await page.waitForTimeout(500);
  await page.click(".tree-row:has-text('Blocks playground')");
  await page.waitForTimeout(600);
  check(
    "table survives navigating away and back",
    (await page.locator(".bn-editor table").count()) > 0,
  );
  check(
    "table cell text survives navigation",
    ((await page.textContent(".bn-editor table")) ?? "").includes("Cell A1"),
  );
  await page.reload();
  await page.waitForSelector(".bn-editor", { timeout: 10000 });
  await page.waitForTimeout(500);
  check(
    "table survives full reload",
    ((await page.textContent(".bn-editor").catch(() => "")) ?? "").includes("Cell A1"),
  );

  // click back into the editor and move to the end of the document
  await page.click(".bn-editor table td >> nth=0");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(200);

  // ---------- sub-page block via slash ----------
  await page.keyboard.press("Enter");
  await page.keyboard.type("/sub");
  await page.waitForTimeout(500);
  const subItem = page.locator("[class*='suggestion'] >> text=Sub-page").first();
  const subVisible = await subItem.isVisible().catch(() => false);
  check("custom Sub-page slash item appears", subVisible);
  await page.screenshot({ path: `${SHOTS}/11-slash-sub.png` });
  if (subVisible) {
    await subItem.click();
    await page.waitForTimeout(600);
    // We should have navigated to the new sub-page
    const crumbs = await page.locator(".breadcrumbs .crumb").allTextContents();
    check(
      "sub-page slash navigates to child",
      crumbs.some((c) => c.includes("Blocks playground")),
      crumbs.join(" | "),
    );
    await page.fill(".page-title", "Linked child");
    await page.waitForTimeout(500);
    // Go back to parent — pageLink block should render with live title
    await page.click(".topbar .icon-btn[title='Back']");
    await page.waitForTimeout(500);
    const linkText = await page.textContent(".page-link-block").catch(() => "");
    check("pageLink block renders live title", linkText.includes("Linked child"), linkText);
    await page.screenshot({ path: `${SHOTS}/12-page-link.png` });
    // click navigates
    await page.click(".page-link-block");
    await page.waitForTimeout(400);
    check(
      "pageLink click navigates",
      (await page.inputValue(".page-title")) === "Linked child",
    );
    // and it shows in the sidebar under the parent
    await page.click(".tree-row:has-text('Blocks playground') .tree-chevron");
    await page.waitForTimeout(300);
    check(
      "sub-page appears in sidebar tree",
      (await page.locator(".tree-children .tree-row:has-text('Linked child')").count()) > 0,
    );
  }

  // ---------- image upload ----------
  // make a tiny png on the fly
  const pngB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGP8z8Dwn4EIwESMolFFlCsCAO0kAv9pEZLcAAAAAElFTkSuQmCC";
  fs.writeFileSync("/tmp/e2e-test.png", Buffer.from(pngB64, "base64"));

  // fresh page for a clean cursor context
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Image test");
  await page.click(".bn-editor");
  await page.keyboard.type("/image");
  await page.waitForTimeout(500);
  const imageItem = page
    .locator("[class*='suggestion'] >> text=/^Image$/")
    .first();
  if (await imageItem.isVisible().catch(() => false)) {
    await imageItem.click();
  } else {
    await page.keyboard.press("Enter");
  }
  await page.waitForSelector(".bn-add-file-button", { timeout: 5000 }).catch(() => {});
  let hasInput = (await page.locator("input[type='file']").count()) > 0;
  if (!hasInput) {
    await page.click(".bn-add-file-button").catch(() => {});
    await page.waitForTimeout(400);
    hasInput = (await page.locator("input[type='file']").count()) > 0;
  }
  const fileInput = page.locator("input[type='file']").last();
  check("image file panel offers upload input", hasInput);
  if (hasInput) {
    await fileInput.setInputFiles("/tmp/e2e-test.png");
    await page.waitForTimeout(1200);
    const imgCount = await page.locator(".bn-editor img").count();
    check("image uploads and renders", imgCount > 0);
    await page.screenshot({ path: `${SHOTS}/13-image.png` });
  }

  // ---------- checklist toggling persists ----------
  await page.keyboard.press("Escape");
  await page.click(".sidebar-footer .new-page");
  await page.waitForTimeout(400);
  await page.fill(".page-title", "Checklist test");
  await page.click(".bn-editor");
  await page.keyboard.type("/check");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Toggle me");
  await page.waitForTimeout(700);
  const checkbox = page.locator(".bn-editor input[type='checkbox']").last();
  await checkbox.check();
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForSelector(".bn-editor", { timeout: 10000 });
  await page.waitForTimeout(500);
  const stillChecked = await page
    .locator(".bn-editor input[type='checkbox']")
    .last()
    .isChecked();
  check("checklist state persists across reload", stillChecked);
} catch (err) {
  check(`UNCAUGHT: ${err.message}`, false);
  await page.screenshot({ path: `${SHOTS}/99-failure.png` });
} finally {
  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
