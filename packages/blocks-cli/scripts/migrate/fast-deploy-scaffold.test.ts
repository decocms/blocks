import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../lib/jsonc";
import { generateWranglerConfig } from "./phase-scaffold";
import { checks } from "./phase-verify";
import { generateSetup } from "./templates/setup";
import type { MigrationContext } from "./types";

/**
 * Fast Deploy is inert unless THREE things line up: the `DECO_KV` binding,
 * `DECO_FAST_DEPLOY=1`, and `setup.ts` handing the KV resolver to
 * `@decocms/blocks-admin` (which cannot import `@decocms/tanstack` itself).
 *
 * Two of three is the worst state: it looks configured, a Studio publish
 * reports success, and nothing ever reaches KV. These tests pin the scaffold to
 * emit all three and pin the verify check to actually catch a partial config.
 */

const FIXTURE: MigrationContext = {
  sourceDir: "",
  siteName: "test-site",
  platform: "custom",
  vtexAccount: null,
  gtmId: null,
  importMap: {},
  discoveredNpmDeps: {},
  themeColors: {},
  tailwindConfig: {
    colors: {},
    fontFamily: {},
    screens: {},
    safelist: [],
    safelistPatterns: [],
    plugins: [],
    reviewItems: [],
    animations: {},
    keyframes: {},
  },
  fontFamily: null,
  googleFonts: [],
  layout: null,
  files: [],
  sectionMetas: [],
  islandClassifications: [],
  loaderInventory: [],
  patterns: {},
  scaffoldedFiles: [],
  transformedFiles: [],
  deletedFiles: [],
  movedFiles: [],
  manualReview: [],
  dryRun: false,
  verbose: false,
} as unknown as MigrationContext;

const fastDeployCheck = checks.find((c) => c.name === "Fast Deploy wired end to end");

/** Write a site tree with the given wrangler + setup contents. */
function makeSite(wrangler: string, setup: string): MigrationContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-scaffold-"));
  fs.writeFileSync(path.join(dir, "wrangler.jsonc"), wrangler);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "setup.ts"), setup);
  return { ...FIXTURE, sourceDir: dir };
}

describe("scaffolded wrangler.jsonc", () => {
  // Parse it rather than grep it: the template is hand-written JSONC, and a
  // stray comma or comment that breaks parsing silently disables fast-deploy
  // everywhere at once (the builder, the control-plane and the verify check
  // below all read this file through a JSONC parser).
  const cfg = parseJsonc(generateWranglerConfig(FIXTURE)) as {
    kv_namespaces: Array<{ binding: string }>;
    vars: Record<string, string>;
    tail_consumers?: unknown[];
  };

  it("declares the DECO_KV binding and DECO_FAST_DEPLOY together", () => {
    expect(cfg.kv_namespaces.map((n) => n.binding)).toContain("DECO_KV");
    expect(cfg.vars.DECO_FAST_DEPLOY).toBe("1");
    expect(cfg.vars.DECO_SITE_NAME).toBe("test-site");
  });

  it("declares a tail consumer, without which exceededMemory is unobservable", () => {
    // Cloudflare kills the isolate over the 128MB cap before any in-worker code
    // could report it — the tail worker is the only channel that sees it.
    expect(cfg.tail_consumers).toBeTruthy();
  });
});

describe("scaffolded setup.ts", () => {
  it("calls setupTanstackFastDeploy, or the Studio publish write-through no-ops", () => {
    const setup = generateSetup(FIXTURE);
    expect(setup).toContain("setupTanstackFastDeploy()");
    expect(setup).toMatch(/import \{[^}]*setupTanstackFastDeploy[^}]*\} from "@decocms\/tanstack"/);
  });
});

describe('verify check "Fast Deploy wired end to end"', () => {
  const FULL_WRANGLER = `{
  // comment + trailing comma: real wrangler.jsonc, not JSON
  "kv_namespaces": [{ "binding": "DECO_KV", "id": "" }],
  "vars": { "DECO_FAST_DEPLOY": "1" },
}`;
  const FULL_SETUP = "setupTanstackFastDeploy();\n";

  it("passes on a fully wired site", () => {
    expect(fastDeployCheck?.fn(makeSite(FULL_WRANGLER, FULL_SETUP))).toBe(true);
  });

  it("fails when the DECO_KV binding is missing", () => {
    const w = '{ "kv_namespaces": [], "vars": { "DECO_FAST_DEPLOY": "1" } }';
    expect(fastDeployCheck?.fn(makeSite(w, FULL_SETUP))).toBe(false);
  });

  it("fails when DECO_FAST_DEPLOY is not set", () => {
    const w = '{ "kv_namespaces": [{ "binding": "DECO_KV", "id": "" }] }';
    expect(fastDeployCheck?.fn(makeSite(w, FULL_SETUP))).toBe(false);
  });

  it("fails when setup.ts never hands over the KV resolver", () => {
    expect(fastDeployCheck?.fn(makeSite(FULL_WRANGLER, "// nothing\n"))).toBe(false);
  });

  it("is an error, not a warning — a silent half-config is the failure mode", () => {
    expect(fastDeployCheck?.severity).toBe("error");
  });
});
