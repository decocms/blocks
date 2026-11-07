import "server-only";
import { cache, type ReactNode } from "react";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { matchRoute, type Route } from "@decocms/blocks";
import { client } from "./client.server";
import type { ResolvedPage } from "./model";
import type { Post } from "./post";

export const openPage = cache(async (pathname: string) => {
  const c = await client();
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
