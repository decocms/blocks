import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectTargetSnapshot,
  isSkipped,
  parseNameStatus,
  type ReconcileManifest,
  targetCandidates,
} from "./reconcile";

describe("parseNameStatus", () => {
  it("splits plain and rename entries", () => {
    expect(parseNameStatus("M\tsections/A.tsx\nR094\tislands/B.tsx\tislands/C.tsx\n"))
      .toEqual([
        { status: "M", path: "sections/A.tsx" },
        { status: "R094", path: "islands/C.tsx", oldPath: "islands/B.tsx" },
      ]);
  });
});

describe("isSkipped", () => {
  it("drops CMS content, lockfiles and binaries but keeps source", () => {
    expect(isSkipped(".deco/blocks/pages-home.json")).toBe(true);
    expect(isSkipped("deno.lock")).toBe(true);
    expect(isSkipped("static/logo.png")).toBe(true);
    expect(isSkipped("sections/Header.tsx")).toBe(false);
  });
});

describe("targetCandidates", () => {
  it("ranks the conventional guess first, keeps other basename matches", () => {
    const byBasename = new Map([
      ["Cart.tsx", ["src/sections/Cart.tsx", "src/components/Cart.tsx"]],
    ]);
    expect(targetCandidates("islands/Cart.tsx", byBasename)).toEqual([
      "src/components/Cart.tsx",
      "src/sections/Cart.tsx",
    ]);
  });

  it("returns nothing when the file does not exist on the target", () => {
    expect(targetCandidates("sections/New.tsx", new Map())).toEqual([]);
  });
});

describe("detectTargetSnapshot", () => {
  it("takes the OLDEST add — git log is newest-first, re-adds must not win", () => {
    expect(detectTargetSnapshot("bbb\naaa\n")).toBe("aaa");
    expect(detectTargetSnapshot("")).toBeUndefined();
  });
});

describe("reconcile end to end", () => {
  let tmp: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

  const write = (repo: string, rel: string, body: string) => {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  const commit = (repo: string, msg: string) => {
    git(repo, "add", "-A");
    git(repo, "commit", "-m", msg);
    return git(repo, "rev-parse", "HEAD");
  };
  const init = (name: string) => {
    const repo = path.join(tmp, name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    return repo;
  };

  beforeEach(() => {
    // realpath: macOS /var → /private/var, which git resolves and we compare against.
    tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "reconcile-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("auto-detects the target snapshot, emits one patch per file, flags hand-fixes", () => {
    const source = init("source");
    write(source, "sections/Header.tsx", "export default () => <h1>a</h1>;\n");
    write(source, "sections/Footer.tsx", "export default () => <footer/>;\n");
    write(source, "deno.lock", "{}\n");
    const snapshot = commit(source, "cut");

    write(source, "sections/Header.tsx", "export default () => <h1>b</h1>;\n");
    write(source, "sections/Footer.tsx", "export default () => <footer id='f'/>;\n");
    write(source, "deno.lock", '{"v":2}\n');
    const sourceHead = commit(source, "upstream work");

    const target = init("target");
    write(target, "src/sections/Header.tsx", "export default () => <h1>a</h1>;\n");
    write(target, "src/sections/Footer.tsx", "export default () => <footer/>;\n");
    // The marker deco-migrate leaves behind — this is what auto-detection finds.
    write(target, "MIGRATION_REPORT.md", "# Migration\n");
    const targetSnapshot = commit(target, "migrate to tanstack");

    // A hand-fix on the target, after the migration commit → collision.
    write(target, "src/sections/Header.tsx", "export default () => <h1>a fixed</h1>;\n");
    commit(target, "fix: codemod ate the heading");

    const out = path.join(tmp, "out");
    execFileSync(
      path.join(__dirname, "../../../node_modules/.bin/tsx"),
      [
        path.join(__dirname, "reconcile.ts"),
        "--source", source,
        "--target", target,
        "--snapshot", snapshot,
        // no --target-snapshot: exercise the MIGRATION_REPORT.md auto-detection
        "--out", out,
      ],
      { encoding: "utf8" },
    );

    const manifest: ReconcileManifest = JSON.parse(
      fs.readFileSync(path.join(out, "manifest.json"), "utf8"),
    );

    expect(manifest.sourceHead).toBe(sourceHead);
    expect(manifest.targetSnapshot).toBe(targetSnapshot);
    // deno.lock filtered out.
    expect(manifest.files.map((f) => f.sourcePath).sort()).toEqual([
      "sections/Footer.tsx",
      "sections/Header.tsx",
    ]);

    const header = manifest.files.find((f) => f.sourcePath === "sections/Header.tsx")!;
    expect(header.targetCandidates).toEqual(["src/sections/Header.tsx"]);
    expect(header.collision).toHaveLength(1);
    expect(header.collision[0]).toContain("codemod ate the heading");
    expect(fs.readFileSync(path.join(out, header.patch), "utf8")).toContain("<h1>b</h1>");

    const footer = manifest.files.find((f) => f.sourcePath === "sections/Footer.tsx")!;
    expect(footer.collision).toEqual([]);
    expect(footer.done).toBe(false);

    expect(fs.readFileSync(path.join(out, "INDEX.md"), "utf8")).toContain(sourceHead);
  });
});
