import { DRAFT_COOKIE_NAME, DRAFT_QUERY_PARAM } from "@decocms/blocks/cms";
import { describe, expect, it } from "vitest";

import { DRAFT_COOKIE, DRAFT_PARAM } from "./draftConstants";

/**
 * The draft cookie/param names are wire protocol shared across a package
 * boundary: the client-safe copy here (the badge imports it without pulling
 * `next/headers` into the client bundle) MUST stay identical to the
 * framework-agnostic owner in `@decocms/blocks`, which `/deco/invoke` reads to
 * bind the same draft. If these drift, invoke silently serves published content
 * while the page shows the draft.
 */
describe("draft constants parity with @decocms/blocks", () => {
  it("cookie name matches", () => {
    expect(DRAFT_COOKIE).toBe(DRAFT_COOKIE_NAME);
  });
  it("query param matches", () => {
    expect(DRAFT_PARAM).toBe(DRAFT_QUERY_PARAM);
  });
});
