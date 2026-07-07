import { describe, expect, it } from "vitest";
import {
  registerLayoutSections,
  registerSections,
  resolveDecoPage,
  setBlocks,
  unregisterLayoutSections,
} from "./index";

/**
 * Regression test for the layout-cache index-corruption bug that shipped in
 * @decocms/start@6.12.1 and was fixed in 6.12.2 (deco-start commit 73d4f19,
 * "fix(cms): don't mutate shared cached section objects when stamping
 * index"). Two live production sites (casaevideo-tanstack, bagaggio-tanstack)
 * hit this in the wild as an intermittent "footer renders above other
 * sections" bug under concurrent traffic.
 *
 * Mechanism: resolveDecoPage caches a layout section's (Header/Footer)
 * resolved output in a module-level Map, shared across every request that
 * references the same layout block — and dedupes concurrent in-flight
 * resolutions to the same shared Promise. Each request then stamps its own
 * page's flat position onto `.index` so mergeSections can sort eager +
 * deferred sections back into CMS order. If two concurrent requests need the
 * SAME cached layout section at DIFFERENT flat positions (e.g. page A has
 * Footer at index 0, page B has Footer at index 2), and stamping mutates the
 * shared cached object in place, whichever request's stamp lands last wins —
 * and both requests then see that same (possibly wrong-for-them) index.
 *
 * The fix clones the wrapper object before stamping, so each caller gets its
 * own `{ ...section, index }` and the shared cache/in-flight objects are
 * never touched.
 */
describe("resolveDecoPage — layout section cache does not leak `.index` across concurrent requests", () => {
  it("gives each page its own correct Footer index when resolved concurrently", async () => {
    const FOOTER_TYPE = "site/sections/RaceFooter.tsx";
    const FILLER_TYPE = "site/sections/RaceFiller.tsx";

    // A controllable delay on Footer's resolver forces both concurrent
    // resolveDecoPage() calls to land on the SAME in-flight promise
    // (resolvedLayoutInflight), reproducing the exact shared-object window
    // the original bug required — without this, the two calls might resolve
    // sequentially and never actually share state.
    let releaseFooter: () => void = () => {};
    const footerGate = new Promise<void>((resolve) => {
      releaseFooter = resolve;
    });

    registerSections({
      [FOOTER_TYPE]: async () => {
        await footerGate;
        return { default: () => null };
      },
      [FILLER_TYPE]: async () => ({ default: () => null }),
    });
    registerLayoutSections([FOOTER_TYPE]);

    setBlocks({
      "pages-race-a": {
        path: "/race-a",
        // Footer at flat index 0 for this page.
        sections: [{ __resolveType: FOOTER_TYPE }, { __resolveType: FILLER_TYPE }],
      },
      "pages-race-b": {
        path: "/race-b",
        // Same Footer, but at flat index 2 for this page.
        sections: [
          { __resolveType: FILLER_TYPE },
          { __resolveType: FILLER_TYPE },
          { __resolveType: FOOTER_TYPE },
        ],
      },
    });

    try {
      const pending = Promise.all([resolveDecoPage("/race-a"), resolveDecoPage("/race-b")]);

      // Let both resolveDecoPage() calls start and reach the shared
      // in-flight Footer promise before releasing it — this is what forces
      // them onto the SAME cached/in-flight object rather than resolving
      // one after the other.
      await new Promise((r) => setTimeout(r, 10));
      releaseFooter();

      const [pageA, pageB] = await pending;

      const footerA = pageA?.resolvedSections.find((s) => s.component === FOOTER_TYPE);
      const footerB = pageB?.resolvedSections.find((s) => s.component === FOOTER_TYPE);

      expect(footerA).toBeDefined();
      expect(footerB).toBeDefined();

      // The bug: mutating a shared cached object in place means both pages
      // would observe whichever index was stamped last (either both 0 or
      // both 2), not their own correct position.
      expect(footerA?.index).toBe(0);
      expect(footerB?.index).toBe(2);

      // The fix clones the wrapper before stamping — each page's Footer
      // section must be its own object, not the same shared reference.
      expect(footerA).not.toBe(footerB);
    } finally {
      unregisterLayoutSections([FOOTER_TYPE]);
    }
  });

  it("mechanism check: mutating a shared object in place under concurrent stamping loses one side's index (isolated, framework-independent)", async () => {
    // This isolates the exact bug mechanism from the diff that shipped in
    // 6.12.1 and was reverted after the rollback, independent of the CMS
    // registry/cache machinery — proof that the failure mode is a plain JS
    // shared-mutable-object race, not something specific to this framework's
    // plumbing.
    type Wrapper = { component: string; index?: number };

    const sharedCached: Wrapper[] = [{ component: "Footer" }];

    // Old (buggy) behavior: mutate the shared array's objects in place.
    function stampBuggy(indexForThisCaller: number): Promise<Wrapper[]> {
      return Promise.resolve(sharedCached).then((sections) => {
        for (const s of sections) s.index = indexForThisCaller;
        return sections;
      });
    }

    // New (fixed) behavior: clone before stamping.
    function stampFixed(indexForThisCaller: number): Promise<Wrapper[]> {
      return Promise.resolve(sharedCached).then((sections) =>
        sections.map((s) => ({ ...s, index: indexForThisCaller })),
      );
    }

    // Two "requests" concurrently want different indices for the same
    // shared cached object. With the buggy stamper, whichever `.then()`
    // callback runs last (caller B, since microtasks run in scheduling
    // order) overwrites the object caller A already received a *reference*
    // to — so caller A's array ends up reporting caller B's index too.
    const [buggyA, buggyB] = await Promise.all([stampBuggy(0), stampBuggy(2)]);
    expect(buggyA[0].index).toBe(2); // <- corrupted: A wanted 0, sees 2
    expect(buggyB[0].index).toBe(2);
    expect(buggyA[0]).toBe(buggyB[0]); // same object reference — the bug

    const [fixedA, fixedB] = await Promise.all([stampFixed(0), stampFixed(2)]);
    expect(fixedA[0].index).toBe(0); // <- correct
    expect(fixedB[0].index).toBe(2); // <- correct
    expect(fixedA[0]).not.toBe(fixedB[0]); // independent objects — the fix
  });
});
