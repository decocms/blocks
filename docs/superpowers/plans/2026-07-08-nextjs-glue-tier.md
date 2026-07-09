# @decocms/nextjs Glue Tier + faststore-fila Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@decocms/nextjs` the bootstrap/config/dispatch glue tier that `@decocms/tanstack` already has, then migrate `~/code/faststore-fila` onto it, deleting its hand-rolled admin-route and registry boilerplate.

**Architecture:** Upstream (repo `~/code/deco-start`, branch `v7`): codegen hygiene fixes in `blocks-cli`, portability fix in `blocks-admin`, then three new `@decocms/nextjs` surfaces — `createNextSetup()` (one-call site bootstrap composing the existing `createSiteSetup` + `applySectionConventions` + admin wiring), `createDecoRouteHandlers()` (single catch-all dispatcher replacing 5 hand-written route files), and `withDeco()` (next.config wrapper adding the Studio-protocol rewrites + transpilePackages). Site (repo `~/code/faststore-fila`, branch `feat/nextjs-package-migration`): make `src/sections/` entry files the single source of truth (generated registry via `generate-sections --registry`), migrate `setup.ts` to `createNextSetup`, replace 5 route files + `adminRoute.ts` with one catch-all. Fila is verified against **packed tarballs** of the upstream changes BEFORE pushing v7 (which auto-releases); only after that verification does v7 get pushed and fila flipped to the published version.

**Tech Stack:** Bun workspaces, TypeScript (packages ship raw `.ts` src), vitest (upstream), Next.js 16 App Router + jest 30 (fila), semantic-release lockstep versioning (`blocks-v*` tags, all 14 packages same version).

## Global Constraints

- **Lockstep versioning**: every push to `v7` releases ALL packages at one shared version. Upstream commits here use `feat:`/`fix:` types → next release is **7.4.0**.
- **Do NOT push `v7` until the fila tarball-verification task (Task 11) passes** — pushing publishes.
- **No breaking changes to existing exports**: every current export of `@decocms/nextjs`, `@decocms/blocks`, `@decocms/blocks-admin`, `@decocms/blocks-cli` keeps working. New behavior is additive (new subpaths, new opt-in flags).
- **Route-handler graphs must stay react-server-safe**: nothing importable from `@decocms/nextjs/routeHandlers`, `@decocms/nextjs/setup`, or `@decocms/nextjs/config` may reach module-scope client-React (`createContext`, `class X extends Component`, `useState`, …). See `packages/nextjs/src/routeHandlers.ts`'s doc comment for the mechanics (route handlers ignore `"use client"` and run on React's react-server build).
- **`withDeco` must be requireable from a CommonJS `next.config.js`** (fila's is CJS). `@decocms/nextjs` has `"type": "module"`, so the config helper ships as **`.cjs`** with a `.d.cts` type file.
- **generate-sections' existing output must stay byte-identical for existing consumers** unless the new `--registry` flag is passed (tanstack sites regenerate these files in CI).
- **No `import.meta` syntax anywhere in `packages/blocks`, `packages/blocks-admin`, `packages/nextjs` source** after Task 3 (breaks CJS consumers like ts-jest). Grep-enforced.
- Monorepo checks that must stay green after every upstream task: `bun run --filter='./packages/<changed>' test` and `typecheck`.
- Fila checks that must stay green after every fila task: `bun jest src/sdk/deco/`, `bun x tsc --noEmit`, `/opt/homebrew/Cellar/node/26.4.0/bin/yarn build`. (Known pre-existing failure NOT to fix: `test/server/index.test.ts` "should handle options and execute" — persisted-query hash drift from unrelated Trustvox work.)
- Fila has two lockfiles: `yarn.lock` (git-tracked, used by the real deploy pipeline) and `bun.lock` (gitignored, local dev). Any `package.json` dependency change requires BOTH `bun install`/`bun update` AND `/opt/homebrew/Cellar/node/26.4.0/bin/yarn install`.
- Decision on legacy alias keys (recorded, do not revisit): fila's `.deco/blocks` uses legacy keys `site/sections/Newsletter/Newsletter.tsx` (365 files) and `site/sections/Footer/Footer.tsx` (1 file) for components canonically named `NewsletterCallout`/`Footer`. These are NOT codemodded — Studio re-imports would reintroduce them. They stay as 1-line alias entry files in `src/sections/`.

---

## Part 1 — Upstream (`~/code/deco-start`, branch `v7`)

### Task 1: Codegen exclusions — skip test/story/generated files in both generators

`generate-schema.ts` scans every `.tsx`/`.ts` under the sections dir and emitted a site's *test file* as a section block (real incident: `sections.test.ts` became a bogus section in fila's `meta.gen.json`). `generate-sections.ts`'s `walkDir` has the same hole.

**Files:**
- Modify: `packages/blocks-cli/scripts/generate-schema.ts` (its `findTsxFiles` function)
- Modify: `packages/blocks-cli/scripts/generate-sections.ts` (its `walkDir` function, ~line 87)
- Test: `packages/blocks-cli/scripts/generate-sections.test.ts` (create), extend `packages/blocks-cli/scripts/generate-schema.test.ts`

**Interfaces:**
- Produces: exported `isExcludedCodegenFile(fileName: string): boolean` from a new shared module `packages/blocks-cli/scripts/lib/codegenExclusions.ts`, used by both generators.

- [ ] **Step 1: Write the failing test.** Create `packages/blocks-cli/scripts/lib/codegenExclusions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isExcludedCodegenFile } from "./codegenExclusions";

describe("isExcludedCodegenFile", () => {
  it.each([
    "Hero.test.tsx",
    "Hero.test.ts",
    "Hero.spec.tsx",
    "Hero.stories.tsx",
    "sections.gen.ts",
    "meta.gen.json",
  ])("excludes %s", (name) => {
    expect(isExcludedCodegenFile(name)).toBe(true);
  });

  it.each(["Hero.tsx", "Product/SearchResult.tsx", "testimonials.tsx", "generic.ts"])(
    "keeps %s",
    (name) => {
      expect(isExcludedCodegenFile(name)).toBe(false);
    },
  );
});
```

Note `testimonials.tsx` and `generic.ts` — the regex must anchor on the dotted suffix, not substring-match `test`/`gen`.

- [ ] **Step 2: Run it, verify it fails** (module doesn't exist): `bun run --filter='./packages/blocks-cli' test` → FAIL.

- [ ] **Step 3: Implement** `packages/blocks-cli/scripts/lib/codegenExclusions.ts`:

```ts
/**
 * Files the codegen scanners must never treat as section/loader sources.
 * `generate-schema.ts` once emitted a site's co-located test file as a
 * section block (it scans every .ts/.tsx under the sections dir), so both
 * generators route their directory walks through this predicate.
 */
const EXCLUDED_SUFFIX_RE = /\.(test|spec|stories|gen)\.(ts|tsx|js|jsx|json)$/;

export function isExcludedCodegenFile(fileName: string): boolean {
  return EXCLUDED_SUFFIX_RE.test(fileName);
}
```

- [ ] **Step 4: Wire it into both generators.** In `generate-schema.ts`, find `findTsxFiles` and filter each file entry: `if (isExcludedCodegenFile(entry.name)) continue;` (import from `./lib/codegenExclusions`). In `generate-sections.ts`'s `walkDir`, change the file-accept branch to:

```ts
} else if (
  (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) &&
  !isExcludedCodegenFile(entry.name)
) {
  results.push(fullPath);
}
```

- [ ] **Step 5: Add an integration assertion** to the existing `generate-schema.test.ts` if it has a fixture-directory test (read it first; if it builds fixture dirs on disk, drop a `Section.test.tsx` fixture in and assert it does NOT appear in output; if it only unit-tests exported helpers, the unit test from Step 1 suffices — do not build new fixture machinery).

- [ ] **Step 6: Run tests + typecheck**: `bun run --filter='./packages/blocks-cli' test && bun run --filter='./packages/blocks-cli' typecheck` → PASS.

- [ ] **Step 7: Commit**: `git commit -m "fix(blocks-cli): exclude test/spec/stories/gen files from codegen scans"`

### Task 2: generate-schema — repo-relative definition IDs

`meta.gen.json` definition keys are currently `btoa("file:////Users/gimenes/code/<repo>/src/sections/X.tsx") + "@Props"` — machine-dependent, so the same repo generates different schema IDs on different machines (noisy diffs, unstable ETags).

**Files:**
- Modify: `packages/blocks-cli/scripts/generate-schema.ts`
- Test: extend `packages/blocks-cli/scripts/generate-schema.test.ts`

**Interfaces:**
- Consumes: the `root` variable already in scope in `generate-schema.ts` (the site root the script resolves at startup — locate it; it's used for `tsConfigFilePath: path.join(root, "tsconfig.json")` at ~line 754).
- Produces: definition IDs of the form `btoa("<repo-relative-path>")` (e.g. `btoa("src/sections/BannerPair.tsx") + "@Props"`), stable across machines. All emitted `$ref`s must use the same transformed IDs — this is an internal-consistency requirement, not a wire-format promise (the admin treats IDs as opaque).

- [ ] **Step 1: Locate the ID construction.** `grep -n "file:" packages/blocks-cli/scripts/generate-schema.ts` and `grep -n "toBase64" packages/blocks-cli/scripts/generate-schema.ts`. The `file:///` prefix comes from ts-morph source-file paths (likely `sourceFile.getFilePath()` or a symbol's declaration path) being fed into a definition-ID helper. Identify every call site that feeds a path into `toBase64`.

- [ ] **Step 2: Write the failing test.** In `generate-schema.test.ts`, add (adapt to the file's existing style — it exports `applyWidgetFormat`/`typeToJsonSchema`; if the ID helper isn't exported, export it as `definitionIdForPath(filePath: string, root: string): string`):

```ts
import { definitionIdForPath } from "./generate-schema";

describe("definitionIdForPath", () => {
  it("is repo-relative, never absolute", () => {
    const id = definitionIdForPath(
      "/Users/anyone/code/mysite/src/sections/Hero.tsx",
      "/Users/anyone/code/mysite",
    );
    expect(Buffer.from(id, "base64").toString()).toBe("src/sections/Hero.tsx");
  });

  it("normalizes file:// prefixes from ts-morph", () => {
    const id = definitionIdForPath(
      "file:///Users/anyone/code/mysite/src/sections/Hero.tsx",
      "/Users/anyone/code/mysite",
    );
    expect(Buffer.from(id, "base64").toString()).toBe("src/sections/Hero.tsx");
  });
});
```

- [ ] **Step 3: Run, verify FAIL** (helper not exported / behavior absolute).

- [ ] **Step 4: Implement.** Add to `generate-schema.ts`:

```ts
/**
 * Definition IDs must be stable across machines: the raw ts-morph path is
 * absolute (`file:///Users/<user>/...`), which made meta.gen.json differ
 * per machine and destabilized the /live/_meta ETag. IDs are opaque to the
 * admin — only internal $ref consistency matters — so relativize to root.
 */
export function definitionIdForPath(filePath: string, rootDir: string): string {
  const cleaned = filePath.replace(/^file:\/+/, "/");
  const rel = path.relative(rootDir, cleaned).replaceAll("\\", "/");
  return toBase64(rel.startsWith("..") ? cleaned : rel);
}
```

Then replace every `toBase64(<path-derived-value>)` call site found in Step 1 with `definitionIdForPath(<path>, root)` — ONLY for file-path-derived IDs. IDs derived from CMS keys (`toBase64("site/sections/X.tsx")`) are already stable; leave them.

- [ ] **Step 5: Run the full blocks-cli suite**: `bun run --filter='./packages/blocks-cli' test && bun run --filter='./packages/blocks-cli' typecheck` → PASS. If existing schema tests assert on old absolute-path IDs, update those assertions — they're asserting the bug.

- [ ] **Step 6: Commit**: `git commit -m "fix(blocks-cli): repo-relative schema definition IDs, not absolute file:// paths"`

### Task 3: blocks-admin — remove `import.meta` syntax (CJS portability)

`packages/blocks-admin/src/admin/decofile.ts:82` has `const isViteDev = !!import.meta.env?.DEV;`. `import.meta` is a *syntax error* in CommonJS output, so any CJS consumer compiling the raw-TS package (ts-jest in fila) explodes; fila currently carries a `jest.mock('@decocms/blocks-admin')` workaround.

**Files:**
- Modify: `packages/blocks-admin/src/admin/decofile.ts:82` (and any other `import.meta` occurrence the grep in Step 1 finds)
- Test: `packages/blocks-admin/src/admin/decofile.test.ts` (existing — must stay green)

- [ ] **Step 1: Find all occurrences**: `grep -rn "import\.meta" packages/blocks/src packages/blocks-admin/src packages/nextjs/src`. Expected: only `decofile.ts:82`. Fix every hit the same way.

- [ ] **Step 2: Read the gated behavior.** Open `decofile.ts` around line 82 and understand what `isViteDev` gates (dev-only decofile reload semantics). Preserve that behavior under Vite dev.

- [ ] **Step 3: Replace** with a runtime-agnostic dev check that is valid syntax in both ESM and CJS:

```ts
// `import.meta.env?.DEV` was a Vite-ism AND a syntax error for CJS
// consumers (ts-jest compiles this raw-TS package to CJS, where
// `import.meta` cannot be represented at all). Vite statically defines
// process.env.NODE_ENV in both dev and build, Next/Node set it natively,
// so NODE_ENV is the portable signal for the same dev-only behavior.
const isViteDev =
  typeof process !== "undefined" && process.env.NODE_ENV === "development";
```

Rename the variable to `isDevRuntime` (update its uses) since it's no longer Vite-specific — unless reads of the surrounding code show genuinely Vite-only semantics (e.g. it must be FALSE on `next dev`); in that case keep the NODE_ENV check but document the widened scope in the comment and verify Step 5's fila regression run.

- [ ] **Step 4: Grep gate**: `grep -rn "import\.meta" packages/blocks/src packages/blocks-admin/src packages/nextjs/src` → zero hits.

- [ ] **Step 5: Tests**: `bun run --filter='./packages/blocks-admin' test && bun run --filter='./packages/blocks-admin' typecheck` → PASS. Behavioral sanity: `cd ~/code/deco-start/examples/tanstack-smoke 2>/dev/null` — if the tanstack smoke example exists and has a dev script, boot it briefly and confirm decofile reload still logs; otherwise rely on the vitest suite (`decofile.test.ts` covers reload semantics).

- [ ] **Step 6: Commit**: `git commit -m "fix(blocks-admin): drop import.meta syntax so CJS consumers (ts-jest) can compile"`

### Task 4: generate-sections — `--registry` flag emitting a lazy-import section map

`createSiteSetup` needs a `sections` map (`{"./sections/X.tsx": () => import(...)}`) that Vite sites get from `import.meta.glob`. Next has no glob — so the generator (which already walks `src/sections/`) emits the equivalent map behind an opt-in flag. Keys use the glob-style `./sections/...` form so the map is a drop-in for `SiteSetupOptions.sections` (whose transform is `site/${path.slice(2)}`).

**Files:**
- Modify: `packages/blocks-cli/scripts/generate-sections.ts`
- Test: `packages/blocks-cli/scripts/generate-sections.test.ts` (created in Task 1, or create now)

**Interfaces:**
- Produces (in generated `sections.gen.ts`, only when `--registry` is passed): `export const sectionImports: Record<string, () => Promise<any>> = { "./sections/Hero.tsx": () => import("../../sections/Hero"), ... };`
- Existing exports (`sectionMeta`, `syncComponents`, `loadingFallbacks`) unchanged; output without the flag stays byte-identical.

- [ ] **Step 1: Write the failing test.** The generator is a CLI script; test it end-to-end with a temp fixture (vitest, node fs):

```ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "generate-sections.ts");

function runFixture(extraArgs: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-sections-"));
  fs.mkdirSync(path.join(dir, "src/sections/Nested"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src/sections/Hero.tsx"),
    "export const sync = true\nexport default function Hero() { return null }\n",
  );
  fs.writeFileSync(
    path.join(dir, "src/sections/Nested/Promo.tsx"),
    "export default function Promo() { return null }\n",
  );
  execFileSync("bun", ["x", "tsx", SCRIPT, ...extraArgs], { cwd: dir });
  return fs.readFileSync(path.join(dir, "src/server/cms/sections.gen.ts"), "utf-8");
}

describe("generate-sections --registry", () => {
  it("emits sectionImports keyed glob-style with relative dynamic imports", () => {
    const out = runFixture(["--registry"]);
    expect(out).toContain('export const sectionImports');
    expect(out).toContain('"./sections/Hero.tsx": () => import("../../sections/Hero")');
    expect(out).toContain('"./sections/Nested/Promo.tsx": () => import("../../sections/Nested/Promo")');
  });

  it("does not emit sectionImports without the flag", () => {
    const out = runFixture([]);
    expect(out).not.toContain("sectionImports");
  });
});
```

Note: without `--registry`, `Promo.tsx` (no convention exports) isn't in `entries` at all today — the registry must be built from **all scanned section files**, not just convention-carrying `entries`.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** In `generate-sections.ts`: parse the flag (`const EMIT_REGISTRY = args.includes("--registry");`). After the existing `sectionFiles` walk, when `EMIT_REGISTRY`, append to `lines` before the final write:

```ts
if (EMIT_REGISTRY) {
  lines.push("");
  lines.push("/**");
  lines.push(" * Lazy section registry — the Next.js/webpack equivalent of Vite's");
  lines.push(' * `import.meta.glob("./sections/**/*.tsx")`. Keys use the glob-style');
  lines.push(" * `./sections/...` form so this map drops straight into");
  lines.push(" * `createSiteSetup({ sections })` / `createNextSetup({ sections })`.");
  lines.push(" */");
  lines.push("export const sectionImports: Record<string, () => Promise<any>> = {");
  for (const filePath of sectionFiles) {
    const rel = path.relative(sectionsDir, filePath).replace(/\\/g, "/");
    const importPath = relativeImportPath(outFile, filePath);
    lines.push(`  "./sections/${rel}": () => import("${importPath}"),`);
  }
  lines.push("};");
}
```

- [ ] **Step 4: Run tests**: `bun run --filter='./packages/blocks-cli' test` → PASS (both new tests and the byte-stability of default output implicitly via the no-flag test).

- [ ] **Step 5: Commit**: `git commit -m "feat(blocks-cli): generate-sections --registry emits a lazy section-import map for non-Vite bundlers"`

### Task 5: `@decocms/nextjs/setup` — `createNextSetup()`

One-call, route-handler-safe bootstrap for Next sites. Composes existing framework pieces; owns nothing novel.

**Files:**
- Create: `packages/nextjs/src/setup.ts`
- Create: `packages/nextjs/src/setup.test.ts`
- Modify: `packages/nextjs/package.json` (exports map: add `"./setup": "./src/setup.ts"`)

**Interfaces:**
- Consumes: `createSiteSetup` from `@decocms/blocks/setup`; `applySectionConventions`, `loadBlocks` from `@decocms/blocks/cms`; `loadDecofileDirectory` from `@decocms/blocks/cms/loadDecofileDirectory`; lazy `setMetaData`, `setRenderShell`, `setPreviewWrapper` from `@decocms/blocks-admin`.
- Produces: `createNextSetup(options: NextSetupOptions): () => Promise<void>` — returns a memoized `ensureSetup`. Task 6's dispatcher and fila's Task 10 consume this exact signature.

- [ ] **Step 1: Write the failing test** `packages/nextjs/src/setup.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRegisteredSections, loadBlocks, setBlocks } from "@decocms/blocks/cms";
import { createNextSetup } from "./setup";

describe("createNextSetup", () => {
  beforeEach(() => {
    setBlocks({});
  });

  it("returns a memoized ensureSetup that registers blocks, sections, meta", async () => {
    const meta = vi.fn().mockResolvedValue({
      major: 1,
      version: "test",
      namespace: "site",
      site: "test",
      manifest: { blocks: { sections: {} } },
      schema: { definitions: {}, root: {} },
      platform: "test",
      cloudProvider: "test",
    });
    const ensureSetup = createNextSetup({
      blocksDir: false,
      blocks: { myBlock: { __resolveType: "site/sections/Hero.tsx" } },
      sections: { "./sections/Hero.tsx": async () => ({ default: () => null }) },
      meta,
    });

    await ensureSetup();
    await ensureSetup(); // memoized — meta loader must run once

    expect(meta).toHaveBeenCalledTimes(1);
    expect(loadBlocks().myBlock).toBeDefined();
    expect(listRegisteredSections()).toContain("site/sections/Hero.tsx");
  });

  it("applies section conventions when provided", async () => {
    const ensureSetup = createNextSetup({
      blocksDir: false,
      sections: { "./sections/Footer.tsx": async () => ({ default: () => null }) },
      conventions: { meta: { "site/sections/Footer.tsx": { layout: true } } },
    });
    await ensureSetup();
    const { isLayoutSection } = await import("@decocms/blocks/cms");
    expect(isLayoutSection("site/sections/Footer.tsx")).toBe(true);
  });
});
```

Check the real exported names before finalizing the test: `isLayoutSection` and `listRegisteredSections` exist in `@decocms/blocks/cms` (see `packages/blocks/src/cms/index.ts`). If `isLayoutSection`'s signature differs, assert via whatever the barrel exposes for layout-section checks.

- [ ] **Step 2: Run, verify FAIL** (`bun run --filter='./packages/nextjs' test`).

- [ ] **Step 3: Implement** `packages/nextjs/src/setup.ts`:

```ts
/**
 * One-call site bootstrap for Next.js — the App Router sibling of the
 * Vite flow (`createSiteSetup` + `createAdminSetup` + import.meta.glob).
 * Next has no import.meta.glob and no Vite plugin, so this composes the
 * same framework pieces from a generated section registry
 * (`generate-sections --registry`) and a filesystem decofile directory.
 *
 * ROUTE-HANDLER-SAFE: this module (and everything it imports eagerly) must
 * never reach module-scope client-React — it is imported by route files
 * via the site's setup module. Admin setters are imported lazily for the
 * same reason createAdminSetup keeps meta lazy: they're only needed when
 * an admin request actually arrives... and because @decocms/blocks-admin
 * is a heavier graph than the CMS core.
 *
 * @example site's `src/deco/setup.ts`
 * ```ts
 * import { createNextSetup } from "@decocms/nextjs/setup";
 * import { sectionImports, sectionMeta, syncComponents } from "./sections.gen";
 *
 * export const ensureSetup = createNextSetup({
 *   sections: sectionImports,
 *   conventions: { meta: sectionMeta, syncComponents },
 *   meta: () => import("./meta.gen.json").then((m) => m.default),
 * });
 * ```
 */
import type { ApplySectionConventionsInput } from "@decocms/blocks/cms";
import { applySectionConventions, loadBlocks } from "@decocms/blocks/cms";
import { loadDecofileDirectory } from "@decocms/blocks/cms/loadDecofileDirectory";
import { createSiteSetup, type SiteSetupOptions } from "@decocms/blocks/setup";

export interface NextSetupOptions {
  /**
   * Directory of decofile JSON snapshots, relative to the site root.
   * Pass `false` to skip filesystem loading (blocks come from `blocks`).
   * @default ".deco/blocks"
   */
  blocksDir?: string | false;

  /** Extra/override blocks, merged OVER the directory's blocks. */
  blocks?: Record<string, unknown>;

  /**
   * Lazy section registry — `sectionImports` from
   * `generate-sections --registry` (keys `./sections/X.tsx`).
   */
  sections: Record<string, () => Promise<any>>;

  /** `{ meta: sectionMeta, syncComponents, loadingFallbacks }` from sections.gen.ts. */
  conventions?: Omit<ApplySectionConventionsInput, "sectionGlob">;

  /** Lazy admin meta schema: `() => import("./meta.gen.json").then(m => m.default)`. */
  meta?: () => Promise<unknown>;

  /** Admin preview shell (CSS/font URLs) — see blocks-admin setRenderShell. */
  renderShell?: { css?: string; fonts?: string[] };

  /** Admin preview wrapper component. */
  previewWrapper?: React.ComponentType<any>;

  productionOrigins?: SiteSetupOptions["productionOrigins"];
  customMatchers?: SiteSetupOptions["customMatchers"];
  onResolveError?: SiteSetupOptions["onResolveError"];
  onDanglingReference?: SiteSetupOptions["onDanglingReference"];

  /**
   * Site-specific wiring that must run after the core setup (section
   * loaders, SEO keys for legacy decofiles, curated post-processing).
   * Receives the loaded blocks.
   */
  extend?: (blocks: Record<string, unknown>) => void | Promise<void>;
}

export function createNextSetup(options: NextSetupOptions): () => Promise<void> {
  let setupPromise: Promise<void> | null = null;

  return function ensureSetup(): Promise<void> {
    setupPromise ??= (async () => {
      const dirBlocks =
        options.blocksDir === false
          ? {}
          : await loadDecofileDirectory(options.blocksDir ?? ".deco/blocks");
      const blocks = { ...dirBlocks, ...options.blocks };

      createSiteSetup({
        sections: options.sections,
        blocks,
        productionOrigins: options.productionOrigins,
        customMatchers: options.customMatchers,
        onResolveError: options.onResolveError,
        onDanglingReference: options.onDanglingReference,
      });

      if (options.conventions) {
        applySectionConventions({
          ...options.conventions,
          sectionGlob: options.sections,
        });
      }

      if (options.meta || options.renderShell || options.previewWrapper) {
        const admin = await import("@decocms/blocks-admin");
        if (options.meta) admin.setMetaData((await options.meta()) as never);
        if (options.renderShell) admin.setRenderShell(options.renderShell);
        if (options.previewWrapper) admin.setPreviewWrapper(options.previewWrapper);
      }

      await options.extend?.(loadBlocks());
    })();
    return setupPromise;
  };
}
```

Verify exact imported names against the barrels before finishing: `ApplySectionConventionsInput` is exported from `@decocms/blocks/cms`; `SiteSetupOptions` from `@decocms/blocks/setup`; `setRenderShell`'s option type in blocks-admin (`{ css: string; fonts?: string[] }` — if `css` is required there, keep `renderShell.css` required in `NextSetupOptions` accordingly).

- [ ] **Step 4: Add the exports entry** in `packages/nextjs/package.json`: `"./setup": "./src/setup.ts"` (after `"./routeHandlers"`).

- [ ] **Step 5: Run tests + typecheck**: `bun run --filter='./packages/nextjs' test && bun run --filter='./packages/nextjs' typecheck` → PASS.

- [ ] **Step 6: Commit**: `git commit -m "feat(nextjs): createNextSetup — one-call Next.js site bootstrap"`

### Task 6: `createDecoRouteHandlers()` — single catch-all dispatcher

Replaces per-URL route files. Mounted at `app/deco/[[...deco]]/route.ts`; `withDeco`'s rewrites (Task 7) funnel the Studio-protocol URLs (`/.decofile`, `/live/_meta`, `/live/previews/*`) under `/deco/*`.

**Files:**
- Modify: `packages/nextjs/src/routeHandlers.ts` (append; existing named exports unchanged)
- Test: `packages/nextjs/src/routeHandlers.test.ts` (extend)

**Interfaces:**
- Consumes: `handleDecofileRead`, `handleDecofileReload`, `handleInvoke`, `handleMeta`, `handleRender` from `@decocms/blocks-admin` (already imported at top of file).
- Produces: `createDecoRouteHandlers(options?: { setup?: () => Promise<void> }): { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> }`. URL contract (post-rewrite paths): `/deco/decofile` (GET read, POST reload), `/deco/meta` (GET), `/deco/previews/<path>` (GET+POST, URL rebuilt to `/live/previews/<path>` before delegating — `handleRender` parses that literal prefix), `/deco/invoke/<key...>` (POST, passed through untouched — `handleInvoke` parses the key from the path), `/deco/render` (GET+POST). Anything else → 404 JSON.

- [ ] **Step 1: Write the failing tests** (extend `routeHandlers.test.ts`; mock the blocks-admin handlers):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleDecofileRead: vi.fn(async () => new Response("decofile")),
  handleDecofileReload: vi.fn(async () => new Response("reloaded")),
  handleInvoke: vi.fn(async () => new Response("invoked")),
  handleMeta: vi.fn(() => new Response("meta")),
  handleRender: vi.fn(async (req: Request) => new Response(new URL(req.url).pathname)),
}));
vi.mock("@decocms/blocks-admin", () => mocks);

import { createDecoRouteHandlers } from "./routeHandlers";

describe("createDecoRouteHandlers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs setup before dispatching and routes decofile GET/POST", async () => {
    const order: string[] = [];
    const setup = vi.fn(async () => { order.push("setup"); });
    const { GET, POST } = createDecoRouteHandlers({ setup });

    await GET(new Request("http://x/deco/decofile"));
    expect(setup).toHaveBeenCalled();
    expect(mocks.handleDecofileRead).toHaveBeenCalled();

    await POST(new Request("http://x/deco/decofile", { method: "POST" }));
    expect(mocks.handleDecofileReload).toHaveBeenCalled();
  });

  it("routes meta, render, and invoke", async () => {
    const { GET, POST } = createDecoRouteHandlers();
    await GET(new Request("http://x/deco/meta"));
    expect(mocks.handleMeta).toHaveBeenCalled();
    await POST(new Request("http://x/deco/render", { method: "POST" }));
    expect(mocks.handleRender).toHaveBeenCalled();
    await POST(new Request("http://x/deco/invoke/site/actions/x", { method: "POST" }));
    expect(mocks.handleInvoke).toHaveBeenCalled();
  });

  it("rebuilds /deco/previews/* URLs to the /live/previews/* prefix handleRender parses", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(new Request("http://x/deco/previews/pages-Home-123?props=x"));
    expect(await res.text()).toBe("/live/previews/pages-Home-123");
    const calledUrl = new URL(mocks.handleRender.mock.calls[0][0].url);
    expect(calledUrl.searchParams.get("props")).toBe("x");
  });

  it("404s unknown deco paths", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(new Request("http://x/deco/nope"));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** (append to `routeHandlers.ts`):

```ts
export interface DecoRouteHandlersOptions {
  /**
   * Site bootstrap, awaited before every admin request — pass the
   * ensureSetup returned by createNextSetup (@decocms/nextjs/setup).
   */
  setup?: () => Promise<void>;
}

/**
 * Single catch-all dispatcher for the whole Studio admin protocol. Mount
 * at `app/deco/[[...deco]]/route.ts` and wrap next.config with
 * `withDeco()` (@decocms/nextjs/config), whose rewrites map the protocol
 * URLs Next can't express as segments (`/.decofile`, `/live/_meta`,
 * `/live/previews/*`) into `/deco/*`:
 *
 * ```ts
 * import { createDecoRouteHandlers } from "@decocms/nextjs/routeHandlers";
 * import { ensureSetup } from "../../../deco/setup";
 * export const dynamic = "force-dynamic";
 * export const { GET, POST } = createDecoRouteHandlers({ setup: ensureSetup });
 * ```
 */
export function createDecoRouteHandlers(options: DecoRouteHandlersOptions = {}): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
} {
  async function dispatch(request: Request): Promise<Response> {
    await options.setup?.();

    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/deco\//, "");

    if (action === "decofile") {
      return request.method === "POST" ? handleDecofileReload(request) : handleDecofileRead();
    }
    if (action === "meta") return handleMeta(request);
    if (action === "render") return handleRender(request);
    if (action.startsWith("invoke/")) return handleInvoke(request);
    if (action === "previews" || action.startsWith("previews/")) {
      // handleRender parses the literal "/live/previews/" prefix — rebuild
      // the pre-rewrite URL (rewrites hand route handlers the DESTINATION
      // path, so the prefix information is otherwise lost).
      const rest = action === "previews" ? "" : action.slice("previews/".length);
      const rebuilt = new URL(url);
      rebuilt.pathname = `/live/previews/${rest}`;
      return handleRender(new Request(rebuilt, request));
    }
    return new Response(JSON.stringify({ error: `Unknown deco route: ${url.pathname}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return { GET: dispatch, POST: dispatch };
}
```

- [ ] **Step 4: Run tests**: `bun run --filter='./packages/nextjs' test` → PASS (new tests + the pre-existing `routeHandlers.test.ts` case).

- [ ] **Step 5: Commit**: `git commit -m "feat(nextjs): createDecoRouteHandlers catch-all admin dispatcher"`

### Task 7: `withDeco()` next.config wrapper

**Files:**
- Create: `packages/nextjs/src/config.cjs` (CJS — requireable from a CJS `next.config.js`; the package is `"type": "module"` so `.js` would be ESM)
- Create: `packages/nextjs/src/config.d.cts`
- Create: `packages/nextjs/src/config.test.ts`
- Modify: `packages/nextjs/package.json` (exports: `"./config": { "types": "./src/config.d.cts", "default": "./src/config.cjs" }`)

**Interfaces:**
- Produces: `withDeco(nextConfig?: NextConfig): NextConfig` — merges (1) rewrites `[{source:"/.decofile",destination:"/deco/decofile"},{source:"/live/_meta",destination:"/deco/meta"},{source:"/live/previews/:path*",destination:"/deco/previews/:path*"}]` ahead of any user rewrites, handling user `rewrites` as absent, async function returning array, or async function returning `{beforeFiles,afterFiles,fallback}`; (2) `transpilePackages` deduped with `["@decocms/blocks","@decocms/blocks-admin","@decocms/nextjs"]`.

- [ ] **Step 1: Write the failing test** `packages/nextjs/src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withDeco, DECO_REWRITES } = require("./config.cjs");

describe("withDeco", () => {
  it("adds rewrites and transpilePackages to a bare config", async () => {
    const cfg = withDeco({});
    expect(cfg.transpilePackages).toEqual(
      expect.arrayContaining(["@decocms/blocks", "@decocms/blocks-admin", "@decocms/nextjs"]),
    );
    expect(await cfg.rewrites()).toEqual(DECO_REWRITES);
  });

  it("prepends deco rewrites to a user's array-returning rewrites()", async () => {
    const cfg = withDeco({
      rewrites: async () => [{ source: "/a", destination: "/b" }],
    });
    const out = await cfg.rewrites();
    expect(out.slice(0, DECO_REWRITES.length)).toEqual(DECO_REWRITES);
    expect(out.at(-1)).toEqual({ source: "/a", destination: "/b" });
  });

  it("merges into a user's object-form rewrites via beforeFiles", async () => {
    const cfg = withDeco({
      rewrites: async () => ({
        beforeFiles: [{ source: "/x", destination: "/y" }],
        afterFiles: [],
        fallback: [],
      }),
    });
    const out = await cfg.rewrites();
    expect(out.beforeFiles.slice(0, DECO_REWRITES.length)).toEqual(DECO_REWRITES);
    expect(out.beforeFiles.at(-1)).toEqual({ source: "/x", destination: "/y" });
  });

  it("dedupes transpilePackages", () => {
    const cfg = withDeco({ transpilePackages: ["@decocms/blocks", "other"] });
    expect(cfg.transpilePackages.filter((p: string) => p === "@decocms/blocks")).toHaveLength(1);
    expect(cfg.transpilePackages).toContain("other");
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** `packages/nextjs/src/config.cjs`:

```js
/**
 * next.config wrapper for Deco sites. CommonJS on purpose: next.config.js
 * is CJS in most sites and this package is "type": "module", so a .js
 * file here would be ESM and unrequireable on Node < 22.
 *
 * Adds:
 * 1. Rewrites for the Studio-protocol URLs Next cannot express as route
 *    segments — `/.decofile` (segments can't start with a dot) and
 *    `/live/_meta` (`_`-prefixed segments are Next "private folders",
 *    silently excluded from routing) — plus `/live/previews/*`, all
 *    funneled to `/deco/*` where a single catch-all route
 *    (`app/deco/[[...deco]]/route.ts` + createDecoRouteHandlers) serves
 *    the whole protocol.
 * 2. transpilePackages for the raw-TS @decocms packages.
 */
const DECO_REWRITES = [
  { source: "/.decofile", destination: "/deco/decofile" },
  { source: "/live/_meta", destination: "/deco/meta" },
  { source: "/live/previews/:path*", destination: "/deco/previews/:path*" },
];

const DECO_TRANSPILE = ["@decocms/blocks", "@decocms/blocks-admin", "@decocms/nextjs"];

function withDeco(nextConfig = {}) {
  const userRewrites = nextConfig.rewrites;
  return {
    ...nextConfig,
    transpilePackages: [
      ...new Set([...(nextConfig.transpilePackages ?? []), ...DECO_TRANSPILE]),
    ],
    async rewrites() {
      const user =
        typeof userRewrites === "function" ? await userRewrites() : (userRewrites ?? []);
      if (Array.isArray(user)) return [...DECO_REWRITES, ...user];
      return { ...user, beforeFiles: [...DECO_REWRITES, ...(user.beforeFiles ?? [])] };
    },
  };
}

module.exports = { withDeco, DECO_REWRITES };
```

And `packages/nextjs/src/config.d.cts`:

```ts
import type { NextConfig } from "next";

export declare const DECO_REWRITES: Array<{ source: string; destination: string }>;
export declare function withDeco(nextConfig?: NextConfig): NextConfig;
```

- [ ] **Step 4: Exports map** in `packages/nextjs/package.json`:

```json
"./config": {
  "types": "./src/config.d.cts",
  "default": "./src/config.cjs"
}
```

- [ ] **Step 5: Run tests + typecheck + knip**: `bun run --filter='./packages/nextjs' test && bun run --filter='./packages/nextjs' typecheck` → PASS. If `lint:unused` (knip) flags the .cjs, add it to knip's entry config in the package.

- [ ] **Step 6: Commit**: `git commit -m "feat(nextjs): withDeco next.config wrapper (Studio rewrites + transpilePackages)"`

### Task 8: Migrate `examples/nextjs-smoke` to the new APIs + package README

The smoke fixture currently hand-rolls exactly what Tasks 5–7 shipped (ad-hoc rewrites in its next.config, `app/deco-decofile/route.ts`, `app/live/meta/route.ts`). Migrating it is the in-repo validation that the new APIs actually compose.

**Files:**
- Modify: `examples/nextjs-smoke/next.config.ts` (wrap with `withDeco`, delete the ad-hoc rewrites)
- Create: `examples/nextjs-smoke/src/app/deco/[[...deco]]/route.ts`
- Delete: `examples/nextjs-smoke/src/app/deco-decofile/route.ts`, `examples/nextjs-smoke/src/app/live/meta/route.ts`
- Modify: `examples/nextjs-smoke/src/setup.ts` (use `createNextSetup`; read the current file first and port its existing registrations into the options / `extend`)
- Create: `packages/nextjs/README.md`

- [ ] **Step 1: Read the current fixture** (`src/setup.ts`, both route files, `next.config.ts`, `package.json` scripts) to know what behavior must be preserved.

- [ ] **Step 2: Rewrite `next.config.ts`**:

```ts
import type { NextConfig } from "next";
import { withDeco } from "@decocms/nextjs/config";

const nextConfig: NextConfig = {};

export default withDeco(nextConfig);
```

(Port any non-rewrite options the current config carries.)

- [ ] **Step 3: Create the catch-all route** `src/app/deco/[[...deco]]/route.ts`:

```ts
import { createDecoRouteHandlers } from "@decocms/nextjs/routeHandlers";
import { ensureSetup } from "../../../setup";

export const dynamic = "force-dynamic";

export const { GET, POST } = createDecoRouteHandlers({ setup: ensureSetup });
```

(Adjust the relative import to the fixture's real setup path; the setup module must export `ensureSetup` after Step 4.)

- [ ] **Step 4: Rewrite `src/setup.ts`** around `createNextSetup`, exporting `ensureSetup`. Keep whatever blocks/sections the fixture registers today (port them into `blocks`/`sections`/`extend`). Delete the two old route files.

- [ ] **Step 5: Build the fixture**: `cd examples/nextjs-smoke && bun install && bun run build` → succeeds. Then `bun run dev` briefly (background, log to file), `curl -s -o /dev/null -w "%{http_code}" localhost:3000/.decofile` → 200, same for `/live/_meta` → 200 (or the fixture's designed response), kill dev.

- [ ] **Step 6: Write `packages/nextjs/README.md`** — the complete recipe a new Next site follows. Contents (all code, no hand-waving): install line; `withDeco` in next.config (both CJS `require` and TS `import` forms); the catch-all route file verbatim; `src/deco/setup.ts` with `createNextSetup` verbatim; the two package scripts with **non-colliding names** (`"generate:deco-meta"` and `"generate:deco-sections"` — call out explicitly that FastStore sites already own `generate:schema`); the `src/sections/` entry-file convention (thin re-export files; component internals stay elsewhere; `export const sync/layout/seo/cache` conventions; warning that EVERY `.tsx` in the dir becomes a section key); the route-handler import rule (subpaths, never the root barrel, and why in one paragraph).

- [ ] **Step 7: Monorepo gate**: `bun run typecheck && bun run test` (all packages) → all green.

- [ ] **Step 8: Commit**: `git commit -m "feat(nextjs): migrate nextjs-smoke to withDeco/createDecoRouteHandlers/createNextSetup + README recipe"`

---

## Part 2 — Site (`~/code/faststore-fila`, branch `feat/nextjs-package-migration`)

Tasks 9–11 run against **packed tarballs** of the Task 1–8 work (NOT bun link — Vite/webpack behave differently with symlinks; this session already proved fixes "verified" via link can be false). Install them like this before Task 9:

```bash
cd ~/code/deco-start
for p in blocks blocks-admin blocks-cli nextjs; do (cd packages/$p && npm pack --pack-destination /tmp/deco-tarballs/); done
cd ~/code/faststore-fila
for p in blocks blocks-admin blocks-cli nextjs; do
  rm -rf node_modules/@decocms/$p
  mkdir -p node_modules/@decocms/$p
  tar -xzf /tmp/deco-tarballs/decocms-$p-*.tgz -C node_modules/@decocms/$p --strip-components=1
done
```

(Workspace `package.json`s say version `0.0.0` with real semver ranges on their `@decocms/*` deps — those deps are already satisfied by the extracted set itself plus the hoisted tree. After extraction run `node -e "require('@decocms/nextjs/package.json')"`-style sanity checks only; do NOT run `bun install`, which would clobber the extraction.)

### Task 9: fila — conventions + generated section registry

**Files:**
- Modify: all 20 files in `~/code/faststore-fila/src/sections/**/*.tsx` (add convention exports)
- Modify: `~/code/faststore-fila/package.json` (add `generate:deco-sections` script)
- Create (generated): `~/code/faststore-fila/src/sdk/deco/sections.gen.ts`
- Rewrite: `~/code/faststore-fila/src/sdk/deco/sections.ts`
- Modify: `~/code/faststore-fila/src/sdk/deco/sectionShims.test.ts`

**Interfaces:**
- Produces: `sections.gen.ts` exporting `sectionImports`, `sectionMeta`, `syncComponents` (from `generate-sections --registry`); rewritten `sections.ts` whose module side effect registers everything on both server and client bundles (this is what pages/hydration rely on — see the current file's doc comment about `sideEffects: false`).

- [ ] **Step 1: Add convention exports to every entry file.** Every one of the 20 files gets `export const sync = true` appended (fila registers every section synchronously today — all components are statically imported in the current `sections.ts`, and hydration relies on `getSyncComponent`). The two Footer entries (`Footer.tsx`, `Footer/Footer.tsx`) ALSO get `export const layout = true` (replaces the manual `registerLayoutSections` call in setup.ts). Example — `src/sections/HeroSlideshow.tsx` becomes:

```tsx
// Schema-codegen + registry entry — NOT imported by app pages directly.
// `generate:deco-meta` and `generate:deco-sections` scan src/sections/ and
// derive each block key from the file path (`site/sections/<relpath>`), so
// this file's location IS the registry key. The re-export points at the
// real component so ts-morph can extract the Props schema.
export { default } from 'src/components/sections/HeroSlideshow'

// Bundled synchronously (static import) — required for hydration parity;
// see src/sdk/deco/sections.ts.
export const sync = true
```

- [ ] **Step 2: Add the script** to fila `package.json` scripts:

```json
"generate:deco-sections": "tsx node_modules/@decocms/blocks-cli/scripts/generate-sections.ts --registry --out-file src/sdk/deco/sections.gen.ts"
```

Run it: `bun run generate:deco-sections`. Inspect `src/sdk/deco/sections.gen.ts`: 20 keys in `sectionMeta` (all `sync: true`, both Footer keys `layout: true`), 20 static `import * as _syncN` lines, 20 entries in `sectionImports`.

- [ ] **Step 3: Rewrite `src/sdk/deco/sections.ts`** — the hand map dies; the file becomes the both-bundles registration side effect:

```ts
/**
 * Section registry — runs as a module-load side effect on both server and
 * client bundles so `getResolvedComponent`/`getSyncComponent` find the
 * same components on both sides of hydration.
 *
 * The registry itself is GENERATED (src/sdk/deco/sections.gen.ts, from the
 * entry files in src/sections/ via `bun run generate:deco-sections`) — the
 * key set lives in the filesystem, not in a hand-written map. Add a
 * section by adding an entry file under src/sections/ and re-running the
 * generator (sectionShims.test.ts fails if you forget).
 *
 * `SECTIONS` stays a NAMED export consumed by setup.ts/pages because the
 * project's `package.json` sets `"sideEffects": false` — webpack drops
 * side-effect-only imports, so importing a value is what keeps this module
 * (and its registration loop) in the bundle.
 */
import { applySectionConventions, registerSections } from '@decocms/blocks/cms'

import { sectionImports, sectionMeta, syncComponents } from './sections.gen'

// Same key transform createSiteSetup applies: "./sections/X.tsx" → "site/sections/X.tsx"
const lazySections: Record<string, () => Promise<unknown>> = {}
for (const [globKey, loader] of Object.entries(sectionImports)) {
  lazySections[`site/${globKey.slice(2)}`] = loader
}
registerSections(lazySections as never)
applySectionConventions({
  meta: sectionMeta,
  syncComponents,
  sectionGlob: sectionImports as never,
})

export const SECTIONS = syncComponents
```

Check every current importer of `SECTIONS` (`grep -rn "from './sections'\|from 'src/sdk/deco/sections'" src/`) — they import it only to defeat tree-shaking (`void _SECTIONS`), so the changed value shape (namespace modules instead of bare components) is fine; confirm no importer indexes into it. If one does, adapt that importer to `getSyncComponent`.

- [ ] **Step 4: Regenerate meta and update the drift test.** `bun run generate:deco-meta`. Rewrite `sectionShims.test.ts`'s registry-comparison to compare against the GENERATED registry instead of the deleted hand map:

```ts
// (imports section stays; replace `import { SECTIONS } from './sections'`)
import { sectionMeta } from './sections.gen'
// registryKeys becomes:
const registryKeys = Object.keys(sectionMeta).sort()
```

Keep all three assertions (shims ↔ registry ↔ meta.gen.json). Note the jest.mock lines for `@generated` may become unnecessary once the hand map (whose component imports pulled `@generated` in) is gone — try removing them; restore if the suite fails.

- [ ] **Step 5: Verify**: `bun jest src/sdk/deco/ && bun x tsc --noEmit` → PASS. Boot `bun dev` (background, log file), curl `/` → 200 and one PLP (e.g. `/sale`) → 200, confirm sections render (grep the HTML for a known section marker, e.g. `hero` markup), kill dev.

- [ ] **Step 6: Commit**: `git commit -m "refactor(deco): generate the section registry from src/sections entries (kill the hand map)"`

### Task 10: fila — `setup.ts` on `createNextSetup`

**Files:**
- Modify: `~/code/faststore-fila/src/sdk/deco/setup.ts` (the `ensureSetup` body, lines ~123–200)

**Interfaces:**
- Consumes: `createNextSetup` from `@decocms/nextjs/setup` (Task 5), `sectionImports`/`sectionMeta`/`syncComponents` from `./sections.gen` (Task 9).
- Produces: `ensureSetup: () => Promise<void>` — same name/signature as today (adminRoute.ts, pages, `getAllCmsPagePaths`, `resolveCmsPage` keep calling it unchanged).

- [ ] **Step 1: Rewrite the setup composition.** Replace the current `let setupPromise` + `export function ensureSetup()` block with:

```ts
import { createNextSetup } from '@decocms/nextjs/setup'
import { sectionImports, sectionMeta, syncComponents } from './sections.gen'
```

```ts
export const ensureSetup = createNextSetup({
  blocksDir: '.deco/blocks',
  // Curated overrides win over the imported decofile snapshots.
  blocks: {
    [HOME_BLOCK_KEY]: homeBlock as unknown as Record<string, unknown>,
    [PDP_BLOCK_KEY]: pdpBlock as unknown as Record<string, unknown>,
  },
  sections: sectionImports,
  conventions: { meta: sectionMeta, syncComponents },
  meta: () => import('./meta.gen.json').then((m) => m.default),
  onResolveError: (error, resolveType, context) => {
    // eslint-disable-next-line no-console
    console.error(`[deco] ${context} "${resolveType}" failed:`, error)
  },
  extend: (allBlocks) => {
    pageFacetsByPath = buildPageFacetsByPath(allBlocks)
    allPagePaths = collectAllPagePaths(allBlocks)

    // Legacy fila-store decofiles put SEO blocks under these commerce/
    // website keys — not section entries, so registered here, not via
    // file conventions. (See the original comment block for the scan
    // numbers: 328 pages SeoPLPV2, 53 SeoV2.)
    registerSeoSections([
      'commerce/sections/Seo/SeoPLPV2.tsx',
      'website/sections/Seo/SeoV2.tsx',
    ])

    registerSectionLoaders({
      /* keep the existing 'site/sections/Product/SearchResult.tsx' and
         FilaProductDetails loader bodies verbatim — move them here
         unchanged from the old ensureSetup */
    })
  },
})
```

Details that must survive the move: (1) `registerLayoutSections` call DELETED — the `layout = true` conventions from Task 9 replace it; (2) the two `jest.mock`-sensitive lazy admin imports are now inside `createNextSetup` — fila's `setup.test.ts` keeps its `jest.mock('@decocms/blocks-admin', ...)` ONLY if Task 3's fix hasn't landed in the installed tarball (it has — try deleting the mock; keep the `@generated` mocks); (3) `createSiteSetup` (inside `createNextSetup`) additionally calls `registerBuiltinMatchers()` — NEW behavior for fila (matcher-carrying decofile pages start evaluating device/date/cookie matchers instead of falling to defaults). Verify Step 3's page-diff below and mention it in the commit message.

- [ ] **Step 2: Static checks**: `bun x tsc --noEmit && bun jest src/sdk/deco/` → PASS.

- [ ] **Step 3: Behavioral diff.** Boot `bun dev`; capture `/`, `/sale`, and one PDP with `curl -s <url> | wc -c` AND spot-grep for a stable marker (title tags). Compare byte sizes to a pre-change capture (git stash the working tree, capture, pop — or accept small diffs and eyeball the HTML for missing sections). `/.decofile` → 200, `/live/_meta` → 200. Kill dev.

- [ ] **Step 4: Commit**: `git commit -m "refactor(deco): ensureSetup via createNextSetup (framework bootstrap, site logic in extend)"`

### Task 11: fila — `withDeco` + catch-all route; delete the boilerplate

**Files:**
- Modify: `~/code/faststore-fila/next.config.js`
- Create: `~/code/faststore-fila/src/app/deco/[[...deco]]/route.ts`
- Delete: `src/app/.decofile/route.ts`, `src/app/live/%5Fmeta/route.ts`, `src/app/deco/render/route.ts`, `src/app/live/previews/[[...path]]/route.ts`, `src/app/deco/invoke/[[...path]]/route.ts`, `src/sdk/deco/adminRoute.ts`

- [ ] **Step 1: next.config.js** — wrap with `withDeco` and delete the now-redundant manual `transpilePackages` trio (keep the storeConfig-derived extras):

```js
const { withDeco } = require('@decocms/nextjs/config')
// ...
module.exports = withDeco(nextConfig)
```

If the existing config exports via a compose chain, wrap at the outermost point. Delete `'@decocms/blocks'`, `'@decocms/blocks-admin'`, `'@decocms/nextjs'` from the manual `transpilePackages` array (withDeco adds them; keep the comment explaining why transpilation is needed, pointing at withDeco).

- [ ] **Step 2: The one route file** `src/app/deco/[[...deco]]/route.ts`:

```ts
// The ENTIRE Studio admin protocol: /.decofile, /live/_meta,
// /live/previews/* (all rewritten here by withDeco in next.config.js),
// plus the natively-addressable /deco/invoke/* and /deco/render.
// Replaces five hand-written route files + adminRoute.ts.
//
// Imports the /routeHandlers subpath, NOT the @decocms/nextjs root barrel:
// route handlers evaluate against React's react-server build and ignore
// "use client", so the root barrel's component graph crashes at import
// time ("createContext is not a function").
import { createDecoRouteHandlers } from '@decocms/nextjs/routeHandlers'

import { ensureSetup } from 'src/sdk/deco/setup'

export const dynamic = 'force-dynamic'

export const { GET, POST } = createDecoRouteHandlers({ setup: ensureSetup })
```

- [ ] **Step 3: Delete** the 5 old route files and `adminRoute.ts`. `grep -rn "adminRoute" src/` → zero hits.

- [ ] **Step 4: Full endpoint verification** (dev server, background + log):
  - `curl -s -o /dev/null -w "%{http_code}" localhost:3000/.decofile` → 200, response starts with `{"` and is ~2.5MB
  - `POST /.decofile` → 200 (reload)
  - `/live/_meta` → 200 with `etag`; repeat with `If-None-Match` → 304
  - `/deco/invoke/site/loaders/anything` POST → a NON-404 admin response (401/400/500 from the handler is fine — proves dispatch reached `handleInvoke`)
  - `/live/previews/<some-page-key>` → 200 HTML shell
  - `/deco/render?resolveChain=...` → 200
  - `/` and `/sale` → 200
  - log grep: zero `createContext` errors, zero unhandled rejections

- [ ] **Step 5: Full gates**: `bun jest` (only the known pre-existing `test/server/index.test.ts` failure allowed), `bun x tsc --noEmit`, `/opt/homebrew/Cellar/node/26.4.0/bin/yarn build` → PASS.

- [ ] **Step 6: Commit**: `git commit -m "refactor(deco): withDeco + single catch-all admin route, delete 5 route files + adminRoute"`

### Task 12: Release + flip fila to the published version

- [ ] **Step 1: Upstream final gate**: in `~/code/deco-start`: `bun run typecheck && bun run test` all green; `git log --oneline origin/v7..v7` shows exactly the Task 1–8 commits.

- [ ] **Step 2: Push v7**: `git push origin v7`. Monitor `gh run list --repo decocms/blocks --branch v7 --limit 1` until complete; verify `npm view @decocms/nextjs@7.4.0 version` → `7.4.0` (all 14 packages, spot-check 3).

- [ ] **Step 3: Flip fila to published packages**: in `~/code/faststore-fila`: set the four `@decocms/*` ranges to `^7.4.0` in `package.json` (`blocks`, `blocks-admin`, `nextjs` in dependencies-or-devDeps as currently placed, `blocks-cli` in devDependencies), then `bun install` (replaces the tarball extractions), `bun update @decocms/blocks @decocms/blocks-admin @decocms/blocks-cli @decocms/nextjs`, then `/opt/homebrew/Cellar/node/26.4.0/bin/yarn install`. Verify `node -e "console.log(require('./node_modules/@decocms/nextjs/package.json').version)"` → `7.4.0`.

- [ ] **Step 4: Re-run the Task 11 Step 4 endpoint verification + Step 5 gates** against the published install (this is the guard against "works from tarball, broken from registry" — the manifest.gen.ts files-field incident class).

- [ ] **Step 5: Update fila `CLAUDE.md`**: in the deco-related sections, document: entry files in `src/sections/` are the single source of truth (`generate:deco-sections` + `generate:deco-meta`), `createNextSetup` in `src/sdk/deco/setup.ts`, the single catch-all admin route + withDeco, and the route-file subpath-import rule.

- [ ] **Step 6: Commit + push fila**: single commit `"refactor(deco): adopt @decocms/nextjs 7.4.0 glue tier (withDeco, catch-all route, createNextSetup, generated registry)"` — then `git push origin feat/nextjs-package-migration`. Before pushing, `git fetch` and check for remote force-updates (this branch was force-rebased by another session once already); rebase if needed, re-run `yarn install --frozen-lockfile` as the lockfile gate.
