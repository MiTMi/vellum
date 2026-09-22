import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * ESLint flat config. `.mjs` because package.json has no `"type": "module"`
 * (Electron's main process is CommonJS, so the package stays CJS).
 *
 * The goal is a config whose ERRORS are all real and cheaply fixable, so it
 * can gate CI without demanding rewrites of deliberate code. Five choices
 * follow from that, and each would be easy to "tidy up" by mistake:
 *
 *  - **typescript-eslint `recommended`, not the type-checked variant.** The
 *    typed rules need a full program per tsconfig (there are two: the root
 *    one and convex/), which turns a ~2 s run into a slow one. `tsc
 *    --noEmit` in `npm run build` already owns type correctness.
 *
 *  - **eslint-plugin-react-hooks' `recommended` preset is NOT used.** v7
 *    bundles the React Compiler rules into it (set-state-in-effect, refs,
 *    purity, immutability, …). Vellum isn't compiled with React Compiler,
 *    and those rules flag large amounts of deliberate code — refs mirrored
 *    during render, effects that sync module-level registries, state set
 *    from subscriptions. Exactly two rules are enabled by hand instead.
 *
 *  - **`exhaustive-deps` is a warning, never an error.** "Just add the dep
 *    it names" is not a safe fix here, because a dep array decides *when* an
 *    effect tears down and re-runs: AiMenu's `[onClose]` effect re-binds its
 *    document listeners on every identity change of that one prop, and the
 *    module-registry patterns (pageRegistry / editorRegistry / vaultSession)
 *    and the replica hooks in storeHooks.ts deliberately key on a version
 *    counter rather than on everything they read. Widening those arrays
 *    changes behaviour. The existing suppressions are deliberate; treat a
 *    new warning as a question to answer, not a to-do to autofix.
 *
 *  - **`rules-of-hooks` stays an error**, including inside BlockNote block
 *    specs. BlockNote mounts a spec's `render` as a component, so hooks are
 *    legal there, but the rule can only tell from the name. Write
 *    `render: function EquationBlock(props) {…}` rather than an anonymous
 *    arrow: no behaviour change, and the rule then checks the body properly
 *    (conditional hooks, hooks after early returns) instead of going blind.
 *
 *  - **Dot-directories are ignored explicitly.** Flat config only skips
 *    node_modules and .git on its own, and `.claude/` + `.agents/` hold some
 *    200 script files of installed agent tooling that is not app code.
 */

/**
 * Shared by the core rule (JS) and its typescript-eslint twin (TS).
 * `ignoreRestSiblings` because `const { publicSlug, publishedAt, ...rest }`
 * is how convex/pages.ts *omits* fields — naming them is the whole point
 * (a slug must never ride along on a create or a duplicate).
 */
const UNUSED_VARS = {
  argsIgnorePattern: "^_",
  varsIgnorePattern: "^_",
  caughtErrorsIgnorePattern: "^_",
  ignoreRestSiblings: true,
};

export default defineConfig([
  globalIgnores([
    "**/node_modules/",
    "dist/",
    "release/",
    "build/",
    "public/",
    "_to_delete/",
    "convex/_generated/",
    "graphify-out/",
    "**/coverage/",
    // Installed agent skill bundles and tool state — not part of the app.
    ".claude/",
    ".agents/",
    ".codex/",
    ".impeccable/",
    ".convex/",
  ]),

  /* ------------------------------ TypeScript ------------------------------ */
  // js.configs.recommended is extended here too: typescript-eslint's preset
  // only switches *off* the core rules TypeScript covers (no-undef, …); it
  // doesn't switch the rest on, so without it no-empty & co. never run on TS.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", UNUSED_VARS],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  /* ------------------------------ JavaScript ------------------------------ */
  // Scoped by `files` so typescript-eslint's rules (no-require-imports above
  // all) never reach electron/*.cjs.
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    rules: {
      "no-unused-vars": ["error", UNUSED_VARS],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  /* ------------------------------- Globals -------------------------------- */
  {
    files: ["src/**"],
    ignores: ["src/pwa/sw.js"], // no `window` in a worker — see below
    languageOptions: { globals: globals.browser },
  },
  {
    // The service worker is registered as a classic script and runs in
    // ServiceWorkerGlobalScope. __PRECACHE__ is the one build-time
    // placeholder used as an identifier (vite.config.ts substitutes it);
    // declaring it keeps no-undef live for real typos in this file.
    files: ["src/pwa/sw.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.serviceworker, __PRECACHE__: "readonly" },
    },
  },
  {
    // Node scripts — but the Playwright suites pass callbacks to
    // page.evaluate() that run in the *browser* while sitting lexically in a
    // Node file, so document/window/indexedDB are legitimately in scope.
    files: ["scripts/**"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["vite.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    // Electron main + preload are CommonJS; `require` is the module system.
    files: ["electron/**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
  },
  {
    // The preload script runs inside the renderer: Node *and* a window.
    files: ["electron/preload.cjs"],
    languageOptions: { globals: globals.browser },
  },
  {
    // Convex functions read process.env; tests import vitest explicitly
    // (every file does — no vitest globals needed) and helpers set env vars.
    files: ["convex/**", "tests/**"],
    languageOptions: { globals: globals.node },
  },

  /* ----------------------------- React hooks ------------------------------ */
  // Two rules by hand — see the header for why the preset is off-limits.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
]);
