import {
  type DecoPageResult,
  extractSeoFromProps,
  extractSeoFromSections,
  isDraftPreviewEnabled,
  type PageSeo,
  resolveDecoPage,
} from "@decocms/blocks/cms";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { DecoPageRenderer } from "./DecoPageRenderer";
import { type DraftSearchParams, ensureDraft } from "./draft";

interface CreateDecoPageOptions {
  siteName: string;
}

interface PageProps {
  params: Promise<{ slug?: string[] }>;
  /**
   * Next always supplies this; optional here so existing callers (and unit
   * tests) that construct props by hand keep compiling. Draft preview reads
   * `?__draft=` from it — see bindDraftOnce.
   */
  searchParams?: Promise<DraftSearchParams>;
}

function pathFromSlug(slug: string[] | undefined): string {
  return `/${(slug ?? []).join("/")}`;
}

/**
 * Merge page-level SEO (the `seo` block resolved into `DecoPageResult.seoSection`)
 * with section-contributed SEO (sections registered via `registerSeoSections`
 * whose resolved props also carry SEO fields — e.g. a PDP SEO section). Page
 * level fields win on conflict, mirroring `buildPageSeo` in the TanStack
 * binding (packages/tanstack/src/routes/cmsRoute.ts:408-484).
 *
 * Deliberately narrower than that binding's version: it does NOT run
 * `seoSection` through its own section loader (so commerce-loader-backed
 * jsonLD on the seo block won't resolve here) and does NOT fall back to
 * site-wide SEO defaults or apply title/description templates. Those are
 * out of scope for this minimal page.tsx wiring.
 */
function buildSeo(page: DecoPageResult): PageSeo {
  const sectionSeo = extractSeoFromSections(page.resolvedSections);
  const pageSeo = page.seoSection ? extractSeoFromProps(page.seoSection.props) : {};
  return { ...sectionSeo, ...pageSeo };
}

/**
 * Creates the { generateMetadata, default } pair a site spreads into
 * app/[[...slug]]/page.tsx. Mirrors `@decocms/tanstack`'s `cmsRouteConfig`.
 *
 * `resolveForPath` is wrapped in React's `cache()` so `generateMetadata` and
 * the page body share one `resolveDecoPage` call per request instead of
 * resolving twice — the same pattern faststore-fila's own
 * `resolveCmsPageByPath` already used against the old /next tier. This relies
 * on Next's RSC renderer establishing a per-request cache boundary that
 * `cache()` memoizes against: calling the returned functions directly outside
 * that renderer (e.g. in a plain unit test) will NOT dedupe, since there is
 * no active cache boundary for `cache()` to key off — verified empirically
 * against this repo's `react` version. The functions still return correct,
 * independent results either way; only the single-request sharing is
 * untestable outside Next's own pipeline.
 */
export function createDecoPage({ siteName }: CreateDecoPageOptions) {
  // `siteName` is unused here. `MatcherContext` (packages/blocks/src/cms/resolve.ts)
  // has no siteName field, so there's nothing to thread it into `resolveDecoPage`.
  // It's kept in the options shape to mirror `cmsRouteConfig({ siteName })`'s call
  // signature and as the extension point for Task 7's root layout
  // (LiveControls/analytics wiring) — genuinely unused in this file.
  void siteName;

  const resolveForPath = cache(async (pathname: string) => resolveDecoPage(pathname, {}));

  /**
   * Bind this request's draft decofile, at most once, BEFORE anything resolves
   * a page.
   *
   * Ordering is load-bearing twice over:
   *
   *  1. `resolveDecoPage` calls `loadBlocks()`, so a draft bound afterwards
   *     would resolve the page against published content and silently render
   *     the wrong thing.
   *  2. `resolveForPath` is `cache()`d per request and Next may run
   *     `generateMetadata` and the page body concurrently — whichever resolves
   *     first wins for both. So this must be awaited at the top of BOTH, not
   *     just the page. `cache()` here makes the second call free.
   *
   * Gated on `isDraftPreviewEnabled()` (DECO_DRAFT_PREVIEW_HOST non-empty) — a
   * plain env read, not a dynamic API —
   * so sites that never opt in behave exactly as before. That gate is doing
   * real work: `cookies()` and `searchParams` are both dynamic, and touching
   * them unconditionally would opt EVERY page out of static/ISR rendering.
   *
   * KNOWN COST: with the flag on, every page served by this route becomes
   * dynamic, because reading the pointer requires `cookies()`. Acceptable
   * while the feature is opt-in; the fix, when it needs to run on a
   * statically-rendered production site, is for middleware to rewrite draft
   * requests onto a separate dynamic route so ordinary traffic keeps its cache.
   */
  const bindDraftOnce = cache(async (searchParams?: DraftSearchParams): Promise<boolean> => {
    if (!isDraftPreviewEnabled()) return false;

    const bound = await ensureDraft(searchParams);

    // A draft render must never be cached — ISR or the Full Route Cache would
    // hand unpublished content to a real visitor. `revalidate` is a static
    // export and cannot vary per request, so opt out at runtime instead.
    if (bound) await connection();

    return bound;
  });

  async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
    const { slug } = await params;
    await bindDraftOnce(await searchParams);
    const page = await resolveForPath(pathFromSlug(slug));
    if (!page) return {};

    const seo = buildSeo(page);
    return {
      title: seo.title,
      description: seo.description,
      alternates: seo.canonical ? { canonical: seo.canonical } : undefined,
      robots: seo.noIndexing ? { index: false, follow: false } : undefined,
    };
  }

  async function Page({ params, searchParams }: PageProps) {
    const { slug } = await params;
    const pathname = pathFromSlug(slug);
    // Before resolveForPath — see bindDraftOnce.
    await bindDraftOnce(await searchParams);
    const page = await resolveForPath(pathname);
    if (!page) notFound();

    // Call DecoPageRenderer directly (await its result) rather than nesting
    // it as `<DecoPageRenderer .../>` JSX. DecoPageRenderer.tsx documents why:
    // it's an async function, and Next's real RSC renderer awaits async
    // components anywhere in the tree — but react-dom/server's synchronous
    // renderer (used by this package's unit tests, and by any consumer not
    // going through Next's RSC pipeline) throws when an async component
    // suspends outside a <Suspense> boundary. Awaiting it here directly
    // keeps both paths working, matching the same convention
    // DecoPageRenderer itself uses for SectionRenderer.
    return await DecoPageRenderer({
      sections: page.resolvedSections,
      deferredSections: page.deferredSections,
      pagePath: pathname,
    });
  }

  return { generateMetadata, default: Page };
}
