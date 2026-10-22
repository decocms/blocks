/**
 * A request's assignments (what its content gives it), decided once by the
 * worker: the version it reads (a Studio link's draft or release SHA), each
 * test of the saved `experiments` block on or off for its visitor and each
 * campaign of the saved `campaigns` block running or not at its date, with a
 * preview's switched tests and campaigns on top. The worker hands them to the
 * page (`x-deco-assignments`) and to the site's `pageCache`
 * (`page.assignments`), whose key carries them (`assignmentsKey`). Two
 * requests with the same assignments render the same content, so they share
 * a cache entry; the visitor id itself is never in the key, or every visitor
 * would miss.
 *
 * Blocks decides (`cms.client({ visitor, version, … })`); this only reads
 * the answers. A site without either block has no assignments and keys as
 * before.
 */
import type { ClientOptions, CMS } from "@decocms/blocks";
import type { Assignments } from "@decocms/blocks/experiments";
import type { DecidedAssignments } from "../assignments.ts";

export interface RequestAssignments extends DecidedAssignments {
  /** The version read, `null` for the current release. */
  version: string | null;
}

const EXPERIMENTS = { block: "experiments", type: "split-traffic" } as const;
const CAMPAIGNS = { block: "campaigns", type: "calendar" } as const;

type Reader = ReturnType<CMS["client"]>;

/** Plain code-unit order, the same on every server and locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const record = (): Assignments => Object.create(null) as Assignments;

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

/** The saved `block` resolved, each name `true` or `false`; none when it is missing. */
async function decided(
  client: Reader,
  spec: { block: string; type: string },
): Promise<Assignments> {
  const out = record();
  try {
    if (!(await saves(client, spec.type))) return out;
    const [value] = await client.resolve<unknown>(spec.block);
    if (!isRecord(value)) return out;
    for (const name of Object.keys(value).sort(byCodeUnit)) out[name] = value[name] === true;
  } catch {
    // Content that doesn't load gives no assignments.
  }
  return out;
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
  const version = typeof options.version === "string" ? options.version : null;
  let client: Reader;
  try {
    client = cms.client(options);
  } catch {
    return { version, experiments: record(), campaigns: record() };
  }
  const [experiments, campaigns] = await Promise.all([
    decided(client, EXPERIMENTS),
    decided(client, CAMPAIGNS),
  ]);
  return { version, experiments, campaigns };
}

/**
 * Every assignments key a live request can carry now, for a site's purge: each
 * subset of the tests in the saved `experiments` block on (the empty one
 * included), with the campaigns running now and with none. Previews are
 * never cached, so no version. A site without either block has one: `""`.
 */
export async function liveAssignmentKeys(cms: Pick<CMS, "client">): Promise<string[]> {
  let client: Reader;
  try {
    client = cms.client();
  } catch {
    return [""];
  }
  const [saved, campaigns] = await Promise.all([
    decided(client, EXPERIMENTS),
    decided(client, CAMPAIGNS),
  ]);
  const tests = Object.keys(saved);
  const running = Object.keys(campaigns).some((name) => campaigns[name] === true);
  const campaignSets = running ? [campaigns, record()] : [record()];
  const keys: string[] = [];
  // Subsets by bitmask, tests in sorted order: 2^tests of them.
  for (let mask = 0; mask < 2 ** tests.length; mask++) {
    const experiments = record();
    tests.forEach((name, i) => {
      experiments[name] = Math.floor(mask / 2 ** i) % 2 === 1;
    });
    for (const set of campaignSets) {
      keys.push(assignmentsKey({ version: null, experiments, campaigns: set }));
    }
  }
  return keys;
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
