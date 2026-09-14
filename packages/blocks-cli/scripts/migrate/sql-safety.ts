/**
 * Helpers for safely embedding untrusted values into SQL sent to the decocms
 * Supabase Management API.
 *
 * The `/database/query` REST endpoint runs raw SQL — it has no bound-parameter
 * facility — so any value spliced into a query string must be both validated
 * and quote-escaped by us. The migrator reads `package.json` `name` from the
 * (untrusted) repo being migrated and used to interpolate it straight into a
 * single-quoted SQL literal, which allowed quote-breakout SQL injection against
 * the central `public.sites` table.
 */

// npm package-name grammar: optional `@scope/`, then the name. Lowercase only,
// limited to [a-z0-9-._~]. Crucially forbids `'`, `;`, spaces, backslashes and
// newlines — i.e. everything needed for SQL breakout.
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** True iff `name` is a syntactically valid npm package name. */
export function isValidNpmPackageName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 214 &&
    NPM_PACKAGE_NAME.test(name)
  );
}

/**
 * Escape a value for inclusion inside a single-quoted SQL string literal by
 * doubling embedded single quotes (SQL-standard escaping). Defense-in-depth on
 * top of {@link isValidNpmPackageName} — also covers the manual `printAnalyticsSQL`
 * output path.
 */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
