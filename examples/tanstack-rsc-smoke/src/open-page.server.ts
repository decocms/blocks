import { notFound, redirect } from "@tanstack/react-router";
import { matchRoute, type Seo } from "@decocms/blocks";
import { client } from "./cms";
import type { StoredPage } from "./model";

export async function openPage<T>(href: string, request: Request) {
  const c = await client(request);
  // Routing reads the index: the pages' paths, then the redirects block.
  const [routes, routesError] = await c.routes();
  if (routesError) throw routesError;
  const match = matchRoute(href, { routes });
  // The page's blocks start downloading with the redirects block, in one wave.
  if (match.kind === "match") c.prefetch(match.entry.name);
  const [redirects, redirectsError] = await c.redirects();
  if (redirectsError) throw redirectsError;
  const moved = matchRoute(href, { routes: [], redirects });
  if (moved.kind === "redirect") throw redirect({ href: moved.location, statusCode: moved.status });
  if (match.kind !== "match") throw notFound();

  const [page, pageError] = await c.resolve<StoredPage>(match.entry.name, { run: false });
  if (pageError) throw pageError;
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
