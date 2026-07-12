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

function run(cwd: string): { stdout: string; stderr: string; code: number } {
  const r = cp.spawnSync("npx", ["tsx", SCRIPT], { encoding: "utf8", cwd });
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
