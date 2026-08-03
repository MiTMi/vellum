import { describe, expect, test } from "vitest";
import {
  checkFormula,
  evalFormula,
  formatFormulaValue,
  FormulaValue,
} from "../src/lib/formula";

const props: Record<string, FormulaValue> = {
  Price: 20,
  Qty: 3,
  Name: "Widget",
  Done: true,
  Start: "2026-08-01",
  End: "2026-08-11",
  Empty: null,
};

const ctx = {
  prop: (n: string) => (n in props ? props[n] : null),
  now: new Date("2026-08-03T12:00:00"),
};

const run = (src: string) => evalFormula(src, ctx);
const val = (src: string) => run(src).value;

describe("arithmetic", () => {
  test("respects precedence and parentheses", () => {
    expect(val("2 + 3 * 4")).toBe(14);
    expect(val("(2 + 3) * 4")).toBe(20);
    expect(val("2 ^ 3 ^ 2")).toBe(512); // right-associative
    expect(val("-5 + 2")).toBe(-3);
  });

  test("division and modulo by zero yield empty rather than Infinity/NaN", () => {
    expect(val("1 / 0")).toBeNull();
    expect(val("1 % 0")).toBeNull();
  });

  test("reads properties", () => {
    expect(val('prop("Price") * prop("Qty")')).toBe(60);
    expect(val('prop("Nope")')).toBeNull();
    expect(val('prop("Empty") + 5')).toBe(5);
  });
});

describe("strings", () => {
  test("+ concatenates when a side isn't numeric", () => {
    expect(val('prop("Name") + " x" + prop("Qty")')).toBe("Widget x3");
    expect(val('"5" + 5')).toBe(10); // both numeric → arithmetic
  });

  test("string functions", () => {
    expect(val('upper(prop("Name"))')).toBe("WIDGET");
    expect(val('length("hello")')).toBe(5);
    expect(val('contains(prop("Name"), "idg")')).toBe(true);
    expect(val('replace("a-b-c", "-", "+")')).toBe("a+b+c");
    expect(val('slice("abcdef", 1, 3)')).toBe("bc");
    expect(val('concat("a", "b", "c")')).toBe("abc");
    expect(val('join(", ", "a", "", "c")')).toBe("a, c");
  });
});

describe("logic", () => {
  test("if / comparisons / booleans", () => {
    expect(val('if(prop("Price") > 10, "expensive", "cheap")')).toBe("expensive");
    expect(val('prop("Done") && prop("Price") == 20')).toBe(true);
    expect(val('not(prop("Done"))')).toBe(false);
    expect(val('empty(prop("Empty"))')).toBe(true);
    expect(val('empty(prop("Name"))')).toBe(false);
  });

  test("= is accepted as equality", () => {
    expect(val('prop("Price") = 20')).toBe(true);
  });

  test("&& short-circuits past a failing right side", () => {
    // The right side would throw on its own; && must never reach it.
    expect(run('false && nosuchfunc()').error).toBeNull();
    expect(val("false && nosuchfunc()")).toBe(false);
  });
});

describe("numbers and dates", () => {
  test("rounding helpers", () => {
    expect(val("round(3.14159, 2)")).toBe(3.14);
    expect(val("round(2.5)")).toBe(3);
    expect(val("floor(2.9)")).toBe(2);
    expect(val("ceil(2.1)")).toBe(3);
    expect(val("abs(0 - 7)")).toBe(7);
    expect(val("min(4, 2, 9)")).toBe(2);
    expect(val("max(4, 2, 9)")).toBe(9);
    expect(val("sum(1, 2, 3)")).toBe(6);
  });

  test("date maths", () => {
    expect(val('dateDiff(prop("Start"), prop("End"))')).toBe(10);
    expect(val('dateAdd(prop("Start"), 5)')).toBe("2026-08-06");
    expect(val('year(prop("Start"))')).toBe(2026);
    expect(val('month(prop("Start"))')).toBe(8);
    expect(val('day(prop("Start"))')).toBe(1);
    expect(val("today()")).toBe("2026-08-03"); // injected clock
  });

  test("date functions return empty for non-dates", () => {
    expect(val('year(prop("Name"))')).toBeNull();
    expect(val('dateDiff(prop("Name"), prop("End"))')).toBeNull();
  });
});

describe("errors are reported, never thrown", () => {
  test.each([
    ["unclosed paren", "(1 + 2"],
    ["unknown function", "bogus(1)"],
    ["bare identifier", "Price * 2"],
    ["unterminated string", '"abc'],
    ["trailing junk", "1 + 2 3"],
    ["stray character", "1 @ 2"],
  ])("%s", (_label, src) => {
    const res = run(src);
    expect(res.error).toBeTruthy();
    expect(res.value).toBeNull();
  });

  test("a bare identifier explains how to reference a property", () => {
    expect(run("Price").error).toContain('prop("Name")');
  });

  test("checkFormula agrees with evaluation", () => {
    expect(checkFormula("1 +")).toBeTruthy();
    expect(checkFormula('prop("Price") * 2')).toBeNull();
    expect(checkFormula("   ")).toBeNull();
  });

  test("an empty formula is empty, not an error", () => {
    expect(run("")).toEqual({ value: null, error: null });
    expect(evalFormula(undefined, ctx)).toEqual({ value: null, error: null });
  });
});

describe("formatting", () => {
  test("booleans read as Yes/No and floats lose binary noise", () => {
    expect(formatFormulaValue(true)).toBe("Yes");
    expect(formatFormulaValue(false)).toBe("No");
    expect(formatFormulaValue(null)).toBe("");
    expect(formatFormulaValue(0.1 + 0.2)).toBe("0.3");
    expect(formatFormulaValue(1 / 3)).toBe("0.3333333333");
  });
});

test("cannot reach globals — formulas are not JavaScript", () => {
  for (const src of [
    "constructor",
    'window("x")',
    "globalThis",
    'eval("1")',
    "process",
  ]) {
    expect(run(src).error).toBeTruthy();
  }
});
