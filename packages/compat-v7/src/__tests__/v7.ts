/**
 * Test-only. v7's own code, the reference every helper here is pinned
 * against: `src/__fixtures__/v7/` holds the files verbatim from `7.x`
 * (`packages/blocks/src/<same path>`, at the commit below; `tanstack/<path>`
 * is `packages/tanstack/src/<path>`), and their hashes are pinned so an edit
 * to a reference fails `fixtures.test.ts` instead of silently moving the
 * goalposts. To refresh after a 7.x change:
 * `git show origin/7.x:packages/blocks/src/<path> > src/__fixtures__/v7/<path>`
 * and update the hash and the commit.
 *
 * `vendor/h3-cookie.js` is the cookie code v7's TanStack route ran through
 * `getCookies()`/`setCookie()`: lines 1236–1335 of `h3-v2` (npm `h3`
 * 2.0.1-rc.16, the version `@tanstack/start-server-core` 1.166 pinned for v7
 * sites) `dist/h3-ByfIX5Jk.mjs`, verbatim, plus one `export` line.
 */
export const V7_COMMIT = "9131e9d9"; // origin/7.x, @decocms/blocks 7.79.6

export const V7_FILES: Record<string, string> = {
  "cms/resolve.ts": "5cc19883e18f99e3c3f84d74a4f7a1fb7264eafbd0b05024cb22387535269337",
  "matchers/builtins.ts": "72e7122c4bc5fb231efe50157906e6ee8fc9b6499488e796876a71b38f7f49fc",
  "matchers/countryNames.ts": "8a9642d2f826fa2776cbf5f8c891feecd0baaeb1edda38de7f3c49790c5fdadb",
  "matchers/override.ts": "0410e149e7bf91bc9babbb5009adafedc0a8c1edbbb3dfd7adaf2cea338d032e",
  "sdk/clx.ts": "19e5421ac3cca8af19da6c31886fa8f2a8cc2d3e0eb16d397503efca14b0601d",
  "sdk/detectDevice.ts": "d0f46159f4d8afef284aed6046ce9f5513544c94caa78ae6cfd151ca73c22632",
  "sdk/djb2.ts": "61c74290f19bf130949e576e654bb670903f2db470ef53c53e507f4a680a0916",
  "sdk/experiments.ts": "0ae6d947a43c812a87be50df3906c9bb98d536cb4fc44c2dda7e6f04c89c3e87",
  "sdk/flags.ts": "cb73a16f0d7522cdd2e3cae051900c921badede4c96eda0a1b5487b540c3240e",
  "sdk/useScript.ts": "fe32f4a89897730a1c5ee2f20aa1894c05943ff2e14da7af400f397b4476fe58",
  "tanstack/routes/cmsRoute.ts": "86c5f980fea9e36c0c3982f1129b883c74f9e906c5a278948b87623829d44bdb",
  "types/index.ts": "e74120a518f1d6c7dd1e4db2499de67db081fb1d8077514806dc434b6f5e5ca5",
  "types/widgets.ts": "f45956ea4344b9267069518fa3e952810dc7d37d9f798b56c68e28527e84c752",
  "vendor/h3-cookie.js": "828b798434aa40d29c8d889758187da5da82bfa39a7b43a7ab37f1ddcb234f7a",
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
