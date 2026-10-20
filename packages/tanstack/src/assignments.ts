/**
 * How the worker hands the app a visitor's A/B assignments: the request
 * header it sets once it ran `assign` (`@decocms/blocks/experiments`) over
 * the release's `Experiments` block, and its encoding. The worker writes it
 * (`./worker/index.ts`); the app reads it (`contentClient` from
 * `@decocms/tanstack/server`). No imports, no state: safe in every bundle.
 */

/**
 * The request header carrying the experiments this visitor is in. The worker
 * removes any copy that arrives from outside and sets it only on a page or
 * server-function request whose content (the release, or a draft) has
 * experiments.
 */
export const ASSIGNMENTS_HEADER = "x-deco-assignments";

/**
 * The header's value: the names the visitor is in, each URL-encoded (a header
 * holds Latin-1 only, and a name may hold a comma), sorted, joined by `,`.
 * `""` when they are in none. A name they are out of is simply absent.
 */
export function encodeAssignments(assignments: Readonly<Record<string, boolean>>): string {
  return Object.keys(assignments)
    .filter((name) => assignments[name] === true)
    .sort()
    .map((name) => encodeURIComponent(name))
    .join(",");
}

/**
 * The assignments a header value names: each listed name `true`. Never
 * throws; a part that doesn't decode is skipped. A record with no prototype,
 * so a name such as `__proto__` is an ordinary key.
 */
export function decodeAssignments(value: string): Record<string, boolean> {
  const out = Object.create(null) as Record<string, boolean>;
  for (const part of value.split(",")) {
    if (part === "") continue;
    try {
      out[decodeURIComponent(part)] = true;
    } catch {
      // Not ours: the worker only writes what encodeAssignments gives.
    }
  }
  return out;
}
