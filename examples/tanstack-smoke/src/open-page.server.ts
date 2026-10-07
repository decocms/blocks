import { notFound, redirect } from "@tanstack/react-router";
import { matchRoute, type Redirect, type Seo } from "@decocms/blocks";
import { client } from "./cms";
import type { StoredPage } from "./model";

export async function openPage<T>(href: string, request: Request) {
  const c = await client(request);
  const [pages, pagesError] = await c.list<StoredPage>("page");
  if (pagesError) throw pagesError;
  const [redirects, redirectsError] = await c.list<Redirect>("redirect");
  if (redirectsError) throw redirectsError;

  const match = matchRoute(href, { routes: pages, redirects });
  if (match.kind === "not-found") throw notFound();
  if (match.kind === "redirect") throw redirect({ href: match.location, statusCode: match.status });

  const page = match.entry;
  // Variants of the whole list are one multivariate block: it resolves to the chosen list and streams as one.
  const sections = Array.isArray(page.sections) ? page.sections : [page.sections];
  const blocks = sections.map((block, index) => ({
    key: `${href}:${index}`,
    value: c.resolve<T | T[] | undefined>(block).then(([value, blockError]) => {
      if (blockError) console.error(blockError);
      return { value: value ?? undefined, failed: blockError !== null };
    }),
  }));

  // Every block has started before SEO is awaited.
  const [seo, seoError] = await c.resolve<Seo | undefined>(page.seo);   // undefined when the page has no seo
  if (seoError) throw seoError;
  return { seo, blocks };
}
