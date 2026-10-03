/**
 * `@decocms/blocks-migrate`: one-time migration of a v7 site to the next
 * major (see /next/renames-and-migrations). A dev dependency: nothing here
 * runs in an app. The `blocks-migrate` bin runs `migrate` and prints the report.
 */
export { type MigrateOptions, migrate } from "./migrate";
export { formatReport, type Note, type Report, type Step } from "./report";
