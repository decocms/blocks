import { describe, expect, it } from "vitest";
import { escapeSqlLiteral, isValidNpmPackageName } from "./sql-safety";

describe("isValidNpmPackageName", () => {
  it("accepts real package names", () => {
    for (const name of ["my-site", "@org/site", "site_1.2.3", "a", "@deco/casaevideo", "x-y.z~q"]) {
      expect(isValidNpmPackageName(name)).toBe(true);
    }
  });

  it("rejects SQL-injection payloads and other illegal names", () => {
    for (const name of [
      "x'; UPDATE public.sites SET metadata='{}'::jsonb; --", // the injection
      "x' OR '1'='1",
      "a b", // space
      "UPPER", // uppercase not allowed
      "name\nwith-newline",
      "", // empty
      "'",
      "a".repeat(215), // too long
    ]) {
      expect(isValidNpmPackageName(name)).toBe(false);
    }
  });

  it("rejects non-string input", () => {
    for (const v of [null, undefined, 42, {}, ["x"]]) {
      expect(isValidNpmPackageName(v)).toBe(false);
    }
  });
});

describe("escapeSqlLiteral", () => {
  it("doubles single quotes so a literal cannot be broken out of", () => {
    expect(escapeSqlLiteral("x'; DROP TABLE sites; --")).toBe("x''; DROP TABLE sites; --");
    expect(escapeSqlLiteral("o'brien")).toBe("o''brien");
  });

  it("leaves quote-free values unchanged", () => {
    expect(escapeSqlLiteral("my-site")).toBe("my-site");
  });

  it("neutralizes a breakout when embedded in a single-quoted literal", () => {
    const evil = "x'; UPDATE public.sites SET metadata='{}'::jsonb WHERE name='victim'; --";
    const sql = `WHERE name = '${escapeSqlLiteral(evil)}'`;
    // The escaped payload contains no lone `'` that could terminate the literal:
    // every original quote is now doubled, so the whole thing stays one string.
    expect(sql).toBe(
      "WHERE name = 'x''; UPDATE public.sites SET metadata=''{}''::jsonb WHERE name=''victim''; --'",
    );
  });
});
