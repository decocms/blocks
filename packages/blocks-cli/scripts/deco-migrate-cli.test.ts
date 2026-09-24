import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCloneArgs, buildRsyncArgs } from "./deco-migrate-cli";

// Regression guard for the git-clone / rsync command-injection fix.
// Untrusted input (repo URL, --branch value, local source path) used to be
// glued into a shell string handed to `execSync` (`/bin/sh -c`), so a value
// like `main; touch pwned` or `$(touch pwned)` executed as a second command.
// The fix passes every value as a discrete argv element via `spawnSync` with
// no shell, making metacharacters inert.

describe("buildCloneArgs", () => {
  it("keeps a malicious branch as ONE literal argv element (not split)", () => {
    const args = buildCloneArgs("https://github.com/org/site", "dest", "main; touch pwned");
    // The whole injection string is a single element, immediately after --branch.
    expect(args).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "main; touch pwned",
      "https://github.com/org/site",
      "dest",
    ]);
    // No element was fractured on `;` or whitespace.
    expect(args.some((a) => a === "touch" || a === "pwned")).toBe(false);
  });

  it("keeps a command-substitution URL as one literal argv element", () => {
    const args = buildCloneArgs("https://github.com/org/$(touch pwned)", "dest", null);
    expect(args).toContain("https://github.com/org/$(touch pwned)");
    expect(args).not.toContain("--branch");
  });
});

describe("buildRsyncArgs", () => {
  it("keeps a malicious source path as one literal argv element", () => {
    const args = buildRsyncArgs("/tmp/$(touch pwned)", "dest");
    expect(args).toContain("/tmp/$(touch pwned)/");
    expect(args).toContain("dest/");
  });
});

describe("git clone runs without a shell (end-to-end injection is inert)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "deco-migrate-injtest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT execute an injected command in the --branch value", () => {
    const markerName = "pwned.txt";
    const marker = path.join(dir, markerName);
    // A non-existent local source so the clone fails fast; the point is the
    // injected `touch` in the branch must NEVER run.
    const args = buildCloneArgs(
      path.join(dir, "no-such-repo"),
      path.join(dir, "out"),
      `main; touch ${markerName}`,
    );
    const result = spawnSync("git", args, { cwd: dir, shell: false, encoding: "utf8" });

    expect(result.status).not.toBe(0); // clone failed, as expected
    expect(existsSync(marker)).toBe(false); // injected command did NOT run
  });

  it("does NOT execute a command-substitution injection in the source URL", () => {
    const markerName = "pwned2.txt";
    const marker = path.join(dir, markerName);
    const args = buildCloneArgs(`file:///$(touch ${markerName})`, path.join(dir, "out2"), null);
    const result = spawnSync("git", args, { cwd: dir, shell: false, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
