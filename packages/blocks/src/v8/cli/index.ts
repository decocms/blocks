/**
 * `@decocms/blocks/cli`: the `deco` commands, importable (spec: internals ›
 * How the CLI ships). Apps never import this subpath and the runtime never
 * does either, so neither the CLI nor the TypeScript compiler it loads ever
 * reaches an app bundle.
 *
 * The four commands and their options, plus what the one-time migration
 * (`@decocms/blocks-migrate`) reads: the built-in block names, the alias
 * table and the saved-blocks reader.
 */
export { BUILT_IN_BLOCKS, LEGACY_ALIASES } from "./builtins";
export { type CheckOptions, check } from "./check/index";
export { type ContentOptions, content, readSavedBlocks, type SavedBlocks } from "./content";
export { type Reporter, silentReporter } from "./log";
export { runCli } from "./run";
export { type SchemaOptions, schema } from "./schema/index";
export { type ServeOptions, serve } from "./serve/server";
