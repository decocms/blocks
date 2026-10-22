/**
 * A request's assignments: what its content gives it, decided once, in the
 * proxy, and handed to the page. The version it reads (a Studio link's draft
 * or release SHA, `null` for the current release), each test of the saved
 * `experiments` block on or off for its visitor, and each campaign of the
 * saved `campaigns` block running or not at its date, with a preview's
 * switched tests and campaigns on top. The page builds
 * `cms.client({ version, experiments, campaigns })` from them, a client that
 * decides nothing again.
 *
 * Two requests with the same assignments render the same content, so they
 * share a cache entry: `assignmentsKey` for a cache keyed on a string,
 * `assignmentsSegment` for Next's own path-keyed cache. The visitor id itself
 * is never in either, or every visitor would miss. The binding caches nothing
 * itself.
 *
 * The same reading as `@decocms/tanstack/worker`'s.
 */
import type { ClientOptions, CMS } from "@decocms/blocks";
import type { Assignments } from "@decocms/blocks/experiments";

export interface RequestAssignments {
  /** The version read, `null` for the current release. */
  version: string | null;
  /** Each test of the saved `experiments` block: on or off. */
  experiments: Readonly<Assignments>;
  /** Each campaign of the saved `campaigns` block: running or not. */
  campaigns: Readonly<Assignments>;
}

/**
 * The request header the proxy hands the pages the assignments it decided on
 * (`assignmentsSegment`), for `bindDraft` and `contentClient`. The proxy
 * removes any copy that arrives from outside.
 */
export const ASSIGNMENTS_HEADER = "x-deco-assignments";

/** What a page's path and the decisions header carry: the tests and campaigns, never the version or the visitor. */
export type PathAssignments = Pick<RequestAssignments, "experiments" | "campaigns">;

const EXPERIMENTS = { block: "experiments", type: "split-traffic" } as const;
const CAMPAIGNS = { block: "campaigns", type: "calendar" } as const;

type Reader = ReturnType<CMS["client"]>;

/** Plain code-unit order, the same on every server and locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(): Assignments {
  return Object.create(null) as Assignments;
}

/**
 * Whether the content saves a block of `type`: listing never fails on a
 * missing block, so a site without tests or campaigns reports no error.
 */
async function saves(client: Reader, type: string): Promise<boolean> {
  const [list] = await client.list(type);
  return (list?.length ?? 0) > 0;
}

/** The saved `block` resolved, each name `true` or `false`; `null` when the content saves none. */
async function decided(
  client: Reader,
  spec: { block: string; type: string },
): Promise<Assignments | null> {
  try {
    if (!(await saves(client, spec.type))) return null;
    const [value] = await client.resolve<unknown>(spec.block);
    const out = record();
    if (!isRecord(value)) return out;
    for (const name of Object.keys(value).sort(byCodeUnit)) out[name] = value[name] === true;
    return out;
  } catch {
    return record();
  }
}

/**
 * The assignments of one request: `cms.client(options)` (the version, the
 * visitor, the date and a preview's switched tests and campaigns, as
 * `cms.readVersion` reads them) resolving `experiments` and `campaigns`.
 * Missing blocks (or content that doesn't load) give none, never an error.
 */
export async function readAssignments(
  cms: Pick<CMS, "client">,
  options: ClientOptions,
): Promise<RequestAssignments> {
  return (await readAssignmentsAndScope(cms, options)).assignments;
}

/**
 * `readAssignments`, and whether its page can differ by them: `true` when the
 * content saves tests or campaigns (or couldn't be read, to stay safe), so a
 * response keyed on them must never be shared by its URL alone.
 */
export async function readAssignmentsAndScope(
  cms: Pick<CMS, "client">,
  options: ClientOptions,
): Promise<{ assignments: RequestAssignments; varies: boolean }> {
  const version = typeof options.version === "string" ? options.version : null;
  const none: RequestAssignments = { version, experiments: record(), campaigns: record() };
  let client: Reader;
  try {
    client = cms.client(options);
  } catch {
    return { assignments: none, varies: true };
  }
  const [experiments, campaigns] = await Promise.all([
    decided(client, EXPERIMENTS),
    decided(client, CAMPAIGNS),
  ]);
  return {
    assignments: {
      version,
      experiments: experiments ?? none.experiments,
      campaigns: campaigns ?? none.campaigns,
    },
    varies: experiments !== null || campaigns !== null,
  };
}

/** The names that are on, sorted. */
function onNames(assignments: Readonly<Assignments>): string[] {
  return Object.keys(assignments)
    .filter((name) => assignments[name] === true)
    .sort(byCodeUnit);
}

/**
 * The assignments as one stable string for a cache key:
 * `v=<version>|x=<tests on>|c=<campaigns running>`, names sorted and
 * URL-encoded, empty parts left out; `""` for none. The names that are off
 * aren't in it: within one content revision they are the rest.
 */
export function assignmentsKey(assignments: RequestAssignments): string {
  const list = (names: string[]) => names.map(encodeURIComponent).join(",");
  const parts: string[] = [];
  if (assignments.version) parts.push(`v=${encodeURIComponent(assignments.version)}`);
  const tests = onNames(assignments.experiments);
  const campaigns = onNames(assignments.campaigns);
  if (tests.length) parts.push(`x=${list(tests)}`);
  if (campaigns.length) parts.push(`c=${list(campaigns)}`);
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

/** The segment for content with no test and no campaign. */
const NONE = "-";

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

/** `+name` on, `-name` off, names URL-encoded and sorted. */
function encodeStates(states: Readonly<Assignments>): string {
  return Object.keys(states)
    .sort(byCodeUnit)
    .map((name) => `${states[name] === true ? "+" : "-"}${encodeURIComponent(name)}`)
    .join(",");
}

/**
 * The tests and campaigns as one path segment, every name with its state
 * (`x=+on,-off|c=+running,-not`, base64url-encoded so Next passes it to the
 * page unchanged), for Next's own path-keyed cache (ISR, the full route
 * cache) and for the decisions header (`ASSIGNMENTS_HEADER`): `-` for none.
 * The same assignments always give the same segment; the visitor is never in
 * it.
 */
export function assignmentsSegment(assignments: PathAssignments): string {
  const parts: string[] = [];
  const tests = encodeStates(assignments.experiments);
  const campaigns = encodeStates(assignments.campaigns);
  if (tests) parts.push(`x=${tests}`);
  if (campaigns) parts.push(`c=${campaigns}`);
  return parts.length === 0 ? NONE : toBase64Url(parts.join("|"));
}

/**
 * The tests and campaigns a segment carries, or `null` when it isn't one
 * `assignmentsSegment` writes (malformed, or the same assignments spelled
 * another way), so each set of assignments has exactly one path.
 */
export function parseAssignmentsSegment(segment: string): PathAssignments | null {
  if (segment === NONE) return { experiments: record(), campaigns: record() };
  const key = fromBase64Url(segment);
  if (key === null) return null;
  const parsed = { experiments: record(), campaigns: record() };
  const seen = new Set<string>();
  try {
    for (const part of key.split("|")) {
      const eq = part.indexOf("=");
      const tag = part.slice(0, eq);
      const list = part.slice(eq + 1);
      if (eq <= 0 || list === "" || seen.has(tag) || (tag !== "x" && tag !== "c")) return null;
      seen.add(tag);
      const target = tag === "x" ? parsed.experiments : parsed.campaigns;
      for (const entry of list.split(",")) {
        const state = entry[0];
        if (state !== "+" && state !== "-") return null;
        target[decodeURIComponent(entry.slice(1))] = state === "+";
      }
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

/**
 * The tests a path or header names, as a page renders them on the current
 * release: a test at 0% stays off whatever it says, so a forged path or
 * header can't switch on a test nobody is in (a preview, on its own version,
 * may). A name the content doesn't have stays out anyway (`cms.client`
 * keeps only the block's names). Read from memory, unresolved.
 */
export async function withoutDarkTests(
  cms: Pick<CMS, "forRelease">,
  assignments: PathAssignments,
): Promise<PathAssignments> {
  const on = Object.keys(assignments.experiments).filter(
    (name) => assignments.experiments[name] === true,
  );
  if (on.length === 0) return assignments;
  let saved: Record<string, unknown> = {};
  try {
    const [block] = await cms.forRelease().resolve<unknown>(EXPERIMENTS.block, { run: false });
    if (isRecord(block) && block.__resolveType === EXPERIMENTS.type) saved = block;
  } catch {
    // No experiments block: every test the client is given stays out.
  }
  const experiments = record();
  for (const name of Object.keys(assignments.experiments)) {
    const pct = Object.hasOwn(saved, name) ? saved[name] : undefined;
    const dark = typeof pct !== "number" || !Number.isFinite(pct) || Math.round(pct) <= 0;
    experiments[name] = assignments.experiments[name] === true && !dark;
  }
  return { experiments, campaigns: assignments.campaigns };
}
