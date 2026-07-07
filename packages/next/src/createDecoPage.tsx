import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  extractSeoFromProps,
  extractSeoFromSections,
  resolveDecoPage,
  type DecoPageResult,
  type PageSeo,
} from "@decocms/runtime/cms";
import { DecoPageRenderer } from "./DecoPageRenderer";

interface CreateDecoPageOptions {
  siteName: string;
}

interface PageProps {
  params: Promise<{ slug?: string[] }>;
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
  // `siteName` is unused here. `MatcherContext` (packages/runtime/src/cms/resolve.ts)
  // has no siteName field, so there's nothing to thread it into `resolveDecoPage`.
  // It's kept in the options shape to mirror `cmsRouteConfig({ siteName })`'s call
  // signature and as the extension point for Task 7's root layout
  // (LiveControls/analytics wiring) — genuinely unused in this file.
  void siteName;

  const resolveForPath = cache(async (pathname: string) => resolveDecoPage(pathname, {}));

  async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { slug } = await params;
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

  async function Page({ params }: PageProps) {
    const { slug } = await params;
    const pathname = pathFromSlug(slug);
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
