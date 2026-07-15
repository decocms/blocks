import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eitriGenerateArgs } from "./index";
import { runEitriInit } from "./init";

describe("eitriGenerateArgs", () => {
  it("always applies --platform eitri", () => {
    expect(eitriGenerateArgs()).toEqual(["--platform", "eitri"]);
  });

  it("maps options onto orchestrator flags", () => {
    expect(
      eitriGenerateArgs({ root: "apps/foo", site: "monte", namespace: "site", force: true }),
    ).toEqual([
      "--platform",
      "eitri",
      "--root",
      "apps/foo",
      "--site",
      "monte",
      "--namespace",
      "site",
      "--force",
    ]);
  });

  it("appends extra raw flags verbatim", () => {
    expect(eitriGenerateArgs({ extraArgs: ["--dry-run"] })).toEqual([
      "--platform",
      "eitri",
      "--dry-run",
    ]);
  });
});

describe("runEitriInit", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eitri-init-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("scaffolds tsconfig.json + src/eitri-env.d.ts on a fresh app", () => {
    const res = runEitriInit({ root: dir });
    expect(res.created).toEqual(["tsconfig.json", path.join("src", "eitri-env.d.ts")]);
    expect(res.skipped).toEqual([]);

    const tsconfig = JSON.parse(fs.readFileSync(path.join(dir, "tsconfig.json"), "utf-8"));
    expect(tsconfig.extends).toBe("@decocms/eitri/tsconfig");
    expect(tsconfig.include).toEqual(["src"]);

    const shim = fs.readFileSync(path.join(dir, "src", "eitri-env.d.ts"), "utf-8");
    expect(shim).toContain('declare module "eitri-luminus"');
    expect(shim).toContain('declare module "eitri-bifrost"');
  });

  it("is idempotent — never overwrites existing files", () => {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), '{"custom":true}\n');
    const res = runEitriInit({ root: dir });
    expect(res.skipped).toContain("tsconfig.json");
    expect(res.created).toEqual([path.join("src", "eitri-env.d.ts")]);
    // The pre-existing tsconfig is left untouched.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "tsconfig.json"), "utf-8"))).toEqual({
      custom: true,
    });
  });
});
