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
  // The posts' paths come from the index too (no post body is read to route); a post's
  // route says so, and the post is read once it matched.
  const [posts, postsError] = await c.entries("post");
  if (postsError) throw postsError;
  const postRoutes = posts.flatMap((p) => (p.path === undefined ? [] : [{ name: p.name, path: p.path, post: true }]));
  const routable: (Route | (typeof postRoutes)[number])[] = [...routes, ...postRoutes];
  const match = matchRoute(pathname, { routes: routable });
  const isPost = match.kind === "match" && "post" in match.entry;
  // The page's (or post's) blocks start downloading with the redirects block, in one wave.
  if (match.kind === "match") c.prefetch(match.entry.name);
  const [redirects, redirectsError] = await c.redirects();
  if (redirectsError) throw redirectsError;
  const moved = matchRoute(pathname, { routes: [], redirects });
  if (moved.kind === "redirect") {
    if (moved.status === 301 || moved.status === 308) permanentRedirect(moved.location);
    redirect(moved.location);
  }
  if (match.kind !== "match") notFound();

  if (isPost) {
    const [post, postError] = await c.resolve<Post>(match.entry.name, { run: false });
    if (postError) throw postError;
    return { post, page: null };
  }
  const [page, error] = await c.resolve<ResolvedPage<ReactNode>>(match.entry.name);
  if (error) throw error;
  return { post: null, page };
});

export const pathnameFor = (segments: string[] = []) =>
  "/" + segments.map(encodeURIComponent).join("/");
