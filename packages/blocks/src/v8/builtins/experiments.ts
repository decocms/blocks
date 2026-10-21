/**
 * A/B tests as content (see /next/built-in-blocks#split-traffic): the
 * built-in type `split-traffic`, which the saved block `experiments` has, and
 * the built-in rule `experiment`.
 *
 * - `experiments` maps each test's name to the whole percentage of visitors
 *   in it (0–100: 0 off, 100 everyone). Resolving it gives each name and
 *   whether the client's visitor is in it, never a percentage.
 * - `experiment { name }` is `true` when that answer is `true`.
 *
 * The visitor arrives as an argument to `cms.client({ visitor })`; these
 * read it through `currentClient()`, before any `await`.
 */
import { currentClient, decided, forcedTests } from "../current.ts";
import { type Assignments, assign } from "../experiments.ts";

/** The saved block every `experiment` rule reads, and its built-in type. */
export const EXPERIMENTS_BLOCK = "experiments";
export const SPLIT_TRAFFIC_TYPE = "split-traffic";

/** The built-in rule that reads a test. */
export const EXPERIMENT_RULE = "experiment";

/**
 * `split-traffic`: each test and whether the current client's visitor is in
 * it (`assign` from `@decocms/blocks/experiments`), with the tests the
 * client's preview link forces applied on top. Without a visitor every test
 * is off. A client created with decisions answers from them instead.
 */
export const splitTraffic = (allocations: Record<string, number> = {}): Assignments => {
  const client = currentClient();
  const earlier = decided(client);
  const assignments =
    earlier === undefined
      ? assign(allocations, client.visitor)
      : fromDecided(allocations, earlier.experiments);
  const forced = forcedTests(client);
  if (forced !== undefined) {
    for (const name of Object.keys(forced)) {
      if (Object.hasOwn(assignments, name)) assignments[name] = forced[name] === true;
    }
  }
  return assignments;
};

/**
 * The answers of a client created with decisions (`cms.client({ decided })`):
 * `true` for each test named there, `false` for every other test the block
 * has, as `assign` gives them (entries that aren't finite numbers left out).
 */
function fromDecided(allocations: Record<string, number>, names: readonly string[]): Assignments {
  const out = Object.create(null) as Assignments;
  if (typeof allocations !== "object" || allocations === null) return out;
  const on = new Set(names);
  for (const name of Object.keys(allocations).sort()) {
    const allocation = allocations[name];
    if (typeof allocation !== "number" || !Number.isFinite(allocation)) continue;
    out[name] = on.has(name);
  }
  return out;
}

/** Inputs of the built-in `experiment` rule. */
interface ExperimentProps {
  /** A test in the saved block `experiments`. */
  name?: string;
}

/**
 * `experiment`: `true` when the current client's visitor is in the test
 * `name` of the saved block `experiments`. An unknown name, no `experiments`
 * block, or no visitor give `false`. The block is resolved once per client,
 * however many rules ask.
 */
export const experiment = ({ name }: ExperimentProps = {}): boolean | Promise<boolean> => {
  const client = currentClient();
  if (typeof name !== "string") return false;
  return client
    .resolve<Record<string, unknown>>(EXPERIMENTS_BLOCK)
    .then(([tests]) => isTrueAt(tests, name));
};

function isTrueAt(record: unknown, name: string): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    Object.hasOwn(record, name) &&
    (record as Record<string, unknown>)[name] === true
  );
}
