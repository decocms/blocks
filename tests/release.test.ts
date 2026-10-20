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

/** publishCmd's lodash-template expressions, as @semantic-release/exec reads them. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a semantic-release template, not JS
const VERSION_EXPR = "${nextRelease.version}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: a semantic-release template, not JS
const TAG_EXPR = "${nextRelease.channel ? nextRelease.channel : 'latest'}";

const BLOCKS = "@decocms/blocks";
/**
 * Each package's @decocms/blocks peer range. sync-versions.mjs leaves it as
 * written; its floor is raised by hand, per package, when the package starts
 * importing a newer blocks API (BLOCKS_API_SINCE below).
 */
const PEER: Record<string, string> = {
  tanstack: "^8.5.0",
  nextjs: "^8.5.0",
  "compat-v7": "^8.4.0",
  "apps-algolia": "^8.4.0",
  "apps-magento": "^8.4.0",
  "apps-resend": "^8.4.0",
  "apps-sfmc-personalization": "^8.4.0",
  "apps-shopify": "^8.4.0",
  "apps-vtex": "^8.4.0",
  "apps-wake": "^8.4.0",
};
/** The first @decocms/blocks release with each subpath a package may import. */
const BLOCKS_API_SINCE: Record<string, string> = {
  "@decocms/blocks/experiments": "8.6.0",
  "@decocms/blocks/metrics": "8.5.0",
};

const semver = (v: string): number[] => v.replace(/^\^/, "").split(".").map(Number);
const compare = (a: string, b: string): number => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
/** Every source file under a package's src/, tests and fixtures excluded. */
const sourcesOf = (dir: string): string[] =>
  (readdirSync(join(repo, "packages", dir, "src"), { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f))
    .filter((f) => !/(\.test\.tsx?$|(^|\/)__(tests|fixtures|conformance)__\/)/.test(f))
    .map((f) => join(repo, "packages", dir, "src", f));

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

  it("hands the real publish to scripts/publish.mjs with the version, the tag and the packages", () => {
    expect(exec.publishCmd).toContain(
      `node scripts/publish.mjs --version ${VERSION_EXPR} --tag ${TAG_EXPR} $PACKAGES`,
    );
    expect(exec.publishCmd).not.toMatch(/npm publish/);
  });
});

describe("release: dependency ranges", () => {
  it("lists a peer floor for every package but blocks", () => {
    expect(Object.keys(PEER).sort()).toEqual(published.filter((d) => d !== "blocks").sort());
  });

  it.each(
    published.filter((d) => d !== "blocks"),
  )("%s takes @decocms/blocks as a caret peer, and the workspace copy only for development", (dir) => {
    const m = readManifest(dir);
    expect(m.dependencies?.[BLOCKS]).toBeUndefined();
    expect(m.peerDependencies?.[BLOCKS]).toBe(PEER[dir]);
    expect(m.devDependencies?.[BLOCKS]).toBe("workspace:*");
  });

  it.each(
    published.filter((d) => d !== "blocks"),
  )("%s: the peer floor is at least the first blocks release with every subpath it imports", (dir) => {
    const floor = readManifest(dir).peerDependencies?.[BLOCKS] ?? "";
    for (const file of sourcesOf(dir)) {
      const code = readFileSync(file, "utf8");
      for (const [subpath, since] of Object.entries(BLOCKS_API_SINCE)) {
        if (!new RegExp(`["']${subpath}["']`).test(code)) continue;
        expect([file, subpath, compare(floor, since) >= 0]).toEqual([file, subpath, true]);
      }
    }
  });

  it("tanstack and nextjs import @decocms/blocks/metrics (the floor test sees them)", () => {
    for (const dir of ["tanstack", "nextjs"]) {
      expect(
        sourcesOf(dir).some((f) => readFileSync(f, "utf8").includes('"@decocms/blocks/metrics"')),
      ).toBe(true);
    }
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

  it("writes 8.5.0 everywhere, keeps the peer ranges and leaves no workspace: range", () => {
    const root = copyManifests();
    const r = sync(root, "8.5.0");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    for (const dir of packageDirs) {
      const m = readManifest(dir, root);
      expect(m.version).toBe("8.5.0");
      expect(JSON.stringify(m)).not.toContain("workspace:");
      if (dir !== "blocks") {
        expect(m.peerDependencies?.[BLOCKS]).toBe(PEER[dir]);
        expect(m.devDependencies?.[BLOCKS]).toBe("8.5.0");
      }
    }
  });

  it("keeps each peer floor on a later lockstep release", () => {
    const root = copyManifests();
    expect(sync(root, "8.5.1").status).toBe(0);
    for (const dir of Object.keys(PEER)) {
      expect(readManifest(dir, root).peerDependencies?.[BLOCKS]).toBe(PEER[dir]);
    }
  });

  it.each([
    "8.3.0",
    "8.3.9",
  ])("refuses %s, below every peer floor, which no blocks of that release could satisfy", (version) => {
    const root = copyManifests();
    const r = sync(root, version);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps-vtex: peer @decocms/blocks "^8.4.0"');
    expect(r.stderr).toContain('tanstack: peer @decocms/blocks "^8.5.0"');
    expect(readManifest("blocks", root).version).toBe("0.0.0");
  });

  it.each([
    "8.4.0",
    "8.4.9",
  ])("refuses %s: the bindings import @decocms/blocks/metrics, which 8.5.0 added", (version) => {
    const root = copyManifests();
    const r = sync(root, version);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('tanstack: peer @decocms/blocks "^8.5.0"');
    expect(r.stderr).toContain('nextjs: peer @decocms/blocks "^8.5.0"');
    expect(r.stderr).not.toContain("apps-vtex:");
    expect(r.stderr).not.toContain("compat-v7:");
    expect(readManifest("blocks", root).version).toBe("0.0.0");
  });

  it("refuses @decocms/blocks as a plain dependency (it would publish as an exact pin)", () => {
    const root = copyManifests();
    const path = join(root, "apps-vtex", "package.json");
    const m = readManifest("apps-vtex", root);
    m.dependencies = { [BLOCKS]: "workspace:*" };
    writeFileSync(path, JSON.stringify(m));
    const r = sync(root, "8.5.0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("apps-vtex: @decocms/blocks must be a peer dependency");
  });

  it("refuses a missing or malformed VERSION", () => {
    expect(sync(copyManifests(), "").status).toBe(1);
    expect(sync(copyManifests(), "v8.3").status).toBe(1);
  });
});

/**
 * scripts/publish.mjs against a fake `npm` first on PATH. The fake keeps its
 * registry in a folder: `npm view <spec> version` prints the version when the
 * spec is there, and `npm publish` adds the package in its cwd, unless
 * config.json says to fail it first (`fail`: a 502 from Sigstore, as
 * blocks-v8.5.0 got for @decocms/tanstack) or to fail after it landed
 * (`lost`: the response is lost). Every call goes to calls.log.
 */
describe("scripts/publish.mjs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ALL = allowlist;
  const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = process.env.FAKE_NPM_DIR;
const registryPath = path.join(state, "registry.json");
const configPath = path.join(state, "config.json");
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "publish") {
  const m = JSON.parse(fs.readFileSync("package.json", "utf8"));
  fs.appendFileSync(path.join(state, "calls.log"), "publish " + m.name + " " + args.slice(1).join(" ") + "\\n");
  const spec = m.name + "@" + m.version;
  for (const mode of ["fail", "lost"]) {
    const left = (config[mode] ?? {})[m.name] ?? 0;
    if (left > 0) {
      config[mode][m.name] = left - 1;
      fs.writeFileSync(configPath, JSON.stringify(config));
      if (mode === "lost") fs.writeFileSync(registryPath, JSON.stringify([...registry, spec]));
      process.stderr.write("npm error code CA_CREATE_SIGNING_CERTIFICATE_ERROR\\nnpm error Error creating signing certificate - (502) Bad Gateway\\n");
      process.exit(1);
    }
  }
  fs.writeFileSync(registryPath, JSON.stringify([...registry, spec]));
  process.exit(0);
}
if (args[0] === "view") {
  fs.appendFileSync(path.join(state, "calls.log"), "view " + args[1] + "\\n");
  if (registry.includes(args[1])) console.log(args[1].slice(args[1].lastIndexOf("@") + 1));
  process.exit(0);
}
process.exit(2);
`;

  type Setup = {
    version?: string;
    registry?: string[];
    fail?: Record<string, number>;
    lost?: Record<string, number>;
  };
  /** A packages folder of the 11 manifests at `version`, and the fake npm's state. */
  const setup = ({ version = "8.5.1", registry = [], fail = {}, lost = {} }: Setup = {}) => {
    const root = mkdtempSync(join(tmpdir(), "publish-"));
    dirs.push(root);
    const packages = join(root, "packages");
    for (const dir of ALL) {
      mkdirSync(join(packages, dir), { recursive: true });
      const m = readManifest(dir);
      writeFileSync(join(packages, dir, "package.json"), JSON.stringify({ name: m.name, version }));
    }
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "npm"), FAKE_NPM, { mode: 0o755 });
    const state = join(root, "state");
    mkdirSync(state);
    writeFileSync(join(state, "registry.json"), JSON.stringify(registry));
    writeFileSync(join(state, "config.json"), JSON.stringify({ fail, lost }));
    writeFileSync(join(state, "calls.log"), "");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_NPM_DIR: state,
    };
    return {
      packages,
      env,
      calls: () =>
        readFileSync(join(state, "calls.log"), "utf8").trim().split("\n").filter(Boolean),
      registry: (): string[] => JSON.parse(readFileSync(join(state, "registry.json"), "utf8")),
    };
  };
  const run = (
    s: ReturnType<typeof setup>,
    { version = "8.5.1", tag = "latest", backoff = "0,0,0", packages = ALL } = {},
  ) =>
    spawnSync(
      "node",
      [
        join(repo, "scripts", "publish.mjs"),
        "--version",
        version,
        "--tag",
        tag,
        "--backoff",
        backoff,
        "--packages-dir",
        s.packages,
        ...packages,
      ],
      { env: s.env, encoding: "utf8" },
    );
  const name = (dir: string) => readManifest(dir).name;

  it("publishes every package once, in order, with --access public and the tag", () => {
    const s = setup();
    const r = run(s);
    expect(r.status, r.stderr).toBe(0);
    expect(s.calls().filter((c) => c.startsWith("publish"))).toEqual(
      ALL.map((dir) => `publish ${name(dir)} --access public --tag latest`),
    );
    expect(s.registry()).toEqual(ALL.map((dir) => `${name(dir)}@8.5.1`));
  });

  it("passes the channel through as the dist-tag (7.x: latest-7)", () => {
    const s = setup({ version: "7.9.1" });
    const r = run(s, { version: "7.9.1", tag: "latest-7", packages: ["blocks"] });
    expect(r.status, r.stderr).toBe(0);
    expect(s.calls()).toContain("publish @decocms/blocks --access public --tag latest-7");
  });

  it("retries a transient failure (Sigstore 502) and publishes on the next attempt", () => {
    const s = setup({ fail: { "@decocms/tanstack": 1 } });
    const r = run(s);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("CA_CREATE_SIGNING_CERTIFICATE_ERROR");
    expect(r.stdout).toContain("@decocms/tanstack@8.5.1 failed; retrying");
    expect(r.stdout).not.toContain("::error::");
    expect(s.calls().filter((c) => c.includes("@decocms/tanstack"))).toEqual([
      "view @decocms/tanstack@8.5.1",
      "publish @decocms/tanstack --access public --tag latest",
      "view @decocms/tanstack@8.5.1",
      "publish @decocms/tanstack --access public --tag latest",
    ]);
    expect(s.registry()).toHaveLength(ALL.length);
  });

  it("waits longer before each retry", () => {
    const s = setup({ fail: { "@decocms/tanstack": 3 } });
    const r = run(s, { backoff: "0.01,0.02,0.04", packages: ["tanstack"] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.match(/retrying in [\d.]+s/g)).toEqual([
      "retrying in 0.01s",
      "retrying in 0.02s",
      "retrying in 0.04s",
    ]);
  });

  it("skips what is already on npm, so a re-run publishes only the missing package", () => {
    const already = ALL.filter((dir) => dir !== "tanstack").map((dir) => `${name(dir)}@8.5.1`);
    const s = setup({ registry: already });
    const r = run(s);
    expect(r.status, r.stderr).toBe(0);
    expect(s.calls().filter((c) => c.startsWith("publish"))).toEqual([
      "publish @decocms/tanstack --access public --tag latest",
    ]);
    expect(r.stdout).toContain("@decocms/blocks@8.5.1 is already on npm, skipping");
  });

  it("does not retry when a failed publish landed anyway (lost response)", () => {
    const s = setup({ lost: { "@decocms/nextjs": 1 } });
    const r = run(s);
    expect(r.status, r.stderr).toBe(0);
    expect(s.calls().filter((c) => c.startsWith("publish @decocms/nextjs"))).toHaveLength(1);
    expect(r.stdout).toContain("@decocms/nextjs@8.5.1 is on npm although npm publish failed");
  });

  it("gives up after 4 attempts, reports the package, publishes the rest and exits 1", () => {
    const s = setup({ fail: { "@decocms/tanstack": 99 } });
    const r = run(s);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::npm publish failed for packages/tanstack");
    expect(r.stdout.match(/::error::/g)).toHaveLength(1);
    expect(s.calls().filter((c) => c.startsWith("publish @decocms/tanstack"))).toHaveLength(4);
    expect(s.registry()).toEqual(
      ALL.filter((dir) => dir !== "tanstack").map((dir) => `${name(dir)}@8.5.1`),
    );
  });

  it("refuses a package whose manifest is not at --version, and publishes the rest", () => {
    const s = setup();
    writeFileSync(
      join(s.packages, "apps-wake", "package.json"),
      JSON.stringify({ name: "@decocms/apps-wake", version: "8.5.0" }),
    );
    const r = run(s);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::packages/apps-wake is at 8.5.0, not 8.5.1");
    expect(s.registry()).not.toContain("@decocms/apps-wake@8.5.1");
    expect(s.registry()).toHaveLength(ALL.length - 1);
  });

  it("refuses to run without a version, a tag or packages", () => {
    const s = setup();
    const node = (args: string[]) =>
      spawnSync("node", [join(repo, "scripts", "publish.mjs"), ...args], {
        env: s.env,
        encoding: "utf8",
      }).status;
    expect(node(["--tag", "latest", "blocks"])).toBe(1);
    expect(node(["--version", "8.5.1", "blocks"])).toBe(1);
    expect(node(["--version", "8.5.1", "--tag", "latest"])).toBe(1);
    expect(s.calls()).toEqual([]);
  });

  /** publishCmd as @semantic-release/exec renders it (lodash template) for `version`. */
  const render = (version: string) =>
    exec.publishCmd.replaceAll(VERSION_EXPR, version).replaceAll(TAG_EXPR, "latest");

  it("publishCmd runs it from the repo root for the whole allowlist", () => {
    // The workspace manifests are at 0.0.0 until sync-versions.mjs runs.
    const s = setup({ version: "0.0.0" });
    const r = spawnSync("sh", ["-c", render("0.0.0")], {
      cwd: repo,
      env: { ...s.env, DRY_RUN: "false" },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(s.calls().filter((c) => c.startsWith("publish"))).toEqual(
      ALL.map((dir) => `publish ${name(dir)} --access public --tag latest`),
    );
  });

  it("publishCmd publishes nothing on a dry run", () => {
    const s = setup();
    const r = spawnSync("sh", ["-c", render("8.5.1")], {
      cwd: repo,
      env: { ...s.env, DRY_RUN: "true" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[dry-run] would publish version 8.5.1 for: blocks tanstack");
    expect(s.calls()).toEqual([]);
  });
});
