/**
 * Tests within a test: a name written `<parent>/<child>` is drawn only among
 * the visitors in `<parent>`, so a test can split its own arm. With
 * `{ "plp-optimizer": 50, "plp-optimizer/b": 50 }` half the visitors see the
 * control, a quarter `plp-optimizer` alone (A) and a quarter
 * `plp-optimizer/b` too (B); ramping `plp-optimizer` keeps its arm split 50/50.
 *
 * The child keeps its own roll (`<parent>/<child>:id`), independent of the
 * parent's; nesting only turns it off for the visitors outside the parent. The
 * parent is the nearest prefix ending before a `/` that names a test of the
 * same map, so a `/` in a name whose prefix is no test changes nothing.
 * Internal: `assign`, the built-in `split-traffic` and the analytics client
 * apply it; the tests import it by path.
 */

/** The test `name` is drawn within: the nearest `/`-prefix that `has` a test, or `undefined`. */
export function parentTest(name: string, has: (name: string) => boolean): string | undefined {
  for (let slash = name.lastIndexOf("/"); slash > 0; slash = name.lastIndexOf("/", slash - 1)) {
    const prefix = name.slice(0, slash);
    if (has(prefix)) return prefix;
  }
  return undefined;
}

/**
 * Turns off, in place, every test whose parent is off, so a child is on only
 * when the whole chain above it is. A parent is a prefix of its child, so it
 * sorts first and is final by the time its child is read.
 */
export function nestTests(assignments: Record<string, boolean>): Record<string, boolean> {
  const has = (name: string) => Object.hasOwn(assignments, name);
  for (const name of Object.keys(assignments).sort(byCodeUnit)) {
    const parent = parentTest(name, has);
    if (parent !== undefined && assignments[parent] !== true) assignments[name] = false;
  }
  return assignments;
}

/** Plain code-unit order: a prefix before every name it starts. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
