/**
 * @decocms/eitri — programmatic entry.
 *
 * Deco does not render Eitri apps (Eitri renders natively on its mobile
 * runtime); this package only *produces* a well-filled `.deco` so Studio can
 * author content. It is a thin, Eitri-flavored wrapper over
 * `@decocms/blocks-cli`'s `generate` orchestrator: `--platform eitri` selects
 * the schema + blocks generators only and emits a SELF-CONTAINED
 * `meta.gen.json` (Page, matchers, Resolvable baked in via composeMeta), plus
 * the bundled `blocks.gen.json` snapshot the Eitri runtime consumes.
 *
 * The CLI (`deco-eitri`) is the usual entry; this function is for scripting.
 */
import { runGenerate } from "@decocms/blocks-cli/generate";

export interface GenerateEitriOptions {
  /** App folder to generate for (input dirs + `.deco/` resolve against it). */
  root?: string;
  /** Site name written into the schema (default: blocks-cli's default). */
  site?: string;
  /** Section namespace (default: "site"). */
  namespace?: string;
  /** Ignore the incremental cache and regenerate. */
  force?: boolean;
  /** Extra raw flags forwarded verbatim to the orchestrator. */
  extraArgs?: string[];
}

/** Build the orchestrator argv for an Eitri generation run. */
export function eitriGenerateArgs(opts: GenerateEitriOptions = {}): string[] {
  const args = ["--platform", "eitri"];
  if (opts.root) args.push("--root", opts.root);
  if (opts.site) args.push("--site", opts.site);
  if (opts.namespace) args.push("--namespace", opts.namespace);
  if (opts.force) args.push("--force");
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

/**
 * Generate the `.deco` for an Eitri app. Resolves to the process exit code
 * (0 = success), mirroring the CLI.
 */
export function generateEitri(opts: GenerateEitriOptions = {}): Promise<number> {
  return runGenerate(eitriGenerateArgs(opts));
}

export { runEitriInit } from "./init";
export type { EitriInitOptions, EitriInitResult } from "./init";
