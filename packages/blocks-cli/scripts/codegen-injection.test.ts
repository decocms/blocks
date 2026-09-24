/**
 * Regression guard for the codegen code-injection fix.
 *
 * generate-loaders.ts / generate-sections.ts build TypeScript source by
 * interpolating filename-derived values (`entry.key`, `importPath`, `rel`) into
 * string literals in the emitted `.gen.ts`. Those values were pasted raw, so a
 * file whose NAME contained `"` `)` `;` broke out of the string literal into
 * executable generated code — run on the next `dev`/`build`. The fix emits every
 * such value via JSON.stringify.
 *
 * A POSIX filename cannot contain `/` or NUL, but `"`, `)`, `;`, `(` are all
 * legal — enough for a breakout. The payload base name below closes the string
 * and opens a call; we assert the emitted quote is ESCAPED (safe) and the raw
 * unescaped breakout never appears.
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// `zz` immediately precedes the quote so the escaped form is `zz\")` and the
// unescaped (vulnerable) form is `zz")` — the two are textually distinguishable.
const PAYLOAD = 'zz");PWN;(';
const SAFE = 'zz\\");PWN'; // escaped quote: what JSON.stringify must produce
const RAW = 'zz");PWN'; // unescaped breakout: must NOT appear

describe("generate-loaders — hostile filename cannot inject code", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-inj-loaders-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("JSON-escapes a filename containing quote/paren breakout chars", () => {
    const loadersDir = path.join(dir, "src", "loaders");
    fs.mkdirSync(loadersDir, { recursive: true });
    // Filename itself carries the payload.
    fs.writeFileSync(path.join(loadersDir, `${PAYLOAD}.ts`), "export default async () => [];\n");

    const r = cp.spawnSync("npx", ["tsx", path.resolve(__dirname, "generate-loaders.ts")], {
      encoding: "utf8",
      cwd: dir,
    });
    expect(r.status).toBe(0);
    const out = fs.readFileSync(path.join(dir, ".deco", "loaders.gen.ts"), "utf8");

    expect(out).toContain(SAFE); // payload present, quote escaped
    expect(out).not.toContain(RAW); // no unescaped string breakout
  });
});

describe("generate-sections — hostile filename cannot inject code", () => {
  let tmpDir: string;
  let sectionsDir: string;
  let outFile: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-inj-sections-"));
    sectionsDir = path.join(tmpDir, "sections");
    outFile = path.join(tmpDir, "out", "sections.gen.ts");
    fs.mkdirSync(sectionsDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("JSON-escapes a section filename containing quote/paren breakout chars", () => {
    fs.writeFileSync(
      path.join(sectionsDir, `${PAYLOAD}.tsx`),
      "export default function S() { return null; }\n",
    );

    const r = cp.spawnSync(
      "npx",
      [
        "tsx",
        path.resolve(__dirname, "generate-sections.ts"),
        "--sections-dir",
        sectionsDir,
        "--out-file",
        outFile,
        "--registry", // emit the sectionImports map (the filename-derived sink)
      ],
      { encoding: "utf8", cwd: tmpDir },
    );
    expect(r.status).toBe(0);
    const out = fs.readFileSync(outFile, "utf8");

    expect(out).toContain(SAFE);
    expect(out).not.toContain(RAW);
  });
});
