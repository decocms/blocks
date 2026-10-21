import "server-only";
import { cache, type ReactNode } from "react";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { matchRoute, type Redirect } from "@decocms/blocks";
import { decidedClient } from "@decocms/nextjs/server";
import { client } from "./client.server";
import { cms } from "./cms";
import type { ResolvedPage, StoredPage } from "./model";
import type { Post } from "./post";

// `decisions`: the decisions route's segment. The page renders what it says (decidedClient: a
// forged one that names a test nobody is in, or a campaign not running, is a 404). Without it, the
// request's own client (a draft, and the visitor bindDraft bound).
export const openPage = cache(async (pathname: string, decisions?: string) => {
  const c = decisions === undefined ? await client() : await decidedClient(cms, decisions);
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
