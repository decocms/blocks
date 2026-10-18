import { describe, expect, it } from "vitest";
import v7Default, { clx as v7 } from "./__fixtures__/v7/sdk/clx";
import { pick, rng } from "./__tests__/v7";
import clxDefault, { clx } from "./clx";

const PARTS = [
  "",
  " ",
  "  ",
  "\t",
  "\n",
  " \n\t ",
  "btn",
  "btn-primary",
  "  px-4  ",
  "flex\n  gap-2",
  "a b",
  "a  b",
  "é",
  null,
  undefined,
  false,
] as const;

describe("clx is v7's", () => {
  it("matches v7 on the cases sites rely on", () => {
    const cases: (string | null | undefined | false)[][] = [
      [],
      ["a"],
      ["a", null, "b", undefined, false, "c"],
      ["", "a"],
      ["  a  ", "  b"],
      ["a\n\n b", "c\t\td"],
      [" "],
    ];
    for (const args of cases) expect([args, clx(...args)]).toEqual([args, v7(...args)]);
    expect(clx("  a  ", "b")).toBe(" a b"); // v7 keeps a single edge space: no trim
    expect(clxDefault).toBe(clx);
    expect(typeof v7Default).toBe("function");
  });

  it("agrees with v7 on 20,000 generated argument lists", () => {
    const r = rng(0xc1c);
    for (let i = 0; i < 20_000; i++) {
      const args = Array.from({ length: Math.floor(r() * 6) }, () => pick(r, PARTS));
      const ours = clx(...args);
      if (ours !== v7(...args)) expect([args, ours]).toEqual([args, v7(...args)]);
    }
  });
});
