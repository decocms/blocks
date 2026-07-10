/**
 * Integration tests for scripts/generate.ts — the unified incremental
 * orchestrator. Fixture-driven like the sibling generate-*.test.ts suites:
 * a minimal site tree is built in a tmp dir and the orchestrator is spawned
 * as a subprocess (`npx tsx generate.ts`), exactly how sites invoke it.
 *
 * "The generator was NOT invoked" is asserted two ways:
 *   - the `(cached)` marker in the orchestrator's own log, and
 *   - output-file mtimes that do not move across a cached run
 *     (generate-blocks rewrites blocks.gen.json unconditionally whenever it
 *     runs, so a stable mtime proves the child never spawned).
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCliOptions } from "./generate";

const SCRIPT = path.resolve(__dirname, "generate.ts");

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; code: number } {
  const r = cp.spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8", cwd });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? -1 };
}

const VALID_INVOKE_TS = `\
import { createInvokeFn } from "@decocms/start/sdk/createInvoke";
import { getOrCreateCart } from "./actions/checkout";
import type { OrderForm } from "./types";

export const invoke = {
	vtex: {
		actions: {
			getOrCreateCart: createInvokeFn(
				(data: { orderFormId?: string }) => getOrCreateCart(data),
			) as unknown as (ctx: { data: { orderFormId?: string } }) => Promise<OrderForm>,
		},
	},
} as const;
`;

interface FixtureOptions {
  framework?: "tanstack" | "nextjs";
  /** Also scaffold a fake apps package with a parseable invoke.ts. */
  withInvoke?: boolean;
  /** Pre-create .deco/blocksManifest.gen.ts so manifest is adopt-enabled. */
  withManifestArtifact?: boolean;
}

function makeFixture(opts: FixtureOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-orchestrator-"));
  const write = (rel: string, content: string) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  write("package.json", JSON.stringify({ name: "orchestrator-fixture", type: "module" }));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        skipLibCheck: true,
        strict: true,
      },
    }),
  );
  write(".deco/blocks/Site.json", JSON.stringify({ __resolveType: "site" }));
  write(
    ".deco/blocks/pages-Home.json",
    JSON.stringify({
      path: "/",
      sections: [{ __resolveType: "site/sections/Hero.tsx", title: "hi" }],
    }),
  );
  write(
    "src/sections/Hero.tsx",
    [
      "export interface Props { title: string; }",
      "export const sync = true;",
      "export default function Hero({ title }: Props) { return <h1>{title}</h1>; }",
      "",
    ].join("\n"),
  );
  write(
    "src/loaders/foo.ts",
    [
      "export interface Props { q?: string; }",
      "export default async function foo(props: Props): Promise<string[]> {",
      '  return [props.q ?? ""];',
      "}",
      "",
    ].join("\n"),
  );

  // Fake installed @decocms/* packages — enough for framework detection and
  // for the version fingerprint that a lockstep bump must invalidate.
  write(
    "node_modules/@decocms/blocks/package.json",
    JSON.stringify({ name: "@decocms/blocks", version: "7.11.0" }),
  );
  const framework = opts.framework ?? "tanstack";
  write(
    `node_modules/@decocms/${framework}/package.json`,
    JSON.stringify({ name: `@decocms/${framework}`, version: "7.11.0" }),
  );

  if (opts.withInvoke) {
    write("fake-apps/invoke.ts", VALID_INVOKE_TS);
    write(
      "fake-apps/actions/checkout.ts",
      "export async function getOrCreateCart(_d: any): Promise<any> { return null; }\n",
    );
    write("fake-apps/types.ts", "export type OrderForm = unknown;\n");
    write(
      "node_modules/@tanstack/react-start/package.json",
      JSON.stringify({ name: "@tanstack/react-start", version: "1.166.8" }),
    );
  }

  if (opts.withManifestArtifact) {
    // Adopt-existing rule: a committed manifest artifact keeps the manifest
    // generator enabled even off-Next.js.
    write(".deco/blocksManifest.gen.ts", "export default {};\n");
  }

  return dir;
}

function mtime(dir: string, rel: string): number {
  return fs.statSync(path.join(dir, rel)).mtimeMs;
}

const DIGESTS = ".deco/generate.digests.json";
const STAT_MEMO = ".deco/.cache/stat-memo.json";

function readDigests(dir: string): { version: number; generators: Record<string, any> } {
  return JSON.parse(fs.readFileSync(path.join(dir, DIGESTS), "utf8"));
}

/** Bump mtime (fresh-clone checkouts have arbitrary mtimes) without touching
 * content. */
function touch(abs: string): void {
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(abs, later, later);
}

/** Every fixture input file, recursively (skipping node_modules/.deco — the
 * @decocms package.jsons are fingerprinted by version, not by stat). */
function touchAllInputs(dir: string): number {
  let touched = 0;
  const visit = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".cache") continue;
        visit(full);
      } else if (e.isFile() && !e.name.includes(".gen.")) {
        touch(full);
        touched++;
      }
    }
  };
  visit(dir);
  return touched;
}

// ---------------------------------------------------------------------------
// parseCliOptions — pure unit coverage
// ---------------------------------------------------------------------------

describe("parseCliOptions", () => {
  it("parses selection, forwarding, and toggles", () => {
    const o = parseCliOptions([
      "--only",
      "blocks,blocks-manifest",
      "--skip",
      "invoke",
      "--force",
      "--site",
      "mysite",
      "--namespace",
      "site",
      "--skip-apps",
      "--registry",
      "--exclude",
      "site/loaders/a,site/loaders/b",
    ]);
    expect(o.only).toEqual(["blocks", "manifest"]); // alias normalized
    expect(o.skip).toEqual(["invoke"]);
    expect(o.force).toBe(true);
    expect(o.site).toBe("mysite");
    expect(o.namespace).toBe("site");
    expect(o.skipApps).toBe(true);
    expect(o.registry).toBe(true);
    expect(o.exclude).toBe("site/loaders/a,site/loaders/b");
  });

  it("rejects unknown generators and unknown flags", () => {
    expect(() => parseCliOptions(["--only", "nope"])).toThrow(/Unknown generator/);
    expect(() => parseCliOptions(["--wat"])).toThrow(/Unknown option/);
  });

  it("--no-registry forces the registry off; default is auto (null)", () => {
    expect(parseCliOptions(["--no-registry"]).registry).toBe(false);
    expect(parseCliOptions([]).registry).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: fresh → cached → selective invalidation → force
// ---------------------------------------------------------------------------

describe("orchestrator lifecycle (tanstack-shaped fixture)", () => {
  let dir: string;

  beforeAll(() => {
    dir = makeFixture({ withInvoke: true, withManifestArtifact: true });
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fresh run generates every artifact and writes the cache scaffold", () => {
    const r = run(["--apps-dir", "fake-apps"], dir);
    expect(r.code).toBe(0);
    for (const out of [
      ".deco/blocks.gen.json",
      ".deco/blocks.gen.ts",
      ".deco/blocksManifest.gen.ts",
      ".deco/sections.gen.ts",
      ".deco/loaders.gen.ts",
      "src/server/invoke.gen.ts",
      ".deco/meta.gen.json",
    ]) {
      expect(fs.existsSync(path.join(dir, out)), `${out} should exist`).toBe(true);
    }
    // All six ran fresh.
    for (const name of ["blocks", "manifest", "sections", "loaders", "invoke", "schema"]) {
      expect(r.stdout).toMatch(new RegExp(`\\[generate\\] ${name} \\d+ms \\(fresh\\)`));
    }
    // Committed tier: one record per generator in .deco/generate.digests.json
    // (meant to be committed). Local tier: the stat memo under .deco/.cache/,
    // with the .gitignore that keeps IT out of git (sites commit .deco/).
    const cache = readDigests(dir);
    expect(Object.keys(cache.generators).sort()).toEqual([
      "blocks",
      "invoke",
      "loaders",
      "manifest",
      "schema",
      "sections",
    ]);
    expect(fs.existsSync(path.join(dir, STAT_MEMO))).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".deco/.cache/.gitignore"), "utf8").trim()).toBe("*");
    // Records are machine-independent: content hashes + versions + argv,
    // never size/mtime.
    const record = cache.generators.blocks;
    expect(record.inputs).toMatch(/^[0-9a-f]{64}$/);
    expect(record.deco).toContain("@decocms/blocks@7.11.0");
    expect(JSON.stringify(record)).not.toMatch(/mtime/i);
  }, 90_000);

  it("second run is fully cached and never invokes the generators", () => {
    const before = mtime(dir, ".deco/blocks.gen.json"); // rewritten on EVERY blocks run
    const beforeMeta = mtime(dir, ".deco/meta.gen.json");
    const r = run(["--apps-dir", "fake-apps"], dir);
    expect(r.code).toBe(0);
    for (const name of ["blocks", "manifest", "sections", "loaders", "invoke", "schema"]) {
      expect(r.stdout).toMatch(new RegExp(`\\[generate\\] ${name} \\d+ms \\(cached\\)`));
    }
    expect(r.stdout).not.toContain("(fresh)");
    expect(mtime(dir, ".deco/blocks.gen.json")).toBe(before);
    expect(mtime(dir, ".deco/meta.gen.json")).toBe(beforeMeta);
  }, 30_000);

  it("touching one .deco/blocks file re-runs only blocks + manifest", () => {
    fs.writeFileSync(
      path.join(dir, ".deco/blocks/pages-Home.json"),
      JSON.stringify({
        path: "/",
        sections: [{ __resolveType: "site/sections/Hero.tsx", title: "edited" }],
      }),
    );
    const sectionsBefore = mtime(dir, ".deco/sections.gen.ts");
    const r = run(["--apps-dir", "fake-apps"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[generate\] blocks \d+ms \(fresh\)/);
    expect(r.stdout).toMatch(/\[generate\] manifest \d+ms \(fresh\)/);
    for (const name of ["sections", "loaders", "invoke", "schema"]) {
      expect(r.stdout).toMatch(new RegExp(`\\[generate\\] ${name} \\d+ms \\(cached\\)`));
    }
    expect(mtime(dir, ".deco/sections.gen.ts")).toBe(sectionsBefore);
  }, 30_000);

  it("changing a forwarded flag re-runs only the generator it maps to", () => {
    const r = run(["--apps-dir", "fake-apps", "--exclude", "site/loaders/foo"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[generate\] loaders \d+ms \(fresh\)/);
    for (const name of ["blocks", "manifest", "sections", "invoke", "schema"]) {
      expect(r.stdout).toMatch(new RegExp(`\\[generate\\] ${name} \\d+ms \\(cached\\)`));
    }
    // The excluded loader is gone from the emitted registry.
    expect(fs.readFileSync(path.join(dir, ".deco/loaders.gen.ts"), "utf8")).not.toContain(
      '"site/loaders/foo"',
    );
  }, 30_000);

  it("a @decocms/* version change busts every generator", () => {
    fs.writeFileSync(
      path.join(dir, "node_modules/@decocms/blocks/package.json"),
      JSON.stringify({ name: "@decocms/blocks", version: "7.12.0" }),
    );
    const r = run(["--apps-dir", "fake-apps", "--exclude", "site/loaders/foo"], dir);
    expect(r.code).toBe(0);
    for (const name of ["blocks", "manifest", "sections", "loaders", "invoke", "schema"]) {
      expect(r.stdout).toMatch(new RegExp(`\\[generate\\] ${name} \\d+ms \\(fresh\\)`));
    }
  }, 90_000);

  it("a deleted output is a cache miss even with a matching digest", () => {
    fs.rmSync(path.join(dir, ".deco/sections.gen.ts"));
    const r = run(["--apps-dir", "fake-apps", "--exclude", "site/loaders/foo"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[generate\] sections \d+ms \(fresh\)/);
    expect(r.stdout).toMatch(/\[generate\] blocks \d+ms \(cached\)/);
    expect(fs.existsSync(path.join(dir, ".deco/sections.gen.ts"))).toBe(true);
  }, 30_000);

  it("--force re-runs everything despite a warm cache", () => {
    const r = run(["--apps-dir", "fake-apps", "--exclude", "site/loaders/foo", "--force"], dir);
    expect(r.code).toBe(0);
    for (const name of ["blocks", "manifest", "sections", "loaders", "invoke", "schema"]) {
      expect(r.stdout).toMatch(new RegExp(`\\[generate\\] ${name} \\d+ms \\(fresh\\)`));
    }
    expect(r.stdout).not.toContain("(cached)");
  }, 90_000);

  it("--dry-run reports the plan without touching anything", () => {
    const digestsBefore = fs.readFileSync(path.join(dir, DIGESTS), "utf8");
    const memoBefore = fs.readFileSync(path.join(dir, STAT_MEMO), "utf8");
    const blocksBefore = mtime(dir, ".deco/blocks.gen.json");
    const r = run(["--apps-dir", "fake-apps", "--dry-run"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dry run");
    // --exclude was dropped again, so loaders would re-run; the rest is cached.
    expect(r.stdout).toMatch(/\[generate\] loaders: would run \(flags changed\)/);
    expect(r.stdout).toMatch(/\[generate\] blocks: skip — cached/);
    expect(fs.readFileSync(path.join(dir, DIGESTS), "utf8")).toBe(digestsBefore);
    // Not even the stat memo — dry run is strictly read-only.
    expect(fs.readFileSync(path.join(dir, STAT_MEMO), "utf8")).toBe(memoBefore);
    expect(mtime(dir, ".deco/blocks.gen.json")).toBe(blocksBefore);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Two-tier cache: committed content-hash digests + local stat memo
// ---------------------------------------------------------------------------

describe("committed digests + stat memo (fresh-clone semantics)", () => {
  let dir: string;
  /** Digest-file bytes after the first successful full run — the baseline
   * every later assertion of determinism/reconciliation compares against. */
  let baseline: string;

  beforeAll(() => {
    dir = makeFixture({ withInvoke: true, withManifestArtifact: true });
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serialization is deterministic: two runs produce byte-identical digests", () => {
    expect(run(["--apps-dir", "fake-apps"], dir).code).toBe(0);
    baseline = fs.readFileSync(path.join(dir, DIGESTS), "utf8");
    // Sanity: committed tier lives OUTSIDE the gitignored .deco/.cache/.
    expect(baseline).toContain('"generators"');
    const r = run(["--apps-dir", "fake-apps", "--force"], dir);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, DIGESTS), "utf8")).toBe(baseline);
  }, 180_000);

  it("fresh clone: no local cache + churned mtimes still cache-hits everything", () => {
    // Simulate `git clone`: the committed digests + artifacts exist, but the
    // machine-local memo does not, and every checkout mtime is arbitrary.
    fs.rmSync(path.join(dir, ".deco", ".cache"), { recursive: true, force: true });
    expect(touchAllInputs(dir)).toBeGreaterThan(5);
    const blocksBefore = mtime(dir, ".deco/blocks.gen.json");
    const metaBefore = mtime(dir, ".deco/meta.gen.json");
    const r = run(["--apps-dir", "fake-apps"], dir);
    expect(r.code).toBe(0);
    // Every generator validated by hashing CONTENT (memo was gone), not stats.
    for (const name of ["blocks", "manifest", "sections", "loaders", "invoke", "schema"]) {
      expect(r.stdout).toMatch(
        new RegExp(`\\[generate\\] ${name} \\d+ms \\(cached, content-verified\\)`),
      );
    }
    expect(r.stdout).not.toContain("(fresh)");
    expect(mtime(dir, ".deco/blocks.gen.json")).toBe(blocksBefore);
    expect(mtime(dir, ".deco/meta.gen.json")).toBe(metaBefore);
    // The local tier was rebuilt (with its .gitignore) for the next run.
    expect(fs.existsSync(path.join(dir, STAT_MEMO))).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".deco/.cache/.gitignore"), "utf8").trim()).toBe("*");
  }, 30_000);

  it("warm run validates via the stat memo alone (no content-verified marker)", () => {
    const r = run(["--apps-dir", "fake-apps"], dir);
    expect(r.code).toBe(0);
    for (const name of ["blocks", "manifest", "sections", "loaders", "invoke", "schema"]) {
      expect(r.stdout).toMatch(new RegExp(`\\[generate\\] ${name} \\d+ms \\(cached\\)`));
    }
    expect(r.stdout).not.toContain("content-verified");
    // Documented limitation (same trade as git's index): a content edit that
    // preserves BOTH size and mtimeMs would be trusted by the stat memo and
    // not detected. Not exercised here — engineering it cross-platform is
    // exactly the pathological case git also accepts.
  }, 30_000);

  it("content-verified marks only the generators whose inputs were rehashed", () => {
    touch(path.join(dir, ".deco/blocks/Site.json"));
    const r = run(["--apps-dir", "fake-apps"], dir);
    expect(r.code).toBe(0);
    // blocks + manifest fingerprint .deco/blocks/*.json → they rehashed it.
    expect(r.stdout).toMatch(/\[generate\] blocks \d+ms \(cached, content-verified\)/);
    expect(r.stdout).toMatch(/\[generate\] manifest \d+ms \(cached, content-verified\)/);
    // Everything else came straight from the memo.
    for (const name of ["sections", "loaders", "invoke", "schema"]) {
      expect(r.stdout).toMatch(new RegExp(`\\[generate\\] ${name} \\d+ms \\(cached\\)`));
    }
  }, 30_000);

  it("a merge-conflicted digests file reconciles by regeneration", () => {
    // Two branches both regenerated → git leaves conflict markers → the file
    // no longer parses. The orchestrator must treat that as "no records",
    // regenerate, and rewrite a valid file — which, with unchanged inputs,
    // is byte-identical to the pre-conflict baseline.
    const conflicted = `<<<<<<< ours\n${baseline}=======\n${baseline.replace(/./, "!")}\n>>>>>>> theirs\n`;
    fs.writeFileSync(path.join(dir, DIGESTS), conflicted);
    const r = run(["--apps-dir", "fake-apps"], dir);
    expect(r.code).toBe(0);
    for (const name of ["blocks", "manifest", "sections", "loaders", "invoke", "schema"]) {
      expect(r.stdout).toMatch(new RegExp(`\\[generate\\] ${name} \\d+ms \\(fresh\\)`));
    }
    expect(fs.readFileSync(path.join(dir, DIGESTS), "utf8")).toBe(baseline);
    expect(readDigests(dir).version).toBe(2);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Crash handling — a failed generator must leave NO digest behind
// ---------------------------------------------------------------------------

describe("crashed generator leaves its digest absent so the next run retries", () => {
  // Note: the prompt-obvious injection (malformed JSON in .deco/blocks) does
  // NOT crash generate-blocks — it warns and skips bad files by design. A
  // deterministic crash is generate-invoke against an invoke.ts with no
  // `export const invoke` (console.error + exit 1).
  let dir: string;

  beforeAll(() => {
    dir = makeFixture({ withInvoke: true });
    fs.writeFileSync(path.join(dir, "fake-apps/invoke.ts"), "export const nothing = 1;\n");
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails the run, caches the successes, and omits the crashed generator", () => {
    const r = run(["--apps-dir", "fake-apps", "--skip", "schema"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/\[generate\] invoke \d+ms FAILED/);
    const cache = readDigests(dir);
    expect(cache.generators.invoke).toBeUndefined();
    // Concurrent stage-1 successes still landed and got cached.
    expect(cache.generators.blocks).toBeDefined();
    expect(cache.generators.sections).toBeDefined();
    expect(cache.generators.loaders).toBeDefined();
  }, 90_000);

  it("retries the crashed generator on the next run (identical inputs)", () => {
    const r = run(["--apps-dir", "fake-apps", "--skip", "schema"], dir);
    expect(r.code).toBe(1);
    // Not `(cached)` — the digest was never written, so it runs (and fails) again.
    expect(r.stderr).toMatch(/\[generate\] invoke \d+ms FAILED/);
    expect(r.stdout).toMatch(/\[generate\] blocks \d+ms \(cached\)/);
  }, 30_000);

  it("succeeds once the input is fixed", () => {
    fs.writeFileSync(path.join(dir, "fake-apps/invoke.ts"), VALID_INVOKE_TS);
    const r = run(["--apps-dir", "fake-apps", "--skip", "schema"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[generate\] invoke \d+ms \(fresh\)/);
    expect(readDigests(dir).generators.invoke).toBeDefined();
    expect(fs.existsSync(path.join(dir, "src/server/invoke.gen.ts"))).toBe(true);
  }, 30_000);

  it("a stage-1 failure skips stage 2 (schema never builds on a broken pass)", () => {
    fs.writeFileSync(path.join(dir, "fake-apps/invoke.ts"), "export const nothing = 1;\n");
    const r = run(["--apps-dir", "fake-apps", "--force"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/\[generate\] schema skipped \(stage 1 failed\)/);
    expect(readDigests(dir).generators.schema).toBeUndefined();
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Framework-shaped defaults
// ---------------------------------------------------------------------------

describe("per-framework defaults", () => {
  it("tanstack: blocks+invoke in, manifest out; sections has no registry", () => {
    const dir = makeFixture({ withInvoke: true });
    try {
      const r = run(["--apps-dir", "fake-apps", "--dry-run"], dir);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/blocks: would run/);
      expect(r.stdout).toMatch(/manifest: skip — not a @decocms\/nextjs site/);
      expect(r.stdout).toMatch(/invoke: would run/);
      expect(r.stdout).toMatch(/sections: would run .*--sections-dir src\/sections\n/);
      expect(r.stdout).not.toContain("--registry");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("nextjs: manifest+registry in, blocks+invoke out", () => {
    const dir = makeFixture({ framework: "nextjs" });
    try {
      const dry = run(["--dry-run"], dir);
      expect(dry.code).toBe(0);
      expect(dry.stdout).toMatch(/manifest: would run/);
      expect(dry.stdout).toMatch(/blocks: skip — @decocms\/nextjs site/);
      expect(dry.stdout).toMatch(/invoke: skip — no apps invoke\.ts/);
      expect(dry.stdout).toMatch(/sections: would run .*--registry/);

      const r = run(["--only", "sections,manifest"], dir);
      expect(r.code).toBe(0);
      expect(fs.readFileSync(path.join(dir, ".deco/sections.gen.ts"), "utf8")).toContain(
        "export const sectionImports",
      );
      expect(fs.readFileSync(path.join(dir, ".deco/blocksManifest.gen.ts"), "utf8")).toContain(
        "pages-Home",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("--only forces a detection-disabled generator on", () => {
    const dir = makeFixture(); // tanstack, no manifest artifact → manifest disabled
    try {
      const r = run(["--only", "manifest"], dir);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/\[generate\] manifest \d+ms \(fresh\)/);
      expect(fs.existsSync(path.join(dir, ".deco/blocksManifest.gen.ts"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
