import fs from "node:fs";
import path from "node:path";

/** Exit codes (spec: cli › Exit codes). */
export const EXIT = {
  ok: 0,
  /** `deco check` found problems, or any other failure not below. */
  failed: 1,
  conflict: 2,
  auth: 3,
  network: 4,
  /** A save answered Unavailable, or a publish ran out of attempts: run again. */
  busy: 5,
  usage: 64,
} as const;

export interface CliErrorOptions {
  /** The exit code (default 1). */
  exitCode?: number;
  /** A snake_case code for `--json` (default `failed`). */
  code?: string;
  /** Extra fields for the `--json` envelope. */
  details?: Record<string, unknown>;
}

/** An error the CLI prints as a single line, without a stack trace. */
export class CliError extends Error {
  override name = "CliError";
  readonly exitCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message);
    this.exitCode = options.exitCode ?? EXIT.failed;
    this.code = options.code ?? (this.exitCode === EXIT.usage ? "usage" : "failed");
    this.details = options.details;
  }
}

/** A usage error (exit 64). */
export function usageError(message: string): CliError {
  return new CliError(message, { exitCode: EXIT.usage, code: "usage" });
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folder that contains `.deco/` (spec: cli › Finding the .deco folder).
 *
 * With `--root`, that folder, relative to `cwd`; it must contain `.deco/`.
 * Without it, walk up from `cwd` to the first folder with a `.deco/`.
 */
export function findDecoRoot(options: { root?: string; cwd?: string } = {}): string {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (options.root !== undefined) {
    const root = path.resolve(cwd, options.root);
    if (!isDirectory(path.join(root, ".deco"))) {
      throw new CliError(`no .deco/ in ${root}; pass the folder that contains .deco/ as --root`);
    }
    return root;
  }
  let dir = cwd;
  for (;;) {
    if (isDirectory(path.join(dir, ".deco"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError(`no .deco/ found from ${cwd}; run inside your app or pass --root`);
}

/** The paths of the files every command reads or writes, inside one root. */
export function decoPaths(root: string) {
  const deco = path.join(root, ".deco");
  return {
    root,
    deco,
    blocks: path.join(deco, "blocks"),
    schema: path.join(deco, "schema.gen.json"),
    legacySchema: path.join(deco, "meta.gen.json"),
    /** The content module, `.deco/blocks.gen.ts`, for content without a site. */
    content: path.join(deco, "blocks.gen.ts"),
    /** What `deco pull` wrote, git-ignored: the base of `deco diff` and `deco push`. */
    pull: path.join(deco, "pull.json"),
    blockMapCandidates: [path.join(deco, "index.ts"), path.join(deco, "index.tsx")],
  };
}

export type DecoPaths = ReturnType<typeof decoPaths>;

/** This package's version, for `deco-meta@1` and `describe`. */
export function packageVersion(): string {
  try {
    const manifest = new URL("../../../package.json", import.meta.url);
    return JSON.parse(fs.readFileSync(manifest, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
