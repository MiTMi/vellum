import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  MIN_PASSWORD_LENGTH,
  assertPasswordPolicy,
  unmetPasswordRules,
} from "../convex/lib/passwordPolicy";

describe("sign-up password policy", () => {
  test("a strong passphrase passes every rule", () => {
    expect(unmetPasswordRules("Correct-Horse-Battery-9")).toEqual([]);
    expect(() => assertPasswordPolicy("Correct-Horse-Battery-9")).not.toThrow();
  });

  test("each missing class is reported individually", () => {
    const ids = (p: string) => unmetPasswordRules(p).map((r) => r.id);
    expect(ids("short-A9!")).toEqual(["length"]);
    expect(ids("ALLUPPERCASE-99!")).toEqual(["lower"]);
    expect(ids("alllowercase-99!")).toEqual(["upper"]);
    expect(ids("No-Digits-Here-!")).toEqual(["digit"]);
    expect(ids("NoSymbolsHere99x")).toEqual(["symbol"]);
  });

  test("the old 8-character minimum is no longer enough", () => {
    expect(unmetPasswordRules("Weak-99!").map((r) => r.id)).toEqual(["length"]);
    expect(() => assertPasswordPolicy("Weak-99!")).toThrow(ConvexError);
  });

  test("boundary: exactly the minimum length passes the length rule", () => {
    const pw = "Aa1!".padEnd(MIN_PASSWORD_LENGTH, "x");
    expect(pw.length).toBe(MIN_PASSWORD_LENGTH);
    expect(unmetPasswordRules(pw)).toEqual([]);
  });

  test("the thrown error names every unmet rule readably", () => {
    try {
      assertPasswordPolicy("weak");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConvexError);
      const msg = (err as ConvexError<string>).data;
      expect(msg).toContain("characters");
      expect(msg).toContain("uppercase");
      expect(msg).toContain("number");
      expect(msg).toContain("symbol");
    }
  });
});
