/**
 * Single source of truth for which invoke actions must NOT be publicly
 * exposed — consulted by BOTH exposure machines so they can never drift:
 *
 *  1. Build-time `_serverFn` generation (`scripts/generate-invoke.ts` and the
 *     migration scaffold `scripts/migrate/templates/server-entry.ts`) — a
 *     denied action's `createServerFn` const is never emitted, so the TanStack
 *     compiler never mints a `POST /_serverFn/<hash>` route for it.
 *
 *  2. Runtime manifest registration (`src/sdk/setupApps.ts`) — a denied action
 *     is never written into the invoke handler registry, so
 *     `POST /deco/invoke/<key>` returns 404 for it.
 *
 * The two machines run at different times (build vs. request) and share no
 * registry, but they share THIS list — closing one door without the other
 * leaves the action reachable through the other, so both import from here.
 *
 * Why these five: the generic VTEX MasterData v2 CRUD actions
 * (`@decocms/apps/vtex/actions/masterData`) run with the store's admin
 * appKey/appToken and take a caller-controlled `entity` + `_where` filter.
 * Exposed unauthenticated they permit dumping/tampering any MasterData entity
 * (e.g. `CL` customer PII). They have no legitimate client-callable use — a
 * site that needs to write one specific entity should ship a narrow,
 * server-side wrapper action instead of exposing the generic CRUD surface.
 *
 * Default-deny: these are blocked out of the box, so upgrading @decocms/start
 * protects every site with no per-site action. A site that genuinely needs one
 * can re-allow it explicitly (see `allow` in InvokePolicyOptions).
 */

/** Bare function names of the always-denied generic MasterData CRUD actions. */
export const DEFAULT_INTERNAL_ACTIONS: ReadonlySet<string> = new Set([
  "searchDocuments",
  "createDocument",
  "patchDocument",
  "getDocument",
  "uploadAttachment",
]);

export interface InvokePolicyOptions {
  /**
   * Extra action keys to deny, beyond the built-in defaults. Matched the same
   * way as the defaults (bare last segment OR full key). Sites pass this to
   * lock down additional sensitive actions.
   */
  deny?: Iterable<string>;
  /**
   * Escape hatch — bare function names to RE-ALLOW despite the default denylist.
   * Use only when a site has a real, audited need to expose one of the generic
   * CRUD actions to the client. Prefer a purpose-built wrapper action instead.
   */
  allow?: Iterable<string>;
}

/**
 * Reduce an invoke key to the bare function name used for matching.
 * Handles both key shapes the two machines produce:
 *   "searchDocuments"                          → "searchDocuments"  (invoke.gen.ts)
 *   "vtex/actions/masterData/searchDocuments"  → "searchDocuments"  (setupApps)
 *   "...searchDocuments.ts"                    → "searchDocuments"  (.ts aliases)
 */
function lastSegment(key: string): string {
  const noExt = key.replace(/\.ts$/, "");
  return noExt.split("/").pop() ?? noExt;
}

/**
 * True if `key` must not be publicly exposed under the given policy.
 *
 * Precedence: an explicit `allow` entry wins over every denylist (built-in or
 * site `deny`), so a site can surgically re-open a single action without
 * forking the framework list.
 */
export function isInternalAction(
  key: string,
  options: InvokePolicyOptions = {},
): boolean {
  const seg = lastSegment(key);

  const allow = options.allow ? new Set(options.allow) : null;
  if (allow && (allow.has(seg) || allow.has(key))) return false;

  if (DEFAULT_INTERNAL_ACTIONS.has(seg)) return true;

  if (options.deny) {
    for (const d of options.deny) {
      if (d === seg || d === key || lastSegment(d) === seg) return true;
    }
  }

  return false;
}
