/**
 * What a request's content decided, as one cache-key part: the version it
 * reads (a Studio link's draft or release SHA, with its preview time `__at`
 * and forced tests), the tests of the saved `experiments` block its visitor
 * is in, and the campaigns of the saved `campaigns` block running at its
 * moment. Two requests with the same decisions render the same content, so
 * they share a cache entry; the visitor id itself is never in the key, or
 * every visitor would miss.
 *
 * Blocks decides (`cms.client({ visitor, version })`); this only reads the
 * answers. A site without either block has no decisions and keys as before.
 */
import type { CMS } from "@decocms/blocks";
import type { Visitor } from "@decocms/blocks/experiments";

export interface Decisions {
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

/** The names that resolved `true` in the saved `block`, sorted; none when it is missing. */
async function trueNames(client: Reader, spec: { block: string; type: string }): Promise<string[]> {
  try {
    if (!(await saves(client, spec.type))) return [];
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
 * The decisions of one request: resolves `experiments` and `campaigns`
 * through `cms.client({ visitor, version })`, as the page will. Missing
 * blocks (or content that doesn't load) give no decisions, never an error.
 */
export async function readDecisions(
  cms: Pick<CMS, "client">,
  inputs: { visitor: Visitor | null; version: string | null },
): Promise<Decisions> {
  const none: Decisions = { version: inputs.version, experiments: [], campaigns: [] };
  let client: Reader;
  try {
    client = cms.client({ visitor: inputs.visitor, version: inputs.version });
  } catch {
    return none;
  }
  const [experiments, campaigns] = await Promise.all([
    trueNames(client, EXPERIMENTS),
    trueNames(client, CAMPAIGNS),
  ]);
  return { ...none, experiments, campaigns };
}

/**
 * The decisions as one stable string: `v=<version>|x=<tests>|c=<campaigns>`,
 * names sorted and URL-encoded, empty parts left out; `""` for none.
 */
export function decisionsKey(decisions: Decisions): string {
  const list = (names: readonly string[]) =>
    [...names].sort(byCodeUnit).map(encodeURIComponent).join(",");
  const parts: string[] = [];
  if (decisions.version) parts.push(`v=${encodeURIComponent(decisions.version)}`);
  if (decisions.experiments.length) parts.push(`x=${list(decisions.experiments)}`);
  if (decisions.campaigns.length) parts.push(`c=${list(decisions.campaigns)}`);
  return parts.join("|");
}

/** Most running tests `possibleDecisions` expands: 2^4 combinations per path and device. */
const MAX_RUNNING_TESTS = 4;

/**
 * Every decision a visitor of the current release can get right now, for a
 * purge: the campaigns running now, and each combination of the tests that
 * are running (0 < share < 100; a test at 100 is on for everyone, at 0 off).
 * `complete` is `false` when more than four tests run and only the
 * combinations of the first four (by name) are listed.
 */
export async function possibleDecisions(
  cms: Pick<CMS, "client">,
): Promise<{ decisions: Decisions[]; complete: boolean }> {
  const client = cms.client();
  const campaigns = await trueNames(client, CAMPAIGNS);
  let shares: Record<string, unknown> = {};
  try {
    if (await saves(client, EXPERIMENTS.type)) {
      const [block] = await client.resolve<unknown>(EXPERIMENTS.block, { run: false });
      if (isRecord(block)) shares = block;
    }
  } catch {
    // No tests: one decision.
  }
  const always: string[] = [];
  const running: string[] = [];
  for (const name of Object.keys(shares).sort(byCodeUnit)) {
    if (name === "__resolveType") continue;
    const share = shares[name];
    if (typeof share !== "number") continue;
    if (share >= 100) always.push(name);
    else if (share > 0) running.push(name);
  }
  const expanded = running.slice(0, MAX_RUNNING_TESTS);
  const decisions: Decisions[] = [];
  for (let mask = 0; mask < 1 << expanded.length; mask++) {
    const on = expanded.filter((_, i) => mask & (1 << i));
    decisions.push({ version: null, experiments: [...always, ...on].sort(byCodeUnit), campaigns });
  }
  return { decisions, complete: running.length <= MAX_RUNNING_TESTS };
}
