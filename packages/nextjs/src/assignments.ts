/**
 * A request's assignments (what its content gives it), as one cache-key
 * part, for a site that caches in front of its pages: the version it reads (a Studio link's draft
 * or release SHA, with its preview time `__at` and forced tests), the tests
 * of the saved `experiments` block its visitor is in, and the campaigns of
 * the saved `campaigns` block running at its moment. Two requests with the
 * same assignments render the same content; the visitor id itself is never in
 * the key, or every visitor would miss. The binding caches nothing itself.
 *
 * The same reading as `@decocms/tanstack/worker`'s edge cache key.
 */
import type { CMS } from "@decocms/blocks";
import type { Visitor } from "@decocms/blocks/experiments";

export interface RequestAssignments {
  /** The version read, `null` for the current release. */
  version: string | null;
  /** The tests the visitor is in, sorted. */
  experiments: readonly string[];
  /** The campaigns running at the request's moment, sorted. */
  campaigns: readonly string[];
}

const EXPERIMENTS = { block: "experiments", type: "split-traffic" } as const;
const CAMPAIGNS = { block: "campaigns", type: "date-windows" } as const;

type Reader = ReturnType<CMS["client"]>;

/** Plain code-unit order, the same on every server and locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the content saves a block of `type`: listing never fails on a
 * missing block, so a site without tests or campaigns reports no error.
 */
async function saves(client: Reader, type: string): Promise<boolean> {
  const [list] = await client.list(type);
  return (list?.length ?? 0) > 0;
}

/** The names that resolved `true` in the saved `block`, sorted; `null` when the content saves none. */
async function trueNames(
  client: Reader,
  spec: { block: string; type: string },
): Promise<string[] | null> {
  try {
    if (!(await saves(client, spec.type))) return null;
    const [value] = await client.resolve<unknown>(spec.block);
    if (!isRecord(value)) return [];
    return Object.keys(value)
      .filter((name) => value[name] === true)
      .sort(byCodeUnit);
  } catch {
    return [];
  }
}

/**
 * The assignments of one request: resolves `experiments` and `campaigns`
 * through `cms.client({ visitor, version })`, as the page will. Missing
 * blocks (or content that doesn't load) give no assignments, never an error.
 */
export async function readAssignments(
  cms: Pick<CMS, "client">,
  inputs: { visitor: Visitor | null; version: string | null },
): Promise<RequestAssignments> {
  return (await readAssignmentsAndScope(cms, inputs)).assignments;
}

/**
 * `readAssignments`, and whether its page can differ by them: `true` when the
 * content saves tests or campaigns (or couldn't be read, to stay safe), so a
 * response keyed on them must never be shared by its URL alone.
 */
export async function readAssignmentsAndScope(
  cms: Pick<CMS, "client">,
  inputs: { visitor: Visitor | null; version: string | null },
): Promise<{ assignments: RequestAssignments; varies: boolean }> {
  const none: RequestAssignments = { version: inputs.version, experiments: [], campaigns: [] };
  let client: Reader;
  try {
    client = cms.client({ visitor: inputs.visitor, version: inputs.version });
  } catch {
    return { assignments: none, varies: true };
  }
  const [experiments, campaigns] = await Promise.all([
    trueNames(client, EXPERIMENTS),
    trueNames(client, CAMPAIGNS),
  ]);
  return {
    assignments: { ...none, experiments: experiments ?? [], campaigns: campaigns ?? [] },
    varies: experiments !== null || campaigns !== null,
  };
}

/**
 * The assignments as one stable string: `v=<version>|x=<tests>|c=<campaigns>`,
 * names sorted and URL-encoded, empty parts left out; `""` for none.
 */
export function assignmentsKey(assignments: RequestAssignments): string {
  const list = (names: readonly string[]) =>
    [...names].sort(byCodeUnit).map(encodeURIComponent).join(",");
  const parts: string[] = [];
  if (assignments.version) parts.push(`v=${encodeURIComponent(assignments.version)}`);
  if (assignments.experiments.length) parts.push(`x=${list(assignments.experiments)}`);
  if (assignments.campaigns.length) parts.push(`c=${list(assignments.campaigns)}`);
  return parts.join("|");
}

/**
 * The route a page renders on under the assignments its proxy made:
 * `/_assignments/<assignments>/<path>`, mounted as `app/%5Fassignments/[assignments]/[[...path]]`
 * (a literal `_assignments` folder is private in Next and never routes). The proxy
 * rewrites to it (`rewriteToAssignmentsRoute`) and answers a direct hit with
 * its 404, so a visitor can't pick the assignments by typing a path.
 */
export const ASSIGNMENTS_ROUTE_PREFIX = "/_assignments";

/** The segment for a request with no test on and no campaign running. */
const NONE = "-";

/** What a assignments segment carries: the tests on and the campaigns running, never the version or the visitor. */
export type PathAssignments = Pick<RequestAssignments, "experiments" | "campaigns">;

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The assignments as one path segment, for Next's own path-keyed cache (ISR,
 * the full route cache): `-` for none, otherwise `assignmentsKey` without the
 * version, base64url-encoded so Next passes it to the page unchanged. The
 * same assignments always give the same segment; the visitor is never in it.
 */
export function assignmentsSegment(assignments: PathAssignments): string {
  const key = assignmentsKey({ version: null, ...assignments });
  return key === "" ? NONE : toBase64Url(key);
}

/**
 * The assignments a segment carries, or `null` when it isn't one
 * `assignmentsSegment` writes (malformed, or the same assignments spelled another
 * way), so each set of assignments has exactly one path.
 */
export function parseAssignmentsSegment(segment: string): PathAssignments | null {
  if (segment === NONE) return { experiments: [], campaigns: [] };
  const key = fromBase64Url(segment);
  if (key === null) return null;
  const parsed: { experiments: string[]; campaigns: string[] } = { experiments: [], campaigns: [] };
  try {
    for (const part of key.split("|")) {
      const [tag, list, ...rest] = part.split("=");
      if (rest.length > 0 || list === undefined || list === "") return null;
      const names = list.split(",").map(decodeURIComponent);
      if (tag === "x" && parsed.experiments.length === 0) parsed.experiments = names;
      else if (tag === "c" && parsed.campaigns.length === 0) parsed.campaigns = names;
      else return null;
    }
  } catch {
    return null;
  }
  return assignmentsSegment(parsed) === segment ? parsed : null;
}

/** `/_assignments/<segment><pathname>` (the bare prefix and segment for `/`). */
export function assignmentsRoutePath(pathname: string, assignments: PathAssignments): string {
  const base = `${ASSIGNMENTS_ROUTE_PREFIX}/${assignmentsSegment(assignments)}`;
  return pathname === "/" || pathname === "" ? base : `${base}${pathname}`;
}

/** Whether `pathname` is on the assignments route: a site's proxy answers a direct hit there with its 404. */
export function isAssignmentsRoutePath(pathname: string): boolean {
  return (
    pathname === ASSIGNMENTS_ROUTE_PREFIX || pathname.startsWith(`${ASSIGNMENTS_ROUTE_PREFIX}/`)
  );
}
