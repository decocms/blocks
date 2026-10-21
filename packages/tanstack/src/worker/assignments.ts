/**
 * A request's assignments (what its content gives it), as one cache-key
 * part: the version it reads (a Studio link's draft or release SHA, with its preview time `__at`
 * and forced tests), the tests of the saved `experiments` block its visitor
 * is in, and the campaigns of the saved `campaigns` block running at its
 * moment. Two requests with the same assignments render the same content, so
 * they share a cache entry; the visitor id itself is never in the key, or
 * every visitor would miss.
 *
 * Blocks decides (`cms.client({ visitor, version })`); this only reads the
 * answers. A site without either block has no assignments and keys as before.
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
 * The assignments of one request: resolves `experiments` and `campaigns`
 * through `cms.client({ visitor, version })`, as the page will. Missing
 * blocks (or content that doesn't load) give no assignments, never an error.
 */
export async function readAssignments(
  cms: Pick<CMS, "client">,
  inputs: { visitor: Visitor | null; version: string | null },
): Promise<RequestAssignments> {
  const none: RequestAssignments = { version: inputs.version, experiments: [], campaigns: [] };
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
