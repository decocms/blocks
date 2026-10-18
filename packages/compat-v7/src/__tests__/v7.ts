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
 * `apps-commerce/<path>` is `packages/apps-commerce/src/<path>` (v7's
 * `@decocms/apps-commerce`, which shipped its source), the same bytes at the
 * commit below and at `d586d6f0`, the 7.x head when `/commerce` was ported.
 *
 * `tanstack/sdk/workerEntry.ts` is from `d586d6f0` (7.x head; its cookie
 * reading is the same as at the commit below).
 *
 * `v7.77.12/<path>` is the same file at `@decocms/blocks` 7.77.12 (`44952cbe`),
 * the last release before 7.x#648: its section runner ran the loaders of
 * the sections a section held directly in a prop or a list prop, and of no
 * section nested deeper (`runSectionLoaders`' `nested: "direct"`).
 *
 * `vendor/h3-cookie.js` is the cookie code v7's TanStack route ran through
 * `getCookies()`/`setCookie()`: lines 1236–1335 of `h3-v2` (npm `h3`
 * 2.0.1-rc.16, the version `@tanstack/start-server-core` 1.166 pinned for v7
 * sites) `dist/h3-ByfIX5Jk.mjs`, verbatim, plus one `export` line.
 */
export const V7_COMMIT = "9131e9d9"; // origin/7.x, @decocms/blocks 7.79.6

export const V7_FILES: Record<string, string> = {
  "apps-commerce/sdk/analytics.ts":
    "b174f6f68de48cd46cf53bb6a5431233da517d8e61278b2b223ad757474a2995",
  "apps-commerce/sdk/formatPrice.ts":
    "047ffa72b0d5ed5fdd5e624e6a0f86a740d67da83c693c8f3fe2f83f7d55f471",
  "apps-commerce/sdk/url.ts": "7699610ee2d6c4bed2f4fc8bb76e8ec4e1a10e897fac509c5d11563a3e2aaf3e",
  "apps-commerce/sdk/useOffer.ts":
    "76c26b55f6523b57721521ab7b080e2ad919af7fc3cab69bf3162d39e3ffad3f",
  "apps-commerce/sdk/useVariantPossibilities.ts":
    "7bc787eae964e8558f3a53e79817c990b6880734dbcab1ba89b29740a0f99ffc",
  "apps-commerce/types/cart.ts": "409e5d3fb12bda87559f3b50a91f378696865d0c29859994096ad07be6242681",
  "apps-commerce/types/commerce.ts":
    "ded8cbea5c330d3f2eb4a8414aecd7b16dfc3b8ff89d58692de076411baa985b",
  "apps-commerce/utils/canonical.ts":
    "77e8e3a12e9f62d6605a5282f887aec11488440968b6c66cf414453fb7956660",
  "apps-commerce/utils/constants.ts":
    "0da4fa7f4a0a98aa4bd298297f8f1f481d0b2e449fc8c22c370280ba7f8a1fdb",
  "apps-commerce/utils/filters.ts":
    "e2a38e9fa7a120e4d15c094d3efdbb7af99319c0ce8484e220c5b5577f07f783",
  "apps-commerce/utils/productToAnalyticsItem.ts":
    "eae34351d7fe0541733ead1dddb92f6062f60bd7e284687f755a76ec1883e228",
  "apps-commerce/utils/stateByZip.ts":
    "f7140dd14345e813be5e9440f76028a6347afcf7a76031a4a3b254a0a622dfd8",
  "cms/resolve.ts": "5cc19883e18f99e3c3f84d74a4f7a1fb7264eafbd0b05024cb22387535269337",
  "cms/sectionLoaders.ts": "d0762627471c4b917f00f2be44b602ccb0a9c87fa0b17b98d639e0839b3d6d4c",
  "cms/sectionMixins.ts": "768706c228f1f62d099308fae6b25eab7b8466ad8e4e9ed66c4288f1ddcf54fd",
  "matchers/builtins.ts": "72e7122c4bc5fb231efe50157906e6ee8fc9b6499488e796876a71b38f7f49fc",
  "matchers/countryNames.ts": "8a9642d2f826fa2776cbf5f8c891feecd0baaeb1edda38de7f3c49790c5fdadb",
  "matchers/override.ts": "0410e149e7bf91bc9babbb5009adafedc0a8c1edbbb3dfd7adaf2cea338d032e",
  "sdk/abTesting.ts": "fe96e05ba52a14ba79716f75320c5cba6c8d3af2643466d52ec2acfdf40875d7",
  "sdk/clx.ts": "19e5421ac3cca8af19da6c31886fa8f2a8cc2d3e0eb16d397503efca14b0601d",
  "sdk/detectDevice.ts": "d0f46159f4d8afef284aed6046ce9f5513544c94caa78ae6cfd151ca73c22632",
  "sdk/djb2.ts": "61c74290f19bf130949e576e654bb670903f2db470ef53c53e507f4a680a0916",
  "sdk/experiments.ts": "0ae6d947a43c812a87be50df3906c9bb98d536cb4fc44c2dda7e6f04c89c3e87",
  "sdk/flags.ts": "cb73a16f0d7522cdd2e3cae051900c921badede4c96eda0a1b5487b540c3240e",
  "sdk/useScript.ts": "fe32f4a89897730a1c5ee2f20aa1894c05943ff2e14da7af400f397b4476fe58",
  "tanstack/routes/cmsRoute.ts": "86c5f980fea9e36c0c3982f1129b883c74f9e906c5a278948b87623829d44bdb",
  "sdk/useDevice.ts": "56ff9a761ddc819f7249dc40317e92db6fe18bf4cbc0c567aad0e0965a3b69ab",
  "sdk/useDeviceContext.tsx": "bca5efa56a7012ea8e3c754b25c96ab6eb9cb0539ff120477f6b26cc435bd972",
  "tanstack/sdk/workerEntry.ts": "3a5c5c6a017b9eefb7ba1e78e6d73e2bc962a21b2e21af090c188b78c75b826e",
  "types/index.ts": "e74120a518f1d6c7dd1e4db2499de67db081fb1d8077514806dc434b6f5e5ca5",
  "types/widgets.ts": "f45956ea4344b9267069518fa3e952810dc7d37d9f798b56c68e28527e84c752",
  "v7.77.12/cms/sectionLoaders.ts":
    "b9e51e240d3e7f42bd07288efa34138f586a7d643f0b0fa8f30472c600792024",
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
