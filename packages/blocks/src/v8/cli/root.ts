import fs from "node:fs";
import path from "node:path";

/** An error the CLI prints as a single line, without a stack trace. */
export class CliError extends Error {
  override name = "CliError";
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
    content: path.join(deco, "blocks.gen.ts"),
    blockMapCandidates: [path.join(deco, "index.ts"), path.join(deco, "index.tsx")],
  };
}

export type DecoPaths = ReturnType<typeof decoPaths>;
