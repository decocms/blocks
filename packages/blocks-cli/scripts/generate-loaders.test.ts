/**
 * Verifies the generated `.deco/loaders.gen.ts` shape: loaders route through
 * `createLoaderEntry` (so their cache/cacheKey exports drive dedup) while
 * actions stay plain pass-throughs (never cached/deduped).
 *
 * The script is spawned as a subprocess (`npx tsx generate-loaders.ts`) exactly
 * how sites invoke it.
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "generate-loaders.ts");

function run(cwd: string, args: string[] = []): { stdout: string; stderr: string; code: number } {
  const r = cp.spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8", cwd });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? -1 };
}

describe("generate-loaders — loader vs action emit", () => {
  let dir: string;
  let out: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-loaders-"));
    const write = (rel: string, content: string) => {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    };
    write("src/loaders/related.ts", "export default async () => [];\n");
    write("src/actions/addToCart.ts", "export default async () => ({});\n");

    const r = run(dir);
    expect(r.code).toBe(0);
    out = fs.readFileSync(path.join(dir, ".deco/loaders.gen.ts"), "utf8");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("imports createLoaderEntry when any loader is present", () => {
    expect(out).toContain(
      'import { createLoaderEntry } from "@decocms/blocks/sdk/cachedLoader";',
    );
  });

  it("wraps loaders (both alias keys) with createLoaderEntry under the non-.ts name", () => {
    expect(out).toContain(
      '"site/loaders/related": createLoaderEntry("site/loaders/related", () => import(',
    );
    expect(out).toContain(
      '"site/loaders/related.ts": createLoaderEntry("site/loaders/related", () => import(',
    );
  });

  it("keeps actions as plain pass-throughs — never routed through createLoaderEntry", () => {
    expect(out).toContain('"site/actions/addToCart": async (props: any, request?: Request) => {');
    expect(out).not.toContain('createLoaderEntry("site/actions/addToCart"');
  });
});

describe("generate-loaders legacy artifact sync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-loaders-legacy-"));
    const write = (rel: string, content: string) => {
      const abs = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    };
    write("src/loaders/related.ts", "export default async () => [];\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("syncs to the old path when legacy file is detected", () => {
    const oldDir = path.join(tmpDir, "src", "server", "cms");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "loaders.gen.ts"), "// stale\n");

    const { code, stderr } = run(tmpDir);
    expect(code).toBe(0);

    expect(stderr).toContain("src/server/cms/loaders.gen.ts");
    expect(stderr).toContain(".deco/loaders.gen.ts");
    expect(stderr).toContain("Update importers to use the new path");

    // New path must exist.
    expect(fs.existsSync(path.join(tmpDir, ".deco", "loaders.gen.ts"))).toBe(true);

    // Old file must be synced (not stale placeholder).
    const oldContent = fs.readFileSync(path.join(oldDir, "loaders.gen.ts"), "utf-8");
    expect(oldContent).not.toBe("// stale\n");
    expect(oldContent).toContain("site/loaders/related");
  }, 30_000);

  it("does not warn and does not sync when an explicit --out-file is passed", () => {
    const oldDir = path.join(tmpDir, "src", "server", "cms");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "loaders.gen.ts"), "// stale\n");

    const explicitOut = path.join(tmpDir, "custom", "loaders.gen.ts");
    const { code, stderr } = run(tmpDir, ["--out-file", explicitOut]);
    expect(code).toBe(0);

    expect(stderr).not.toContain("Generator default output moved");
    expect(fs.existsSync(explicitOut)).toBe(true);
    expect(fs.readFileSync(path.join(oldDir, "loaders.gen.ts"), "utf-8")).toBe("// stale\n");
  }, 30_000);
});
