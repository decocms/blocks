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
const PEER = "^8.3.0";

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
  )("%s takes @decocms/blocks as a peer, ^8.3.0, and the workspace copy only for development", (dir) => {
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

  it("writes 8.3.0 everywhere, keeps the peer ranges and leaves no workspace: range", () => {
    const root = copyManifests();
    const r = sync(root, "8.3.0");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    for (const dir of packageDirs) {
      const m = readManifest(dir, root);
      expect(m.version).toBe("8.3.0");
      expect(JSON.stringify(m)).not.toContain("workspace:");
      if (dir !== "blocks") {
        expect(m.peerDependencies?.[BLOCKS]).toBe(PEER);
        expect(m.devDependencies?.[BLOCKS]).toBe("8.3.0");
      }
    }
  });

  it("keeps the peer floor on a later lockstep release", () => {
    const root = copyManifests();
    expect(sync(root, "8.4.1").status).toBe(0);
    expect(readManifest("tanstack", root).peerDependencies?.[BLOCKS]).toBe(PEER);
  });

  it("refuses a release below a peer floor, which no blocks of that release could satisfy", () => {
    const root = copyManifests();
    const r = sync(root, "8.2.4");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('peer @decocms/blocks "^8.3.0"');
    expect(readManifest("blocks", root).version).toBe("0.0.0");
  });

  it("refuses @decocms/blocks as a plain dependency (it would publish as an exact pin)", () => {
    const root = copyManifests();
    const path = join(root, "apps-vtex", "package.json");
    const m = readManifest("apps-vtex", root);
    m.dependencies = { [BLOCKS]: "workspace:*" };
    writeFileSync(path, JSON.stringify(m));
    const r = sync(root, "8.3.0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("apps-vtex: @decocms/blocks must be a peer dependency");
  });

  it("refuses a missing or malformed VERSION", () => {
    expect(sync(copyManifests(), "").status).toBe(1);
    expect(sync(copyManifests(), "v8.3").status).toBe(1);
  });
});
