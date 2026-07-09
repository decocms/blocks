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
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "generate-sections.ts");

function runGenerator(
  args: string[],
  opts: { cwd?: string } = {},
): { stdout: string; stderr: string; code: number } {
  const r = cp.spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8", cwd: opts.cwd });
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

describe("generate-sections default output path (.deco/)", () => {
  let tmpDir: string;
  let sectionsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-sections-defaults-"));
    sectionsDir = path.join(tmpDir, "src", "sections");
    fs.mkdirSync(sectionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sectionsDir, "Hero.tsx"),
      "export const eager = true;\nexport default function Hero() { return null; }\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes to .deco/sections.gen.ts when no --out-file flag is passed", () => {
    const { code, stderr } = runGenerator([], { cwd: tmpDir });
    expect(code).toBe(0);

    const newDefault = path.join(tmpDir, ".deco", "sections.gen.ts");
    expect(fs.existsSync(newDefault)).toBe(true);
    expect(fs.readFileSync(newDefault, "utf-8")).toContain("site/sections/Hero.tsx");
    // No legacy file present, so no warning is expected.
    expect(stderr).not.toContain("Generator default output moved");
  });

  it("warns once to stderr naming both paths when the OLD default file exists and no --out-file is passed, but still writes the NEW default", () => {
    const oldDefaultDir = path.join(tmpDir, "src", "server", "cms");
    fs.mkdirSync(oldDefaultDir, { recursive: true });
    fs.writeFileSync(path.join(oldDefaultDir, "sections.gen.ts"), "// stale\n");

    const { code, stderr } = runGenerator([], { cwd: tmpDir });
    expect(code).toBe(0);

    expect(stderr).toContain("src/server/cms/sections.gen.ts");
    expect(stderr).toContain(".deco/sections.gen.ts");
    expect(stderr).toContain("Move the file and update its importers");

    const newDefault = path.join(tmpDir, ".deco", "sections.gen.ts");
    expect(fs.existsSync(newDefault)).toBe(true);
    expect(fs.readFileSync(newDefault, "utf-8")).toContain("site/sections/Hero.tsx");
  });

  it("does not warn when an explicit --out-file is passed, even if the OLD default file exists", () => {
    const oldDefaultDir = path.join(tmpDir, "src", "server", "cms");
    fs.mkdirSync(oldDefaultDir, { recursive: true });
    fs.writeFileSync(path.join(oldDefaultDir, "sections.gen.ts"), "// stale\n");

    const explicitOut = path.join(tmpDir, "custom", "sections.gen.ts");
    const { code, stderr } = runGenerator(["--out-file", explicitOut], { cwd: tmpDir });
    expect(code).toBe(0);

    expect(stderr).not.toContain("Generator default output moved");
    expect(fs.existsSync(explicitOut)).toBe(true);
  });
});

describe("generate-sections --registry", () => {
  let tmpDir: string;
  let sectionsDir: string;
  let outFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-sections-registry-"));
    sectionsDir = path.join(tmpDir, "sections");
    outFile = path.join(tmpDir, "out", "sections.gen.ts");
    fs.mkdirSync(path.join(sectionsDir, "Nested"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function expectedImportPath(filePath: string): string {
    let rel = path.relative(path.dirname(outFile), filePath).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return rel.replace(/\.tsx?$/, "");
  }

  it("emits sectionImports keyed glob-style with relative dynamic imports, built from all scanned section files (not just convention-carrying ones)", () => {
    const heroPath = path.join(sectionsDir, "Hero.tsx");
    const promoPath = path.join(sectionsDir, "Nested", "Promo.tsx");
    fs.writeFileSync(
      heroPath,
      "export const sync = true\nexport default function Hero() { return null }\n",
    );
    // No convention exports — regression guard: without --registry this file
    // never makes it into `entries`, so the registry must be built from the
    // raw `sectionFiles` walk, not from `entries`.
    fs.writeFileSync(
      promoPath,
      "export default function Promo() { return null }\n",
    );

    const { code } = runGenerator([
      "--sections-dir", sectionsDir,
      "--out-file", outFile,
      "--registry",
    ]);
    expect(code).toBe(0);

    const generated = fs.readFileSync(outFile, "utf-8");
    expect(generated).toContain("export const sectionImports");
    expect(generated).toContain(
      `"./sections/Hero.tsx": () => import("${expectedImportPath(heroPath)}")`,
    );
    expect(generated).toContain(
      `"./sections/Nested/Promo.tsx": () => import("${expectedImportPath(promoPath)}")`,
    );
  });

  it("does not emit sectionImports without the --registry flag", () => {
    fs.writeFileSync(
      path.join(sectionsDir, "Hero.tsx"),
      "export const sync = true\nexport default function Hero() { return null }\n",
    );
    fs.writeFileSync(
      path.join(sectionsDir, "Nested", "Promo.tsx"),
      "export default function Promo() { return null }\n",
    );

    const { code } = runGenerator(["--sections-dir", sectionsDir, "--out-file", outFile]);
    expect(code).toBe(0);

    const generated = fs.readFileSync(outFile, "utf-8");
    expect(generated).not.toContain("sectionImports");
  });

  it("emits a doc comment that does not self-terminate early, and the resulting file is importable (regression: a literal `**/` inside the emitted /** */ comment used to close it prematurely, leaving prose as bare statements and making every --registry output invalid TypeScript)", () => {
    const heroPath = path.join(sectionsDir, "Hero.tsx");
    fs.writeFileSync(
      heroPath,
      "export const sync = true\nexport default function Hero() { return null }\n",
    );

    const { code } = runGenerator([
      "--sections-dir", sectionsDir,
      "--out-file", outFile,
      "--registry",
    ]);
    expect(code).toBe(0);

    const generated = fs.readFileSync(outFile, "utf-8");

    // Pin the regression directly: the doc comment's body (everything
    // between the opening `/**` and its own closing `*/`) must contain
    // exactly one `*/` — the intended closing marker itself, at the very
    // end. A premature `*/` embedded in the prose (e.g. from a literal
    // `**/*.tsx` glob pattern) would close the block comment early and
    // leave the rest of the doc text as bare top-level statements.
    const docCommentStart = generated.indexOf("/**\n * Lazy section registry");
    const exportStart = generated.indexOf("export const sectionImports");
    expect(docCommentStart).toBeGreaterThan(-1);
    expect(exportStart).toBeGreaterThan(docCommentStart);
    const docComment = generated.slice(docCommentStart + "/**".length, exportStart);
    const closeMarkerCount = (docComment.match(/\*\//g) ?? []).length;
    expect(closeMarkerCount).toBe(1);
    expect(docComment.trimEnd().endsWith("*/")).toBe(true);

    // Strongest available check: actually import the generated file through
    // tsx (esbuild) and confirm it parses/executes as valid TS/ESM and
    // exports `sectionImports`. A premature `*/` would leave trailing prose
    // as bare top-level statements, which fails to parse. `tsx -e` evaluates
    // its argument as CommonJS (named exports of a dynamic `import()` come
    // back CJS-interop-wrapped), so write a real `.mjs` file instead and run
    // that — mirrors the check used to hand-verify this fix.
    const checkerFile = path.join(tmpDir, "check-import.mjs");
    fs.writeFileSync(
      checkerFile,
      [
        `import { pathToFileURL } from "node:url";`,
        `const m = await import(${JSON.stringify(pathToFileURL(outFile).href)});`,
        `if (typeof m.sectionImports !== "object" || m.sectionImports === null) {`,
        `  throw new Error("sectionImports missing or not an object");`,
        `}`,
      ].join("\n"),
    );

    const importResult = cp.spawnSync("npx", ["tsx", checkerFile], { encoding: "utf8" });
    expect(importResult.status, importResult.stderr).toBe(0);
  }, 30_000);
});
