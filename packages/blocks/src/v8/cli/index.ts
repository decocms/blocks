/**
 * `@decocms/blocks/cli`: the `deco` commands, importable (spec: internals ›
 * How the CLI ships). Apps never import this subpath and the runtime never
 * does either, so neither the CLI nor the TypeScript compiler it loads ever
 * reaches an app bundle.
 */
export { BUILT_IN_BLOCKS, LEGACY_ALIASES } from "./builtins";
export {
  type CheckOptions,
  check,
  checkContent,
  formatProblems,
  type Problem,
} from "./check/index";
export {
  type ContentDiagnostic,
  type ContentOptions,
  content,
  readSavedBlocks,
  renderContentModule,
  type SavedBlocks,
  writeContent,
} from "./content";
export { consoleReporter, type Reporter, silentReporter } from "./log";
export { CliError, decoPaths, findDecoRoot } from "./root";
export { runCli, USAGE } from "./run";
export { type DecoMeta, generateSchema, type SchemaResult } from "./schema/generate";
export { type SchemaOptions, schema, writeSchema } from "./schema/index";
export { type RunningServer, type ServeOptions, serve, startServer } from "./serve/server";
