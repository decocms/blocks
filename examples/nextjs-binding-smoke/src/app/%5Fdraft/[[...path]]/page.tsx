// The draft route: the proxy rewrites a drafted request here (/_draft/<path>). Dynamic by
// construction, so a draft is never rendered into, or served from, the static pages' cache.
import { DraftPreviewIndicator } from "@decocms/nextjs";
import { bindDraft, type SearchParams } from "@decocms/nextjs/server";
import type { Metadata } from "next";
import { preview } from "../../../cms.config";
import { cms } from "../../../cms";
import { openPage, pathnameFor } from "../../../open-page.server";
import { PageView } from "../../PageView";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ path?: string[] }>; searchParams: Promise<SearchParams> };

async function open({ params, searchParams }: Props) {
  await bindDraft(cms, { searchParams: await searchParams, ...preview });
  return openPage(pathnameFor((await params).path));
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { post, page } = await open(props);
  if (post) return { title: post.name };
  return { title: page.seo?.title, description: page.seo?.description };
}

export default async function DraftPage(props: Props) {
  return (
    <>
      <PageView {...await open(props)} />
      <DraftPreviewIndicator />
    </>
  );
}
