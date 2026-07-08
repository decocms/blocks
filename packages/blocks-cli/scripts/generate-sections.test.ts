/**
 * Integration test for `generate-sections.ts`.
 *
 * Drives the script as a child process against a tmp sections-dir fixture,
 * mirroring the pattern used by migrate-to-cf-observability.test.ts. The
 * script has no `isMainModule()` guard (unlike generate-schema.ts) — it runs
 * its filesystem walk and write on import — so it's exercised as a subprocess
 * rather than imported directly.
 *
 * Verifies the operationally important behavior: a co-located test/spec/
 * stories/gen file sitting next to a real section must never be walked into
 * sectionMeta (the fila incident this generator's `walkDir` reproduced:
 * `sections.test.ts` became a bogus section in a site's generated output).
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "generate-sections.ts");

function runGenerator(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = cp.spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8" });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? 0 };
}

describe("generate-sections walkDir exclusions", () => {
  let tmpDir: string;
  let sectionsDir: string;
  let outFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-sections-"));
    sectionsDir = path.join(tmpDir, "sections");
    outFile = path.join(tmpDir, "out", "sections.gen.ts");
    fs.mkdirSync(sectionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes co-located test/spec/stories/gen files from the generated sectionMeta", () => {
    fs.writeFileSync(
      path.join(sectionsDir, "Hero.tsx"),
      `export const eager = true;\nexport default function Hero() { return null; }\n`,
    );
    fs.writeFileSync(
      path.join(sectionsDir, "Hero.test.tsx"),
      `export const eager = true;\nexport default function HeroTest() { return null; }\n`,
    );
    fs.writeFileSync(
      path.join(sectionsDir, "Hero.stories.tsx"),
      `export const eager = true;\nexport default function HeroStories() { return null; }\n`,
    );
    fs.writeFileSync(
      path.join(sectionsDir, "sections.gen.ts"),
      `export const eager = true;\n`,
    );

    const { code } = runGenerator(["--sections-dir", sectionsDir, "--out-file", outFile]);
    expect(code).toBe(0);

    const generated = fs.readFileSync(outFile, "utf-8");
    expect(generated).toContain("site/sections/Hero.tsx");
    expect(generated).not.toContain("Hero.test.tsx");
    expect(generated).not.toContain("Hero.stories.tsx");
    expect(generated).not.toContain("sections.gen.ts");
  });
});
