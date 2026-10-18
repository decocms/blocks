// @vitest-environment node
/**
 * Release mechanics: every published package releases in lockstep at one
 * version (.releaserc.json's publish allowlist, scripts/sync-versions.mjs),
 * and every package that builds on @decocms/blocks takes it as a caret peer
 * range, so a site installs one blocks copy and a blocks patch release never
 * adds a second one next to an app or a binding.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "packages", "blocks"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate repo root (packages/blocks not found above cwd)");
}
const repo = findRepoRoot();

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const readManifest = (dir: string, root = join(repo, "packages")): Manifest =>
  JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
const packageDirs = readdirSync(join(repo, "packages")).filter((d) =>
  existsSync(join(repo, "packages", d, "package.json")),
);
const published = packageDirs.filter((d) => !readManifest(d).private);

const releaserc = JSON.parse(readFileSync(join(repo, ".releaserc.json"), "utf8"));
const exec = releaserc.plugins.find(
  (p: unknown) => Array.isArray(p) && p[0] === "@semantic-release/exec",
)[1] as { prepareCmd: string; publishCmd: string };
const allowlist = /PACKAGES=\\?"([^"\\]+)\\?"/.exec(exec.publishCmd)?.[1].split(" ") ?? [];

const BLOCKS = "@decocms/blocks";
const PEER = "^8.4.0";

describe("release: lockstep", () => {
  it("publishes every package in packages/, blocks first, then the bindings", () => {
    expect([...allowlist].sort()).toEqual([...published].sort());
    expect(allowlist.slice(0, 3)).toEqual(["blocks", "tanstack", "nextjs"]);
  });

  it("syncs the one release version before the build", () => {
    expect(exec.prepareCmd).toMatch(
      /^VERSION=\$\{nextRelease\.version\} node scripts\/sync-versions\.mjs && bun run build$/,
    );
  });

  it("main publishes to latest; 7.x keeps its own channel (latest-7)", () => {
    expect(releaserc.branches).toContainEqual({ name: "7.x", range: "7.x", channel: "latest-7" });
    expect(releaserc.branches).toContain("main");
    expect(exec.publishCmd).toMatch(
      /--tag \$\{nextRelease\.channel \? nextRelease\.channel : 'latest'\}/,
    );
    expect(exec.publishCmd).toMatch(/if \[ \\?"\$DRY_RUN\\?" = \\?"true\\?" \]/);
  });
});

describe("release: dependency ranges", () => {
  it.each(
    published.filter((d) => d !== "blocks"),
  )("%s takes @decocms/blocks as a peer, ^8.4.0, and the workspace copy only for development", (dir) => {
    const m = readManifest(dir);
    expect(m.dependencies?.[BLOCKS]).toBeUndefined();
    expect(m.peerDependencies?.[BLOCKS]).toBe(PEER);
    expect(m.devDependencies?.[BLOCKS]).toBe("workspace:*");
  });

  it("no manifest pins a workspace package in dependencies or peerDependencies", () => {
    for (const dir of packageDirs) {
      const m = readManifest(dir);
      for (const range of Object.values({ ...m.dependencies, ...m.peerDependencies })) {
        expect([dir, range.startsWith("workspace:")]).toEqual([dir, false]);
      }
    }
  });
});

type Leaf = { types?: string; source?: string; default?: string; sharedTypes?: true };
/**
 * Each export target object, through the conditional branches (`node`,
 * `workerd`, `default`). A branch without its own `types` takes the one its
 * parent declares for all of them (`@decocms/tanstack/scope`), listed first.
 */
const leaves = (value: unknown, types?: string): Leaf[] => {
  if (typeof value !== "object" || value === null) return [];
  const target = value as Leaf;
  if (typeof target.default === "string") {
    return [
      target.types === undefined && types !== undefined
        ? { types, ...target, sharedTypes: true }
        : target,
    ];
  }
  return Object.entries(value)
    .filter(([key]) => key !== "types")
    .flatMap(([, branch]) => leaves(branch, target.types ?? types));
};
const exportsOf = (dir: string): [string, Leaf][] =>
  Object.entries((readManifest(dir) as Manifest & { exports: object }).exports).flatMap(
    ([subpath, target]) => leaves(target).map((leaf): [string, Leaf] => [subpath, leaf]),
  );

/** The paths `npm pack` would put in the package's tarball (no build: `--ignore-scripts`). */
function packedFiles(dir: string): Set<string> {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: join(repo, "packages", dir),
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  const out = JSON.parse(r.stdout);
  // npm 10 prints an array, npm 11+ an object keyed by the package name.
  const entry = Array.isArray(out) ? out[0] : Object.values(out)[0];
  return new Set((entry as { files: { path: string }[] }).files.map((f) => f.path));
}

// Every subpath of every published package, including the platform helpers
// the clients ship next to their root (`@decocms/apps-vtex/image`,
// `@decocms/apps-shopify/image`): CI imports each built target with plain
// Node (ci.yml), and these check what npm would ship for it.
describe("release: what each tarball ships", () => {
  it.each(
    published,
  )("%s: every export is types + source + default, or plain JS shipped from src", (dir) => {
    const subpaths = exportsOf(dir);
    expect(subpaths.length).toBeGreaterThan(0);
    for (const [subpath, leaf] of subpaths) {
      const where = `${dir} ${subpath}`;
      if (leaf.source === undefined) {
        // `@decocms/nextjs/config`: CommonJS that next.config.js requires as is.
        expect(Object.keys(leaf), where).toEqual(["types", "default"]);
        expect(leaf.types, where).toMatch(/^\.\/src\/.+\.d\.c?ts$/);
        expect(leaf.default, where).toMatch(/^\.\/src\/.+\.c?js$/);
        continue;
      }
      expect(
        Object.keys(leaf).filter((k) => k !== "sharedTypes"),
        where,
      ).toEqual(["types", "source", "default"]);
      const base = leaf.source.replace(/^\.\/src\//, "").replace(/\.tsx?$/, "");
      expect(leaf.source, where).toMatch(/^\.\/src\/.+\.tsx?$/);
      if (leaf.sharedTypes) expect(leaf.types, where).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      else expect(leaf.types, where).toBe(`./dist/${base}.d.ts`);
      expect(leaf.default, where).toBe(`./dist/${base}.js`);
    }
  });

  it.each(published)("%s: the tarball holds every export's files and no test or fixture", (dir) => {
    const files = packedFiles(dir);
    const missing = exportsOf(dir).flatMap(([, leaf]) =>
      [leaf.types, leaf.source, leaf.default]
        .filter((path): path is string => path !== undefined)
        .map((path) => path.replace(/^\.\//, ""))
        .filter((path) => !files.has(path)),
    );
    // dist/ comes from `bun run build` (`bun install` runs it); release runs it before publishing.
    expect(missing, "missing from the tarball (is dist/ built?)").toEqual([]);
    expect(
      [...files].filter((path) =>
        /(\.test\.tsx?$|(^|\/)__(tests|fixtures|conformance)__\/)/.test(path),
      ),
    ).toEqual([]);
    expect(files.has("package.json")).toBe(true);
  }, 30_000);
});

describe("scripts/sync-versions.mjs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const copyManifests = (): string => {
    const root = mkdtempSync(join(tmpdir(), "sync-versions-"));
    dirs.push(root);
    for (const dir of packageDirs) {
      mkdirSync(join(root, dir));
      cpSync(join(repo, "packages", dir, "package.json"), join(root, dir, "package.json"));
    }
    return root;
  };
  const sync = (root: string, version: string) =>
    spawnSync("node", [join(repo, "scripts", "sync-versions.mjs")], {
      env: { ...process.env, VERSION: version, PACKAGES_DIR: root },
      encoding: "utf8",
    });

  it("writes 8.4.0 everywhere, keeps the peer ranges and leaves no workspace: range", () => {
    const root = copyManifests();
    const r = sync(root, "8.4.0");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    for (const dir of packageDirs) {
      const m = readManifest(dir, root);
      expect(m.version).toBe("8.4.0");
      expect(JSON.stringify(m)).not.toContain("workspace:");
      if (dir !== "blocks") {
        expect(m.peerDependencies?.[BLOCKS]).toBe(PEER);
        expect(m.devDependencies?.[BLOCKS]).toBe("8.4.0");
      }
    }
  });

  it("keeps the peer floor on a later lockstep release", () => {
    const root = copyManifests();
    expect(sync(root, "8.5.1").status).toBe(0);
    expect(readManifest("tanstack", root).peerDependencies?.[BLOCKS]).toBe(PEER);
  });

  it.each([
    "8.3.0",
    "8.3.9",
  ])("refuses %s, below the peer floor, which no blocks of that release could satisfy", (version) => {
    const root = copyManifests();
    const r = sync(root, version);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('peer @decocms/blocks "^8.4.0"');
    expect(readManifest("blocks", root).version).toBe("0.0.0");
  });

  it("refuses @decocms/blocks as a plain dependency (it would publish as an exact pin)", () => {
    const root = copyManifests();
    const path = join(root, "apps-vtex", "package.json");
    const m = readManifest("apps-vtex", root);
    m.dependencies = { [BLOCKS]: "workspace:*" };
    writeFileSync(path, JSON.stringify(m));
    const r = sync(root, "8.4.0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("apps-vtex: @decocms/blocks must be a peer dependency");
  });

  it("refuses a missing or malformed VERSION", () => {
    expect(sync(copyManifests(), "").status).toBe(1);
    expect(sync(copyManifests(), "v8.3").status).toBe(1);
  });
});
