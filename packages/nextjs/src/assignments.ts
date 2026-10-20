/**
 * How the proxy hands the pages a visitor's A/B assignments: the request
 * header it forwards once it ran `assign` (`@decocms/blocks/experiments`)
 * over the release's `Experiments` block, and its encoding. The proxy writes
 * it (`assignmentRequestHeaders` from `@decocms/nextjs/proxy`); the pages read
 * it (`bindDraft`, then `contentClient`, from `@decocms/nextjs/server`). The
 * package's own copy: it never imports `@decocms/tanstack`. No imports, no
 * state: safe in every bundle.
 */

/**
 * The request header carrying the experiments this visitor is in. The proxy
 * removes any copy that arrives from outside (`draftRequestHeaders`) and sets
 * it only on a request of the release when the release has experiments; a
 * draft never carries one (a preview shows the control, plus the variants
 * its pointer forces).
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
      // Not ours: the proxy only writes what encodeAssignments gives.
    }
  }
  return out;
}
