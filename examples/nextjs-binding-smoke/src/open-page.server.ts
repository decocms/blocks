import "server-only";
import { cache, type ReactNode } from "react";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { matchRoute, type Redirect } from "@decocms/blocks";
import { assignedClient } from "@decocms/nextjs/server";
import { client } from "./client.server";
import { cms } from "./cms";
import type { ResolvedPage, StoredPage } from "./model";
import type { Post } from "./post";

// `assignments`: the assignments route's segment. The page shows the tests it names (assignedClient:
// a visitor with no id in exactly those tests; campaigns checked at render time; a name the content
// doesn't have stays off, and a segment the proxy never writes is a 404). Without it, the
// request's own client (a draft, and the visitor bindDraft bound).
export const openPage = cache(async (pathname: string, assignments?: string) => {
  const c = assignments === undefined ? await client() : assignedClient(cms, assignments);
  if (!c) notFound();
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
