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
 * read it through `currentClient()`, before any `await`. A test the client
 * is given (`cms.client({ experiments })`) is on or off as given, whatever
 * the visitor and its percentage (a preview may switch on a test at 0%); a
 * name the block doesn't have stays out. A test `<parent>/<child>` is on only
 * while `<parent>` is, given or not, and is otherwise the child's own roll or
 * what it was given: a preview switching on `plp-optimizer` alone shows the
 * visitor's own arm of `plp-optimizer/b` (A without a visitor), and one
 * switching on `plp-optimizer/b` alone shows B only to visitors in
 * `plp-optimizer`.
 */
import { currentClient, experimentOverrides } from "../current.ts";
import { type Assignments, assign } from "../experiments.ts";
import { nestTests } from "../nested.ts";

/** The saved block every `experiment` rule reads, and its built-in type. */
export const EXPERIMENTS_BLOCK = "experiments";
export const SPLIT_TRAFFIC_TYPE = "split-traffic";

/** The built-in rule that reads a test. */
export const EXPERIMENT_RULE = "experiment";

/**
 * `split-traffic`: each test and whether the current client's visitor is in
 * it (`assign` from `@decocms/blocks/experiments`), with the tests the
 * client was given applied on top, then each `<parent>/<child>` turned off
 * where its parent is off. Without a visitor every test it wasn't given is
 * off.
 *
 * Each test is drawn on its own first, so the nesting sees the given parent
 * rather than the visitor's: a child's roll still counts when a preview
 * switches its parent on.
 */
export const splitTraffic = (allocations: Record<string, number> = {}): Assignments => {
  const client = currentClient();
  const assignments = Object.create(null) as Assignments;
  for (const name of Object.keys(allocations).sort()) {
    // One test per call: nothing to nest within, so this is the test's own roll.
    const own = assign({ [name]: allocations[name] as number }, client.visitor);
    if (Object.hasOwn(own, name)) assignments[name] = own[name] === true;
  }
  const given = experimentOverrides(client);
  if (given !== undefined) {
    for (const name of Object.keys(given)) {
      if (Object.hasOwn(assignments, name)) assignments[name] = given[name] === true;
    }
  }
  return nestTests(assignments);
};

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
