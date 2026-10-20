/**
 * The A/B tests as content (see /next/built-in-blocks#experiments): the
 * built-in type `experiments`, saved once as the well-known block
 * `Experiments`, and the built-in matcher `experiment`.
 *
 * - `Experiments` maps each test's name to the whole percentage of visitors
 *   in it (0–100). Two arms only, in and out; a multi-way test is several
 *   experiments. 0 is off, 100 is everyone, anything between is running, and
 *   a running test's name is its stable key: renaming it re-rolls everyone.
 * - The visitor's assignments (`assign` from `@decocms/blocks/experiments`)
 *   reach the matcher per client, `cms.forRelease({ assignments })` or
 *   `cms.forDraft(pointer, { assignments })`: the core has no request scope.
 */
import { isPlainObject, own } from "../json.ts";
import type { BlockFunction, Blocks, Client, Snapshot } from "../types.ts";

/** The well-known saved block that holds the experiments, and its built-in type. */
export const EXPERIMENTS_BLOCK = "Experiments";
export const EXPERIMENTS_TYPE = "experiments";

/** The built-in matcher that reads a visitor's assignment. */
export const EXPERIMENT_MATCHER = "experiment";

/** `experiments`: the type of the well-known saved block `Experiments`; returns its input. */
export const experiments = (props: Record<string, number> = {}): Record<string, number> => props;

/** Inputs of the built-in `experiment` matcher. */
interface ExperimentProps {
  /** A name in the `Experiments` block. */
  name?: string;
}

/**
 * The names a client's assignments put the visitor in, copied when the
 * client is created, so a caller changing its object later changes no
 * client. `undefined` without assignments.
 */
export function assignedNames(
  assignments: Readonly<Record<string, boolean>> | undefined,
): ReadonlySet<string> | undefined {
  if (!isPlainObject(assignments)) return undefined;
  const inside = new Set<string>();
  for (const name of Object.keys(assignments)) {
    if (assignments[name] === true) inside.add(name);
  }
  return inside;
}

/** Whether `name` is a test in the snapshot's `Experiments` block (of the built-in type). */
function hasExperiment(snapshot: Snapshot, name: string): boolean {
  const entry = own(snapshot.blocks, EXPERIMENTS_BLOCK);
  return (
    isPlainObject(entry) &&
    entry.__resolveType === EXPERIMENTS_TYPE &&
    name !== "__resolveType" &&
    Object.hasOwn(entry, name)
  );
}

/**
 * The `experiment` matcher of one client: `true` when its assignments put
 * the visitor in `name` and `name` is a test in the `Experiments` block of
 * the snapshot the client reads (the release's, or a draft's). An unknown
 * name, no `Experiments` block (or one of another type) and a client created
 * without assignments all give `false`.
 */
export function experimentMatcher(
  inside: ReadonlySet<string> | undefined,
  snapshot: Snapshot | undefined,
): BlockFunction {
  return ({ name }: ExperimentProps = {}): boolean =>
    typeof name === "string" &&
    inside !== undefined &&
    snapshot !== undefined &&
    inside.has(name) &&
    hasExperiment(snapshot, name);
}

/** `experiment` with no assignments: every rule is `false`. */
export const experiment = experimentMatcher(undefined, undefined);

/**
 * The built-ins of a client reading `snapshot` with the visitor's
 * assignments: `experiment` bound to both. Without assignments, or with a
 * built-ins table without `experiment`, they are returned as is.
 */
export function withExperiments(
  builtIns: Readonly<Blocks>,
  snapshot: Snapshot,
  inside: ReadonlySet<string> | undefined,
): Readonly<Blocks> {
  if (inside === undefined || own(builtIns, EXPERIMENT_MATCHER) === undefined) return builtIns;
  return Object.freeze({ ...builtIns, [EXPERIMENT_MATCHER]: experimentMatcher(inside, snapshot) });
}

/**
 * The experiments a snapshot holds: the `Experiments` block, resolved with
 * `client` (so its type's function and any variant in it run), keeping each
 * name whose allocation is a finite number. A missing block, a block of
 * another type, or one that fails to resolve gives no experiments. Never
 * rejects.
 */
export async function readExperiments(
  snapshot: Snapshot,
  client: () => Client,
): Promise<Record<string, number>> {
  const out = Object.create(null) as Record<string, number>;
  try {
    const entry = snapshot.blocks[EXPERIMENTS_BLOCK];
    if (!isPlainObject(entry) || entry.__resolveType !== EXPERIMENTS_TYPE) return out;
    const [value] = await client().resolve<Record<string, unknown>>(EXPERIMENTS_BLOCK);
    if (typeof value !== "object" || value === null) return out;
    for (const name of Object.keys(value)) {
      const allocation = value[name];
      if (typeof allocation === "number" && Number.isFinite(allocation)) out[name] = allocation;
    }
    return out;
  } catch {
    return out;
  }
}
