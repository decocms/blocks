// @vitest-environment node
/**
 * The v8 core must run anywhere: Node, Cloudflare Workers, Deno, Bun and a
 * browser. A real esbuild bundle (not just tsc) is the only reliable way to
 * catch a Node built-in sneaking into the graph, so bundle it for a browser
 * and for a workerd-style target and check the output.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// Shell out to the esbuild binary: its JS API trips over Vitest's realm isolation.
const esbuildBin = join(here, "../../../../node_modules/.bin/esbuild");

/**
 * Bundles `entry`. The `source` condition is always on, so the package's own
 * conditional imports (`#async-store`) resolve to source, as in the tests.
 */
function bundle(args: string[], entry = "index.ts"): string {
  const conditions = args.find((arg) => arg.startsWith("--conditions="));
  const withSource = conditions
    ? args.map((arg) => (arg === conditions ? `--conditions=source,${arg.slice(13)}` : arg))
    : [...args, "--conditions=source"];
  return execFileSync(esbuildBin, [join(here, entry), "--bundle", "--format=esm", ...withSource], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("v8 core bundle", () => {
  it("bundles for a browser target with no Node built-ins", () => {
    const output = bundle(["--platform=browser"]);
    expect(output).not.toMatch(/node:|require\(/);
    expect(output).toContain("createCMS");
  });

  it("bundles for a workerd target (neutral platform, Workers conditions) with no Node built-in but AsyncLocalStorage", () => {
    // currentClient() survives await through `#async-store`, whose workerd
    // condition imports node:async_hooks (Workers with nodejs_compat).
    const output = bundle([
      "--platform=neutral",
      "--conditions=workerd,worker,browser",
      "--external:node:async_hooks",
    ]);
    expect(output.match(/node:[\w/]+/g) ?? []).toEqual(["node:async_hooks"]);
    expect(output).not.toMatch(/require\(/);
  });

  it("@decocms/blocks/fetch bundles for a browser and a workerd target with no Node built-ins", () => {
    expect(bundle(["--platform=browser"], "fetch.ts")).not.toMatch(/node:|require\(/);
    expect(
      bundle(["--platform=neutral", "--conditions=workerd,worker,browser"], "fetch.ts"),
    ).not.toMatch(/node:|require\(/);
  });

  it("@decocms/blocks/metrics bundles for a workerd target with no Node built-ins and no React", () => {
    const output = bundle(
      ["--platform=neutral", "--conditions=workerd,worker,browser"],
      "metrics.ts",
    );
    expect(output).not.toMatch(/node:|require\(|react/);
    expect(output).toContain("http.server.request.duration");
  });

  it("@decocms/blocks/image bundles for a browser and a workerd target with no Node built-ins and no React", () => {
    for (const args of [
      ["--platform=browser"],
      ["--platform=neutral", "--conditions=workerd,worker,browser"],
    ]) {
      const output = bundle(args, "image.ts");
      expect(output).not.toMatch(/node:|require\(|react/);
      expect(output).toContain("createImageUrl");
    }
  });

  it("@decocms/blocks/experiments bundles for a browser and a workerd target with no Node built-ins, no React and no CMS runtime", () => {
    for (const args of [
      ["--platform=browser"],
      ["--platform=neutral", "--conditions=workerd,worker,browser"],
    ]) {
      const output = bundle(args, "experiments.ts");
      expect(output).not.toMatch(/node:|require\(|react/);
      // The decision is the same function on both sides, so it must not drag
      // the CMS in: a browser pays for the bucketing alone.
      expect(output).not.toContain("createCMS");
      expect(output).toContain("assign");
    }
  });

  it("@decocms/blocks/experiments computes the same rolls out of the browser and workerd bundles, with only web globals", () => {
    // The pinned table in `experiments.test.ts` runs under Vitest, which has
    // every Node global in scope. A visitor must get the same arm wherever
    // the decision happens, so run the bundled artifact in a bare context
    // holding only what a browser and workerd both give — no `process`, no
    // `require`, no Node built-in — and compare. (Both runtimes are V8, so
    // what this can catch is the bundle picking up a different
    // implementation, not an engine difference.)
    const vectors: [string, string, number][] = [
      ["pdp-cta", "AAAAAAAAAAAAAAAAAAAAAA", 84.57],
      ["hero-copy", "Zm9vYmFyYmF6cXV4MTIzNA", 0.93],
      ["name@2", "0123456789abcdefghijkl", 12.89],
      ["Test AB 0,5", "__--__--__--__--__--__", 21.67],
    ];

    for (const args of [
      ["--platform=browser"],
      ["--platform=neutral", "--conditions=workerd,worker,browser"],
    ]) {
      const sandbox = () => createContext({ TextEncoder, btoa, atob, crypto, Math, JSON });
      // The roll is internal (not exported by the subpath), so its own module
      // is bundled the same way to run the table.
      const rolls = sandbox();
      runInContext(bundle([...args, "--global-name=B", "--format=iife"], "bucketing.ts"), rolls);
      const bucketing = (rolls as unknown as { B: typeof import("./bucketing.ts") }).B;
      for (const [name, id, expected] of vectors) expect(bucketing.roll(name, id)).toBe(expected);
      // And the whole decision, through the subpath's own bundle.
      const decisions = sandbox();
      runInContext(
        bundle([...args, "--global-name=E", "--format=iife"], "experiments.ts"),
        decisions,
      );
      const mod = (decisions as unknown as { E: typeof import("./experiments.ts") }).E;
      expect(
        mod.assign(
          { "pdp-cta": 50 },
          { active: [], inactiveDrawn: [], pct: {}, id: vectors[0][1] },
        ),
      ).toMatchObject({ "pdp-cta": false }); // roll 84.57, out at 50
    }
  });

  it("@decocms/blocks/preview bundles for a browser with no server code: only its own files, the draft names and React (no Studio origin list)", () => {
    for (const args of [
      ["--platform=browser"],
      ["--platform=neutral", "--conditions=workerd,worker,browser", "--main-fields=module,main"],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), "blocks-preview-bundle-"));
      try {
        const metafile = join(dir, "meta.json");
        const outfile = join(dir, "out.js");
        bundle(
          [
            ...args,
            '--define:process.env.NODE_ENV="production"',
            `--metafile=${metafile}`,
            `--outfile=${outfile}`,
            "--log-level=error",
          ],
          "preview/index.ts",
        );
        const output = readFileSync(outfile, "utf-8");
        expect(output).not.toMatch(/node:|require\("(?!react)/);
        expect(output).toContain("editor::inject");
        expect(output).not.toMatch(/createCMS|AsyncLocalStorage/);
        const inputs = Object.keys(JSON.parse(readFileSync(metafile, "utf-8")).inputs);
        for (const input of inputs) {
          expect(input, input).toMatch(
            /(^|\/)(packages\/blocks\/src\/v8\/(preview\/[^/]+|draft\.ts)|node_modules\/(react|scheduler)\/.*)$/,
          );
        }
        expect(inputs.some((i) => i.endsWith("v8/draft.ts"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("imports nothing at runtime but its own modules, the async store, the ciphertext format and the shared content hash (no React, no v7 code)", () => {
    // A real file, not /dev/stdout: esbuild leaves that empty on Linux.
    const dir = mkdtempSync(join(tmpdir(), "blocks-bundle-"));
    let meta: { inputs: Record<string, unknown> };
    try {
      const metafile = join(dir, "meta.json");
      bundle([
        "--platform=neutral",
        `--metafile=${metafile}`,
        `--outfile=${join(dir, "out.js")}`,
        "--log-level=error",
      ]);
      meta = JSON.parse(readFileSync(metafile, "utf-8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const inputs = Object.keys(meta.inputs);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input, input).toMatch(
        /(^|\/)src\/(v8\/|async\/default\.ts$|protocol\/(canonical|ciphertext)\.ts$)/,
      );
    }
  });
});
