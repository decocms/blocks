import type { Metadata } from "next";
import { openPage, pathnameFor } from "../../../../open-page.server";
import { PageView } from "../../../PageView";

// A published page. The proxy rewrites every CMS page here, to /_decided/<decisions>/<path>: the
// tests the visitor is in and the campaigns running, never the visitor. Static, so Next renders
// one entry per path and decisions and serves it to every visitor with the same ones; the page
// renders what its path says (decidedClient), never deciding again. Drafts render on /_draft.
export const dynamic = "force-static";
type Props = { params: Promise<{ decisions: string; path?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { decisions, path } = await params;
  const { post, page } = await openPage(pathnameFor(path), decisions);
  if (post) return { title: post.name };
  return { title: page.seo?.title, description: page.seo?.description };
}

export default async function Page({ params }: Props) {
  const { decisions, path } = await params;
  return <PageView {...await openPage(pathnameFor(path), decisions)} decisions={decisions} />;
}
