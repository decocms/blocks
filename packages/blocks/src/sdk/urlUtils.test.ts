import { describe, expect, it } from "vitest";
import { cleanPathForCacheKey, isTrackingParam } from "./urlUtils";

describe("tracking params that used to fragment the cache key", () => {
  // Each of these was measured missing the edge cache on every route probed on a
  // production storefront, because it was absent from UTM_PARAMS.
  const cases = [
    ["GA4 campaign id", "utm_id"],
    ["GA4 source platform", "utm_source_platform"],
    ["Google Ads source", "gad_source"],
    ["Google Ads iOS click id", "gbraid"],
    ["Google Ads web-to-app click id", "wbraid"],
    ["GA cross-domain linker", "_gl"],
    ["Instagram", "igshid"],
    ["Pinterest", "epik"],
    ["Marketo", "mkt_tok"],
    ["Yandex", "yclid"],
  ] as const;

  for (const [label, param] of cases) {
    it(`strips ${label} (${param})`, () => {
      expect(isTrackingParam(param)).toBe(true);
      expect(cleanPathForCacheKey(`https://x.com/aneis?color=ouro&${param}=abc`)).toBe(
        "/aneis?color=ouro",
      );
    });
  }

  it("still keeps functional params", () => {
    for (const p of ["page", "order", "map", "PS", "filter.color", "skuId", "q"]) {
      expect(isTrackingParam(p)).toBe(false);
    }
  });
});
