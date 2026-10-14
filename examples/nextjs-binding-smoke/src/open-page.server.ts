import "server-only";
import { cache, type ReactNode } from "react";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { matchRoute, type Redirect } from "@decocms/blocks";
import { client } from "./client.server";
import type { ResolvedPage, StoredPage } from "./model";
import type { Post } from "./post";

export const openPage = cache(async (pathname: string) => {
  const c = await client();
  const [pages, pagesError] = await c.list<StoredPage>("page");
  if (pagesError) throw pagesError;
  const [redirects, redirectsError] = await c.list<Redirect>("redirect");
  if (redirectsError) throw redirectsError;
  const [posts, postsError] = await c.list<Post>("post");
  if (postsError) throw postsError;

  const match = matchRoute(pathname, { routes: [...pages, ...posts], redirects });
  if (match.kind === "not-found") notFound();
  if (match.kind === "redirect") {
    if (match.status === 301 || match.status === 308) permanentRedirect(match.location);
    redirect(match.location);
  }

  if ("__resolveType" in match.entry && match.entry.__resolveType === "post") return { post: match.entry as Post, page: null };
  const [page, error] = await c.resolve<ResolvedPage<ReactNode>>(match.entry);
  if (error) throw error;
  return { post: null, page };
});

export const pathnameFor = (segments: string[] = []) =>
  "/" + segments.map(encodeURIComponent).join("/");
