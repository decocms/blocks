/**
 * `@decocms/blocks/cli`: the `deco` commands, importable (spec: internals ›
 * How the CLI ships). Apps never import this subpath and the runtime never
 * does either, so neither the CLI nor the TypeScript compiler it loads ever
 * reaches an app bundle.
 *
 * The four commands and their options, plus what the one-time migration
 * (the `deco-v7-to-v8-migration` skill) reads: the built-in block names, the alias
 * table and the saved-blocks reader.
 */
export { BUILT_IN_BLOCKS, LEGACY_ALIASES } from "./builtins.ts";
export { type CheckOptions, check } from "./check/index.ts";
export { type ContentOptions, content, readSavedBlocks, type SavedBlocks } from "./content.ts";
export { type Reporter, silentReporter } from "./log.ts";
export { runCli } from "./run.ts";
export { type SchemaOptions, schema } from "./schema/index.ts";
export { type ServeOptions, serve } from "./serve/server.ts";
