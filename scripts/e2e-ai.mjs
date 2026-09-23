/**
 * E2E: the three AI features (mock mode — deterministic stubs, no key, no
 * network). Covers the selection menu, writing from a blank line, the AI
 * database column, and workspace Q&A.
 * Usage: VITE_MOCK_CONVEX=1 npx vite --port 5199 & node scripts/e2e-ai.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = (process.env.E2E_URL ?? "http://localhost:5199") + "/app.html";
const SHOTS = "/tmp/shots-ai";
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

const mod = process.platform === "darwin" ? "Meta" : "Control";

try {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });

  /* ---------------- 1. selection menu: improve writing ---------------- */

  await page.fill(".page-title", "AI test page");
  await page.click(".bn-block-content");
  await page.keyboard.type("this sentence    has   bad spacing");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".bn-editor")
        ?.textContent.includes("this sentence    has   bad spacing"),
    null,
    { timeout: 4000 },
  );

  // Select everything, then ⌘J.
  //
  // ⌘A is not bound by the editor: the browser does a native select-all and
  // ProseMirror only learns about it from the *asynchronous*
  // `selectionchange` event. Playwright fires the next chord in under a
  // millisecond — before that event — so ⌘J used to read the old collapsed
  // selection about one run in five and open the menu in its no-selection
  // shape (no "Improve writing"). No human can press two chords inside one
  // event-loop turn, so this is a test race, not a product bug. The
  // formatting toolbar renders off the editor's own selection state, which
  // makes it the user-visible proof that the selection has landed.
  await page.keyboard.press(`${mod}+A`);
  await page
    .waitForSelector(".bn-formatting-toolbar", { timeout: 4000 })
    .catch(() => {
      throw new Error(
        "⌘A never produced an editor selection (formatting toolbar did not appear)",
      );
    });
  await page.keyboard.press(`${mod}+J`);
  // The menu alone is not enough: it also opens with no selection, showing
  // only "Continue writing". The rewrite actions prove it saw the selection.
  const menuOpened = await page
    .waitForSelector(".ai-menu-item:has-text('Improve writing')", {
      timeout: 4000,
    })
    .then(() => true)
    .catch(() => false);
  check(
    "⌘J opens the AI menu over a selection",
    menuOpened,
    menuOpened
      ? ""
      : `menu items: ${await page.locator(".ai-menu-item").allTextContents()}`,
  );

  // ⌘J must NOT also open the workspace modal.
  check(
    "⌘J does not open the Q&A modal too",
    !(await page.locator(".ask-ai").isVisible().catch(() => false)),
  );

  await page.click(".ai-menu-item:has-text('Improve writing')");
  const gotResult = await page
    .waitForSelector(".ai-menu-result", { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  check("a result preview renders before anything is applied", gotResult);
  await page.screenshot({ path: `${SHOTS}/01-result.png` });

  const docBefore = await page.textContent(".bn-editor");
  check(
    "the document is untouched until the user accepts",
    docBefore.includes("has   bad spacing") ||
      docBefore.includes("has  bad spacing"),
  );

  await page.click(".ai-menu-item:has-text('Replace selection')");
  await page.waitForTimeout(700);
  const docAfter = await page.textContent(".bn-editor");
  check(
    "Replace selection rewrites the block",
    docAfter.includes("this sentence has bad spacing"),
    docAfter.slice(0, 80),
  );
  check("the menu closes after applying", !(await page.locator(".ai-menu").isVisible()));

  /* --------------- 2. writing from a blank line (regression) --------------- */

  await page.click(".bn-block-content >> nth=-1");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.keyboard.type("/Ask AI");
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");

  const blankMenu = await page
    .waitForSelector(".ai-menu", { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check("/Ask AI opens the menu on a blank line", blankMenu);

  // A free-form instruction with no selection is the write-from-scratch flow
  // that the server used to reject outright.
  await page.fill(".ai-menu-input input", "Draft a standup update");
  await page.keyboard.press("Enter");
  const blankResult = await page
    .waitForSelector(".ai-menu-result", { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  const blankError = await page
    .locator(".ai-menu-error")
    .textContent()
    .catch(() => null);
  check(
    "writing from a blank line is not rejected",
    blankResult && !blankError,
    blankError ?? "",
  );

  await page.click(".ai-menu-item:has-text('Insert below')");
  await page.waitForTimeout(700);
  check(
    "Insert below adds the generated text",
    (await page.textContent(".bn-editor")).includes("Draft a standup update"),
  );
  await page.screenshot({ path: `${SHOTS}/02-blank-line.png` });

  /* ---------------- 3. AI database property ---------------- */

  await page.click(".sidebar-footer .icon-btn[title='New database']");
  await page.click(".menu-item:has-text('New database')");
  await page.waitForTimeout(500);
  await page.fill(".page-title", "AI columns");
  await page.waitForSelector(".db-table");

  await page.click(".new-row-btn");
  await page.waitForTimeout(250);
  await page.keyboard.type("Quarterly review");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  // Add a column, open its menu, and switch the type to AI.
  await page.click(".th-btn.add");
  await page.waitForTimeout(500);
  // The new column's header opens the property menu.
  await page.click(".db-table thead th:nth-last-child(2)");
  await page.waitForSelector(".prop-type-btn", { timeout: 5000 });
  await page.click(".prop-type-btn");
  await page.waitForSelector(".prop-type-list", { timeout: 5000 });

  const aiType = page.locator(".prop-type-list .menu-item", { hasText: "AI" });
  const aiTypeVisible = await aiType
    .first()
    .isVisible()
    .catch(() => false);
  check("AI appears as a property type", aiTypeVisible);
  if (aiTypeVisible) {
    await aiType.first().click();
    await page.waitForTimeout(400);
    const hasKinds = await page
      .locator(".menu-item:has-text('Key topics')")
      .isVisible()
      .catch(() => false);
    check("the AI column exposes its generate kinds", hasKinds);
    await page.screenshot({ path: `${SHOTS}/03-ai-column-config.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    const genBtn = page.locator(".ai-cell-generate").first();
    const hasGen = await genBtn.isVisible().catch(() => false);
    check("the AI cell offers a Generate button", hasGen);
    if (hasGen) {
      await genBtn.click();
      await page.waitForTimeout(900);
      const cellText = await page.textContent(".ai-cell");
      check(
        "generating fills the cell and flips to Regenerate",
        cellText.includes("Regenerate"),
        cellText.slice(0, 60),
      );
      await page.screenshot({ path: `${SHOTS}/04-ai-cell.png` });
    }

    // Fill a whole column at once: two more empty rows, then the menu's
    // "Fill N empty rows" — the already-filled row must not be redone.
    for (const title of ["Budget plan", "Hiring notes"]) {
      await page.click(".new-row-btn");
      await page.waitForTimeout(250);
      await page.keyboard.type(title);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
    }
    await page.click(".db-table thead th:nth-last-child(2)");
    const fillBtn = await page
      .waitForSelector(".ai-fill-all", { timeout: 4000 })
      .catch(() => null);
    check("the AI column menu offers a fill-all action", !!fillBtn);
    if (fillBtn) {
      const label = await fillBtn.textContent();
      check("it counts only the empty rows", /Fill 2 empty rows/.test(label), label);
      await fillBtn.click();
      const finished = await page
        .waitForFunction(
          () => /Filled 2 rows/.test(document.querySelector(".prop-menu")?.textContent ?? ""),
          null,
          { timeout: 6000 },
        )
        .then(() => true)
        .catch(() => false);
      check("fill-all reports every row filled", finished);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      check(
        "all three AI cells now hold a value",
        (await page.locator(".ai-cell-value").count()) === 3,
      );
    }
  }

  /* ---------------- 4. floating launcher + chat panel ---------------- */

  // The bubble is the discoverable entry point — it must be visible before
  // anything is opened, and must open the panel on click.
  const launcher = page.locator(".ai-launcher");
  check("the floating AI button shows bottom-right", await launcher.isVisible());
  if (await launcher.isVisible()) {
    const box = await launcher.boundingBox();
    const vw = page.viewportSize().width;
    const vh = page.viewportSize().height;
    check(
      "the button really is in the bottom-right corner",
      box.x + box.width > vw - 90 && box.y + box.height > vh - 90,
      `x=${Math.round(box.x)} y=${Math.round(box.y)} of ${vw}x${vh}`,
    );
    await launcher.click();
    const viaButton = await page
      .waitForSelector(".ai-panel", { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    check("clicking the button opens the panel", viaButton);
    check(
      "the button hides while the panel is open",
      !(await launcher.isVisible()),
    );
    await page.screenshot({ path: `${SHOTS}/09-launcher.png` });
    // Close again so the shortcut check below starts from a known state.
    await page.click(".ai-panel-head-actions .icon-btn[title='Close']");
    await page.waitForTimeout(300);
    check("the button returns after closing", await launcher.isVisible());
  }

  await page.keyboard.press(`${mod}+Shift+J`);
  const panelOpened = await page
    .waitForSelector(".ai-panel", { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check("⌘⇧J opens the AI chat panel", panelOpened);

  if (panelOpened) {
    check(
      "the empty state greets and offers suggestions",
      (await page.locator(".ai-panel-empty h2").isVisible()) &&
        (await page.locator(".ai-panel-suggestion").count()) > 0,
    );
    check(
      "the composer shows the open page as a context chip",
      await page.locator(".ai-context-chip").isVisible(),
    );
    await page.screenshot({ path: `${SHOTS}/05-panel-empty.png` });

    // The panel docks beside the page rather than covering it.
    const mainVisible = await page.locator(".main-content").isVisible();
    check("the panel docks alongside the page, not over it", mainVisible);

    await page.fill(".ai-panel-composer textarea", "What is on the roadmap?");
    await page.keyboard.press("Enter");
    const replied = await page
      .waitForSelector(".ai-msg-assistant .ai-msg-body", { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check("the panel answers and renders the thread", replied);
    check(
      "the user's own turn is in the thread",
      (await page.locator(".ai-msg-user").count()) === 1,
    );

    // Multi-turn: a second message must not wipe the first exchange.
    await page.fill(".ai-panel-composer textarea", "And after that?");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    check(
      "conversation is multi-turn (history is kept)",
      (await page.locator(".ai-msg-user").count()) === 2,
    );
    await page.screenshot({ path: `${SHOTS}/06-panel-thread.png` });

    // Personalize persists to localStorage.
    await page.click(".ai-composer-foot .icon-btn[title='Personalize']");
    await page.waitForSelector(".ai-persona textarea", { timeout: 4000 });
    await page.fill(".ai-persona textarea", "Be blunt.");
    await page.waitForTimeout(300);
    const saved = await page.evaluate(() =>
      localStorage.getItem("vellum:ai-persona"),
    );
    check("Personalize persists custom instructions", saved === "Be blunt.");

    await page.click(".ai-panel-head-actions .icon-btn[title='New chat']");
    await page.waitForTimeout(400);
    check(
      "New chat clears the thread",
      (await page.locator(".ai-msg-user").count()) === 0,
    );

    /* ------------- workspace agent: plan card → Apply → real pages ------ */
    await page.fill(".ai-panel-composer textarea", "Create a meal plan for the week");
    await page.keyboard.press("Enter");
    const planCard = await page
      .waitForSelector(".ai-plan-card", { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    check("a creation ask renders a plan card", planCard);
    if (planCard) {
      const steps = await page.locator(".ai-plan-steps li").count();
      check("the card lists the plan's steps", steps === 4, `${steps} steps`);
      check(
        "the card says it only creates",
        (await page.textContent(".ai-plan-note"))?.includes("nothing is changed"),
      );
      await page.screenshot({ path: `${SHOTS}/07-plan-card.png` });

      await page.click(".ai-plan-apply");
      await page.waitForSelector(".ai-plan-applied", { timeout: 5000 });
      check("Apply collapses the card into a receipt", true);
      const chips = await page.locator(".ai-msg-sources").last().locator(".ai-msg-source").count();
      check("the confirmation links what was created", chips === 2, `${chips} chips`);

      // The promised pages actually exist in the sidebar tree.
      check(
        "the database landed in the sidebar",
        await page.isVisible(".tree-title:text('Meal plan')"),
      );
      check(
        "the content page landed in the sidebar",
        await page.isVisible(".tree-title:text('Grocery list')"),
      );
      // And the database really has the plan's rows.
      await page.click(".tree-title:text('Meal plan')");
      await page.waitForSelector(".db-table", { timeout: 5000 });
      const rowTitles = await page.$$eval(".db-table .row-title", (els) =>
        els.map((e) => e.textContent),
      );
      check(
        "the rows from the plan exist",
        rowTitles.includes("Pasta night") && rowTitles.includes("Taco night"),
        rowTitles.join(", "),
      );
      await page.screenshot({ path: `${SHOTS}/08-plan-applied.png` });

      // Dismiss leaves no trace: new chat, same ask, dismiss instead.
      await page.click(".ai-launcher").catch(() => {});
      const panelStillOpen = await page.locator(".ai-panel").isVisible();
      if (!panelStillOpen) await page.keyboard.press(`${mod}+Shift+J`);
      await page.click(".ai-panel-head-actions .icon-btn[title='New chat']");
      await page.waitForTimeout(300);
      await page.fill(".ai-panel-composer textarea", "Create another meal plan");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".ai-plan-card", { timeout: 5000 });
      await page.click(".ai-plan-actions .btn.subtle");
      await page.waitForTimeout(300);
      const cardsLeft = await page.locator(".ai-plan-card").count();
      // Scoped to the tree: the Recents section legitimately shows the
      // freshly-edited database too.
      const mealPlans = await page.locator(".tree-root .tree-title:text('Meal plan')").count();
      check(
        "Dismiss removes the card without writing",
        cardsLeft === 0 && mealPlans === 1,
        `cards=${cardsLeft} mealplans=${mealPlans}`,
      );
    }

    await page.click(".ai-panel-head-actions .icon-btn[title='Close']");
    await page.waitForTimeout(300);
    check("the panel closes", !(await page.locator(".ai-panel").isVisible()));
  }

  // The sidebar no longer carries an AI row — the bubble replaced it.
  check(
    "no stray AI row is left in the sidebar",
    (await page.locator(".sidebar-item:has-text('Ask AI')").count()) === 0,
  );

  /* ------- 5. Replace is refused when the result gained a placeholder ------- */
  // The provider guardrail redacts card numbers on the way in, so a rewrite
  // of "card 4111 1111 1111 1111" comes back as "card [CREDIT_CARD]"; the
  // mock mirrors that. Accepting Replace would overwrite the real number.

  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });
  await page.fill(".page-title", "Redaction page");
  await page.click(".bn-block-content");
  await page.keyboard.type("card 4111 1111 1111 1111");
  await page.waitForFunction(
    () =>
      document.querySelector(".bn-editor")?.textContent.includes("4111 1111"),
    null,
    { timeout: 4000 },
  );
  await page.keyboard.press(`${mod}+A`);
  await page.waitForSelector(".bn-formatting-toolbar", { timeout: 4000 });
  await page.keyboard.press(`${mod}+J`);
  await page.waitForSelector(".ai-menu-item:has-text('Fix spelling')", {
    timeout: 4000,
  });
  await page.click(".ai-menu-item:has-text('Fix spelling')");
  await page.waitForSelector(".ai-menu-result", { timeout: 6000 });
  check(
    "a redacted result carries the placeholder",
    (await page.textContent(".ai-menu-result")).includes("[CREDIT_CARD]"),
  );
  const replaceBtn = page.locator(".ai-menu-item:has-text('Replace selection')");
  check(
    "Replace selection is disabled for a redacted result",
    await replaceBtn.isDisabled(),
  );
  check(
    "the menu explains why",
    (await page.locator(".ai-menu-note").textContent()).includes("placeholder"),
  );
  check(
    "Insert below stays available",
    await page.locator(".ai-menu-item:has-text('Insert below')").isEnabled(),
  );
  await page.keyboard.press("Escape");
  check(
    "the real number is still in the document",
    (await page.textContent(".bn-editor")).includes("4111 1111 1111 1111"),
  );

  /* ---------- 6. the agent edits existing text via a diffed plan ---------- */
  // The mock turns an edit-shaped ask that quotes a phrase into one
  // replaceText step on the open page; the card must show the diff, Apply
  // must swap the block in the live editor, and nothing else may change.

  // Escape left focus on the menu's trigger, not the editor: click back in
  // at the last block before typing a fresh line.
  await page.locator(".bn-block-content").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("The quick brown fox");
  await page.waitForFunction(
    () => document.querySelector(".bn-editor")?.textContent.includes("quick brown fox"),
    null,
    { timeout: 4000 },
  );
  await page.keyboard.press(`${mod}+Shift+J`);
  await page.waitForSelector(".ai-panel", { timeout: 4000 });
  await page.fill(".ai-panel-composer textarea", 'Rewrite "The quick brown fox" to be formal');
  await page.keyboard.press("Enter");
  const diffCard = await page
    .waitForSelector(".ai-plan-card .ai-plan-diff", { timeout: 6000 })
    .catch(() => null);
  check("an edit ask renders a plan card with a diff", !!diffCard);
  if (diffCard) {
    const diff = await diffCard.textContent();
    check("the diff shows what goes and what comes", diff.includes("− The quick brown fox") && diff.includes("+ The quick brown fox (edited by AI)"));
    check(
      "the note says edits are undoable, not additive-only",
      (await page.textContent(".ai-plan-note")).includes("page history"),
    );
    await page.click(".ai-plan-apply");
    await page.waitForSelector(".ai-plan-applied", { timeout: 6000 });
    await page.waitForTimeout(400);
    const body = await page.textContent(".bn-editor");
    check("Apply swaps the block in the live editor", body.includes("The quick brown fox (edited by AI)"));
    check("the old block is gone (not duplicated)", body.split("The quick brown fox").length === 2);
    check("the rest of the page is untouched", body.includes("4111 1111 1111 1111"));
    check(
      "the receipt says updated, not created",
      (await page.locator(".ai-msg-body").last().textContent()).includes("updated"),
    );
  }

  /* ------------- 7. the reply streams in, and chats are saved ------------- */

  await page.fill(".ai-panel-composer textarea", "Summarize my week");
  await page.keyboard.press("Enter");
  const streamed = await page
    .waitForSelector(".ai-msg-streaming", { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check("the reply streams in before it is complete", streamed);
  await page.waitForSelector(".ai-msg-streaming", { state: "detached", timeout: 5000 });
  check(
    "the finished reply replaces the streaming one",
    (await page.locator(".ai-msg-assistant").last().textContent()).includes("Summarize my week"),
  );

  // A reload keeps the conversation: the panel reopens the latest chat.
  await page.waitForTimeout(600); // let the save settle
  await page.reload();
  await page.waitForSelector(".page-title", { timeout: 10000 });
  await page.keyboard.press(`${mod}+Shift+J`);
  await page.waitForSelector(".ai-panel", { timeout: 4000 });
  const restored = await page
    .waitForFunction(
      () => (document.querySelector(".ai-panel-thread")?.textContent ?? "").includes("Summarize my week"),
      null,
      { timeout: 4000 },
    )
    .then(() => true)
    .catch(() => false);
  check("the chat survives a reload", restored);

  await page.click(".ai-panel-head-actions .icon-btn[title='New chat']");
  check("New chat starts an empty thread", await page.locator(".ai-panel-empty").isVisible());
  await page.click(".ai-panel-title");
  await page.waitForSelector(".ai-history", { timeout: 3000 });
  const items = await page.locator(".ai-history-item").count();
  check("the history menu lists saved chats", items >= 1, `${items} chats`);
  await page.locator(".ai-history-open").first().click();
  const reopened = await page
    .waitForFunction(
      () => (document.querySelector(".ai-panel-thread")?.textContent ?? "").includes("Summarize my week"),
      null,
      { timeout: 3000 },
    )
    .then(() => true)
    .catch(() => false);
  check("picking a chat from history reopens it", reopened);
  await page.click(".ai-panel-title");
  await page.waitForSelector(".ai-history", { timeout: 3000 });
  await page.locator(".ai-history-item .icon-btn[title='Delete chat']").first().click();
  await page.waitForTimeout(300);
  check(
    "deleting a chat removes it from the history",
    (await page.locator(".ai-history-item").count()) === items - 1,
  );
} catch (err) {
  check(`threw: ${err.message}`, false);
  await page.screenshot({ path: `${SHOTS}/crash.png` }).catch(() => {});
} finally {
  await browser.close();
  console.log(results.join("\n"));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  console.log(`screenshots: ${SHOTS}`);
  process.exit(failures === 0 ? 0 : 1);
}
