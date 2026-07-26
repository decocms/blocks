import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checks } from "./phase-verify";
import type { MigrationContext } from "./types";

/**
 * #367: blocks-cli must never leave the frozen pre-7.x-split package
 * specifiers (@decocms/start@6.30.0, @decocms/apps@5.4.0) in a migrated
 * site's src/ — including via a transform hand-off marker (jsx.ts emits
 * `@decocms/start/hooks` as a same-run marker that phase-cleanup.ts is
 * supposed to resolve to `@decocms/blocks/hooks`) that leaks past cleanup
 * if the pipeline order ever changes.
 */

function makeCtx(sourceDir: string): MigrationContext {
  return {
    sourceDir,
    siteName: "test-site",
    platform: "custom",
    vtexAccount: null,
    gtmId: null,
    importMap: {},
    discoveredNpmDeps: {},
    themeColors: {},
    fontFamily: null,
    files: [],
    sectionMetas: [],
    islandClassifications: [],
    islandWrapperTargets: new Map(),
    loaderInventory: [],
    scaffoldedFiles: [],
    transformedFiles: [],
    deletedFiles: [],
    movedFiles: [],
    manualReviewItems: [],
    frameworkFindings: [],
    dryRun: false,
    verbose: false,
  };
}

const legacySpecifierCheck = checks.find(
  (c) => c.name === "No frozen pre-split package specifiers in src/ (@decocms/start, @decocms/apps/*)",
);
if (!legacySpecifierCheck) {
  throw new Error("verify check not found — name changed?");
}

function runCheck(ctx: MigrationContext): { ok: boolean; output: string } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  try {
    const ok = legacySpecifierCheck!.fn(ctx);
    return { ok, output: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

describe("verify check: 'No frozen pre-split package specifiers in src/' (#367)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-legacy-specifiers-"));
    fs.mkdirSync(path.join(tmp, "src", "hooks"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes when src/ only imports from the current split packages", () => {
    fs.writeFileSync(
      path.join(tmp, "src", "hooks", "useUser.ts"),
      `import { SectionRenderer } from "@decocms/blocks/hooks";\n` +
        `import { invoke } from "@decocms/blocks/sdk/invoke";\n` +
        `export const x = 1;\n`,
    );
    const { ok, output } = runCheck(makeCtx(tmp));
    expect(ok).toBe(true);
    expect(output).toBe("");
  });

  it("fails when a `@decocms/start/hooks` hand-off marker leaked past cleanup", () => {
    fs.writeFileSync(
      path.join(tmp, "src", "hooks", "useUser.ts"),
      `import { SectionRenderer } from "@decocms/start/hooks";\nexport const x = 1;\n`,
    );
    const { ok, output } = runCheck(makeCtx(tmp));
    expect(ok).toBe(false);
    expect(output).toContain("@decocms/start");
  });

  it("fails on a bare `@decocms/start` import (no subpath)", () => {
    fs.writeFileSync(
      path.join(tmp, "src", "hooks", "setup.ts"),
      `import "@decocms/start";\nexport const x = 1;\n`,
    );
    const { ok } = runCheck(makeCtx(tmp));
    expect(ok).toBe(false);
  });

  it("fails on a `@decocms/apps/vtex/...` monolith subpath import", () => {
    fs.writeFileSync(
      path.join(tmp, "src", "hooks", "old.ts"),
      `import { getUser } from "@decocms/apps/vtex/loaders/user";\nexport const x = 1;\n`,
    );
    const { ok, output } = runCheck(makeCtx(tmp));
    expect(ok).toBe(false);
    expect(output).toContain("@decocms/apps/");
  });

  it("does not flag the current @decocms/apps-vtex split package", () => {
    fs.writeFileSync(
      path.join(tmp, "src", "hooks", "useUser.ts"),
      `import { getUser } from "@decocms/apps-vtex/loaders/user";\nexport const x = 1;\n`,
    );
    const { ok } = runCheck(makeCtx(tmp));
    expect(ok).toBe(true);
  });

  it("ignores commented-out references", () => {
    fs.writeFileSync(
      path.join(tmp, "src", "hooks", "Docs.ts"),
      `// import { x } from "@decocms/start/hooks"\nexport const x = 1;\n`,
    );
    const { ok } = runCheck(makeCtx(tmp));
    expect(ok).toBe(true);
  });
});
