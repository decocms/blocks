/**
 * Test helpers: real git repositories for the filesystem storage's base,
 * isolated from the machine's git configuration.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ISOLATED_ENV = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
    delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
})();

/** Runs git in `dir` and returns its trimmed stdout. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: ISOLATED_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Makes `dir` a git repository on branch `main`; with `commit` (the default),
 * commits everything in it, so the files there are the base.
 */
export function gitInit(dir: string, { commit = true }: { commit?: boolean } = {}): void {
  git(dir, "init", "-q", "-b", "main");
  if (commit) gitCommitAll(dir);
}

/** Commits everything in the work tree (an empty commit when there's nothing). */
export function gitCommitAll(dir: string, message = "test"): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "--no-verify", "-m", message);
}

/**
 * Makes sure `dir` is inside a git work tree, as `deco serve` requires:
 * when it isn't, the nearest folder at or above `dir` that holds `.deco`
 * (else `dir`) becomes a repository with everything committed.
 */
export function ensureGitWorkTree(dir: string): void {
  try {
    if (git(dir, "rev-parse", "--is-inside-work-tree") === "true") return;
  } catch {
    // Not a repository.
  }
  let root = dir;
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".deco"))) {
      root = d;
      break;
    }
    if (dirname(d) === d) break;
  }
  gitInit(root);
}
