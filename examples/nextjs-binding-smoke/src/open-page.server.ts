import "server-only";
import { cache, type ReactNode } from "react";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { matchRoute, type Route } from "@decocms/blocks";
import { assignedClient } from "@decocms/nextjs/server";
import { client } from "./client.server";
import { cms } from "./cms";
import type { ResolvedPage } from "./model";
import type { Post } from "./post";

// `assignments`: the assignments route's segment. The page shows the tests and campaigns it names,
// as the proxy decided them (assignedClient: cms.client({ experiments, campaigns }) with every test
// and campaign on or off as named, and no visitor; a test at 0% and a name the content doesn't have
// stay off, and a segment the proxy never writes is a 404). Without it, the request's own client
// (a draft, and the tests and campaigns the proxy decided, which bindDraft bound).
export const openPage = cache(async (pathname: string, assignments?: string) => {
  const c = assignments === undefined ? await client() : await assignedClient(cms, assignments);
  if (!c) notFound();
  // Routing reads the index: the pages' paths (and the posts), then the redirects block.
  const [routes, routesError] = await c.routes();
  if (routesError) throw routesError;
  const [posts, postsError] = await c.list<Post>("post");
  if (postsError) throw postsError;
  const routable: (Route | Post)[] = [...routes, ...posts];
  const match = matchRoute(pathname, { routes: routable });
  const post = match.kind === "match" && "__resolveType" in match.entry ? (match.entry as Post) : null;
  // The page's blocks start downloading with the redirects block, in one wave.
  if (match.kind === "match" && post === null) c.prefetch(match.entry.name);
  const [redirects, redirectsError] = await c.redirects();
  if (redirectsError) throw redirectsError;
  const moved = matchRoute(pathname, { routes: [], redirects });
  if (moved.kind === "redirect") {
    if (moved.status === 301 || moved.status === 308) permanentRedirect(moved.location);
    redirect(moved.location);
  }
  if (match.kind !== "match") notFound();

  if (post !== null) return { post, page: null };
  const [page, error] = await c.resolve<ResolvedPage<ReactNode>>(match.entry.name);
  if (error) throw error;
  return { post: null, page };
});

export const pathnameFor = (segments: string[] = []) =>
  "/" + segments.map(encodeURIComponent).join("/");
