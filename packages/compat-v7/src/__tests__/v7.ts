/**
 * Test-only. v7's own code, the reference every helper here is pinned
 * against: `src/__fixtures__/v7/` holds the files verbatim from `7.x`
 * (`packages/blocks/src/<same path>`, at the commit below), and their hashes
 * are pinned so an edit to a reference fails `fixtures.test.ts` instead of
 * silently moving the goalposts. To refresh after a 7.x change:
 * `git show origin/7.x:packages/blocks/src/<path> > src/__fixtures__/v7/<path>`
 * and update the hash and the commit.
 */
export const V7_COMMIT = "9131e9d9"; // origin/7.x, @decocms/blocks 7.79.6

export const V7_FILES: Record<string, string> = {
  "sdk/clx.ts": "19e5421ac3cca8af19da6c31886fa8f2a8cc2d3e0eb16d397503efca14b0601d",
  "sdk/detectDevice.ts": "d0f46159f4d8afef284aed6046ce9f5513544c94caa78ae6cfd151ca73c22632",
  "sdk/useScript.ts": "fe32f4a89897730a1c5ee2f20aa1894c05943ff2e14da7af400f397b4476fe58",
  "types/index.ts": "e74120a518f1d6c7dd1e4db2499de67db081fb1d8077514806dc434b6f5e5ca5",
  "types/widgets.ts": "f45956ea4344b9267069518fa3e952810dc7d37d9f798b56c68e28527e84c752",
};

/** A seeded PRNG (mulberry32), so a fuzz failure reproduces. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: () => number, items: readonly T[]): T =>
  items[Math.floor(r() * items.length)];
