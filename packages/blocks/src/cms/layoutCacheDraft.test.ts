import { afterEach, describe, expect, it } from "vitest";
import { setDraftOverrideGetter } from "./draftSource";
import {
  registerLayoutSections,
  registerSections,
  resolveDecoPage,
  setBlocks,
  unregisterLayoutSections,
  withBlocksOverride,
} from "./index";

/**
 * Regression: the process-wide resolved-layout cache (Header/Footer) is keyed
 * on published content by block name alone. When a request resolves against an
 * override — an admin POST-render preview (`withBlocksOverride`) or a
 * pull-based draft (`getRequestDraftOverride`) — it must NOT serve from or
 * write into that shared cache: doing so both masked the preview's own layout
 * edits (surfaced testing draft preview against a real site: main-content
 * sections reflected the draft, Header/Footer did not) and risked leaking
 * unpublished layout content to real visitors.
 *
 * The fix bypasses the layout cache while `hasActiveBlocksOverride()` is true.
 */
const HEADER_TYPE = "site/sections/DraftHeader.tsx";

function pageWithHeader(headerKey: string) {
  return {
    [`pages-${headerKey}`]: {
      path: `/${headerKey}`,
      sections: [{ __resolveType: headerKey }],
    },
    [headerKey]: { __resolveType: HEADER_TYPE, label: "PUBLISHED" },
  };
}

function headerLabel(page: Awaited<ReturnType<typeof resolveDecoPage>>): unknown {
  return page?.resolvedSections.find((s) => s.component === HEADER_TYPE)?.props.label;
}

registerSections({ [HEADER_TYPE]: async () => ({ default: () => null }) });

afterEach(() => {
  unregisterLayoutSections([HEADER_TYPE]);
  setDraftOverrideGetter(() => undefined);
});

describe("layout cache is bypassed while a blocks override is active", () => {
  it("reflects a withBlocksOverride (admin preview) edit to a cached layout section, and never poisons the published cache", async () => {
    const KEY = "DraftHeaderA";
    registerLayoutSections([HEADER_TYPE]);
    setBlocks(pageWithHeader(KEY));

    // 1) Published resolve — populates the shared layout cache with PUBLISHED.
    expect(headerLabel(await resolveDecoPage(`/${KEY}`))).toBe("PUBLISHED");

    // 2) Preview resolve overriding the header block — must see DRAFT, not the
    //    cached PUBLISHED. (Pre-fix: the cache HIT returns PUBLISHED.)
    const drafted = await withBlocksOverride(
      { [KEY]: { __resolveType: HEADER_TYPE, label: "DRAFT" } },
      () => resolveDecoPage(`/${KEY}`),
    );
    expect(headerLabel(drafted)).toBe("DRAFT");

    // 3) Leak check: a subsequent published resolve still sees PUBLISHED — the
    //    preview resolve must not have written DRAFT into the shared cache.
    expect(headerLabel(await resolveDecoPage(`/${KEY}`))).toBe("PUBLISHED");
  });

  it("reflects a pull-based draft override to a cached layout section", async () => {
    const KEY = "DraftHeaderB";
    registerLayoutSections([HEADER_TYPE]);
    setBlocks(pageWithHeader(KEY));

    // Warm the cache with published content.
    expect(headerLabel(await resolveDecoPage(`/${KEY}`))).toBe("PUBLISHED");

    // The draft binding installs a request-scoped override getter (this is what
    // the Next/TanStack bindings do via setDraftOverrideGetter).
    setDraftOverrideGetter(() => ({ [KEY]: { __resolveType: HEADER_TYPE, label: "DRAFT" } }));
    expect(headerLabel(await resolveDecoPage(`/${KEY}`))).toBe("DRAFT");

    // Remove the draft → back to published (and the cache was never poisoned).
    setDraftOverrideGetter(() => undefined);
    expect(headerLabel(await resolveDecoPage(`/${KEY}`))).toBe("PUBLISHED");
  });
});
