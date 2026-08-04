import { afterEach, expect, test, vi } from "vitest";
import { publicUrlFor } from "../src/data/api";

/**
 * Regression guard for a trap that shipped once already: `npx convex deploy
 * --cmd` injects VITE_CONVEX_SITE_URL into the build environment, and a real
 * process env var outranks .env.production in Vite. Minting share links from
 * that variable therefore worked in every local build and was silently
 * reverted to the raw .convex.site domain on every CI build.
 *
 * VITE_PUBLIC_SITE_URL exists so the app's own domain always wins.
 */

const CONVEX_SITE = "https://deployment-123.eu-west-1.convex.site";
const OWN_DOMAIN = "https://vellum-gilt.vercel.app";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("falls back to the Convex site domain when no override is set", () => {
  vi.stubEnv("VITE_PUBLIC_SITE_URL", undefined);
  vi.stubEnv("VITE_CONVEX_SITE_URL", CONVEX_SITE);
  expect(publicUrlFor("abc123")).toBe(`${CONVEX_SITE}/p/abc123`);
});

test("VITE_PUBLIC_SITE_URL wins, even when convex deploy injects the other", () => {
  vi.stubEnv("VITE_PUBLIC_SITE_URL", OWN_DOMAIN);
  vi.stubEnv("VITE_CONVEX_SITE_URL", CONVEX_SITE);
  expect(publicUrlFor("abc123")).toBe(`${OWN_DOMAIN}/p/abc123`);
});

test("a trailing slash on the origin doesn't double up", () => {
  vi.stubEnv("VITE_PUBLIC_SITE_URL", `${OWN_DOMAIN}/`);
  expect(publicUrlFor("abc123")).toBe(`${OWN_DOMAIN}/p/abc123`);
});

test("no origin configured means no link, rather than a broken one", () => {
  vi.stubEnv("VITE_PUBLIC_SITE_URL", undefined);
  vi.stubEnv("VITE_CONVEX_SITE_URL", undefined);
  expect(publicUrlFor("abc123")).toBeNull();
});
