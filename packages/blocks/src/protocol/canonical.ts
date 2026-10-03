/**
 * Canonical JSON and content hashing. The implementation is a dependency-free
 * leaf module of the SDK (`src/v8/canonical.ts`), because the runtime checks
 * content revisions too; the protocol re-exports it so the CLI, the server
 * and the site editor share one definition.
 */
export * from "../v8/canonical";
