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
import { isPlainObject } from "../json.ts";
import type { BlockFunction, Client, Snapshot } from "../types.ts";

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
 * The `experiment` matcher of one client: `true` when the assignments it was
 * created with put the visitor in `name`. An unknown name, or a client
 * created without assignments, gives `false`. The assignments are copied, so
 * a caller changing its object later changes no client.
 */
export function experimentMatcher(
  assignments: Readonly<Record<string, boolean>> | undefined,
): BlockFunction {
  const inside = new Set<string>();
  if (isPlainObject(assignments)) {
    for (const name of Object.keys(assignments)) {
      if (assignments[name] === true) inside.add(name);
    }
  }
  return ({ name }: ExperimentProps = {}): boolean => typeof name === "string" && inside.has(name);
}

/** `experiment` with no assignments: every rule is `false`. */
export const experiment = experimentMatcher(undefined);

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
